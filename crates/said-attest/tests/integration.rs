//! Integration tests for `said-attest`.
//!
//! Real Nitro attestation documents are only available from running enclaves.
//! These tests therefore build a fake-but-structurally-faithful attestation
//! document: an ECDSA P-384 root + intermediate + leaf chain (rcgen), a CBOR
//! payload with PCRs and `user_data` set the way an enclave would, all
//! wrapped in a `COSE_Sign1` envelope signed by the leaf key.
//!
//! `said-attest` exposes `verify_attestation_with_root` so we substitute our
//! test root for the pinned AWS Nitro Root G1.

use ciborium::Value;
use coset::{iana, CoseSign1Builder, HeaderBuilder, TaggedCborSerializable};
use ed25519_dalek::{Signer, SigningKey as EdSigningKey};
use p384::ecdsa::{Signature as P384Sig, SigningKey as P384Sk};
use p384::pkcs8::DecodePrivateKey;
use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair, PKCS_ECDSA_P384_SHA384};
use sha2::{Digest, Sha256};

use said_attest::{
    measurement_digest, pack_user_data, verify_attestation_with_root, AttestationError,
};
use ghola_assistant_types::TeeKind;

struct Chain {
    root_der: Vec<u8>,
    intermediate_der: Vec<u8>,
    leaf_der: Vec<u8>,
    leaf_signer: P384Sk,
}

fn make_chain() -> Chain {
    let root_kp = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
    let mut root_params =
        CertificateParams::new(vec!["Test Nitro Root".to_string()]).unwrap();
    root_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let root_cert = root_params.self_signed(&root_kp).unwrap();

    let int_kp = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
    let mut int_params =
        CertificateParams::new(vec!["Test Intermediate".to_string()]).unwrap();
    int_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let int_cert = int_params.signed_by(&int_kp, &root_cert, &root_kp).unwrap();

    let leaf_kp = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
    let leaf_params = CertificateParams::new(vec!["Test Leaf".to_string()]).unwrap();
    let leaf_cert = leaf_params
        .signed_by(&leaf_kp, &int_cert, &int_kp)
        .unwrap();

    let leaf_signer =
        P384Sk::from_pkcs8_der(&leaf_kp.serialize_der()).expect("leaf key is PKCS#8");

    Chain {
        root_der: root_cert.der().to_vec(),
        intermediate_der: int_cert.der().to_vec(),
        leaf_der: leaf_cert.der().to_vec(),
        leaf_signer,
    }
}

/// AWS Nitro convention puts the trust root at `cabundle[0]`. We follow that.
fn build_cbor_payload(
    timestamp_ms: u64,
    pcrs: &[(u32, Vec<u8>)],
    user_data: Option<Vec<u8>>,
    leaf_der: &[u8],
    intermediate_der: &[u8],
    root_der: &[u8],
) -> Vec<u8> {
    let mut payload_map: Vec<(Value, Value)> = vec![
        (
            Value::Text("module_id".into()),
            Value::Text("i-0test12345".into()),
        ),
        (
            Value::Text("timestamp".into()),
            Value::Integer(timestamp_ms.into()),
        ),
        (Value::Text("digest".into()), Value::Text("SHA384".into())),
        (
            Value::Text("pcrs".into()),
            Value::Map(
                pcrs.iter()
                    .map(|(i, b)| {
                        (Value::Integer((*i as u64).into()), Value::Bytes(b.clone()))
                    })
                    .collect(),
            ),
        ),
        (
            Value::Text("certificate".into()),
            Value::Bytes(leaf_der.to_vec()),
        ),
        (
            Value::Text("cabundle".into()),
            // [root, intermediate] — root first, per AWS spec.
            Value::Array(vec![
                Value::Bytes(root_der.to_vec()),
                Value::Bytes(intermediate_der.to_vec()),
            ]),
        ),
        (Value::Text("public_key".into()), Value::Null),
        (
            Value::Text("user_data".into()),
            match user_data {
                Some(b) => Value::Bytes(b),
                None => Value::Null,
            },
        ),
        (Value::Text("nonce".into()), Value::Null),
    ];
    let _ = &mut payload_map;
    let value = Value::Map(payload_map);
    let mut out = Vec::new();
    ciborium::ser::into_writer(&value, &mut out).unwrap();
    out
}

