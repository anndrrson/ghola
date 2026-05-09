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

pub use said_noncecache::NonceCache;

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
    /// Parent UCAN tokens (proof chain for delegation).
    #[serde(default)]
    pub prf: Vec<String>,
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
        prf: Vec::new(),
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
///
/// **Note:** this overload does **not** enforce replay protection. If you are
/// accepting bearer tokens over a network (HTTP, WebSocket), prefer
/// [`verify_ucan_with_replay`] and pass a long-lived [`NonceCache`] so the
/// `nnc` claim is checked against recently-seen nonces.
pub fn verify_ucan(token: &str, expected_issuer: &VerifyingKey) -> Result<UcanPayload> {
    verify_ucan_inner(token, expected_issuer, None)
}

/// Same as [`verify_ucan`] but additionally rejects tokens whose `nnc` has
/// already been seen within the cache's TTL window.
///
/// Pass a single shared [`NonceCache`] across all middleware for a process so
/// that an attacker who captures a UCAN bearer token cannot replay it after
/// the legitimate request has been accepted, even within the validity window.
pub fn verify_ucan_with_replay(
    token: &str,
    expected_issuer: &VerifyingKey,
    nonce_cache: &NonceCache,
) -> Result<UcanPayload> {
    verify_ucan_inner(token, expected_issuer, Some(nonce_cache))
}

fn verify_ucan_inner(
    token: &str,
    expected_issuer: &VerifyingKey,
    nonce_cache: Option<&NonceCache>,
) -> Result<UcanPayload> {
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

    // Replay detection — only after the token is otherwise valid so a
    // tampered token does not poison the cache.
    if let Some(cache) = nonce_cache {
        if cache.check_and_insert(&payload.nnc) {
            return Err(SaidError::Auth("UCAN nonce already seen (replay)".into()));
        }
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

// ── Delegation ──

/// Check if child capabilities are a subset of parent capabilities.
///
/// Returns `true` if every capability in `child` is granted by at least one
/// capability in `parent`. If `parent` contains `Capability::All`, returns
/// `true` for any `child` set.
pub fn is_capability_subset(child: &[Capability], parent: &[Capability]) -> bool {
    if parent.iter().any(|c| *c == Capability::All) {
        return true;
    }
    child.iter().all(|child_cap| {
        parent.iter().any(|parent_cap| parent_cap.grants(child_cap))
    })
}

/// Decode just the payload segment from a JWT token string (without verifying the signature).
fn decode_payload(token: &str) -> Result<UcanPayload> {
    let parts: Vec<&str> = token.splitn(3, '.').collect();
    if parts.len() != 3 {
        return Err(SaidError::Ucan("invalid JWT: expected 3 parts".into()));
    }
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|e| SaidError::Ucan(format!("payload decode error: {}", e)))?;
    serde_json::from_slice(&payload_bytes)
        .map_err(|e| SaidError::Ucan(format!("payload parse error: {}", e)))
}

/// Verify the signature of a token against a specific issuer key, returning the payload.
///
/// This is like `verify_ucan` but takes the issuer key to verify against as a
/// parameter derived from the token's `iss` field rather than an externally-provided key.
fn verify_token_signature(token: &str) -> Result<UcanPayload> {
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

    // Decode payload to get the issuer DID
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|e| SaidError::Ucan(format!("payload decode error: {}", e)))?;
    let payload: UcanPayload = serde_json::from_slice(&payload_bytes)
        .map_err(|e| SaidError::Ucan(format!("payload parse error: {}", e)))?;

    // Derive the issuer's public key from the DID
    let issuer_key = pub_key_from_did_key(&payload.iss)?;

    // Verify signature
    let message = format!("{}.{}", header_b64, payload_b64);
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|e| SaidError::Ucan(format!("signature decode error: {}", e)))?;
    let sig_array: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| SaidError::Ucan("invalid signature length".into()))?;
    let signature = Signature::from_bytes(&sig_array);

    issuer_key
        .verify(message.as_bytes(), &signature)
        .map_err(|_| SaidError::Auth("UCAN signature verification failed".into()))?;

    // Check expiry
    let now = chrono::Utc::now().timestamp();
    if payload.exp <= now {
        return Err(SaidError::SessionExpired);
    }

    Ok(payload)
}

