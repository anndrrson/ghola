//! Intel TDX (Trust Domain Extensions) attestation verifier.
//!
//! Threat-model rationale (TEE vendor diversity):
//! The relay's peak-security plan calls for accepting inference enclaves
//! from *more than one* hardware vendor. AWS Nitro is the original
//! verifier (`nitro.rs`); NVIDIA H100 CC is the second (`h100.rs`); Intel
//! TDX is the natural third leg — it covers the CPU-side TEE market the
//! same way H100 covers the GPU side, and it roots in a completely
//! independent vendor PKI (Intel SGX/DCAP, with Provisioning Certification
//! Service certs chained to Intel's root CA). If an attacker breaks
//! AWS's Nitro chain *and* NVIDIA's NRAS chain, they still have to break
//! Intel's DCAP chain to subvert the network. Three unrelated vendors is
//! the smallest sane committee for a privacy-first product where a single
//! compromise leaks every user's chat in one shot.
//!
//! Attestation format:
//! On a real TDX node the CPU produces a "TDQuote" — a binary structure
//! defined by Intel in the SGX/DCAP specification. The TDQuote contains:
//!   * `MRTD` — the launch measurement of the trust domain (analogue of
//!     a Nitro PCR0 / H100 firmware-measurement claim)
//!   * `RTMR0..3` — four runtime-measurement registers extended by the
//!     TD's bootloader, kernel, and runtime (analogues of PCR1..PCRn)
//!   * `TD_ATTRIBUTES` — 8-byte feature mask; bit 0 (`DEBUG`) MUST be
//!     zero in production. Other bits gate SEPT veridicality, KSL, etc.
//!   * `XFAM` — extended-feature mask (XSAVE-state subset enabled in the
//!     guest)
//!   * `REPORT_DATA` — 64-byte caller-supplied blob. Like Nitro
//!     `user_data`, we bind enclave keys + timestamp here.
//! The TDQuote is signed by an Intel-provisioned attestation key (ECDSA
//! P-256), and the signing key's cert chains via PCK / PCS to Intel's
//! pinned SGX Root CA.
//!
//! This module hand-parses a JSON-wrapped TDQuote claims envelope — the
//! same shape h100.rs uses for its NRAS-stand-in JWT — so CI can exercise
//! the verifier without an actual TDX-capable host or Intel PCS access.
//! The wire format mirrors the requested schema:
//!   {
//!     "tdx_module_version": "1.5",
//!     "td_attributes":     "0000000000000000",   // hex of u64 LE
//!     "xfam":              "<hex of u64 LE>",
//!     "mrtd":              "<hex>",
//!     "rtmr0":             "<hex>",
//!     "rtmr1":             "<hex>",
//!     "rtmr2":             "<hex>",
//!     "rtmr3":             "<hex>",
//!     "report_data":       "<hex>",
//!     "signature_alg":     "ed25519",
//!     "iat":               <unix>,
//!     "exp":               <unix>,
//!     "enclave_x25519_pub_hex": "<hex>",
//!     "enclave_ed25519_pub_hex": "<hex>",
//!     "signature":         "<base64>"            // signs every other field
//!   }
//! We verify the signature with `ed25519-dalek` against a root public key
//! supplied by the operator via `THUMPER_INTEL_TDX_ROOT_PEM` — same
//! env-var contract h100.rs uses for NRAS.