fn wrap_cose(payload: &[u8], leaf_signer: &P384Sk) -> Vec<u8> {
    let protected = HeaderBuilder::new()
        .algorithm(iana::Algorithm::ES384)
        .build();
    let sign1 = CoseSign1Builder::new()
        .protected(protected)
        .payload(payload.to_vec())
        .create_signature(&[], |tbs| {
            let sig: P384Sig = leaf_signer.sign(tbs);
            // Nitro uses raw r||s fixed-width sig, NOT DER. p384's `to_bytes()`
            // gives r||s, 96 bytes.
            sig.to_bytes().to_vec()
        })
        .build();
    sign1.to_tagged_vec().unwrap()
}

/// Build a complete fake attestation document + the matching Ghola allowlist
/// signature. Returns (vendor_quote, allowlist_sig, allowlist_pub,
/// test_root_der, doc_timestamp_ms).
fn build_full(
    enclave_x25519: [u8; 32],
    enclave_ed25519: [u8; 32],
    pcrs_override: Option<Vec<(u32, Vec<u8>)>>,
    timestamp_ms: u64,
) -> (
    Vec<u8>,
    Vec<u8>,
    ed25519_dalek::VerifyingKey,
    Vec<u8>,
    Chain,
) {
    let chain = make_chain();

    let pcrs = pcrs_override.unwrap_or_else(|| {
        vec![
            (0u32, vec![0xAAu8; 48]),
            (1u32, vec![0xBBu8; 48]),
            (2u32, vec![0xCCu8; 48]),
        ]
    });
    let user_data = pack_user_data(&enclave_x25519, &enclave_ed25519, timestamp_ms as i64);

    let payload = build_cbor_payload(
        timestamp_ms,
        &pcrs,
        Some(user_data),
        &chain.leaf_der,
        &chain.intermediate_der,
        &chain.root_der,
    );
    let quote = wrap_cose(&payload, &chain.leaf_signer);

    // Allowlist signing.
    let mut csprng = rand::rngs::OsRng;
    let allowlist_sk = EdSigningKey::generate(&mut csprng);
    let allowlist_pk = allowlist_sk.verifying_key();
    let measurement: Vec<u8> = pcrs.iter().flat_map(|(_, b)| b.clone()).collect();
    let digest = measurement_digest(&measurement);
    let allowlist_sig = allowlist_sk.sign(&digest).to_bytes().to_vec();

    let root_der = chain.root_der.clone();
    (quote, allowlist_sig, allowlist_pk, root_der, chain)
}

#[test]
fn happy_path_verifies() {
    let x25519 = [0x11u8; 32];
    let ed25519 = [0x22u8; 32];
    let ts_ms: u64 = 1_700_000_000_000;
    let now = (ts_ms / 1000) as i64 + 30; // 30s after attestation

    let (quote, sig, pk, root, _chain) =
        build_full(x25519, ed25519, None, ts_ms);

    let attested = verify_attestation_with_root(&quote, &sig, &pk, TeeKind::Nitro, now, &root)
        .expect("happy path");

    assert_eq!(attested.enclave_x25519_pub, x25519);
    assert_eq!(attested.enclave_ed25519_pub, ed25519);
    assert_eq!(attested.tee_kind, TeeKind::Nitro);
    assert_eq!(attested.measurement.len(), 48 * 3);
    assert_eq!(attested.attested_at_unix, (ts_ms / 1000) as i64);
    assert_eq!(attested.expires_at_unix, attested.attested_at_unix + 86400);
    assert!(attested.provider_id.is_empty()); // caller fills

    // enclave_key_id = hex(sha256(x25519_pub))
    let mut h = Sha256::new();
    h.update(x25519);
    let want = hex::encode(h.finalize());
    assert_eq!(attested.enclave_key_id.0, want);
}

