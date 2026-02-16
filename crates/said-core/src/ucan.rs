//! Thin UCAN (User Controlled Authorization Network) layer.
//!
//! Implements UCAN 0.10 as a standard JWT (header.payload.signature)
//! signed with Ed25519 (EdDSA). No heavy `ucan` crate dependency.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use said_types::Capability;

use crate::error::{Result, SaidError};

/// Multicodec prefix for Ed25519 public keys (0xed01).
const ED25519_MULTICODEC: [u8; 2] = [0xed, 0x01];

// ── JWT Structures ──

#[derive(Serialize, Deserialize)]
struct UcanHeader {
    alg: String,
    typ: String,
    ucv: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UcanAttenuation {
    pub with: String,
    pub can: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UcanPayload {
    pub iss: String,
    pub aud: String,
    pub exp: i64,
    pub iat: i64,
    pub att: Vec<UcanAttenuation>,
    pub nnc: String,
}

// ── did:key encoding ──

/// Encode an Ed25519 public key as a `did:key:z6Mk...` string.
pub fn did_key_from_pub(pub_key: &VerifyingKey) -> String {
    let mut bytes = Vec::with_capacity(2 + 32);
    bytes.extend_from_slice(&ED25519_MULTICODEC);
    bytes.extend_from_slice(pub_key.as_bytes());
    format!("did:key:z{}", bs58::encode(&bytes).into_string())
}

/// Decode a `did:key:z6Mk...` string back to an Ed25519 public key.
pub fn pub_key_from_did_key(did: &str) -> Result<VerifyingKey> {
    let z_part = did
        .strip_prefix("did:key:z")
        .ok_or_else(|| SaidError::Ucan("invalid did:key format".into()))?;
    let bytes = bs58::decode(z_part)
        .into_vec()
        .map_err(|e| SaidError::Ucan(format!("base58 decode error: {}", e)))?;
    if bytes.len() < 2 + 32 {
        return Err(SaidError::Ucan("did:key payload too short".into()));
    }
    if bytes[0..2] != ED25519_MULTICODEC {
        return Err(SaidError::Ucan("unsupported multicodec prefix".into()));
    }
    let key_bytes: [u8; 32] = bytes[2..34]
        .try_into()
        .map_err(|_| SaidError::Ucan("invalid key length".into()))?;
    VerifyingKey::from_bytes(&key_bytes)
        .map_err(|e| SaidError::Ucan(format!("invalid ed25519 key: {}", e)))
}

// ── UCAN creation and verification ──

/// Create a signed UCAN JWT token.
///
/// - `signing_key`: the issuer's Ed25519 signing key (master key)
/// - `audience_pub`: the audience's public key (provider key)
/// - `capabilities`: the capabilities being granted
/// - `expires_in`: how long until the token expires
pub fn create_ucan(
    signing_key: &SigningKey,
    audience_pub: &VerifyingKey,
    capabilities: &[Capability],
    expires_in: Duration,
) -> Result<String> {
    let header = UcanHeader {
        alg: "EdDSA".into(),
        typ: "JWT".into(),
        ucv: "0.10.0".into(),
    };

    let now = chrono::Utc::now().timestamp();
    let exp = now + expires_in.as_secs() as i64;

    let issuer_pub = signing_key.verifying_key();
    let iss = did_key_from_pub(&issuer_pub);
    let aud = did_key_from_pub(audience_pub);

    let att: Vec<UcanAttenuation> = capabilities
        .iter()
        .map(|cap| UcanAttenuation {
            with: "said://data/*".into(),
            can: cap.to_ucan_action().into(),
        })
        .collect();

    // Generate a random nonce for replay protection
    let nonce_bytes: [u8; 16] = rand::random();
    let nnc = URL_SAFE_NO_PAD.encode(nonce_bytes);

    let payload = UcanPayload {
        iss,
        aud,
        exp,
        iat: now,
        att,
        nnc,
    };

    // Encode header and payload
    let header_json =
        serde_json::to_vec(&header).map_err(|e| SaidError::Ucan(e.to_string()))?;
    let payload_json =
        serde_json::to_vec(&payload).map_err(|e| SaidError::Ucan(e.to_string()))?;

    let header_b64 = URL_SAFE_NO_PAD.encode(&header_json);
    let payload_b64 = URL_SAFE_NO_PAD.encode(&payload_json);

    // Sign
    let message = format!("{}.{}", header_b64, payload_b64);
    let signature = signing_key.sign(message.as_bytes());
    let sig_b64 = URL_SAFE_NO_PAD.encode(signature.to_bytes());

    Ok(format!("{}.{}.{}", header_b64, payload_b64, sig_b64))
}

/// Verify a UCAN JWT token and return its payload.
///
/// - `token`: the JWT string (header.payload.signature)
/// - `expected_issuer`: the expected issuer's public key (master pub key)
pub fn verify_ucan(token: &str, expected_issuer: &VerifyingKey) -> Result<UcanPayload> {
    let parts: Vec<&str> = token.splitn(3, '.').collect();
    if parts.len() != 3 {
        return Err(SaidError::Ucan("invalid JWT: expected 3 parts".into()));
    }

    let (header_b64, payload_b64, sig_b64) = (parts[0], parts[1], parts[2]);

    // Verify header
    let header_bytes = URL_SAFE_NO_PAD
        .decode(header_b64)
        .map_err(|e| SaidError::Ucan(format!("header decode error: {}", e)))?;
    let header: UcanHeader = serde_json::from_slice(&header_bytes)
        .map_err(|e| SaidError::Ucan(format!("header parse error: {}", e)))?;
    if header.alg != "EdDSA" {
        return Err(SaidError::Ucan(format!(
            "unsupported algorithm: {}",
            header.alg
        )));
    }

    // Verify signature
    let message = format!("{}.{}", header_b64, payload_b64);
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|e| SaidError::Ucan(format!("signature decode error: {}", e)))?;
    let sig_array: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| SaidError::Ucan("invalid signature length".into()))?;
    let signature = Signature::from_bytes(&sig_array);