// TODO(tdx-prod): everything in this module is feature-flagged for a
// synthetic, single-key signing path (Ed25519 over the canonical claims
// body). Moving to production requires:
//   1. Replace the Ed25519 root with Intel's actual DCAP PCK chain. The
//      real TDQuote signing key is an ECDSA-P-256 key whose cert chains
//      via the Provisioning Certification Service (PCS) to Intel's SGX
//      Root CA. Wire that up via `x509-cert` + `p256` exactly like
//      nitro.rs does for the AWS root.
//   2. Replace the env-var-supplied root with a pinned Intel SGX Root CA
//      PEM compiled into this crate's source (with "valid from / to"
//      comments, mirroring `NITRO_ROOT_PEM`).
//   3. Switch the wire format from this JSON-wrapped envelope to the
//      actual binary TDQuote layout (per Intel's `Quote V4` spec —
//      header(48B) || td_report(584B) || sig_data(variable)). Parse
//      with `bytes` + a small structured-binary helper; keep the
//      `xfam`/`td_attributes`/`mrtd`/`rtmr*` semantics the same so the
//      allowlist contract doesn't change.
//   4. Implement the `td_attributes` bit-level checks beyond DEBUG=0:
//      SEPT_VE_DISABLE (bit 28) MUST be set on production silicon to
//      prevent the guest from observing #VE injection from the host;
//      KEY_LOCKER (bit 26) gates AES key locker access; etc. The Intel
//      "TDX Module Base Spec v1.5" Table 3.16 is the authority.
//   5. Tighten the `xfam` policy. Today we accept any non-zero value as
//      a stub. Production should pin XFAM to a Ghola-approved superset
//      so the relay refuses TDs that, e.g., enable an XSAVE feature
//      area we haven't audited side-channel behaviour for.
//   6. Implement an allowlist over `MRTD || RTMR0..3` signed by the
//      same Ghola offline Ed25519 key used for Nitro PCRs — so a
//      single, vendor-independent allowlist gates which TD firmware /
//      kernel / runtime combinations the relay will accept. (The
//      `verify_tdx_inner` already wires the Ed25519 allowlist sig over
//      sha256(measurement); the production cut-over only changes how
//      the measurement is reconstructed.)
//   7. Add a relay-chosen nonce in REPORT_DATA so the TDQuote is bound
//      to a challenge from the relay, not just a freshness timestamp.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use thumper_types::{EnclaveKeyId, TeeKind};

use crate::{AttestationError, AttestedEnclave, ATTESTATION_TTL_SECS};

/// Subset of TDX claims this verifier validates.
///
/// A real TDQuote has many more fields (cf. Intel "Quote V4" structure,
/// Appendix A of the DCAP API spec). We pin the security-relevant ones;
/// fields not listed here are intentionally not trusted by this module.
///
/// `signature` covers the *canonical* JSON serialization of this struct
/// with the `signature` field removed (see [`canonical_body_for_sig`]).
#[derive(Debug, Deserialize, Serialize)]
struct TdxClaims {
    /// Intel TDX-module version string, e.g. `"1.5"`. Informational
    /// (the production verifier will additionally check that the
    /// version is on the operator-blessed list).
    #[serde(default)]
    #[allow(dead_code)]
    tdx_module_version: String,
    /// Hex of the 8-byte `TD_ATTRIBUTES` field. Bit 0 is `DEBUG`; we
    /// reject any quote with DEBUG=1.
    td_attributes: String,
    /// Hex of the 8-byte `XFAM` field. Must be non-zero (stub — see
    /// `TODO(tdx-prod)` step 5).
    xfam: String,
    /// Hex of the launch measurement (MRTD), typically 48 bytes
    /// (SHA-384).
    mrtd: String,
    /// Hex of runtime measurement register 0.
    rtmr0: String,
    /// Hex of runtime measurement register 1.
    rtmr1: String,
    /// Hex of runtime measurement register 2.
    rtmr2: String,
    /// Hex of runtime measurement register 3.
    rtmr3: String,
    /// Hex of the 64-byte REPORT_DATA. Reserved for nonce binding in
    /// the production cut-over.
    #[serde(default)]
    #[allow(dead_code)]
    report_data: String,
    /// Algorithm tag — we only honour `"ed25519"` in the synthetic
    /// path; production accepts `"ecdsa_p256_sha256"` (Intel's quote
    /// signing key type).
    signature_alg: String,
    /// Issued-at, seconds-since-epoch.
    iat: i64,
    /// Expiry, seconds-since-epoch.
    exp: i64,
    /// Hex of the enclave X25519 public key. Binds the quote to the keys
    /// the relay will seal requests to.
    enclave_x25519_pub_hex: String,
    /// Hex of the enclave Ed25519 public key.
    enclave_ed25519_pub_hex: String,
    /// Base64 (standard, with padding) of the signature over the
    /// canonical claims body.
    signature: String,
}