#[test]
fn tampered_measurement_fails_allowlist() {
    let x25519 = [0x11u8; 32];
    let ed25519 = [0x22u8; 32];
    let ts_ms: u64 = 1_700_000_000_000;
    let now = (ts_ms / 1000) as i64;

    // Build full with one set of PCRs, but the allowlist signed the
    // measurement of *different* PCRs (we'll mutate the chain to embed
    // PCRs that don't match what the allowlist key signed).
    let chain = make_chain();

    let real_pcrs = vec![
        (0u32, vec![0xAAu8; 48]),
        (1u32, vec![0xBBu8; 48]),
        (2u32, vec![0xCCu8; 48]),
    ];
    let user_data = pack_user_data(&x25519, &ed25519, ts_ms as i64);
    let payload = build_cbor_payload(
        ts_ms,
        &real_pcrs,
        Some(user_data),
        &chain.leaf_der,
        &chain.intermediate_der,
        &chain.root_der,
    );
    let quote = wrap_cose(&payload, &chain.leaf_signer);

    // Allowlist signed a different measurement.
    let mut csprng = rand::rngs::OsRng;
    let allowlist_sk = EdSigningKey::generate(&mut csprng);
    let allowlist_pk = allowlist_sk.verifying_key();
    let fake_measurement: Vec<u8> = vec![0u8; 48 * 3];
    let digest = measurement_digest(&fake_measurement);
    let allowlist_sig = allowlist_sk.sign(&digest).to_bytes().to_vec();

    let err = verify_attestation_with_root(
        &quote,
        &allowlist_sig,
        &allowlist_pk,
        TeeKind::Nitro,
        now,
        &chain.root_der,
    )
    .unwrap_err();
    assert!(matches!(err, AttestationError::AllowlistSig), "got: {err}");
}

#[test]
fn tampered_cose_signature_fails() {
    let x25519 = [0x11u8; 32];
    let ed25519 = [0x22u8; 32];
    let ts_ms: u64 = 1_700_000_000_000;
    let now = (ts_ms / 1000) as i64;

    let (mut quote, sig, pk, root, _chain) =
        build_full(x25519, ed25519, None, ts_ms);

    // Flip a byte deep inside the CBOR-encoded COSE blob — likely lands in
    // the signature field given the tail layout. Flipping the very last
    // byte deterministically lands in the trailing signature bytes.
    let len = quote.len();
    quote[len - 5] ^= 0xFF;

    let err = verify_attestation_with_root(
        &quote,
        &sig,
        &pk,
        TeeKind::Nitro,
        now,
        &root,
    )
    .unwrap_err();
    assert!(
        matches!(err, AttestationError::Signature | AttestationError::Cose(_)),
        "got: {err}"
    );
}

#[test]
fn tampered_cert_chain_fails() {
    let x25519 = [0x11u8; 32];
    let ed25519 = [0x22u8; 32];
    let ts_ms: u64 = 1_700_000_000_000;
    let now = (ts_ms / 1000) as i64;

    // Build a quote, but verify against a different root cert.
    let (quote, sig, pk, _real_root, _chain) =
        build_full(x25519, ed25519, None, ts_ms);

    let other_root = make_chain().root_der;
    let err = verify_attestation_with_root(
        &quote,
        &sig,
        &pk,
        TeeKind::Nitro,
        now,
        &other_root,
    )
    .unwrap_err();
    assert!(matches!(err, AttestationError::CertChain(_)), "got: {err}");
}

#[test]
fn missing_user_data_fails() {
    let ts_ms: u64 = 1_700_000_000_000;
    let now = (ts_ms / 1000) as i64;
    let chain = make_chain();
    let pcrs = vec![
        (0u32, vec![0xAAu8; 48]),
        (1u32, vec![0xBBu8; 48]),
        (2u32, vec![0xCCu8; 48]),
    ];
    let payload = build_cbor_payload(
        ts_ms,
        &pcrs,
        /* user_data = */ None,
        &chain.leaf_der,
        &chain.intermediate_der,
        &chain.root_der,
    );
    let quote = wrap_cose(&payload, &chain.leaf_signer);

    let mut csprng = rand::rngs::OsRng;
    let allowlist_sk = EdSigningKey::generate(&mut csprng);
    let allowlist_pk = allowlist_sk.verifying_key();
    let measurement: Vec<u8> = pcrs.iter().flat_map(|(_, b)| b.clone()).collect();
    let allowlist_sig = allowlist_sk
        .sign(&measurement_digest(&measurement))
        .to_bytes()
        .to_vec();

    let err = verify_attestation_with_root(
        &quote,
        &allowlist_sig,
        &allowlist_pk,
        TeeKind::Nitro,
        now,
        &chain.root_der,
    )
    .unwrap_err();
    assert!(matches!(err, AttestationError::UserDataMismatch), "got: {err}");
}

