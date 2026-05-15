//! NVIDIA H100 Confidential Compute attestation verifier.
//!
//! Threat-model rationale (TEE vendor diversity):
//! The relay's peak-security plan calls for accepting inference enclaves
//! from *more than one* hardware vendor. If we only trust AWS Nitro, a
//! single root-of-trust compromise (cert exfil, microcode break,
//! supply-chain attack on the Nitro hypervisor) collapses the whole
//! privacy guarantee for every user in one shot. By admitting H100 CC
//! enclaves under an independent vendor chain (NVIDIA NRAS, rooted in
//! NVIDIA's own attestation PKI), an attacker has to break two
//! unrelated vendors to subvert the network. This module is the second
//! independent verifier; future modules (`tdx.rs`, `phala.rs`) add more.
//!
//! Attestation format:
//! On a real H100 CC node the GPU produces a "GPU evidence" blob signed
//! by the GPU's attestation key; the provider forwards that blob to
//! NVIDIA's Remote Attestation Service (NRAS), which returns a JWT
//! whose claims summarise:
//!   * `nonce` — replay defense
//!   * `measres` — array of measurement claims (firmware, driver, CC
//!     mode, VBIOS) — these are the H100 analogue of Nitro PCRs
//!   * `secboot` / `dbgstat` / `ccmode` — must be `enabled` / `disabled`
//!     / `on` respectively
//!   * `x-nvidia-overall-att-result` — must be `true`
//! The JWT is signed by NVIDIA's NRAS leaf, whose chain roots in a
//! pinned NVIDIA root CA. The wire format is the IETF JWT:
//!   `base64url(header).base64url(payload).base64url(signature)`
//!
//! This module hand-parses the JWT (we deliberately avoid pulling in a
//! `jsonwebtoken` crate to keep the platform-tools rustc 1.75 build
//! lane tidy). We verify the signature with `ed25519-dalek` against a
//! root public key supplied by the operator via the env var
//! `THUMPER_NVIDIA_NRAS_ROOT_PEM`.

// TODO(h100-prod): everything in this module is feature-flagged for a
// synthetic, single-key signing path (Ed25519 over the JWT signing
// input). Moving to production requires:
//   1. Replace the Ed25519 root with NVIDIA's actual NRAS root chain.
//      NRAS leaves are RSA-2048 / ECDSA-P-384 today (per NVIDIA's
//      published attestation docs as of 2026-Q1) — wire those up via
//      `x509-cert` + `p384`/`rsa` exactly like nitro.rs does for the
//      AWS root.
//   2. Replace the env-var-supplied root with a pinned NVIDIA root PEM
//      compiled into this crate's source (with a "valid from / to"
//      comment, mirroring `NITRO_ROOT_PEM`).
//   3. Verify the JWT's `x5c` header chain to that pinned root.
//   4. Implement an allowlist over the H100 `measres` array, signed by
//      the same Ghola offline Ed25519 key used for Nitro PCRs — so a
//      single, vendor-independent allowlist gates which firmware /
//      driver / VBIOS combinations the relay will accept.
//   5. Add NRAS nonce challenge/response so the provider-side blob is
//      bound to a relay-chosen nonce (today we only check timestamp
//      freshness via the JWT `iat` claim).

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use thumper_types::{EnclaveKeyId, TeeKind};

use crate::{AttestationError, AttestedEnclave, ATTESTATION_TTL_SECS};

/// JOSE header. Only the fields we currently inspect are present; the
/// real NVIDIA JWT also carries `x5c` (cert chain) and `kid`.
#[derive(Debug, Deserialize)]
struct JwtHeader {
    alg: String,
    /// `"JWT"` in the synthetic path. Read by the production cut-over
    /// (TODO(h100-prod)) when handling `x5c`-bearing headers.
    #[serde(default)]
    #[allow(dead_code)]
    typ: Option<String>,
}