/// Operator-controlled trusted root for TDX quotes.
///
/// On a production node this returns the Intel PCS-issued attestation
/// signing key (after validating an Intel-rooted chain — see the
/// `TODO(tdx-prod)` block). For now we accept a 32-byte Ed25519 public
/// key, hex-encoded, supplied via `THUMPER_INTEL_TDX_ROOT_PEM`. The env
/// var name retains the future PEM shape so the contract doesn't change
/// when we cut over.
///
/// CI default: when unset, the verifier refuses every quote — the relay
/// must explicitly trust a key. This is the same fail-closed posture as
/// `THUMPER_NVIDIA_NRAS_ROOT_PEM` in the H100 path.
pub fn tdx_root_pub_from_env() -> Option<VerifyingKey> {
    let raw = std::env::var("THUMPER_INTEL_TDX_ROOT_PEM").ok()?;
    let trimmed = raw.trim();
    // Tolerate the hex-only short form (32 bytes) we use in CI. A real
    // PEM-encoded key path is handled by the TODO(tdx-prod) production
    // cut-over; the env var name is shared so operators configure the
    // same secret on both sides.
    let bytes = hex::decode(trimmed).ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&arr).ok()
}

/// The signature_alg string this verifier currently accepts.
pub const EXPECTED_SIG_ALG: &str = "ed25519";

/// Verify an Intel TDX attestation envelope and return an
/// `AttestedEnclave`. See the module-level docs for the threat model.
///
/// `vendor_quote` is the JSON-wrapped TDX claims envelope (as bytes; the
/// provider base64-wraps it on the wire, the relay base64-decodes before
/// calling us).
///
/// `ghola_allowlist_sig` + `ghola_allowlist_pub` provide the same
/// defense-in-depth as the Nitro + H100 paths: an Ed25519 signature over
/// `sha256(MRTD || RTMR0 || RTMR1 || RTMR2 || RTMR3)` by a
/// Ghola-controlled offline key.
pub fn verify_tdx(
    vendor_quote: &[u8],
    ghola_allowlist_sig: &[u8],
    ghola_allowlist_pub: &VerifyingKey,
    expected_tee_kind: TeeKind,
    now_unix: i64,
) -> Result<AttestedEnclave, AttestationError> {
    verify_tdx_inner(
        vendor_quote,
        ghola_allowlist_sig,
        ghola_allowlist_pub,
        expected_tee_kind,
        now_unix,
        /* override_root = */ None,
    )
}

/// Test-only variant that lets the caller substitute a custom TDX root
/// public key, bypassing the env var. Real callers use [`verify_tdx`].
#[doc(hidden)]
pub fn verify_tdx_with_root(
    vendor_quote: &[u8],
    ghola_allowlist_sig: &[u8],
    ghola_allowlist_pub: &VerifyingKey,
    expected_tee_kind: TeeKind,
    now_unix: i64,
    test_root_pub: &VerifyingKey,
) -> Result<AttestedEnclave, AttestationError> {
    verify_tdx_inner(
        vendor_quote,
        ghola_allowlist_sig,
        ghola_allowlist_pub,
        expected_tee_kind,
        now_unix,
        Some(*test_root_pub),
    )
}

