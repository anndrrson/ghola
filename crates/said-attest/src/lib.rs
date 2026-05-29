//! `said-attest` — AWS Nitro Enclave attestation verifier for Ghola.
//!
//! Public surface: [`verify_attestation`], which combines two independent
//! layers of verification:
//!
//! 1. **Vendor chain**: the Nitro attestation document is parsed
//!    ([`nitro::parse_and_verify`]) and its COSE_Sign1 signature is checked
//!    against the leaf certificate, whose chain is validated to the AWS
//!    Nitro Root G1 cert pinned in this crate's source.
//! 2. **Ghola allowlist**: an Ed25519 signature over
//!    `sha256(PCR0 || PCR1 || PCR2)` is verified against a Ghola-controlled
//!    public key. This is defense-in-depth — if the vendor cert chain is
//!    ever compromised, the allowlist still gates which measurements the
//!    relay will accept.
//!
//! The returned [`AttestedEnclave`] is suitable for insertion into the
//! relay's in-memory attested-providers map. Note: `provider_id` is left
//! empty by this crate; the caller (relay) fills it from the WebSocket
//! session that received the `ProviderAttest`.

pub mod allowlist;
pub mod h100;
pub mod kms;
pub mod nitro;
pub mod tdx;
pub mod types;

pub use h100::{verify_h100_cc, verify_h100_cc_with_root};
pub use tdx::{verify_tdx, verify_tdx_with_root};
pub use types::{AttestationError, AttestedEnclave, NitroAttestation};

use ed25519_dalek::VerifyingKey;
use ghola_assistant_types::{EnclaveKeyId, TeeKind};

use sha2::{Digest, Sha256};

/// How long a single attestation is honored before re-attestation is
/// required.
pub const ATTESTATION_TTL_SECS: i64 = 24 * 60 * 60;

/// Clock skew tolerance when binding `user_data` timestamp to the doc's
/// own timestamp, in milliseconds.
const USER_DATA_TS_SKEW_MS: i64 = 60_000;

/// Verify a vendor attestation document and the Ghola allowlist
/// signature over its measurement. Returns an [`AttestedEnclave`]
/// suitable for inserting into the relay's attested-providers map.
///
/// `now_unix` is injected so tests can mock time without a global clock.
///
/// `expected_tee_kind` must be [`TeeKind::Nitro`] for this verifier;
/// other TEEs are reserved for future modules.
pub fn verify_attestation(
    vendor_quote: &[u8],
    ghola_allowlist_sig: &[u8],
    ghola_allowlist_pub: &VerifyingKey,
    expected_tee_kind: TeeKind,
    now_unix: i64,
) -> Result<AttestedEnclave, AttestationError> {
    // TEE vendor dispatch — Nitro keeps the existing PCR-based path;
    // H100 CC and TDX route to their own verifier modules. The
    // three-vendor diversity matters because a single hardware vendor
    // would be a single point of compromise for the whole network
    // (Yahya's privacy thesis explicitly calls this out as the
    // structural moat).
    match expected_tee_kind {
        TeeKind::Nitro => verify_attestation_inner(
            vendor_quote,
            ghola_allowlist_sig,
            ghola_allowlist_pub,
            expected_tee_kind,
            now_unix,
            None,
            None,
        ),
        TeeKind::H100Cc => h100::verify_h100_cc(
            vendor_quote,
            ghola_allowlist_sig,
            ghola_allowlist_pub,
            expected_tee_kind,
            now_unix,
        ),
        TeeKind::Tdx => tdx::verify_tdx(
            vendor_quote,
            ghola_allowlist_sig,
            ghola_allowlist_pub,
            expected_tee_kind,
            now_unix,
        ),
        _ => Err(AttestationError::UnsupportedTeeKind),
    }
}