/// Subset of NRAS JWT claims this verifier validates.
///
/// The real NVIDIA payload has dozens of fields (see
/// `https://docs.nvidia.com/cc-deployment-guide-snp.pdf`, Appendix
/// "NRAS Token Format"). We pin the security-relevant ones; the rest
/// are passed through opaquely and not trusted.
#[derive(Debug, Deserialize, Serialize)]
struct H100Claims {
    /// Issuer — must be the NRAS service URL we trust.
    iss: String,
    /// Issued-at, seconds-since-epoch.
    iat: i64,
    /// Expiry, seconds-since-epoch.
    exp: i64,
    /// `"true"` when the GPU is in Confidential Compute On mode. NVIDIA
    /// serializes this as a string, not a bool.
    #[serde(rename = "ccmode")]
    cc_mode: String,
    /// `"enabled"` when secure boot is on.
    secboot: String,
    /// `"disabled"` when JTAG / debug interfaces are locked.
    dbgstat: String,
    /// Overall pass/fail — NRAS sets this only if *every* underlying
    /// check passed. We re-check the individual fields anyway (defense
    /// in depth).
    #[serde(rename = "x-nvidia-overall-att-result")]
    overall_result: bool,
    /// Concatenated runtime measurement claims, hex-encoded. This is
    /// the H100 analogue of `PCR0 || PCR1 || PCR2`. In a real NRAS
    /// payload this is built from the `measres` array; we accept it
    /// pre-flattened here to keep the wire format symmetric with Nitro.
    #[serde(rename = "measurement_hex")]
    measurement_hex: String,
    /// Hex of the enclave X25519 public key. Binds the JWT to the keys
    /// the relay will seal requests to.
    enclave_x25519_pub_hex: String,
    /// Hex of the enclave Ed25519 public key.
    enclave_ed25519_pub_hex: String,
}

/// Operator-controlled trusted root for NRAS JWTs.
///
/// On a production node this returns NVIDIA's NRAS leaf-signing key
/// (after validating an `x5c` chain to a pinned root — see the
/// TODO(h100-prod) block). For now we accept a 32-byte Ed25519 public
/// key, hex-encoded, supplied via `THUMPER_NVIDIA_NRAS_ROOT_PEM`. The
/// env-var name retains the future PEM shape so the contract doesn't
/// change when we cut over.
///
/// CI default: when unset, the verifier refuses every JWT — the relay
/// must explicitly trust a key. This is the same fail-closed posture
/// as `GHOLA_ATTEST_SIGNING_PUB` in the Nitro path.
pub fn nras_root_pub_from_env() -> Option<VerifyingKey> {
    let raw = std::env::var("THUMPER_NVIDIA_NRAS_ROOT_PEM").ok()?;
    let trimmed = raw.trim();
    // Tolerate the hex-only short form (32 bytes) we use in CI. A
    // real PEM-encoded key path is handled by the TODO(h100-prod)
    // production cut-over; the env var name is shared so operators
    // configure the same secret on both sides.
    let bytes = hex::decode(trimmed).ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&arr).ok()
}

/// The issuer string this verifier currently accepts. Matches what we
/// emit from `thumper-gpu-provider` in CI for synthetic fixtures. The
/// production path will validate against the canonical NRAS URL
/// `https://nras.attestation.nvidia.com/v1/attest/gpu`.
pub const EXPECTED_ISSUER: &str = "https://nras.attestation.nvidia.com/v1/attest/gpu";

/// Verify an H100 CC NRAS JWT and return an `AttestedEnclave`. See
/// the module-level docs for the threat model.
///
/// `vendor_quote` is the full JWT string (as bytes; the provider
/// base64-wraps it on the wire, the relay base64-decodes before
/// calling us).
///
/// `ghola_allowlist_sig` + `ghola_allowlist_pub` provide the same
/// defense-in-depth as the Nitro path: an Ed25519 signature over
/// `sha256(measurement_bytes)` by a Ghola-controlled offline key.
pub fn verify_h100_cc(
    vendor_quote: &[u8],
    ghola_allowlist_sig: &[u8],
    ghola_allowlist_pub: &VerifyingKey,
    expected_tee_kind: TeeKind,
    now_unix: i64,
) -> Result<AttestedEnclave, AttestationError> {
    verify_h100_cc_inner(
        vendor_quote,
        ghola_allowlist_sig,
        ghola_allowlist_pub,
        expected_tee_kind,
        now_unix,
        /* override_root = */ None,
    )
}

/// Test-only variant that lets the caller substitute a custom NRAS
/// root public key, bypassing the env var. Real callers use
/// [`verify_h100_cc`].
#[doc(hidden)]
pub fn verify_h100_cc_with_root(
    vendor_quote: &[u8],
    ghola_allowlist_sig: &[u8],
    ghola_allowlist_pub: &VerifyingKey,
    expected_tee_kind: TeeKind,
    now_unix: i64,
    test_root_pub: &VerifyingKey,
) -> Result<AttestedEnclave, AttestationError> {
    verify_h100_cc_inner(
        vendor_quote,
        ghola_allowlist_sig,
        ghola_allowlist_pub,
        expected_tee_kind,
        now_unix,
        Some(*test_root_pub),
    )
}

