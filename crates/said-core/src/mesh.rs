//! Agent mesh primitives: challenge/response identity verification
//! and X25519-based encrypted channels between SAID wallets.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Signer, Verifier, SigningKey, VerifyingKey};
use rand::RngCore;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

use crate::encrypt::{decrypt_blob, encrypt_blob};
use crate::error::SaidError;
use crate::ucan::{did_key_from_pub, pub_key_from_did_key, xprv_to_signing_key};
use crate::{Result, Wallet};
use said_types::{KeyType, Provider};

// ── Challenge / Response ──

/// Create a challenge for wallet identity verification.
/// Returns `(challenge_string, nonce_bytes)`.
pub fn create_challenge() -> (String, [u8; 32]) {
    let mut nonce = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut nonce);
    let challenge = URL_SAFE_NO_PAD.encode(&nonce);
    (challenge, nonce)
}

/// Respond to an identity challenge by signing the nonce with the master key.
pub fn respond_to_challenge(wallet: &Wallet, challenge: &str) -> Result<String> {
    let nonce_bytes = URL_SAFE_NO_PAD
        .decode(challenge)
        .map_err(|e| SaidError::Encryption(format!("Invalid challenge: {}", e)))?;
    let master_xprv = wallet.derive_provider_key(Provider::Master, KeyType::Signing, 0);
    let signing_key = xprv_to_signing_key(&master_xprv);
    let signature = signing_key.sign(&nonce_bytes);
    Ok(URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

/// Verify a challenge response against an expected DID.
pub fn verify_challenge_response(
    response: &str,
    expected_did: &str,
    nonce: &[u8; 32],
) -> Result<bool> {
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(response)
        .map_err(|e| SaidError::Encryption(format!("Invalid response: {}", e)))?;
    let signature = Signature::from_slice(&sig_bytes)
        .map_err(|e| SaidError::Encryption(format!("Invalid signature: {}", e)))?;
    let pub_key = pub_key_from_did_key(expected_did)?;
    Ok(pub_key.verify(nonce, &signature).is_ok())
}

// ── Encrypted Channels (X25519 ECDH) ──

/// Convert an Ed25519 signing key to an X25519 static secret.
///
/// Uses the standard Ed25519-to-X25519 conversion: hash the seed with SHA-512,
/// clamp the first 32 bytes, and use as the X25519 scalar.
fn ed25519_to_x25519_secret(signing_key: &SigningKey) -> StaticSecret {
    use sha2::{Digest, Sha512};
    let hash = Sha512::digest(signing_key.to_bytes());
    let mut key_bytes = [0u8; 32];
    key_bytes.copy_from_slice(&hash[..32]);
    StaticSecret::from(key_bytes)
}

/// Convert an Ed25519 verifying key to an X25519 public key.
///
/// Maps the compressed Edwards Y point to its Montgomery form.
fn ed25519_to_x25519_public(verifying_key: &VerifyingKey) -> Result<X25519PublicKey> {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    let compressed = CompressedEdwardsY(*verifying_key.as_bytes());
    let edwards = compressed
        .decompress()
        .ok_or_else(|| SaidError::Encryption("Failed to decompress Ed25519 point".into()))?;
    let montgomery = edwards.to_montgomery();
    Ok(X25519PublicKey::from(montgomery.to_bytes()))
}

/// Derive a shared secret between our signing key and their public key using X25519 ECDH.
pub fn derive_shared_secret(
    our_signing_key: &SigningKey,
    their_pub_key: &VerifyingKey,
) -> Result<[u8; 32]> {
    let our_secret = ed25519_to_x25519_secret(our_signing_key);
    let their_public = ed25519_to_x25519_public(their_pub_key)?;
    let shared = our_secret.diffie_hellman(&their_public);
    Ok(shared.to_bytes())
}

/// Encrypt a message for a specific recipient identified by DID.
pub fn encrypt_for_recipient(
    wallet: &Wallet,
    recipient_did: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let recipient_pub = pub_key_from_did_key(recipient_did)?;
    let master_xprv = wallet.derive_provider_key(Provider::Master, KeyType::Signing, 0);
    let master_key = xprv_to_signing_key(&master_xprv);
    let shared_secret = derive_shared_secret(&master_key, &recipient_pub)?;
    encrypt_blob(&shared_secret, plaintext)
}

/// Decrypt a message from a specific sender identified by DID.
pub fn decrypt_from_sender(
    wallet: &Wallet,
    sender_did: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>> {
    let sender_pub = pub_key_from_did_key(sender_did)?;
    let master_xprv = wallet.derive_provider_key(Provider::Master, KeyType::Signing, 0);
    let master_key = xprv_to_signing_key(&master_xprv);
    let shared_secret = derive_shared_secret(&master_key, &sender_pub)?;
    decrypt_blob(&shared_secret, ciphertext)
}

/// Get the DID of this wallet's master signing key.
pub fn wallet_did(wallet: &Wallet) -> String {
    let master_xprv = wallet.derive_provider_key(Provider::Master, KeyType::Signing, 0);
    let verifying_key = xprv_to_signing_key(&master_xprv).verifying_key();
    did_key_from_pub(&verifying_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_wallet() -> (Wallet, TempDir) {
        let dir = TempDir::new().unwrap();
        let wallet_dir = dir.path().join(".said");
        let (wallet, _phrase) = Wallet::init(&wallet_dir, None).unwrap();
        (wallet, dir)
    }

    #[test]
    fn challenge_response_roundtrip() {
        let (wallet, _dir) = test_wallet();
        let did = wallet_did(&wallet);

        let (challenge, nonce) = create_challenge();
        let response = respond_to_challenge(&wallet, &challenge).unwrap();
        let valid = verify_challenge_response(&response, &did, &nonce).unwrap();
        assert!(valid);
    }

    #[test]
    fn challenge_response_wrong_did() {
        let (wallet, _dir) = test_wallet();
        let (wallet2, _dir2) = test_wallet();
        let wrong_did = wallet_did(&wallet2);

        let (challenge, nonce) = create_challenge();
        let response = respond_to_challenge(&wallet, &challenge).unwrap();
        let valid = verify_challenge_response(&response, &wrong_did, &nonce).unwrap();
        assert!(!valid);
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let (wallet_a, _dir_a) = test_wallet();
        let (wallet_b, _dir_b) = test_wallet();
        let did_a = wallet_did(&wallet_a);
        let did_b = wallet_did(&wallet_b);

        let plaintext = b"hello from wallet A to wallet B";
        let ciphertext = encrypt_for_recipient(&wallet_a, &did_b, plaintext).unwrap();
        let decrypted = decrypt_from_sender(&wallet_b, &did_a, &ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn shared_secret_symmetry() {
        let (wallet_a, _dir_a) = test_wallet();
        let (wallet_b, _dir_b) = test_wallet();

        let key_a = xprv_to_signing_key(
            &wallet_a.derive_provider_key(Provider::Master, KeyType::Signing, 0),
        );
        let key_b = xprv_to_signing_key(
            &wallet_b.derive_provider_key(Provider::Master, KeyType::Signing, 0),
        );

        let secret_ab = derive_shared_secret(&key_a, &key_b.verifying_key()).unwrap();
        let secret_ba = derive_shared_secret(&key_b, &key_a.verifying_key()).unwrap();
        assert_eq!(secret_ab, secret_ba);
    }

    #[test]
    fn decrypt_with_wrong_wallet_fails() {
        let (wallet_a, _dir_a) = test_wallet();
        let (wallet_b, _dir_b) = test_wallet();
        let (wallet_c, _dir_c) = test_wallet();
        let did_b = wallet_did(&wallet_b);
        let did_a = wallet_did(&wallet_a);

        let plaintext = b"secret message";
        let ciphertext = encrypt_for_recipient(&wallet_a, &did_b, plaintext).unwrap();

        // Wallet C should NOT be able to decrypt a message from A to B
        let result = decrypt_from_sender(&wallet_c, &did_a, &ciphertext);
        assert!(result.is_err());
    }
}