#[test]
fn missing_pcr_fails() {
    let ts_ms: u64 = 1_700_000_000_000;
    let now = (ts_ms / 1000) as i64;
    let chain = make_chain();
    // Only PCR0 and PCR1 — PCR2 missing.
    let pcrs = vec![
        (0u32, vec![0xAAu8; 48]),
        (1u32, vec![0xBBu8; 48]),
    ];
    let x25519 = [0x11u8; 32];
    let ed25519 = [0x22u8; 32];
    let user_data = pack_user_data(&x25519, &ed25519, ts_ms as i64);
    let payload = build_cbor_payload(
        ts_ms,
        &pcrs,
        Some(user_data),
        &chain.leaf_der,
        &chain.intermediate_der,
        &chain.root_der,
    );
    let quote = wrap_cose(&payload, &chain.leaf_signer);

    let mut csprng = rand::rngs::OsRng;
    let allowlist_sk = EdSigningKey::generate(&mut csprng);
    let allowlist_pk = allowlist_sk.verifying_key();
    let allowlist_sig = vec![0u8; 64];

    let err = verify_attestation_with_root(
        &quote,
        &allowlist_sig,
        &allowlist_pk,
        TeeKind::Nitro,
        now,
        &chain.root_der,
    )
    .unwrap_err();
    assert!(matches!(err, AttestationError::MissingPcr(2)), "got: {err}");
}

#[test]
fn expired_fails() {
    let x25519 = [0x11u8; 32];
    let ed25519 = [0x22u8; 32];
    let ts_ms: u64 = 1_700_000_000_000;
    // now is 25h after attestation
    let now = (ts_ms / 1000) as i64 + 25 * 3600;

    let (quote, sig, pk, root, _chain) =
        build_full(x25519, ed25519, None, ts_ms);

    let err =
        verify_attestation_with_root(&quote, &sig, &pk, TeeKind::Nitro, now, &root)
            .unwrap_err();
    assert!(matches!(err, AttestationError::Expired { .. }), "got: {err}");
}

#[test]
fn future_timestamp_fails() {
    let x25519 = [0x11u8; 32];
    let ed25519 = [0x22u8; 32];
    let ts_ms: u64 = 1_700_000_000_000;
    // now is 5 minutes BEFORE the doc claims it was made
    let now = (ts_ms / 1000) as i64 - 300;

    let (quote, sig, pk, root, _chain) =
        build_full(x25519, ed25519, None, ts_ms);

    let err =
        verify_attestation_with_root(&quote, &sig, &pk, TeeKind::Nitro, now, &root)
            .unwrap_err();
    assert!(matches!(err, AttestationError::FutureTimestamp), "got: {err}");
}

// ---- KMS-anchored measurement verification path ----

mod kms_path {
    use super::*;
    use p384::ecdsa::{signature::Signer as _, VerifyingKey as P384Vk};
    use sha2::Sha384;
    use said_attest::verify_attestation_with_root_and_kms;

    fn kms_sign(measurement: &[u8]) -> (Vec<u8>, P384Vk) {
        let sk = P384Sk::random(&mut rand::rngs::OsRng);
        let vk = *sk.verifying_key();
        let mut h = Sha384::new();
        h.update(measurement);
        let digest = h.finalize();
        let sig: P384Sig = sk.sign(&digest);
        (sig.to_der().as_bytes().to_vec(), vk)
    }