fn verify_h100_cc_inner(
    vendor_quote: &[u8],
    ghola_allowlist_sig: &[u8],
    ghola_allowlist_pub: &VerifyingKey,
    expected_tee_kind: TeeKind,
    now_unix: i64,
    override_root: Option<VerifyingKey>,
) -> Result<AttestedEnclave, AttestationError> {
    if expected_tee_kind != TeeKind::H100Cc {
        return Err(AttestationError::UnsupportedTeeKind);
    }

    let nras_root = match override_root {
        Some(pk) => pk,
        None => nras_root_pub_from_env().ok_or_else(|| {
            AttestationError::CertChain(
                "THUMPER_NVIDIA_NRAS_ROOT_PEM unset; refusing H100 CC attestation".into(),
            )
        })?,
    };

    // 1. Parse the JWT envelope.
    let jwt_str = std::str::from_utf8(vendor_quote)
        .map_err(|_| AttestationError::Cose("H100 JWT is not valid UTF-8".into()))?;
    let (header, claims, signing_input, signature) = parse_jwt(jwt_str)?;

    // 2. Algorithm check. We only honour EdDSA today; the
    // TODO(h100-prod) block tracks adding RS256/ES384 for production.
    if header.alg != "EdDSA" {
        return Err(AttestationError::Cose(format!(
            "unsupported JWT alg {} (only EdDSA accepted in the synthetic path)",
            header.alg
        )));
    }

    // 3. Verify the JWT signature against the NRAS root key. In the
    // production cut-over this becomes "verify against the leaf in
    // `x5c`, then validate the chain back to the pinned NVIDIA root".
    let sig_arr: [u8; 64] = signature
        .as_slice()
        .try_into()
        .map_err(|_| AttestationError::Signature)?;
    let sig = Signature::from_bytes(&sig_arr);
    nras_root
        .verify(signing_input.as_bytes(), &sig)
        .map_err(|_| AttestationError::Signature)?;

    // 4. Claim checks (fail-closed: every assertion must pass).
    if claims.iss != EXPECTED_ISSUER {
        return Err(AttestationError::CertChain(format!(
            "untrusted JWT issuer: {}",
            claims.iss
        )));
    }
    if !claims.overall_result {
        return Err(AttestationError::CertChain(
            "NRAS overall_result is false".into(),
        ));
    }
    if claims.cc_mode != "on" {
        return Err(AttestationError::CertChain(format!(
            "GPU not in Confidential Compute mode (ccmode={})",
            claims.cc_mode
        )));
    }
    if claims.secboot != "enabled" {
        return Err(AttestationError::CertChain(format!(
            "secure boot not enabled (secboot={})",
            claims.secboot
        )));
    }
    if claims.dbgstat != "disabled" {
        return Err(AttestationError::CertChain(format!(
            "debug interfaces not locked (dbgstat={})",
            claims.dbgstat
        )));
    }

    // 5. Time checks. Allow ±60s skew, same tolerance as Nitro.
    if claims.iat > now_unix + 60 {
        return Err(AttestationError::FutureTimestamp);
    }
    if now_unix > claims.exp {
        return Err(AttestationError::Expired {
            now: now_unix,
            ts: claims.iat,
        });
    }

    // 6. Decode the measurement bytes (analogue of PCR0||PCR1||PCR2).
    let measurement = hex::decode(claims.measurement_hex.trim())
        .map_err(|_| AttestationError::Internal("measurement_hex not hex".into()))?;
    if measurement.is_empty() {
        return Err(AttestationError::MissingPcr(0));
    }

    // 7. Defense-in-depth allowlist: Ed25519 signature over
    // sha256(measurement) by the Ghola offline key. Identical contract
    // to the Nitro path so the operator workflow is unified.
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

    // 8. Bind the enclave keys carried by the JWT to the same shape
    // the relay uses for Nitro.
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
        tee_kind: TeeKind::H100Cc,
        measurement,
        attested_at_unix,
        expires_at_unix,
    })
}

fn parse_pub32_hex(s: &str) -> Option<[u8; 32]> {
    let bytes = hex::decode(s.trim()).ok()?;
    bytes.try_into().ok()
}