/// Create a delegated UCAN token from a parent token.
///
/// The delegator must be the audience of the parent token. The attenuated
/// capabilities must be a subset of the parent's capabilities. The expiry
/// is clamped to not exceed the parent's expiry.
///
/// - `parent_token`: the parent UCAN JWT string
/// - `delegator_key`: the signing key of the delegator (who is `aud` in the parent)
/// - `new_audience`: the audience of the new delegated token
/// - `attenuated_caps`: capabilities to grant (must be subset of parent's)
/// - `expires_in`: requested duration (clamped to parent's expiry)
pub fn delegate_ucan(
    parent_token: &str,
    delegator_key: &SigningKey,
    new_audience: &VerifyingKey,
    attenuated_caps: &[Capability],
    expires_in: Duration,
) -> Result<String> {
    // Decode the parent token payload
    let parent_payload = decode_payload(parent_token)?;

    // Verify the delegator is the audience of the parent
    let delegator_did = did_key_from_pub(&delegator_key.verifying_key());
    if parent_payload.aud != delegator_did {
        return Err(SaidError::Auth(
            "delegator is not the audience of the parent token".into(),
        ));
    }

    // Parse parent capabilities and verify attenuation
    let parent_caps = capabilities_from_payload(&parent_payload);
    if !is_capability_subset(attenuated_caps, &parent_caps) {
        return Err(SaidError::InsufficientCapability(
            "delegated capabilities exceed parent's capabilities".into(),
        ));
    }

    // Clamp expiry to not exceed parent's
    let now = chrono::Utc::now().timestamp();
    let requested_exp = now + expires_in.as_secs() as i64;
    let exp = std::cmp::min(requested_exp, parent_payload.exp);

    // Build the header
    let header = UcanHeader {
        alg: "EdDSA".into(),
        typ: "JWT".into(),
        ucv: "0.10.0".into(),
    };

    let iss = delegator_did;
    let aud = did_key_from_pub(new_audience);

    let att: Vec<UcanAttenuation> = attenuated_caps
        .iter()
        .map(|cap| UcanAttenuation {
            with: "said://data/*".into(),
            can: cap.to_ucan_action().into(),
        })
        .collect();

    let nonce_bytes: [u8; 16] = rand::random();
    let nnc = URL_SAFE_NO_PAD.encode(nonce_bytes);

    let payload = UcanPayload {
        iss,
        aud,
        exp,
        iat: now,
        att,
        nnc,
        prf: vec![parent_token.to_string()],
    };

    // Encode header and payload
    let header_json =
        serde_json::to_vec(&header).map_err(|e| SaidError::Ucan(e.to_string()))?;
    let payload_json =
        serde_json::to_vec(&payload).map_err(|e| SaidError::Ucan(e.to_string()))?;

    let header_b64 = URL_SAFE_NO_PAD.encode(&header_json);
    let payload_b64 = URL_SAFE_NO_PAD.encode(&payload_json);

    // Sign with delegator's key
    let message = format!("{}.{}", header_b64, payload_b64);
    let signature = delegator_key.sign(message.as_bytes());
    let sig_b64 = URL_SAFE_NO_PAD.encode(signature.to_bytes());

    Ok(format!("{}.{}.{}", header_b64, payload_b64, sig_b64))
}