fn verify_tdx_inner(
    vendor_quote: &[u8],
    ghola_allowlist_sig: &[u8],
    ghola_allowlist_pub: &VerifyingKey,
    expected_tee_kind: TeeKind,
    now_unix: i64,
    override_root: Option<VerifyingKey>,
) -> Result<AttestedEnclave, AttestationError> {
    if expected_tee_kind != TeeKind::Tdx {
        return Err(AttestationError::UnsupportedTeeKind);
    }

    let tdx_root = match override_root {
        Some(pk) => pk,
        None => tdx_root_pub_from_env().ok_or_else(|| {
            AttestationError::CertChain(
                "THUMPER_INTEL_TDX_ROOT_PEM unset; refusing TDX attestation".into(),
            )
        })?,
    };

    // 1. Parse the JSON envelope.
    let claims: TdxClaims = serde_json::from_slice(vendor_quote)
        .map_err(|e| AttestationError::Cbor(format!("TDX claims json: {e}")))?;

    // 2. Algorithm check. We only honour ed25519 today; the
    // TODO(tdx-prod) block tracks adding ECDSA-P-256 for production.
    if claims.signature_alg != EXPECTED_SIG_ALG {
        return Err(AttestationError::Cose(format!(
            "unsupported TDX signature_alg {} (only ed25519 accepted in the synthetic path)",
            claims.signature_alg
        )));
    }

    // 3. Verify the quote signature against the TDX root key. In the
    // production cut-over this becomes "verify against the Intel
    // PCS-issued leaf, then validate the chain back to the pinned
    // Intel SGX Root CA".
    let signing_input = canonical_body_for_sig(&claims)
        .map_err(|e| AttestationError::Cbor(format!("TDX canonical body: {e}")))?;
    use base64::Engine;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(claims.signature.as_bytes())
        .map_err(|e| AttestationError::Cose(format!("TDX signature base64: {e}")))?;
    let sig_arr: [u8; 64] = sig_bytes
        .as_slice()
        .try_into()
        .map_err(|_| AttestationError::Signature)?;
    let sig = Signature::from_bytes(&sig_arr);
    tdx_root
        .verify(signing_input.as_bytes(), &sig)
        .map_err(|_| AttestationError::Signature)?;

    // 4. Claim checks (fail-closed: every assertion must pass).
    //
    // 4a. td_attributes DEBUG bit must be zero. The hex string encodes
    // the 8 raw bytes of TD_ATTRIBUTES; bit 0 of byte 0 is DEBUG. We
    // parse the full u64 (little-endian, matching Intel's wire layout)
    // so future bit-level checks can be added without reshaping.
    let td_attrs = parse_u64_hex_le(&claims.td_attributes)
        .ok_or_else(|| AttestationError::CertChain("td_attributes not 8-byte hex".into()))?;
    if (td_attrs & 0x1) != 0 {
        return Err(AttestationError::CertChain(format!(
            "TD is in DEBUG mode (td_attributes={:#x})",
            td_attrs
        )));
    }

    // 4b. xfam must be non-zero. STUB — see TODO(tdx-prod) step 5.
    let xfam = parse_u64_hex_le(&claims.xfam)
        .ok_or_else(|| AttestationError::CertChain("xfam not 8-byte hex".into()))?;
    if xfam == 0 {
        return Err(AttestationError::CertChain(
            "xfam is zero (no XSAVE features enabled — quote likely synthetic noise)".into(),
        ));
    }

    // 5. Time checks. Allow ±60s skew, same tolerance as Nitro + H100.
    if claims.iat > now_unix + 60 {
        return Err(AttestationError::FutureTimestamp);
    }
    if now_unix > claims.exp {
        return Err(AttestationError::Expired {
            now: now_unix,
            ts: claims.iat,
        });
    }

    // 6. Reconstruct the measurement: MRTD || RTMR0 || RTMR1 || RTMR2 ||
    // RTMR3. This is the TDX analogue of `PCR0 || PCR1 || PCR2` in
    // Nitro.
    let mut measurement: Vec<u8> = Vec::with_capacity(48 * 5);
    for (i, hex_str) in [
        &claims.mrtd,
        &claims.rtmr0,
        &claims.rtmr1,
        &claims.rtmr2,
        &claims.rtmr3,
    ]
    .iter()
    .enumerate()
    {
        let chunk = hex::decode(hex_str.trim()).map_err(|_| {
            AttestationError::Internal(format!("TDX measurement slot {i} not hex"))
        })?;
        if chunk.is_empty() {
            return Err(AttestationError::MissingPcr(i as u32));
        }
        measurement.extend_from_slice(&chunk);
    }

    // 7. Defense-in-depth allowlist: Ed25519 signature over
    // sha256(measurement) by the Ghola offline key. Identical contract
    // to the Nitro + H100 paths so the operator workflow is unified.
    let allowlist_sig_arr: [u8; 64] = ghola_allowlist_sig
        .try_into()
        .map_err(|_| AttestationError::AllowlistSig)?;
    let allowlist_sig = Signature::from_bytes(&allowlist_sig_arr);
    let mut hasher = Sha256::new();
    hasher.update(&measurement);
    let digest = hasher.finalize();
    ghola_allowlist_pub
        .verify(&digest, &allowlist_sig)
        .map_err(|_| AttestationError::AllowlistSig)?;

    // 8. Bind the enclave keys carried by the claims to the same shape
    // the relay uses for Nitro + H100.
    let x25519_pub = parse_pub32_hex(&claims.enclave_x25519_pub_hex)
        .ok_or(AttestationError::UserDataMismatch)?;
    let ed25519_pub = parse_pub32_hex(&claims.enclave_ed25519_pub_hex)
        .ok_or(AttestationError::UserDataMismatch)?;

    // 9. Build EnclaveKeyId = hex(sha256(x25519_pub)), matching Nitro.
    let mut h = Sha256::new();
    h.update(x25519_pub);
    let enclave_key_id = EnclaveKeyId(hex::encode(h.finalize()));

    let attested_at_unix = claims.iat;
    let expires_at_unix = attested_at_unix + ATTESTATION_TTL_SECS;

    Ok(AttestedEnclave {
        provider_id: String::new(), // caller fills
        enclave_key_id,
        enclave_x25519_pub: x25519_pub,
        enclave_ed25519_pub: ed25519_pub,
        tee_kind: TeeKind::Tdx,
        measurement,
        attested_at_unix,
        expires_at_unix,
    })
}