/// Hand-parse a JWT. Returns `(header, claims, signing_input,
/// signature)`. JWT is just three base64url-no-pad segments joined by
/// `.`; the signing input is `header_b64.payload_b64`.
fn parse_jwt(
    s: &str,
) -> Result<(JwtHeader, H100Claims, String, Vec<u8>), AttestationError> {
    let mut parts = s.split('.');
    let header_b64 = parts
        .next()
        .ok_or_else(|| AttestationError::Cose("JWT missing header".into()))?;
    let payload_b64 = parts
        .next()
        .ok_or_else(|| AttestationError::Cose("JWT missing payload".into()))?;
    let sig_b64 = parts
        .next()
        .ok_or_else(|| AttestationError::Cose("JWT missing signature".into()))?;
    if parts.next().is_some() {
        return Err(AttestationError::Cose("JWT has more than 3 segments".into()));
    }

    let header_bytes = b64url_decode(header_b64)
        .map_err(|e| AttestationError::Cose(format!("JWT header b64url: {e}")))?;
    let payload_bytes = b64url_decode(payload_b64)
        .map_err(|e| AttestationError::Cose(format!("JWT payload b64url: {e}")))?;
    let sig_bytes = b64url_decode(sig_b64)
        .map_err(|e| AttestationError::Cose(format!("JWT signature b64url: {e}")))?;

    let header: JwtHeader = serde_json::from_slice(&header_bytes)
        .map_err(|e| AttestationError::Cose(format!("JWT header json: {e}")))?;
    let claims: H100Claims = serde_json::from_slice(&payload_bytes)
        .map_err(|e| AttestationError::Cbor(format!("JWT claims json: {e}")))?;

    let signing_input = format!("{header_b64}.{payload_b64}");
    Ok((header, claims, signing_input, sig_bytes))
}

/// Base64URL decode without padding, per RFC 7515 §2 ("Base64url
/// Encoding"). Equivalent to `base64::URL_SAFE_NO_PAD`.
fn b64url_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s.as_bytes())
}