    expected_issuer
        .verify(message.as_bytes(), &signature)
        .map_err(|_| SaidError::Auth("UCAN signature verification failed".into()))?;

    // Parse and validate payload
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|e| SaidError::Ucan(format!("payload decode error: {}", e)))?;
    let payload: UcanPayload = serde_json::from_slice(&payload_bytes)
        .map_err(|e| SaidError::Ucan(format!("payload parse error: {}", e)))?;

    // Verify issuer matches expected
    let expected_did = did_key_from_pub(expected_issuer);
    if payload.iss != expected_did {
        return Err(SaidError::Auth("UCAN issuer mismatch".into()));
    }

    // Check expiry
    let now = chrono::Utc::now().timestamp();
    if payload.exp <= now {
        return Err(SaidError::SessionExpired);
    }

    Ok(payload)
}

/// Extract the capabilities from a verified UCAN payload.
pub fn capabilities_from_payload(payload: &UcanPayload) -> Vec<Capability> {
    payload
        .att
        .iter()
        .filter_map(|att| Capability::from_ucan_action(&att.can))
        .collect()
}

/// Convert an `ed25519_bip32::XPrv` to an `ed25519_dalek::SigningKey`.
///
/// XPrv stores 64 bytes: [secret(32) | chain_code(32)].
/// We extract the first 32 bytes as the Ed25519 secret key.
pub fn xprv_to_signing_key(xprv: &ed25519_bip32::XPrv) -> SigningKey {
    let bytes: &[u8] = xprv.as_ref();
    let secret: [u8; 32] = bytes[..32].try_into().expect("XPrv has 64 bytes");
    SigningKey::from_bytes(&secret)
}

