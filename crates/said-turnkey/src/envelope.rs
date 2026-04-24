//! AES-256-GCM envelope primitives.
//!
//! Matches the pattern already used by `thumper-cloud` for Gmail OAuth tokens:
//! a random 12-byte nonce is prepended to the AEAD ciphertext (which includes
//! the 16-byte tag). The result is `nonce || ciphertext_and_tag`.
//!
//! This module is deliberately tiny and backend-agnostic. Both `LocalVault`
//! and any future HSM-backed vault use the same wire format for
//! `merchant_credentials.ciphertext`, so the gateway can decrypt without
//! knowing which backend wrote the row.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use rand::RngCore;

use crate::VaultError;

/// Encrypt `plaintext` under the given 32-byte key. Returns
/// `nonce(12) || aead_ciphertext_with_tag(len(plaintext) + 16)`.
pub fn seal(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, VaultError> {
    let cipher = Aes256Gcm::new(key.into());
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ct = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| VaultError::Encrypt(e.to_string()))?;

    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Reverse of [`seal`]. Rejects inputs shorter than `nonce(12) + tag(16)`.
pub fn open(key: &[u8; 32], sealed: &[u8]) -> Result<Vec<u8>, VaultError> {
    if sealed.len() < 12 + 16 {
        return Err(VaultError::Decrypt("sealed blob too short".into()));
    }
    let (nonce_bytes, ct) = sealed.split_at(12);
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ct)
        .map_err(|e| VaultError::Decrypt(e.to_string()))
}

/// Parse a 64-character hex string into a 32-byte key. Used for
/// `GHOLA_VAULT_KEY` at startup.
pub fn parse_hex_key(hex_str: &str) -> Result<[u8; 32], VaultError> {
    let bytes =
        hex::decode(hex_str).map_err(|e| VaultError::InvalidKey(format!("hex decode: {e}")))?;
    if bytes.len() != 32 {
        return Err(VaultError::InvalidKey(format!(
            "expected 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let key = [7u8; 32];
        let pt = b"sk-merchant-secret-abcdef";
        let sealed = seal(&key, pt).unwrap();
        assert!(sealed.len() >= 12 + pt.len() + 16);
        let opened = open(&key, &sealed).unwrap();
        assert_eq!(opened, pt);
    }

    #[test]
    fn wrong_key_fails() {
        let key = [7u8; 32];
        let wrong = [8u8; 32];
        let sealed = seal(&key, b"hello").unwrap();
        assert!(open(&wrong, &sealed).is_err());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let key = [7u8; 32];
        let mut sealed = seal(&key, b"hello").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0xff;
        assert!(open(&key, &sealed).is_err());
    }

    #[test]
    fn short_blob_rejected() {
        let key = [7u8; 32];
        assert!(open(&key, &[0u8; 10]).is_err());
    }

    #[test]
    fn parse_hex_key_roundtrip() {
        let hex = "0101010101010101010101010101010101010101010101010101010101010101";
        let key = parse_hex_key(hex).unwrap();
        assert_eq!(key, [1u8; 32]);
    }

    #[test]
    fn parse_hex_key_rejects_wrong_length() {
        assert!(parse_hex_key("deadbeef").is_err());
    }
}