/// Base64URL encode without padding. Exposed for fixture-builders
/// (tests + the synthetic provider path).
pub fn b64url_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    fn synth_jwt(
        signing_key: &SigningKey,
        cc_mode: &str,
        secboot: &str,
        dbgstat: &str,
        overall_result: bool,
        iat: i64,
        exp: i64,
        measurement_hex: &str,
        x25519_hex: &str,
        ed25519_hex: &str,
    ) -> String {
        let header = serde_json::json!({"alg": "EdDSA", "typ": "JWT"});
        let claims = serde_json::json!({
            "iss": EXPECTED_ISSUER,
            "iat": iat,
            "exp": exp,
            "ccmode": cc_mode,
            "secboot": secboot,
            "dbgstat": dbgstat,
            "x-nvidia-overall-att-result": overall_result,
            "measurement_hex": measurement_hex,
            "enclave_x25519_pub_hex": x25519_hex,
            "enclave_ed25519_pub_hex": ed25519_hex,
        });
        let h_b64 = b64url_encode(serde_json::to_vec(&header).unwrap().as_slice());
        let p_b64 = b64url_encode(serde_json::to_vec(&claims).unwrap().as_slice());
        let signing_input = format!("{h_b64}.{p_b64}");
        let sig = signing_key.sign(signing_input.as_bytes());
        let s_b64 = b64url_encode(&sig.to_bytes());
        format!("{signing_input}.{s_b64}")
    }

    fn make_allowlist_sig(measurement: &[u8], sk: &SigningKey) -> Vec<u8> {
        let mut h = Sha256::new();
        h.update(measurement);
        let digest = h.finalize();
        sk.sign(&digest).to_bytes().to_vec()
    }

    #[test]
    fn happy_path_accepts_well_formed_jwt() {
        let nras_sk = SigningKey::generate(&mut OsRng);
        let allow_sk = SigningKey::generate(&mut OsRng);
        let measurement = vec![0x11u8; 48];
        let measurement_hex = hex::encode(&measurement);
        let x25519_hex = hex::encode([0x22u8; 32]);
        let ed25519_hex = hex::encode([0x33u8; 32]);

        let now = 1_700_000_000;
        let jwt = synth_jwt(
            &nras_sk,
            "on",
            "enabled",
            "disabled",
            true,
            now - 5,
            now + 600,
            &measurement_hex,
            &x25519_hex,
            &ed25519_hex,
        );
        let allow_sig = make_allowlist_sig(&measurement, &allow_sk);
        let enc = verify_h100_cc_with_root(
            jwt.as_bytes(),
            &allow_sig,
            &allow_sk.verifying_key(),
            TeeKind::H100Cc,
            now,
            &nras_sk.verifying_key(),
        )
        .expect("happy path");

        assert_eq!(enc.tee_kind, TeeKind::H100Cc);
        assert_eq!(enc.measurement, measurement);
        assert_eq!(enc.attested_at_unix, now - 5);
    }

    #[test]
    fn cc_mode_off_is_rejected() {
        let nras_sk = SigningKey::generate(&mut OsRng);
        let allow_sk = SigningKey::generate(&mut OsRng);
        let measurement = vec![0x11u8; 48];
        let now = 1_700_000_000;
        let jwt = synth_jwt(
            &nras_sk,
            "off",
            "enabled",
            "disabled",
            true,
            now - 5,
            now + 600,
            &hex::encode(&measurement),
            &hex::encode([0x22u8; 32]),
            &hex::encode([0x33u8; 32]),
        );
        let allow_sig = make_allowlist_sig(&measurement, &allow_sk);
        let err = verify_h100_cc_with_root(
            jwt.as_bytes(),
            &allow_sig,
            &allow_sk.verifying_key(),
            TeeKind::H100Cc,
            now,
            &nras_sk.verifying_key(),
        )
        .unwrap_err();
        assert!(matches!(err, AttestationError::CertChain(_)));
    }

    #[test]
    fn wrong_signing_key_is_rejected() {
        let nras_sk = SigningKey::generate(&mut OsRng);
        let bad_sk = SigningKey::generate(&mut OsRng);
        let allow_sk = SigningKey::generate(&mut OsRng);
        let measurement = vec![0x11u8; 48];
        let now = 1_700_000_000;
        let jwt = synth_jwt(
            &bad_sk,
            "on",
            "enabled",
            "disabled",
            true,
            now - 5,
            now + 600,
            &hex::encode(&measurement),
            &hex::encode([0x22u8; 32]),
            &hex::encode([0x33u8; 32]),
        );
        let allow_sig = make_allowlist_sig(&measurement, &allow_sk);
        let err = verify_h100_cc_with_root(
            jwt.as_bytes(),
            &allow_sig,
            &allow_sk.verifying_key(),
            TeeKind::H100Cc,
            now,
            &nras_sk.verifying_key(),
        )
        .unwrap_err();
        assert!(matches!(err, AttestationError::Signature));
    }

    #[test]
    fn expired_jwt_is_rejected() {
        let nras_sk = SigningKey::generate(&mut OsRng);
        let allow_sk = SigningKey::generate(&mut OsRng);
        let measurement = vec![0x11u8; 48];
        let now = 1_700_000_000;
        let jwt = synth_jwt(
            &nras_sk,
            "on",
            "enabled",
            "disabled",
            true,
            now - 10_000,
            now - 1, // expired one second ago
            &hex::encode(&measurement),
            &hex::encode([0x22u8; 32]),
            &hex::encode([0x33u8; 32]),
        );
        let allow_sig = make_allowlist_sig(&measurement, &allow_sk);
        let err = verify_h100_cc_with_root(
            jwt.as_bytes(),
            &allow_sig,
            &allow_sk.verifying_key(),
            TeeKind::H100Cc,
            now,
            &nras_sk.verifying_key(),
        )
        .unwrap_err();
        assert!(matches!(err, AttestationError::Expired { .. }));
    }

    #[test]
    fn bad_allowlist_sig_is_rejected() {
        let nras_sk = SigningKey::generate(&mut OsRng);
        let allow_sk = SigningKey::generate(&mut OsRng);
        let other_allow_sk = SigningKey::generate(&mut OsRng);
        let measurement = vec![0x11u8; 48];
        let now = 1_700_000_000;
        let jwt = synth_jwt(
            &nras_sk,
            "on",
            "enabled",
            "disabled",
            true,
            now - 5,
            now + 600,
            &hex::encode(&measurement),
            &hex::encode([0x22u8; 32]),
            &hex::encode([0x33u8; 32]),
        );
        // Sign with the wrong allowlist key.
        let bad_sig = make_allowlist_sig(&measurement, &other_allow_sk);
        let err = verify_h100_cc_with_root(
            jwt.as_bytes(),
            &bad_sig,
            &allow_sk.verifying_key(),
            TeeKind::H100Cc,
            now,
            &nras_sk.verifying_key(),
        )
        .unwrap_err();
        assert!(matches!(err, AttestationError::AllowlistSig));
    }
}