/// Convert an `ed25519_bip32::XPrv` to an `ed25519_dalek::VerifyingKey` (public key).
pub fn xprv_to_verifying_key(xprv: &ed25519_bip32::XPrv) -> VerifyingKey {
    xprv_to_signing_key(xprv).verifying_key()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn test_keypair() -> SigningKey {
        let secret = [42u8; 32];
        SigningKey::from_bytes(&secret)
    }

    fn other_keypair() -> SigningKey {
        let secret = [99u8; 32];
        SigningKey::from_bytes(&secret)
    }

    #[test]
    fn did_key_roundtrip() {
        let key = test_keypair();
        let pub_key = key.verifying_key();
        let did = did_key_from_pub(&pub_key);
        assert!(did.starts_with("did:key:z"));
        let decoded = pub_key_from_did_key(&did).unwrap();
        assert_eq!(decoded.as_bytes(), pub_key.as_bytes());
    }

    #[test]
    fn create_and_verify_ucan() {
        let issuer = test_keypair();
        let audience = other_keypair().verifying_key();
        let caps = vec![Capability::ReadPrompts, Capability::ReadMemories];

        let token = create_ucan(&issuer, &audience, &caps, Duration::from_secs(3600)).unwrap();

        let payload = verify_ucan(&token, &issuer.verifying_key()).unwrap();
        assert_eq!(payload.iss, did_key_from_pub(&issuer.verifying_key()));
        assert_eq!(payload.aud, did_key_from_pub(&audience));
        assert_eq!(payload.att.len(), 2);
        assert_eq!(payload.att[0].can, "said/read_prompts");
        assert_eq!(payload.att[1].can, "said/read_memories");
    }

    #[test]
    fn expired_ucan_rejected() {
        let issuer = test_keypair();
        let audience = other_keypair().verifying_key();
        let caps = vec![Capability::ReadPrompts];

        // Create with 0 seconds — already expired
        let token = create_ucan(&issuer, &audience, &caps, Duration::from_secs(0)).unwrap();

        let result = verify_ucan(&token, &issuer.verifying_key());
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            crate::error::SaidError::SessionExpired
        ));
    }

    #[test]
    fn wrong_issuer_rejected() {
        let issuer = test_keypair();
        let wrong_issuer = other_keypair();
        let audience = other_keypair().verifying_key();
        let caps = vec![Capability::ReadPrompts];

        let token = create_ucan(&issuer, &audience, &caps, Duration::from_secs(3600)).unwrap();

        // Verify with the wrong issuer key
        let result = verify_ucan(&token, &wrong_issuer.verifying_key());
        assert!(result.is_err());
    }

    #[test]
    fn capability_checking() {
        // All grants everything
        assert!(Capability::All.grants(&Capability::ReadPrompts));
        assert!(Capability::All.grants(&Capability::WriteMemories));
        assert!(Capability::All.grants(&Capability::All));

        // Specific caps are exact
        assert!(Capability::ReadPrompts.grants(&Capability::ReadPrompts));
        assert!(!Capability::ReadPrompts.grants(&Capability::ReadMemories));
        assert!(!Capability::ReadPrompts.grants(&Capability::All));
    }

    #[test]
    fn capabilities_from_payload_roundtrip() {
        let issuer = test_keypair();
        let audience = other_keypair().verifying_key();
        let caps = vec![Capability::ReadPrompts, Capability::WriteMemories, Capability::All];

        let token = create_ucan(&issuer, &audience, &caps, Duration::from_secs(3600)).unwrap();
        let payload = verify_ucan(&token, &issuer.verifying_key()).unwrap();
        let parsed_caps = capabilities_from_payload(&payload);

        assert_eq!(parsed_caps.len(), 3);
        assert!(parsed_caps.contains(&Capability::ReadPrompts));
        assert!(parsed_caps.contains(&Capability::WriteMemories));
        assert!(parsed_caps.contains(&Capability::All));
    }
}