fn parse_pub32_hex(s: &str) -> Option<[u8; 32]> {
    let bytes = hex::decode(s.trim()).ok()?;
    bytes.try_into().ok()
}

/// Parse a hex string into a `u64` interpreted as little-endian raw
/// bytes (matching the on-wire layout of `TD_ATTRIBUTES` / `XFAM` in a
/// real TDQuote). The string MUST be exactly 16 hex chars = 8 bytes.
fn parse_u64_hex_le(s: &str) -> Option<u64> {
    let bytes = hex::decode(s.trim()).ok()?;
    if bytes.len() != 8 {
        return None;
    }
    let arr: [u8; 8] = bytes.try_into().ok()?;
    Some(u64::from_le_bytes(arr))
}

/// Build the canonical signing input for the TDX claims envelope.
///
/// We re-serialize the claims via `serde_json` with the `signature`
/// field set to an empty string, so producer + verifier agree on byte
/// layout. Field order is fixed by the struct definition (`serde_json`
/// preserves declaration order for structs, which is the contract we
/// rely on here; the synthesizer in tests uses the same struct so
/// there's no schema drift surface).
fn canonical_body_for_sig(claims: &TdxClaims) -> Result<String, serde_json::Error> {
    let stripped = TdxClaims {
        tdx_module_version: claims.tdx_module_version.clone(),
        td_attributes: claims.td_attributes.clone(),
        xfam: claims.xfam.clone(),
        mrtd: claims.mrtd.clone(),
        rtmr0: claims.rtmr0.clone(),
        rtmr1: claims.rtmr1.clone(),
        rtmr2: claims.rtmr2.clone(),
        rtmr3: claims.rtmr3.clone(),
        report_data: claims.report_data.clone(),
        signature_alg: claims.signature_alg.clone(),
        iat: claims.iat,
        exp: claims.exp,
        enclave_x25519_pub_hex: claims.enclave_x25519_pub_hex.clone(),
        enclave_ed25519_pub_hex: claims.enclave_ed25519_pub_hex.clone(),
        signature: String::new(),
    };
    serde_json::to_string(&stripped)
}