/// Variant that additionally verifies a KMS-anchored ECDSA P-384
/// signature over `sha384(PCR0||PCR1||PCR2)`. This is the production
/// path for Phase 1 of the v3.5 privacy rollout — both the offline
/// Ed25519 allowlist sig and the KMS-managed P-384 sig must verify
/// for the attestation to be accepted.
///
/// `kms_sig_bytes` accepts either DER-encoded (the KMS-native output)
/// or raw `r||s` (96 bytes) per [`kms::verify_measurement_kms_raw_or_der`].
pub fn verify_attestation_with_kms(
    vendor_quote: &[u8],
    ghola_allowlist_sig: &[u8],
    ghola_allowlist_pub: &VerifyingKey,
    kms_sig_bytes: &[u8],
    kms_pub: &p384::ecdsa::VerifyingKey,
    expected_tee_kind: TeeKind,
    now_unix: i64,
) -> Result<AttestedEnclave, AttestationError> {
    verify_attestation_inner(
        vendor_quote,
        ghola_allowlist_sig,
        ghola_allowlist_pub,
        expected_tee_kind,
        now_unix,
        None,
        Some((kms_sig_bytes, kms_pub)),
    )
}

/// Test-only variant that lets the caller substitute a custom root cert
/// for the pinned AWS Nitro Root G1. Real callers always use
/// [`verify_attestation`].
#[doc(hidden)]
pub fn verify_attestation_with_root(
    vendor_quote: &[u8],
    ghola_allowlist_sig: &[u8],
    ghola_allowlist_pub: &VerifyingKey,
    expected_tee_kind: TeeKind,
    now_unix: i64,
    test_root_der: &[u8],
) -> Result<AttestedEnclave, AttestationError> {
    verify_attestation_inner(
        vendor_quote,
        ghola_allowlist_sig,
        ghola_allowlist_pub,
        expected_tee_kind,
        now_unix,
        Some(test_root_der),
        None,
    )
}

/// Test-only variant that combines test root + KMS verification.
#[doc(hidden)]
pub fn verify_attestation_with_root_and_kms(
    vendor_quote: &[u8],
    ghola_allowlist_sig: &[u8],
    ghola_allowlist_pub: &VerifyingKey,
    kms_sig_bytes: &[u8],
    kms_pub: &p384::ecdsa::VerifyingKey,
    expected_tee_kind: TeeKind,
    now_unix: i64,
    test_root_der: &[u8],
) -> Result<AttestedEnclave, AttestationError> {
    verify_attestation_inner(
        vendor_quote,
        ghola_allowlist_sig,
        ghola_allowlist_pub,
        expected_tee_kind,
        now_unix,
        Some(test_root_der),
        Some((kms_sig_bytes, kms_pub)),
    )
}

