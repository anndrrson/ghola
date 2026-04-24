use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use ed25519_dalek::{Signature, Verifier, VerifyingKey, PUBLIC_KEY_LENGTH, SIGNATURE_LENGTH};

use thumper_types::AuthPayload;

use crate::error::RelayError;

/// Cache of recently-seen nonces to prevent replay attacks.
/// Nonces are stored for `ttl` seconds, then pruned.
#[derive(Clone)]
pub struct NonceCache {
    inner: Arc<DashMap<String, Instant>>,
    ttl_secs: u64,
}

impl NonceCache {
    pub fn new(ttl_secs: u64) -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
            ttl_secs,
        }
    }

    /// Returns true if the nonce was already seen (replay detected).
    pub fn check_and_insert(&self, nonce: &str) -> bool {
        if self.inner.contains_key(nonce) {
            return true; // replay
        }
        self.inner.insert(nonce.to_string(), Instant::now());
        false
    }

    /// Remove expired nonces.
    pub fn prune(&self) {
        let cutoff = Instant::now() - std::time::Duration::from_secs(self.ttl_secs);
        self.inner.retain(|_, v| *v > cutoff);
    }
}

/// Verify an authentication payload. Returns the authenticated pubkey on success.
///
/// In dev mode, signature verification is skipped — only timestamp is checked.
pub fn verify_auth(
    payload: &AuthPayload,
    auth_timeout_secs: u64,
    dev_mode: bool,
    nonce_cache: Option<&NonceCache>,
) -> Result<String, RelayError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| RelayError::Internal("system clock error".into()))?
        .as_secs();

    let elapsed = now.saturating_sub(payload.message.timestamp);
    if elapsed > auth_timeout_secs {
        return Err(RelayError::Auth("auth message expired".into()));
    }

    if payload.message.timestamp > now.saturating_add(30) {
        return Err(RelayError::Auth(
            "auth message timestamp in the future".into(),
        ));
    }

    // Check nonce for replay prevention
    if let Some(cache) = nonce_cache {
        if cache.check_and_insert(&payload.message.nonce) {
            return Err(RelayError::Auth(
                "nonce already used (replay detected)".into(),
            ));
        }
    }

    // In dev mode, trust the pubkey without verifying the signature
    if dev_mode {
        tracing::warn!(
            pubkey = %payload.message.pubkey,
            "dev mode: skipping signature verification"
        );
        return Ok(payload.message.pubkey.clone());
    }

    // Decode pubkey from base58
    let pubkey_bytes = bs58_decode(&payload.message.pubkey)
        .map_err(|_| RelayError::Auth("invalid pubkey encoding".into()))?;

    if pubkey_bytes.len() != PUBLIC_KEY_LENGTH {
        return Err(RelayError::Auth("invalid pubkey length".into()));
    }

    let mut key_array = [0u8; PUBLIC_KEY_LENGTH];
    key_array.copy_from_slice(&pubkey_bytes);
    let verifying_key = VerifyingKey::from_bytes(&key_array)
        .map_err(|_| RelayError::Auth("invalid public key".into()))?;

    // Decode signature from base64
    let sig_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &payload.signature,
    )
    .map_err(|_| RelayError::Auth("invalid signature encoding".into()))?;

    if sig_bytes.len() != SIGNATURE_LENGTH {
        return Err(RelayError::Auth("invalid signature length".into()));
    }

    let signature = Signature::from_bytes(
        sig_bytes
            .as_slice()
            .try_into()
            .map_err(|_| RelayError::Auth("invalid signature length".into()))?,
    );

    let message_bytes = payload.message.canonical_bytes();

    verifying_key
        .verify(&message_bytes, &signature)
        .map_err(|_| RelayError::Auth("signature verification failed".into()))?;

    Ok(payload.message.pubkey.clone())
}

/// Minimal base58 decoding (Bitcoin/Solana alphabet). Exported for testing.
pub(crate) fn bs58_decode(input: &str) -> Result<Vec<u8>, ()> {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    let mut result: Vec<u8> = Vec::new();

    for &c in input.as_bytes() {
        let mut carry = ALPHABET.iter().position(|&a| a == c).ok_or(())? as u32;
        for byte in result.iter_mut() {
            let val = (*byte as u32) * 58 + carry;
            *byte = (val & 0xFF) as u8;
            carry = val >> 8;
        }
        while carry > 0 {
            result.push((carry & 0xFF) as u8);
            carry >>= 8;
        }
    }

    for &c in input.as_bytes() {
        if c == b'1' {
            result.push(0);
        } else {
            break;
        }
    }

    result.reverse();
    Ok(result)
}
