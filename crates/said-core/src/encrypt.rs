use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, AeadCore, Nonce,
};
use hkdf::Hkdf;
use sha2::Sha256;

use crate::error::{Result, SaidError};

const NONCE_SIZE: usize = 12;

/// Encrypt plaintext using AES-256-GCM.
/// Returns `[nonce(12) | ciphertext | tag(16)]`.
pub fn encrypt_blob(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| SaidError::Encryption(e.to_string()))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| SaidError::Encryption(e.to_string()))?;

    let mut blob = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// Decrypt a blob produced by `encrypt_blob`.
/// Expects: `[nonce(12) | ciphertext | tag(16)]`.
pub fn decrypt_blob(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < NONCE_SIZE + 16 {
        return Err(SaidError::Decryption(
            "blob too short to contain nonce and tag".into(),
        ));
    }
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| SaidError::Decryption(e.to_string()))?;
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| SaidError::Decryption(e.to_string()))
}

/// Derive a 32-byte key from seed material using HKDF-SHA256.
pub fn derive_key(seed: &[u8], context: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(b"said-wallet-v1"), seed);
    let mut key = [0u8; 32];
    hk.expand(context, &mut key)
        .expect("HKDF expand should not fail for 32-byte output");
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = [42u8; 32];
        let plaintext = b"hello, said wallet!";
        let blob = encrypt_blob(&key, plaintext).unwrap();
        assert_eq!(blob.len(), 12 + plaintext.len() + 16);
        let decrypted = decrypt_blob(&key, &blob).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn decrypt_wrong_key_fails() {
        let key = [1u8; 32];
        let wrong_key = [2u8; 32];
        let blob = encrypt_blob(&key, b"secret").unwrap();
        assert!(decrypt_blob(&wrong_key, &blob).is_err());
    }

    #[test]
    fn decrypt_truncated_blob_fails() {
        let key = [1u8; 32];
        assert!(decrypt_blob(&key, &[0u8; 20]).is_err());
    }

    #[test]
    fn derive_key_deterministic() {
        let seed = b"test-seed-material";
        let k1 = derive_key(seed, b"context-a");
        let k2 = derive_key(seed, b"context-a");
        assert_eq!(k1, k2);
    }

    #[test]
    fn derive_key_different_contexts() {
        let seed = b"test-seed-material";
        let k1 = derive_key(seed, b"context-a");
        let k2 = derive_key(seed, b"context-b");
        assert_ne!(k1, k2);
    }

    #[test]
    fn unique_nonces() {
        let key = [99u8; 32];
        let blob1 = encrypt_blob(&key, b"same").unwrap();
        let blob2 = encrypt_blob(&key, b"same").unwrap();
        assert_ne!(&blob1[..12], &blob2[..12]);
    }
}