/// Verify a UCAN delegation chain recursively.
///
/// - If the token has no proofs (`prf` is empty), it is verified as a root token
///   against `root_issuer`.
/// - If the token has proofs, the parent chain is verified recursively, and then
///   the current token's signature, capability attenuation, and expiry are checked.
pub fn verify_ucan_chain(
    token: &str,
    root_issuer: &VerifyingKey,
) -> Result<UcanPayload> {
    let payload = decode_payload(token)?;

    if payload.prf.is_empty() {
        // Root token — verify directly against the root issuer
        return verify_ucan(token, root_issuer);
    }

    // Delegated token — verify the parent chain first
    let parent_token = &payload.prf[0];
    let parent_payload = verify_ucan_chain(parent_token, root_issuer)?;

    // Verify the current token's signature against its own issuer
    let current_payload = verify_token_signature(token)?;

    // Verify the current issuer is the audience of the parent
    if current_payload.iss != parent_payload.aud {
        return Err(SaidError::Auth(
            "delegation chain broken: token issuer is not parent's audience".into(),
        ));
    }

    // Verify capability attenuation
    let parent_caps = capabilities_from_payload(&parent_payload);
    let current_caps = capabilities_from_payload(&current_payload);
    if !is_capability_subset(&current_caps, &parent_caps) {
        return Err(SaidError::InsufficientCapability(
            "delegated capabilities exceed parent's capabilities".into(),
        ));
    }

    Ok(current_payload)
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
    fn replay_cache_rejects_repeat_token() {
        let issuer = test_keypair();
        let audience = other_keypair().verifying_key();
        let caps = vec![Capability::ReadPrompts];

        let token = create_ucan(&issuer, &audience, &caps, Duration::from_secs(3600)).unwrap();
        let cache = NonceCache::new(60);

        // First presentation succeeds and seeds the cache.
        verify_ucan_with_replay(&token, &issuer.verifying_key(), &cache).unwrap();

        // A second presentation of the same token (same nnc) is rejected.
        let result = verify_ucan_with_replay(&token, &issuer.verifying_key(), &cache);
        assert!(matches!(result, Err(crate::error::SaidError::Auth(_))));
    }

    #[test]
    fn replay_cache_only_seeded_for_valid_tokens() {
        // A token whose signature does not verify must not poison the cache —
        // otherwise an attacker could DoS legitimate tokens by submitting
        // tampered variants under the same nnc.
        let issuer = test_keypair();
        let wrong_issuer = other_keypair();
        let audience = other_keypair().verifying_key();
        let caps = vec![Capability::ReadPrompts];

        let token = create_ucan(&issuer, &audience, &caps, Duration::from_secs(3600)).unwrap();
        let cache = NonceCache::new(60);

        // Try the token against the wrong issuer — should fail with Auth and
        // leave the cache empty.
        let _ = verify_ucan_with_replay(&token, &wrong_issuer.verifying_key(), &cache);
        assert!(cache.is_empty(), "cache should not record nonces for failed verifications");

        // Now the correct verification still succeeds.
        verify_ucan_with_replay(&token, &issuer.verifying_key(), &cache).unwrap();
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

    // ── Delegation Tests ──

    fn third_keypair() -> SigningKey {
        let secret = [77u8; 32];
        SigningKey::from_bytes(&secret)
    }

    #[test]
    fn is_capability_subset_all_grants_everything() {
        let parent = vec![Capability::All];
        assert!(is_capability_subset(&[Capability::ReadPrompts], &parent));
        assert!(is_capability_subset(
            &[Capability::ReadPrompts, Capability::WriteMemories],
            &parent
        ));
        assert!(is_capability_subset(&[Capability::All], &parent));
        assert!(is_capability_subset(&[], &parent));
    }

    #[test]
    fn is_capability_subset_exact_match() {
        let parent = vec![Capability::ReadPrompts, Capability::ReadMemories];
        assert!(is_capability_subset(&[Capability::ReadPrompts], &parent));
        assert!(is_capability_subset(
            &[Capability::ReadPrompts, Capability::ReadMemories],
            &parent
        ));
        assert!(!is_capability_subset(
            &[Capability::WriteMemories],
            &parent
        ));
        assert!(!is_capability_subset(
            &[Capability::ReadPrompts, Capability::WriteMemories],
            &parent
        ));
    }

    #[test]
    fn is_capability_subset_empty_child() {
        let parent = vec![Capability::ReadPrompts];
        assert!(is_capability_subset(&[], &parent));
    }

    #[test]
    fn is_capability_subset_empty_parent() {
        assert!(!is_capability_subset(
            &[Capability::ReadPrompts],
            &[]
        ));
        // Empty child with empty parent is trivially true
        assert!(is_capability_subset(&[], &[]));
    }

    #[test]
    fn delegate_and_verify_chain() {
        let root = test_keypair();
        let delegate = other_keypair();
        let delegate_pub = delegate.verifying_key();

        // Root creates UCAN for delegate
        let root_token = create_ucan(
            &root,
            &delegate_pub,
            &[Capability::ReadPrompts, Capability::ReadMemories],
            Duration::from_secs(3600),
        )
        .unwrap();

        // Delegate creates a sub-delegation for a third party
        let agent = third_keypair();
        let agent_pub = agent.verifying_key();
        let delegated_token = delegate_ucan(
            &root_token,
            &delegate,
            &agent_pub,
            &[Capability::ReadPrompts],
            Duration::from_secs(1800),
        )
        .unwrap();

        // Verify the full chain
        let payload = verify_ucan_chain(&delegated_token, &root.verifying_key()).unwrap();
        assert_eq!(payload.iss, did_key_from_pub(&delegate_pub));
        assert_eq!(payload.aud, did_key_from_pub(&agent_pub));
        assert_eq!(payload.prf.len(), 1);

        let caps = capabilities_from_payload(&payload);
        assert_eq!(caps, vec![Capability::ReadPrompts]);
    }

    #[test]
    fn delegate_over_attenuation_fails() {
        let root = test_keypair();
        let delegate = other_keypair();

        // Root grants only ReadPrompts
        let root_token = create_ucan(
            &root,
            &delegate.verifying_key(),
            &[Capability::ReadPrompts],
            Duration::from_secs(3600),
        )
        .unwrap();

        // Delegate tries to grant WriteMemories (not in parent)
        let agent = third_keypair();
        let result = delegate_ucan(
            &root_token,
            &delegate,
            &agent.verifying_key(),
            &[Capability::WriteMemories],
            Duration::from_secs(1800),
        );
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            crate::error::SaidError::InsufficientCapability(_)
        ));
    }

    #[test]
    fn delegate_expiry_clamped_to_parent() {
        let root = test_keypair();
        let delegate = other_keypair();

        // Root creates a token that expires in 1 hour
        let root_token = create_ucan(
            &root,
            &delegate.verifying_key(),
            &[Capability::ReadPrompts],
            Duration::from_secs(3600),
        )
        .unwrap();
        let root_payload = decode_payload(&root_token).unwrap();

        // Delegate requests 24 hours — should be clamped to parent's exp
        let agent = third_keypair();
        let delegated_token = delegate_ucan(
            &root_token,
            &delegate,
            &agent.verifying_key(),
            &[Capability::ReadPrompts],
            Duration::from_secs(86400),
        )
        .unwrap();
        let delegated_payload = decode_payload(&delegated_token).unwrap();

        assert!(delegated_payload.exp <= root_payload.exp);
    }

    #[test]
    fn multi_level_delegation() {
        let root = test_keypair();
        let level1 = other_keypair();
        let level2 = third_keypair();
        let level3_key = SigningKey::from_bytes(&[55u8; 32]);

        // Root → Level 1
        let token_l1 = create_ucan(
            &root,
            &level1.verifying_key(),
            &[Capability::ReadPrompts, Capability::ReadMemories, Capability::WriteMemories],
            Duration::from_secs(7200),
        )
        .unwrap();

        // Level 1 → Level 2 (attenuate)
        let token_l2 = delegate_ucan(
            &token_l1,
            &level1,
            &level2.verifying_key(),
            &[Capability::ReadPrompts, Capability::ReadMemories],
            Duration::from_secs(3600),
        )
        .unwrap();

        // Level 2 → Level 3 (attenuate further)
        let token_l3 = delegate_ucan(
            &token_l2,
            &level2,
            &level3_key.verifying_key(),
            &[Capability::ReadPrompts],
            Duration::from_secs(1800),
        )
        .unwrap();

        // Verify entire chain
        let payload = verify_ucan_chain(&token_l3, &root.verifying_key()).unwrap();
        let caps = capabilities_from_payload(&payload);
        assert_eq!(caps, vec![Capability::ReadPrompts]);
        assert_eq!(payload.aud, did_key_from_pub(&level3_key.verifying_key()));
    }

    #[test]
    fn expired_parent_invalidates_child() {
        let root = test_keypair();
        let delegate = other_keypair();

        // Root creates a token that expires immediately (0 seconds)
        let root_token = create_ucan(
            &root,
            &delegate.verifying_key(),
            &[Capability::ReadPrompts],
            Duration::from_secs(0),
        )
        .unwrap();

        // Delegate creates a child — this succeeds (delegation doesn't re-verify parent signature)
        let agent = third_keypair();
        let delegated_token = delegate_ucan(
            &root_token,
            &delegate,
            &agent.verifying_key(),
            &[Capability::ReadPrompts],
            Duration::from_secs(3600),
        )
        .unwrap();

        // But verification of the chain should fail because the root is expired
        let result = verify_ucan_chain(&delegated_token, &root.verifying_key());
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            crate::error::SaidError::SessionExpired
        ));
    }

    #[test]
    fn empty_prf_backward_compat() {
        let root = test_keypair();
        let audience = other_keypair().verifying_key();

        // Create a standard (non-delegated) token
        let token = create_ucan(
            &root,
            &audience,
            &[Capability::ReadPrompts],
            Duration::from_secs(3600),
        )
        .unwrap();

        // verify_ucan_chain should work the same as verify_ucan for root tokens
        let payload = verify_ucan_chain(&token, &root.verifying_key()).unwrap();
        assert_eq!(payload.iss, did_key_from_pub(&root.verifying_key()));
        assert_eq!(payload.aud, did_key_from_pub(&audience));
        assert!(payload.prf.is_empty());
    }

    #[test]
    fn delegate_wrong_delegator_fails() {
        let root = test_keypair();
        let delegate = other_keypair();
        let wrong_delegator = third_keypair();

        let root_token = create_ucan(
            &root,
            &delegate.verifying_key(),
            &[Capability::ReadPrompts],
            Duration::from_secs(3600),
        )
        .unwrap();

        // wrong_delegator is not the audience of the root token
        let agent = SigningKey::from_bytes(&[55u8; 32]);
        let result = delegate_ucan(
            &root_token,
            &wrong_delegator,
            &agent.verifying_key(),
            &[Capability::ReadPrompts],
            Duration::from_secs(1800),
        );
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            crate::error::SaidError::Auth(_)
        ));
    }
}