    #[test]
    fn happy_path_with_kms() {
        let x25519 = [0x11u8; 32];
        let ed25519 = [0x22u8; 32];
        let ts_ms: u64 = 1_700_000_000_000;
        let now = (ts_ms / 1000) as i64;

        let (quote, sig, pk, root, _chain) = build_full(x25519, ed25519, None, ts_ms);

        // KMS signs the same measurement (PCR0||PCR1||PCR2).
        let measurement: Vec<u8> = vec![
            vec![0xAAu8; 48],
            vec![0xBBu8; 48],
            vec![0xCCu8; 48],
        ]
        .concat();
        let (kms_sig, kms_pub) = kms_sign(&measurement);

        let attested = verify_attestation_with_root_and_kms(
            &quote, &sig, &pk, &kms_sig, &kms_pub, TeeKind::Nitro, now, &root,
        )
        .expect("happy path with KMS");
        assert_eq!(attested.enclave_x25519_pub, x25519);
    }

    #[test]
    fn tampered_kms_sig_fails() {
        let x25519 = [0x11u8; 32];
        let ed25519 = [0x22u8; 32];
        let ts_ms: u64 = 1_700_000_000_000;
        let now = (ts_ms / 1000) as i64;

        let (quote, sig, pk, root, _chain) = build_full(x25519, ed25519, None, ts_ms);
        let measurement: Vec<u8> = vec![
            vec![0xAAu8; 48],
            vec![0xBBu8; 48],
            vec![0xCCu8; 48],
        ]
        .concat();
        let (mut kms_sig, kms_pub) = kms_sign(&measurement);

        // Flip a byte in the middle of the sig (skip the DER header so
        // we still parse but verify-fail).
        let mid = kms_sig.len() / 2;
        kms_sig[mid] ^= 0xFF;

        let err = verify_attestation_with_root_and_kms(
            &quote, &sig, &pk, &kms_sig, &kms_pub, TeeKind::Nitro, now, &root,
        )
        .unwrap_err();
        assert!(matches!(err, AttestationError::KmsSig), "got: {err}");
    }

    #[test]
    fn wrong_kms_pubkey_fails() {
        let x25519 = [0x11u8; 32];
        let ed25519 = [0x22u8; 32];
        let ts_ms: u64 = 1_700_000_000_000;
        let now = (ts_ms / 1000) as i64;

        let (quote, sig, pk, root, _chain) = build_full(x25519, ed25519, None, ts_ms);
        let measurement: Vec<u8> = vec![
            vec![0xAAu8; 48],
            vec![0xBBu8; 48],
            vec![0xCCu8; 48],
        ]
        .concat();
        let (kms_sig, _kms_pub) = kms_sign(&measurement);
        // Verify with a *different* pubkey.
        let other_sk = P384Sk::random(&mut rand::rngs::OsRng);
        let other_vk = *other_sk.verifying_key();

        let err = verify_attestation_with_root_and_kms(
            &quote, &sig, &pk, &kms_sig, &other_vk, TeeKind::Nitro, now, &root,
        )
        .unwrap_err();
        assert!(matches!(err, AttestationError::KmsSig), "got: {err}");
    }

    #[test]
    fn kms_sig_over_different_measurement_fails() {
        let x25519 = [0x11u8; 32];
        let ed25519 = [0x22u8; 32];
        let ts_ms: u64 = 1_700_000_000_000;
        let now = (ts_ms / 1000) as i64;

        let (quote, sig, pk, root, _chain) = build_full(x25519, ed25519, None, ts_ms);
        // Sign a *different* measurement than the one PCRs encode.
        let fake_measurement: Vec<u8> = vec![0u8; 48 * 3];
        let (kms_sig, kms_pub) = kms_sign(&fake_measurement);

        let err = verify_attestation_with_root_and_kms(
            &quote, &sig, &pk, &kms_sig, &kms_pub, TeeKind::Nitro, now, &root,
        )
        .unwrap_err();
        assert!(matches!(err, AttestationError::KmsSig), "got: {err}");
    }
}

#[test]
fn unsupported_tee_kind_rejected() {
    let x25519 = [0x11u8; 32];
    let ed25519 = [0x22u8; 32];
    let ts_ms: u64 = 1_700_000_000_000;
    let now = (ts_ms / 1000) as i64;

    let (quote, sig, pk, root, _chain) =
        build_full(x25519, ed25519, None, ts_ms);

    let err =
        verify_attestation_with_root(&quote, &sig, &pk, TeeKind::Tdx, now, &root)
            .unwrap_err();
    assert!(matches!(err, AttestationError::UnsupportedTeeKind), "got: {err}");
}
