use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, AeadCore, Nonce,
};
use argon2::Argon2;
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroize;

use crate::error::{Result, SaidError};

const NONCE_SIZE: usize = 12;
const SEED_MAGIC: &[u8; 4] = b"SAID";
const SALT_SIZE: usize = 16;

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

/// Check whether a seed file blob is password-encrypted (starts with SAID magic bytes).
pub fn is_seed_encrypted(blob: &[u8]) -> bool {
    blob.len() > 4 && &blob[..4] == SEED_MAGIC
}

/// Encrypt a seed with a password using Argon2id + AES-256-GCM.
/// Returns: magic(4) | salt(16) | nonce(12) | ciphertext | tag(16)
pub fn encrypt_seed_with_password(seed: &[u8], password: &str) -> Result<Vec<u8>> {
    let mut salt = [0u8; SALT_SIZE];
    OsRng.fill_bytes(&mut salt);

    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, &mut key)
        .map_err(|e| SaidError::Encryption(format!("Argon2 error: {}", e)))?;

    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| SaidError::Encryption(e.to_string()))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, seed)
        .map_err(|e| SaidError::Encryption(e.to_string()))?;

    key.zeroize();

    // magic(4) | salt(16) | nonce(12) | ciphertext+tag
    let mut blob = Vec::with_capacity(4 + SALT_SIZE + NONCE_SIZE + ciphertext.len());
    blob.extend_from_slice(SEED_MAGIC);
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// Decrypt a password-encrypted seed blob.
/// Expects: magic(4) | salt(16) | nonce(12) | ciphertext | tag(16)
pub fn decrypt_seed_with_password(blob: &[u8], password: &str) -> Result<Vec<u8>> {
    let min_len = 4 + SALT_SIZE + NONCE_SIZE + 16;
    if blob.len() < min_len {
        return Err(SaidError::Decryption(
            "encrypted seed blob too short".into(),
        ));
    }
    if &blob[..4] != SEED_MAGIC {
        return Err(SaidError::Decryption("invalid seed magic bytes".into()));
    }

    let salt = &blob[4..4 + SALT_SIZE];
    let nonce_bytes = &blob[4 + SALT_SIZE..4 + SALT_SIZE + NONCE_SIZE];
    let ciphertext = &blob[4 + SALT_SIZE + NONCE_SIZE..];

    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| SaidError::Decryption(format!("Argon2 error: {}", e)))?;

    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| SaidError::Decryption(e.to_string()))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| SaidError::WrongPassword)?;

    key.zeroize();
    Ok(plaintext)
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

    #[test]
    fn seed_password_roundtrip() {
        let seed = [42u8; 64];
        let password = "test-password-123";
        let blob = encrypt_seed_with_password(&seed, password).unwrap();
        assert!(is_seed_encrypted(&blob));
        assert!(&blob[..4] == b"SAID");
        let decrypted = decrypt_seed_with_password(&blob, password).unwrap();
        assert_eq!(decrypted, seed);
    }

    #[test]
    fn seed_password_wrong_password() {
        let seed = [42u8; 64];
        let blob = encrypt_seed_with_password(&seed, "correct").unwrap();
        let result = decrypt_seed_with_password(&blob, "wrong");
        assert!(result.is_err());
    }

    #[test]
    fn unencrypted_seed_not_detected() {
        let raw_seed = [42u8; 64];
        assert!(!is_seed_encrypted(&raw_seed));
    }
}