fn verify_attestation_inner(
    vendor_quote: &[u8],
    ghola_allowlist_sig: &[u8],
    ghola_allowlist_pub: &VerifyingKey,
    expected_tee_kind: TeeKind,
    now_unix: i64,
    test_root_der: Option<&[u8]>,
    kms: Option<(&[u8], &p384::ecdsa::VerifyingKey)>,
) -> Result<AttestedEnclave, AttestationError> {
    if expected_tee_kind != TeeKind::Nitro {
        return Err(AttestationError::UnsupportedTeeKind);
    }

    // 1. Vendor chain + COSE signature.
    let doc = match test_root_der {
        Some(root) => nitro::parse_and_verify_with_root(vendor_quote, root)?,
        None => nitro::parse_and_verify(vendor_quote)?,
    };

    // 2. Measurement = PCR0 || PCR1 || PCR2 (in that order).
    let measurement = derive_measurement(&doc)?;

    // Temporary diagnostic: log the PCRs the NSM-issued attestation
    // doc actually contains. The allowlist sig check below has been
    // failing in production despite the build-side measurement_digest
    // matching the EIF metadata — this confirms whether the runtime
    // PCRs equal the metadata PCRs. Remove after Phase 1 ships.
    {
        let pcr_hex = |n: u32| {
            doc.pcrs
                .iter()
                .find(|(i, _)| *i == n)
                .map(|(_, b)| hex::encode(b))
                .unwrap_or_else(|| "<missing>".to_string())
        };
        let measurement_sha256_hex = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(&measurement);
            hex::encode(h.finalize())
        };
        eprintln!(
            "[said-attest] attestation doc PCRs (pre-allowlist-verify): pcr0={} pcr1={} pcr2={} measurement_sha256={}",
            pcr_hex(0),
            pcr_hex(1),
            pcr_hex(2),
            measurement_sha256_hex,
        );
        // ALSO log the sig + allowlist pub bytes the verifier is using, so
        // we can compare against what the operator signed locally. The
        // pubkey is non-secret; the sig is also non-secret (it's a
        // signature over a public hash, not a key).
        eprintln!(
            "[said-attest] allowlist inputs: sig_hex={} sig_len={} allowlist_pub_hex={}",
            hex::encode(ghola_allowlist_sig),
            ghola_allowlist_sig.len(),
            hex::encode(ghola_allowlist_pub.to_bytes()),
        );
    }

    // 3a. Allowlist signature over sha256(measurement).
    allowlist::verify_measurement(&measurement, ghola_allowlist_sig, ghola_allowlist_pub)?;

    // 3b. KMS signature over sha384(measurement), when provided.
    if let Some((sig_bytes, kms_pub)) = kms {
        kms::verify_measurement_kms_raw_or_der(&measurement, sig_bytes, kms_pub)?;
    }

    // 4. user_data bind: [x25519_pub (32)][ed25519_pub (32)][ts_ms_le (8)].
    let ud = doc
        .user_data
        .as_ref()
        .ok_or(AttestationError::UserDataMismatch)?;
    if ud.len() != 72 {
        return Err(AttestationError::UserDataMismatch);
    }
    let mut x25519_pub = [0u8; 32];
    x25519_pub.copy_from_slice(&ud[0..32]);
    let mut ed25519_pub = [0u8; 32];
    ed25519_pub.copy_from_slice(&ud[32..64]);
    let mut ts_buf = [0u8; 8];
    ts_buf.copy_from_slice(&ud[64..72]);
    let ud_ts_ms = i64::from_le_bytes(ts_buf);

    // Loose bind: the embedded ts must be within ±60s of the doc ts. This
    // catches replay across boots while tolerating clock skew between the
    // moment the enclave forms user_data and the moment the doc is signed.
    let doc_ts_ms = i64::try_from(doc.timestamp_ms)
        .map_err(|_| AttestationError::Internal("doc timestamp overflow".into()))?;
    if (ud_ts_ms - doc_ts_ms).abs() > USER_DATA_TS_SKEW_MS {
        return Err(AttestationError::UserDataMismatch);
    }

    // 5. Build EnclaveKeyId = hex(sha256(enclave_x25519_pub)).
    let mut hasher = Sha256::new();
    hasher.update(x25519_pub);
    let enclave_key_id = EnclaveKeyId(hex::encode(hasher.finalize()));

    // 6. Timing checks.
    let attested_at_unix = doc_ts_ms / 1000;
    let expires_at_unix = attested_at_unix + ATTESTATION_TTL_SECS;
    if attested_at_unix > now_unix + 60 {
        return Err(AttestationError::FutureTimestamp);
    }
    if now_unix > expires_at_unix {
        return Err(AttestationError::Expired {
            now: now_unix,
            ts: attested_at_unix,
        });
    }

    Ok(AttestedEnclave {
        provider_id: String::new(), // caller fills
        enclave_key_id,
        enclave_x25519_pub: x25519_pub,
        enclave_ed25519_pub: ed25519_pub,
        tee_kind: expected_tee_kind,
        measurement,
        attested_at_unix,
        expires_at_unix,
    })
}

/// Extract PCR0||PCR1||PCR2 from a decoded Nitro doc. Missing PCRs map to
/// [`AttestationError::MissingPcr`].
fn derive_measurement(doc: &NitroAttestation) -> Result<Vec<u8>, AttestationError> {
    let mut out = Vec::with_capacity(48 * 3);
    for n in 0u32..3 {
        let (_, digest) = doc
            .pcrs
            .iter()
            .find(|(i, _)| *i == n)
            .ok_or(AttestationError::MissingPcr(n))?;
        out.extend_from_slice(digest);
    }
    Ok(out)
}

/// Re-exported for tests + downstream tooling that wants to build the
/// same `[x25519 || ed25519 || ts_le_i64]` user_data payload that
/// [`verify_attestation`] expects.
pub fn pack_user_data(
    x25519_pub: &[u8; 32],
    ed25519_pub: &[u8; 32],
    timestamp_ms: i64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(72);
    out.extend_from_slice(x25519_pub);
    out.extend_from_slice(ed25519_pub);
    out.extend_from_slice(&timestamp_ms.to_le_bytes());
    out
}

/// Compute `sha256(PCR0||PCR1||PCR2)` for an allowlist signer to sign
/// offline.
pub fn measurement_digest(measurement: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(measurement);
    let out = h.finalize();
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&out);
    digest
}