/// Helper exposed for fixture-builders (tests + the synthetic provider
/// path): build a signed TDX claims envelope from raw inputs.
#[doc(hidden)]
pub fn build_synthetic_tdx_quote(
    signing_key: &ed25519_dalek::SigningKey,
    tdx_module_version: &str,
    td_attributes_hex: &str,
    xfam_hex: &str,
    mrtd_hex: &str,
    rtmr0_hex: &str,
    rtmr1_hex: &str,
    rtmr2_hex: &str,
    rtmr3_hex: &str,
    report_data_hex: &str,
    iat: i64,
    exp: i64,
    enclave_x25519_pub_hex: &str,
    enclave_ed25519_pub_hex: &str,
) -> String {
    use ed25519_dalek::Signer;
    let claims = TdxClaims {
        tdx_module_version: tdx_module_version.to_string(),
        td_attributes: td_attributes_hex.to_string(),
        xfam: xfam_hex.to_string(),
        mrtd: mrtd_hex.to_string(),
        rtmr0: rtmr0_hex.to_string(),
        rtmr1: rtmr1_hex.to_string(),
        rtmr2: rtmr2_hex.to_string(),
        rtmr3: rtmr3_hex.to_string(),
        report_data: report_data_hex.to_string(),
        signature_alg: EXPECTED_SIG_ALG.to_string(),
        iat,
        exp,
        enclave_x25519_pub_hex: enclave_x25519_pub_hex.to_string(),
        enclave_ed25519_pub_hex: enclave_ed25519_pub_hex.to_string(),
        signature: String::new(),
    };
    let signing_input = canonical_body_for_sig(&claims).expect("synth canonical body");
    let sig = signing_key.sign(signing_input.as_bytes());
    use base64::Engine;
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
    let signed = TdxClaims {
        signature: sig_b64,
        ..claims
    };
    serde_json::to_string(&signed).expect("synth final body")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    fn synth_quote(
        signing_key: &SigningKey,
        td_attributes_hex: &str,
        xfam_hex: &str,
        iat: i64,
        exp: i64,
        mrtd_hex: &str,
        x25519_hex: &str,
        ed25519_hex: &str,
    ) -> String {
        build_synthetic_tdx_quote(
            signing_key,
            "1.5",
            td_attributes_hex,
            xfam_hex,
            mrtd_hex,
            &hex::encode([0x01u8; 48]),
            &hex::encode([0x02u8; 48]),
            &hex::encode([0x03u8; 48]),
            &hex::encode([0x04u8; 48]),
            &hex::encode([0u8; 64]),
            iat,
            exp,
            x25519_hex,
            ed25519_hex,
        )
    }

    fn make_allowlist_sig(measurement: &[u8], sk: &SigningKey) -> Vec<u8> {
        let mut h = Sha256::new();
        h.update(measurement);
        let digest = h.finalize();
        sk.sign(&digest).to_bytes().to_vec()
    }

    /// Concatenate the same measurement bytes the verifier rebuilds
    /// from MRTD || RTMR0..3 — used by tests to compute the allowlist
    /// digest against the same fixture.
    fn synth_measurement(mrtd: &[u8; 48]) -> Vec<u8> {
        let mut m = Vec::with_capacity(48 * 5);
        m.extend_from_slice(mrtd);
        m.extend_from_slice(&[0x01u8; 48]);
        m.extend_from_slice(&[0x02u8; 48]);
        m.extend_from_slice(&[0x03u8; 48]);
        m.extend_from_slice(&[0x04u8; 48]);
        m
    }

    #[test]
    fn happy_path_accepts_well_formed_quote() {
        let tdx_sk = SigningKey::generate(&mut OsRng);
        let allow_sk = SigningKey::generate(&mut OsRng);
        let mrtd_bytes = [0xaau8; 48];
        let measurement = synth_measurement(&mrtd_bytes);
        let x25519_hex = hex::encode([0x22u8; 32]);
        let ed25519_hex = hex::encode([0x33u8; 32]);

        let now = 1_700_000_000;
        let quote = synth_quote(
            &tdx_sk,
            "0000000000000000", // td_attributes: DEBUG=0
            "0700000000000000", // xfam: bits 0..2 set (FP|SSE|AVX), non-zero
            now - 5,
            now + 600,
            &hex::encode(mrtd_bytes),
            &x25519_hex,
            &ed25519_hex,
        );
        let allow_sig = make_allowlist_sig(&measurement, &allow_sk);
        let enc = verify_tdx_with_root(
            quote.as_bytes(),
            &allow_sig,
            &allow_sk.verifying_key(),
            TeeKind::Tdx,
            now,
            &tdx_sk.verifying_key(),
        )
        .expect("happy path");

        assert_eq!(enc.tee_kind, TeeKind::Tdx);
        assert_eq!(enc.measurement, measurement);
        assert_eq!(enc.attested_at_unix, now - 5);
    }

    #[test]
    fn debug_mode_is_rejected() {
        let tdx_sk = SigningKey::generate(&mut OsRng);
        let allow_sk = SigningKey::generate(&mut OsRng);
        let mrtd_bytes = [0xaau8; 48];
        let measurement = synth_measurement(&mrtd_bytes);
        let now = 1_700_000_000;
        let quote = synth_quote(
            &tdx_sk,
            "0100000000000000", // td_attributes: DEBUG=1 (bit 0 of byte 0)
            "0700000000000000",
            now - 5,
            now + 600,
            &hex::encode(mrtd_bytes),
            &hex::encode([0x22u8; 32]),
            &hex::encode([0x33u8; 32]),
        );
        let allow_sig = make_allowlist_sig(&measurement, &allow_sk);
        let err = verify_tdx_with_root(
            quote.as_bytes(),
            &allow_sig,
            &allow_sk.verifying_key(),
            TeeKind::Tdx,
            now,
            &tdx_sk.verifying_key(),
        )
        .unwrap_err();
        assert!(matches!(err, AttestationError::CertChain(_)));
    }

    #[test]
    fn expired_quote_is_rejected() {
        let tdx_sk = SigningKey::generate(&mut OsRng);
        let allow_sk = SigningKey::generate(&mut OsRng);
        let mrtd_bytes = [0xaau8; 48];
        let measurement = synth_measurement(&mrtd_bytes);
        let now = 1_700_000_000;
        let quote = synth_quote(
            &tdx_sk,
            "0000000000000000",
            "0700000000000000",
            now - 10_000,
            now - 1, // expired one second ago
            &hex::encode(mrtd_bytes),
            &hex::encode([0x22u8; 32]),
            &hex::encode([0x33u8; 32]),
        );
        let allow_sig = make_allowlist_sig(&measurement, &allow_sk);
        let err = verify_tdx_with_root(
            quote.as_bytes(),
            &allow_sig,
            &allow_sk.verifying_key(),
            TeeKind::Tdx,
            now,
            &tdx_sk.verifying_key(),
        )
        .unwrap_err();
        assert!(matches!(err, AttestationError::Expired { .. }));
    }

    #[test]
    fn wrong_root_key_is_rejected() {
        let tdx_sk = SigningKey::generate(&mut OsRng);
        let other_sk = SigningKey::generate(&mut OsRng);
        let allow_sk = SigningKey::generate(&mut OsRng);
        let mrtd_bytes = [0xaau8; 48];
        let measurement = synth_measurement(&mrtd_bytes);
        let now = 1_700_000_000;
        // Sign with `other_sk` but verify against `tdx_sk` — must fail.
        let quote = synth_quote(
            &other_sk,
            "0000000000000000",
            "0700000000000000",
            now - 5,
            now + 600,
            &hex::encode(mrtd_bytes),
            &hex::encode([0x22u8; 32]),
            &hex::encode([0x33u8; 32]),
        );
        let allow_sig = make_allowlist_sig(&measurement, &allow_sk);
        let err = verify_tdx_with_root(
            quote.as_bytes(),
            &allow_sig,
            &allow_sk.verifying_key(),
            TeeKind::Tdx,
            now,
            &tdx_sk.verifying_key(),
        )
        .unwrap_err();
        assert!(matches!(err, AttestationError::Signature));
    }

    #[test]
    fn bad_allowlist_sig_is_rejected() {
        let tdx_sk = SigningKey::generate(&mut OsRng);
        let allow_sk = SigningKey::generate(&mut OsRng);
        let other_allow_sk = SigningKey::generate(&mut OsRng);
        let mrtd_bytes = [0xaau8; 48];
        let measurement = synth_measurement(&mrtd_bytes);
        let now = 1_700_000_000;
        let quote = synth_quote(
            &tdx_sk,
            "0000000000000000",
            "0700000000000000",
            now - 5,
            now + 600,
            &hex::encode(mrtd_bytes),
            &hex::encode([0x22u8; 32]),
            &hex::encode([0x33u8; 32]),
        );
        // Sign with the wrong allowlist key.
        let bad_sig = make_allowlist_sig(&measurement, &other_allow_sk);
        let err = verify_tdx_with_root(
            quote.as_bytes(),
            &bad_sig,
            &allow_sk.verifying_key(),
            TeeKind::Tdx,
            now,
            &tdx_sk.verifying_key(),
        )
        .unwrap_err();
        assert!(matches!(err, AttestationError::AllowlistSig));
    }
}
