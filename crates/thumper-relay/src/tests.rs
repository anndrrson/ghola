use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;

use thumper_types::{AuthMessage, AuthPayload, ConnectionRole};

use crate::auth::{verify_auth, NonceCache};
use crate::state::RateLimiter;

// -- NonceCache tests --

#[test]
fn nonce_cache_detects_replay() {
    let cache = NonceCache::new(300);
    assert!(!cache.check_and_insert("nonce-1")); // first time: not a replay
    assert!(cache.check_and_insert("nonce-1")); // second time: replay detected
}

#[test]
fn nonce_cache_allows_different_nonces() {
    let cache = NonceCache::new(300);
    assert!(!cache.check_and_insert("nonce-1"));
    assert!(!cache.check_and_insert("nonce-2"));
    assert!(!cache.check_and_insert("nonce-3"));
}

#[test]
fn nonce_cache_prune_is_safe() {
    let cache = NonceCache::new(300);
    cache.check_and_insert("nonce-1");
    cache.prune(); // should not panic, nonce is recent so it stays
    assert!(cache.check_and_insert("nonce-1")); // still there
}

// -- verify_auth tests --

fn make_auth_payload(
    pubkey: &str,
    timestamp: u64,
    nonce: &str,
    role: ConnectionRole,
) -> AuthPayload {
    AuthPayload {
        message: AuthMessage {
            pubkey: pubkey.into(),
            timestamp,
            nonce: nonce.into(),
            role,
        },
        signature: String::new(),
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[test]
fn verify_auth_dev_mode_accepts_any_pubkey() {
    let payload = make_auth_payload("fake_key", now_secs(), "nonce-1", ConnectionRole::Device);

    let result = verify_auth(&payload, 300, true, None);
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), "fake_key");
}

#[test]
fn verify_auth_expired_timestamp() {
    let old_time = now_secs() - 600; // 10 minutes ago, exceeds 300s timeout
    let payload = make_auth_payload("key", old_time, "nonce-1", ConnectionRole::Device);

    let result = verify_auth(&payload, 300, true, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("expired"));
}

#[test]
fn verify_auth_future_timestamp() {
    let future_time = now_secs() + 60; // 60 seconds in the future (>30s threshold)
    let payload = make_auth_payload("key", future_time, "nonce-1", ConnectionRole::Device);

    let result = verify_auth(&payload, 300, true, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("future"));
}

#[test]
fn verify_auth_replayed_nonce() {
    let cache = NonceCache::new(300);
    let payload = make_auth_payload("key", now_secs(), "same-nonce", ConnectionRole::Device);

    // First attempt should succeed
    let result = verify_auth(&payload, 300, true, Some(&cache));
    assert!(result.is_ok());

    // Second attempt with same nonce should fail
    let result = verify_auth(&payload, 300, true, Some(&cache));
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("replay"));
}

#[test]
fn verify_auth_valid_ed25519_signature() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let pubkey_bytes = verifying_key.as_bytes();

    // Base58 encode the pubkey
    let pubkey_b58 = bs58_encode(pubkey_bytes);

    let message = AuthMessage {
        pubkey: pubkey_b58.clone(),
        timestamp: now_secs(),
        nonce: "valid-nonce".into(),
        role: ConnectionRole::McpClient,
    };

    let canonical = message.canonical_bytes();
    let signature = signing_key.sign(&canonical);
    let sig_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        signature.to_bytes(),
    );

    let payload = AuthPayload {
        message,
        signature: sig_b64,
    };

    // Production mode (dev_mode = false)
    let result = verify_auth(&payload, 300, false, None);
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), pubkey_b58);
}

#[test]
fn verify_auth_invalid_signature_rejected() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    let pubkey_bytes = verifying_key.as_bytes();
    let pubkey_b58 = bs58_encode(pubkey_bytes);

    let message = AuthMessage {
        pubkey: pubkey_b58,
        timestamp: now_secs(),
        nonce: "nonce-invalid-sig".into(),
        role: ConnectionRole::Device,
    };

    // Sign with a DIFFERENT key
    let wrong_key = SigningKey::generate(&mut OsRng);
    let canonical = message.canonical_bytes();
    let bad_sig = wrong_key.sign(&canonical);
    let sig_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        bad_sig.to_bytes(),
    );

    let payload = AuthPayload {
        message,
        signature: sig_b64,
    };

    let result = verify_auth(&payload, 300, false, None);
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("signature verification failed"));
}

#[test]
fn verify_auth_invalid_pubkey_encoding() {
    let payload = AuthPayload {
        message: AuthMessage {
            pubkey: "not-valid-base58!!!".into(),
            timestamp: now_secs(),
            nonce: "nonce-bad-key".into(),
            role: ConnectionRole::Device,
        },
        signature: "AAAA".into(), // some base64
    };

    let result = verify_auth(&payload, 300, false, None);
    assert!(result.is_err());
}

// -- RateLimiter tests --

#[test]
fn rate_limiter_allows_burst_up_to_max() {
    let mut limiter = RateLimiter::new(5);
    for _ in 0..5 {
        assert!(limiter.try_consume());
    }
    // 6th should fail
    assert!(!limiter.try_consume());
}

#[test]
fn rate_limiter_refills_over_time() {
    let mut limiter = RateLimiter::new(10);
    // Consume all tokens
    for _ in 0..10 {
        limiter.try_consume();
    }
    assert!(!limiter.try_consume());

    // Wait a bit for refill
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert!(limiter.try_consume());
}

// -- bs58 helper --

fn bs58_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    if input.is_empty() {
        return String::new();
    }

    let mut digits: Vec<u8> = Vec::new();
    for &byte in input {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            let val = (*d as u32) * 256 + carry;
            *d = (val % 58) as u8;
            carry = val / 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }

    // Leading zeros
    for &byte in input {
        if byte == 0 {
            digits.push(0);
        } else {
            break;
        }
    }

    digits.reverse();
    digits
        .into_iter()
        .map(|d| ALPHABET[d as usize] as char)
        .collect()
}

#[test]
fn bs58_encode_decode_roundtrip() {
    let original = [1, 2, 3, 4, 5, 6, 7, 8];
    let encoded = bs58_encode(&original);
    let decoded = crate::auth::bs58_decode(&encoded).unwrap();
    assert_eq!(decoded, original);
}
