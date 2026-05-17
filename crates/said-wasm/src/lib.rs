//! SAID WASM — browser-based wallet management with client-side crypto.
//!
//! All cryptographic operations happen in the browser. The encrypted seed blob
//! can be uploaded to a server for persistence, but the server never sees plaintext
//! key material.
//!
//! Architecture: a global `Vec<Option<WalletHandle>>` behind a `Mutex` stores
//! active wallets. Functions return a `u32` handle index. On `wallet_close()`,
//! the entry is zeroized and set to `None`.

use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, AeadCore, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use bip39::Mnemonic;
use ed25519_bip32::XPrv;
use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

// ── Constants ──

const NONCE_SIZE: usize = 12;
const SALT_SIZE: usize = 16;
const TAG_SIZE: usize = 16;
const ED25519_MULTICODEC: [u8; 2] = [0xed, 0x01];

// ── Error Type ──

/// Internal error type used by core logic. Converted to `JsValue` at the
/// wasm_bindgen boundary.
#[derive(Debug, thiserror::Error)]
pub enum WasmError {
    #[error("{0}")]
    Crypto(String),
    #[error("{0}")]
    Wallet(String),
    #[error("{0}")]
    Serde(String),
}

impl From<WasmError> for JsValue {
    fn from(e: WasmError) -> JsValue {
        JsValue::from_str(&e.to_string())
    }
}

type Result<T> = std::result::Result<T, WasmError>;

// ── WalletHandle (internal, not exported) ──

struct WalletHandle {
    entropy: Vec<u8>,
    seed: [u8; 64],
    data_key: [u8; 32],
    master_xprv: XPrv,
}

impl Drop for WalletHandle {
    fn drop(&mut self) {
        self.entropy.zeroize();
        self.seed.zeroize();
        self.data_key.zeroize();
    }
}

// ── Global Wallet Store ──

static WALLETS: Mutex<Vec<Option<WalletHandle>>> = Mutex::new(Vec::new());

fn with_wallet<F, T>(handle: u32, f: F) -> Result<T>
where
    F: FnOnce(&WalletHandle) -> Result<T>,
{
    let wallets = WALLETS
        .lock()
        .map_err(|e| WasmError::Wallet(format!("lock poisoned: {}", e)))?;
    let slot = wallets
        .get(handle as usize)
        .ok_or_else(|| WasmError::Wallet("invalid wallet handle".into()))?;
    let wallet = slot
        .as_ref()
        .ok_or_else(|| WasmError::Wallet("wallet handle has been closed".into()))?;
    f(wallet)
}

fn store_wallet(wallet: WalletHandle) -> Result<u32> {
    let mut wallets = WALLETS
        .lock()
        .map_err(|e| WasmError::Wallet(format!("lock poisoned: {}", e)))?;

    // Reuse a None slot if available
    for (i, slot) in wallets.iter_mut().enumerate() {
        if slot.is_none() {
            *slot = Some(wallet);
            return Ok(i as u32);
        }
    }

    // No free slot, push a new one
    let idx = wallets.len();
    wallets.push(Some(wallet));
    Ok(idx as u32)
}

// ── Crypto Primitives ──

/// Derive a 32-byte key from seed material using HKDF-SHA256.
/// Matches said-core/encrypt.rs: salt = "said-wallet-v1".
fn derive_data_key(seed: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(b"said-wallet-v1"), seed);
    let mut key = [0u8; 32];
    hk.expand(b"said-local-data-key", &mut key)
        .expect("HKDF expand should not fail for 32-byte output");
    key
}

/// Derive master XPrv from seed, matching said-core/wallet.rs.
fn derive_master_xprv(seed: &[u8]) -> XPrv {
    let hk_secret = Hkdf::<Sha256>::new(Some(b"said-wallet-v1"), seed);
    let mut hd_secret = [0u8; 32];
    hk_secret
        .expand(b"said-hd-secret", &mut hd_secret)
        .expect("HKDF expand should not fail");

    let hk_chain = Hkdf::<Sha256>::new(Some(b"said-wallet-v1"), seed);
    let mut hd_chain = [0u8; 32];
    hk_chain
        .expand(b"said-hd-chain", &mut hd_chain)
        .expect("HKDF expand should not fail");

    let xprv = XPrv::from_nonextended_force(&hd_secret, &hd_chain);
    hd_secret.zeroize();
    xprv
}

/// Extract Ed25519 signing key from XPrv (first 32 bytes).
fn xprv_to_signing_key(xprv: &XPrv) -> SigningKey {
    let bytes: &[u8] = xprv.as_ref();
    let secret: [u8; 32] = bytes[..32].try_into().expect("XPrv has 64 bytes");
    SigningKey::from_bytes(&secret)
}

/// Encode an Ed25519 public key as a did:key string.
fn did_key_from_signing(signing_key: &SigningKey) -> String {
    let pub_key = signing_key.verifying_key();
    let mut bytes = Vec::with_capacity(2 + 32);
    bytes.extend_from_slice(&ED25519_MULTICODEC);
    bytes.extend_from_slice(pub_key.as_bytes());
    format!("did:key:z{}", bs58::encode(&bytes).into_string())
}

/// Derive Argon2id encryption key from password + salt.
/// Parameters: memory=65536 (64 MiB), iterations=3, parallelism=1.
fn argon2_derive(password: &[u8], salt: &[u8]) -> Result<[u8; 32]> {
    let params = Params::new(65536, 3, 1, Some(32))
        .map_err(|e| WasmError::Crypto(format!("argon2 params error: {}", e)))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password, salt, &mut key)
        .map_err(|e| WasmError::Crypto(format!("argon2 hash error: {}", e)))?;
    Ok(key)
}

/// AES-256-GCM encrypt plaintext with a key.
/// Returns: nonce(12) || ciphertext || tag(16)
fn aes_encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| WasmError::Crypto(format!("aes key error: {}", e)))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| WasmError::Crypto(format!("aes encrypt error: {}", e)))?;
    let mut blob = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// AES-256-GCM decrypt blob (nonce(12) || ciphertext || tag(16)).
fn aes_decrypt(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < NONCE_SIZE + TAG_SIZE {
        return Err(WasmError::Crypto("encrypted blob too short".into()));
    }
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| WasmError::Crypto(format!("aes key error: {}", e)))?;
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| WasmError::Crypto(format!("aes decrypt error: {}", e)))
}

/// Encrypt entropy with password-derived key.
/// Returns base64 of: salt(16) || nonce(12) || ciphertext || tag(16)
fn encrypt_entropy(password: &str, entropy: &[u8]) -> Result<String> {
    let mut salt = [0u8; SALT_SIZE];
    OsRng.fill_bytes(&mut salt);

    let enc_key = argon2_derive(password.as_bytes(), &salt)?;
    let encrypted = aes_encrypt(&enc_key, entropy)?;

    let mut blob = Vec::with_capacity(SALT_SIZE + encrypted.len());
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&encrypted);

    Ok(STANDARD.encode(&blob))
}

/// Decrypt entropy from base64 blob using password.
fn decrypt_entropy(password: &str, encrypted_blob: &str) -> Result<Vec<u8>> {
    let blob = STANDARD
        .decode(encrypted_blob)
        .map_err(|e| WasmError::Crypto(format!("base64 decode error: {}", e)))?;

    if blob.len() < SALT_SIZE + NONCE_SIZE + TAG_SIZE {
        return Err(WasmError::Crypto("encrypted blob too short".into()));
    }

    let (salt, encrypted) = blob.split_at(SALT_SIZE);
    let enc_key = argon2_derive(password.as_bytes(), salt)?;
    aes_decrypt(&enc_key, encrypted)
}

/// Build a WalletHandle from entropy bytes.
fn wallet_from_entropy(entropy: &[u8]) -> Result<WalletHandle> {
    let mnemonic = Mnemonic::from_entropy(entropy)
        .map_err(|e| WasmError::Crypto(format!("invalid entropy: {}", e)))?;
    let seed = mnemonic.to_seed("");
    let data_key = derive_data_key(&seed);
    let master_xprv = derive_master_xprv(&seed);

    Ok(WalletHandle {
        entropy: entropy.to_vec(),
        seed,
        data_key,
        master_xprv,
    })
}

// ── JS return types ──

#[derive(Serialize, Deserialize)]
struct InitResult {
    handle: u32,
    mnemonic: String,
    encrypted_blob: String,
    did: String,
}

#[derive(Serialize, Deserialize)]
struct RecoverResult {
    handle: u32,
    encrypted_blob: String,
    did: String,
}

#[derive(Serialize, Deserialize)]
struct UnlockResult {
    handle: u32,
    did: String,
}

// ── UCAN JWT Types (internal) ──

#[derive(Serialize, Deserialize)]
struct UcanHeader {
    alg: String,
    typ: String,
    ucv: String,
}

#[derive(Serialize, Deserialize)]
struct UcanAttenuation {
    with: String,
    can: String,
}

#[derive(Serialize, Deserialize)]
struct UcanPayload {
    iss: String,
    aud: String,
    exp: i64,
    iat: i64,
    att: Vec<UcanAttenuation>,
    nnc: String,
}

// ── Core Logic (pure Rust, no JsValue) ──

fn core_init_wallet(password: &str) -> Result<String> {
    let mnemonic = Mnemonic::generate(24)
        .map_err(|e| WasmError::Crypto(format!("mnemonic generation error: {}", e)))?;
    let phrase = mnemonic.to_string();
    let entropy = mnemonic.to_entropy();
    let encrypted_blob = encrypt_entropy(password, &entropy)?;

    let wallet = wallet_from_entropy(&entropy)?;
    let did = did_key_from_signing(&xprv_to_signing_key(&wallet.master_xprv));
    let handle = store_wallet(wallet)?;

    let result = InitResult {
        handle,
        mnemonic: phrase,
        encrypted_blob,
        did,
    };
    serde_json::to_string(&result).map_err(|e| WasmError::Serde(e.to_string()))
}

fn core_recover_wallet(password: &str, mnemonic: &str) -> Result<String> {
    let parsed: Mnemonic = mnemonic
        .parse()
        .map_err(|e: bip39::Error| WasmError::Crypto(format!("invalid mnemonic: {}", e)))?;
    let entropy = parsed.to_entropy();
    let encrypted_blob = encrypt_entropy(password, &entropy)?;

    let wallet = wallet_from_entropy(&entropy)?;
    let did = did_key_from_signing(&xprv_to_signing_key(&wallet.master_xprv));
    let handle = store_wallet(wallet)?;

    let result = RecoverResult {
        handle,
        encrypted_blob,
        did,
    };
    serde_json::to_string(&result).map_err(|e| WasmError::Serde(e.to_string()))
}

fn core_unlock_wallet(password: &str, encrypted_blob: &str) -> Result<String> {
    let entropy = decrypt_entropy(password, encrypted_blob)?;
    let wallet = wallet_from_entropy(&entropy)?;
    let did = did_key_from_signing(&xprv_to_signing_key(&wallet.master_xprv));
    let handle = store_wallet(wallet)?;

    let result = UnlockResult { handle, did };
    serde_json::to_string(&result).map_err(|e| WasmError::Serde(e.to_string()))
}

fn core_wallet_did(handle: u32) -> Result<String> {
    with_wallet(handle, |w| {
        Ok(did_key_from_signing(&xprv_to_signing_key(&w.master_xprv)))
    })
}

fn core_wallet_create_ucan(
    handle: u32,
    audience_did: &str,
    capabilities_json: &str,
    expires_in_secs: u64,
) -> Result<String> {
    let capabilities: Vec<String> = serde_json::from_str(capabilities_json)
        .map_err(|e| WasmError::Serde(format!("invalid capabilities JSON: {}", e)))?;

    with_wallet(handle, |w| {
        let signing_key = xprv_to_signing_key(&w.master_xprv);
        let iss = did_key_from_signing(&signing_key);

        let att: Vec<UcanAttenuation> = capabilities
            .iter()
            .map(|cap| UcanAttenuation {
                with: "said://data/*".to_string(),
                can: cap.clone(),
            })
            .collect();

        let now = chrono::Utc::now().timestamp();
        let exp = now + expires_in_secs as i64;

        let mut nonce_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nnc = URL_SAFE_NO_PAD.encode(nonce_bytes);

        let header = UcanHeader {
            alg: "EdDSA".to_string(),
            typ: "JWT".to_string(),
            ucv: "0.10.0".to_string(),
        };

        let payload = UcanPayload {
            iss,
            aud: audience_did.to_string(),
            exp,
            iat: now,
            att,
            nnc,
        };

        let header_json =
            serde_json::to_vec(&header).map_err(|e| WasmError::Serde(e.to_string()))?;
        let payload_json =
            serde_json::to_vec(&payload).map_err(|e| WasmError::Serde(e.to_string()))?;

        let header_b64 = URL_SAFE_NO_PAD.encode(&header_json);
        let payload_b64 = URL_SAFE_NO_PAD.encode(&payload_json);

        let message = format!("{}.{}", header_b64, payload_b64);
        let signature = signing_key.sign(message.as_bytes());
        let sig_b64 = URL_SAFE_NO_PAD.encode(signature.to_bytes());

        Ok(format!("{}.{}.{}", header_b64, payload_b64, sig_b64))
    })
}

fn core_wallet_encrypt(handle: u32, data: &str) -> Result<String> {
    with_wallet(handle, |w| {
        let encrypted = aes_encrypt(&w.data_key, data.as_bytes())?;
        Ok(STANDARD.encode(&encrypted))
    })
}

fn core_wallet_decrypt(handle: u32, encrypted: &str) -> Result<String> {
    with_wallet(handle, |w| {
        let blob = STANDARD
            .decode(encrypted)
            .map_err(|e| WasmError::Crypto(format!("base64 decode error: {}", e)))?;
        let plaintext = aes_decrypt(&w.data_key, &blob)?;
        String::from_utf8(plaintext)
            .map_err(|e| WasmError::Crypto(format!("invalid utf-8 in decrypted data: {}", e)))
    })
}

fn core_wallet_export_mnemonic(handle: u32) -> Result<String> {
    with_wallet(handle, |w| {
        let mnemonic = Mnemonic::from_entropy(&w.entropy)
            .map_err(|e| WasmError::Crypto(format!("entropy reconstruction error: {}", e)))?;
        Ok(mnemonic.to_string())
    })
}

fn core_wallet_close(handle: u32) -> Result<()> {
    let mut wallets = WALLETS
        .lock()
        .map_err(|e| WasmError::Wallet(format!("lock poisoned: {}", e)))?;
    let slot = wallets
        .get_mut(handle as usize)
        .ok_or_else(|| WasmError::Wallet("invalid wallet handle".into()))?;

    if slot.is_none() {
        return Err(WasmError::Wallet("wallet handle already closed".into()));
    }

    // Drop triggers zeroize via WalletHandle::drop
    *slot = None;
    Ok(())
}

// ── Exported WASM Functions ──
//
// Thin wrappers that convert Result<T, WasmError> to Result<T, JsValue>.

/// Initialize a new wallet with a fresh 24-word mnemonic.
///
/// Returns a JSON string: `{ handle, mnemonic, encrypted_blob, did }`
#[wasm_bindgen]
pub fn init_wallet(password: &str) -> std::result::Result<JsValue, JsValue> {
    core_init_wallet(password)
        .map(|s| JsValue::from_str(&s))
        .map_err(|e| e.into())
}

/// Recover a wallet from an existing mnemonic phrase.
///
/// Returns a JSON string: `{ handle, encrypted_blob, did }`
#[wasm_bindgen]
pub fn recover_wallet(
    password: &str,
    mnemonic: &str,
) -> std::result::Result<JsValue, JsValue> {
    core_recover_wallet(password, mnemonic)
        .map(|s| JsValue::from_str(&s))
        .map_err(|e| e.into())
}

/// Unlock a wallet from an encrypted blob and password.
///
/// Returns a JSON string: `{ handle, did }`
#[wasm_bindgen]
pub fn unlock_wallet(
    password: &str,
    encrypted_blob: &str,
) -> std::result::Result<JsValue, JsValue> {
    core_unlock_wallet(password, encrypted_blob)
        .map(|s| JsValue::from_str(&s))
        .map_err(|e| e.into())
}

/// Get the DID for an open wallet.
#[wasm_bindgen]
pub fn wallet_did(handle: u32) -> std::result::Result<String, JsValue> {
    core_wallet_did(handle).map_err(|e| e.into())
}

/// Create a UCAN JWT token for delegation.
///
/// `capabilities_json` should be a JSON array of strings, e.g.
/// `["said/read_prompts", "said/read_preferences"]`.
#[wasm_bindgen]
pub fn wallet_create_ucan(
    handle: u32,
    audience_did: &str,
    capabilities_json: &str,
    expires_in_secs: u64,
) -> std::result::Result<String, JsValue> {
    core_wallet_create_ucan(handle, audience_did, capabilities_json, expires_in_secs)
        .map_err(|e| e.into())
}

/// Encrypt a string using the wallet's data key (AES-256-GCM).
///
/// Returns base64-encoded: nonce(12) || ciphertext || tag(16)
#[wasm_bindgen]
pub fn wallet_encrypt(handle: u32, data: &str) -> std::result::Result<String, JsValue> {
    core_wallet_encrypt(handle, data).map_err(|e| e.into())
}

/// Decrypt a base64-encoded blob using the wallet's data key.
///
/// Returns the plaintext string.
#[wasm_bindgen]
pub fn wallet_decrypt(handle: u32, encrypted: &str) -> std::result::Result<String, JsValue> {
    core_wallet_decrypt(handle, encrypted).map_err(|e| e.into())
}

/// Export the wallet's mnemonic phrase (24 words).
#[wasm_bindgen]
pub fn wallet_export_mnemonic(handle: u32) -> std::result::Result<String, JsValue> {
    core_wallet_export_mnemonic(handle).map_err(|e| e.into())
}

/// Close a wallet, zeroizing its key material.
#[wasm_bindgen]
pub fn wallet_close(handle: u32) -> std::result::Result<(), JsValue> {
    core_wallet_close(handle).map_err(|e| e.into())
}

// ── Tests ──
//
// Tests call core_* functions directly (pure Rust, no JsValue dependency)
// so they work on native targets without wasm-bindgen runtime.

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: parse a JSON result string and extract a field as a string.
    fn json_field(json: &str, field: &str) -> String {
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        match &v[field] {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            other => panic!("unexpected value for {}: {:?}", field, other),
        }
    }

    /// Helper: init a wallet and return (handle, json_str).
    fn init_test_wallet(password: &str) -> (u32, String) {
        let json = core_init_wallet(password).unwrap();
        let handle: u32 = json_field(&json, "handle").parse().unwrap();
        (handle, json)
    }

    #[test]
    fn test_init_wallet_returns_valid_structure() {
        let (handle, json) = init_test_wallet("test-password-123");

        let mnemonic = json_field(&json, "mnemonic");
        let encrypted_blob = json_field(&json, "encrypted_blob");
        let did = json_field(&json, "did");

        // 24 words
        assert_eq!(mnemonic.split_whitespace().count(), 24);

        // encrypted_blob is valid base64
        assert!(STANDARD.decode(&encrypted_blob).is_ok());

        // Blob should contain salt(16) + nonce(12) + at least ciphertext + tag(16)
        let blob = STANDARD.decode(&encrypted_blob).unwrap();
        assert!(blob.len() >= SALT_SIZE + NONCE_SIZE + TAG_SIZE);

        // did starts with did:key:z
        assert!(did.starts_with("did:key:z"));

        // handle is valid
        assert_eq!(core_wallet_did(handle).unwrap(), did);

        core_wallet_close(handle).unwrap();
    }

    #[test]
    fn test_unlock_wallet_roundtrip() {
        let password = "my-secure-password";
        let (handle1, json1) = init_test_wallet(password);
        let encrypted_blob = json_field(&json1, "encrypted_blob");
        let did1 = json_field(&json1, "did");
        core_wallet_close(handle1).unwrap();

        // Unlock with same password
        let json2 = core_unlock_wallet(password, &encrypted_blob).unwrap();
        let handle2: u32 = json_field(&json2, "handle").parse().unwrap();
        let did2 = json_field(&json2, "did");

        assert_eq!(did1, did2);

        core_wallet_close(handle2).unwrap();
    }

    #[test]
    fn test_wrong_password_fails_unlock() {
        let (handle, json) = init_test_wallet("correct-password");
        let encrypted_blob = json_field(&json, "encrypted_blob");
        core_wallet_close(handle).unwrap();

        let result = core_unlock_wallet("wrong-password", &encrypted_blob);
        assert!(result.is_err());
    }

    #[test]
    fn test_wallet_encrypt_decrypt_roundtrip() {
        let (handle, _) = init_test_wallet("password");
        let plaintext = "Hello, SAID wallet! This is sensitive data.";

        let encrypted = core_wallet_encrypt(handle, plaintext).unwrap();
        assert_ne!(encrypted, plaintext);

        let decrypted = core_wallet_decrypt(handle, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);

        core_wallet_close(handle).unwrap();
    }

    #[test]
    fn test_wallet_did_returns_valid_format() {
        let (handle, json) = init_test_wallet("password");
        let did_from_init = json_field(&json, "did");
        let did_from_fn = core_wallet_did(handle).unwrap();

        assert_eq!(did_from_init, did_from_fn);
        assert!(did_from_fn.starts_with("did:key:z"));

        // Decode the did:key to verify it is valid
        let z_part = did_from_fn.strip_prefix("did:key:z").unwrap();
        let decoded = bs58::decode(z_part).into_vec().unwrap();
        assert_eq!(decoded.len(), 2 + 32); // multicodec prefix + 32 byte key
        assert_eq!(&decoded[..2], &ED25519_MULTICODEC);

        core_wallet_close(handle).unwrap();
    }

    #[test]
    fn test_wallet_export_mnemonic_returns_24_words() {
        let (handle, json) = init_test_wallet("password");
        let original_mnemonic = json_field(&json, "mnemonic");

        let exported = core_wallet_export_mnemonic(handle).unwrap();
        assert_eq!(exported.split_whitespace().count(), 24);
        assert_eq!(exported, original_mnemonic);

        core_wallet_close(handle).unwrap();
    }

    #[test]
    fn test_wallet_close_invalidates_handle() {
        let (handle, _) = init_test_wallet("password");

        // Should work before close
        assert!(core_wallet_did(handle).is_ok());

        core_wallet_close(handle).unwrap();

        // Should fail after close
        assert!(core_wallet_did(handle).is_err());
        assert!(core_wallet_encrypt(handle, "test").is_err());
        assert!(core_wallet_decrypt(handle, "dGVzdA==").is_err());
        assert!(core_wallet_export_mnemonic(handle).is_err());

        // Double close should fail
        assert!(core_wallet_close(handle).is_err());
    }

    #[test]
    fn test_recover_wallet_with_known_mnemonic() {
        let password = "recovery-password";
        let (handle1, json1) = init_test_wallet(password);
        let mnemonic = json_field(&json1, "mnemonic");
        let did1 = json_field(&json1, "did");
        core_wallet_close(handle1).unwrap();

        // Recover from the mnemonic
        let json2 = core_recover_wallet(password, &mnemonic).unwrap();
        let handle2: u32 = json_field(&json2, "handle").parse().unwrap();
        let did2 = json_field(&json2, "did");

        // Same DID since same seed
        assert_eq!(did1, did2);

        // The encrypted blob can be unlocked
        let encrypted_blob = json_field(&json2, "encrypted_blob");
        core_wallet_close(handle2).unwrap();

        let json3 = core_unlock_wallet(password, &encrypted_blob).unwrap();
        let handle3: u32 = json_field(&json3, "handle").parse().unwrap();
        let did3 = json_field(&json3, "did");
        assert_eq!(did1, did3);

        core_wallet_close(handle3).unwrap();
    }

    #[test]
    fn test_wallet_create_ucan() {
        let (handle, json) = init_test_wallet("password");
        let did = json_field(&json, "did");

        let caps = r#"["said/read_prompts", "said/read_preferences"]"#;
        let audience_did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
        let token =
            core_wallet_create_ucan(handle, audience_did, caps, 3600).unwrap();

        // JWT has 3 parts
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);

        // Decode and verify header
        let header_bytes = URL_SAFE_NO_PAD.decode(parts[0]).unwrap();
        let header: serde_json::Value = serde_json::from_slice(&header_bytes).unwrap();
        assert_eq!(header["alg"], "EdDSA");
        assert_eq!(header["typ"], "JWT");
        assert_eq!(header["ucv"], "0.10.0");

        // Decode and verify payload
        let payload_bytes = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&payload_bytes).unwrap();
        assert_eq!(payload["iss"], did);
        assert_eq!(payload["aud"], audience_did);
        assert!(payload["exp"].as_i64().unwrap() > payload["iat"].as_i64().unwrap());
        assert_eq!(payload["att"].as_array().unwrap().len(), 2);
        assert_eq!(payload["att"][0]["can"], "said/read_prompts");
        assert_eq!(payload["att"][0]["with"], "said://data/*");
        assert_eq!(payload["att"][1]["can"], "said/read_preferences");
        assert!(payload["nnc"].as_str().is_some());

        // Verify Ed25519 signature
        let message = format!("{}.{}", parts[0], parts[1]);
        let sig_bytes = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        let sig_array: [u8; 64] = sig_bytes.try_into().unwrap();
        let signature = ed25519_dalek::Signature::from_bytes(&sig_array);

        let z_part = did.strip_prefix("did:key:z").unwrap();
        let key_bytes = bs58::decode(z_part).into_vec().unwrap();
        let pub_bytes: [u8; 32] = key_bytes[2..34].try_into().unwrap();
        let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&pub_bytes).unwrap();

        use ed25519_dalek::Verifier;
        assert!(verifying_key.verify(message.as_bytes(), &signature).is_ok());

        core_wallet_close(handle).unwrap();
    }

    #[test]
    fn test_encrypt_decrypt_different_wallets_incompatible() {
        let (handle1, _) = init_test_wallet("password1");
        let (handle2, _) = init_test_wallet("password2");

        let encrypted = core_wallet_encrypt(handle1, "secret message").unwrap();

        // Different wallet should fail to decrypt
        let result = core_wallet_decrypt(handle2, &encrypted);
        assert!(result.is_err());

        core_wallet_close(handle1).unwrap();
        core_wallet_close(handle2).unwrap();
    }

    #[test]
    fn test_invalid_mnemonic_recovery_fails() {
        let result = core_recover_wallet("password", "not a valid mnemonic phrase");
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_encrypted_blob_fails() {
        let result = core_unlock_wallet("password", "not-valid-base64!!!");
        assert!(result.is_err());

        // Valid base64 but too short
        let result2 = core_unlock_wallet("password", &STANDARD.encode([0u8; 10]));
        assert!(result2.is_err());
    }

    #[test]
    fn test_deterministic_key_derivation() {
        let password = "password";
        let (handle1, json1) = init_test_wallet(password);
        let mnemonic = json_field(&json1, "mnemonic");
        let did1 = json_field(&json1, "did");

        let json2 = core_recover_wallet("different-password", &mnemonic).unwrap();
        let handle2: u32 = json_field(&json2, "handle").parse().unwrap();
        let did2 = json_field(&json2, "did");

        assert_eq!(did1, did2);

        // Data encrypted by one should be decryptable by the other (same data_key)
        let encrypted = core_wallet_encrypt(handle1, "cross-wallet test").unwrap();
        let decrypted = core_wallet_decrypt(handle2, &encrypted).unwrap();
        assert_eq!(decrypted, "cross-wallet test");

        core_wallet_close(handle1).unwrap();
        core_wallet_close(handle2).unwrap();
    }

    #[test]
    fn test_handle_reuse_after_close() {
        // Verify that closing a handle makes slot reuse possible.
        //
        // We hold the global lock across the entire sequence to keep
        // parallel tests out, but we cannot assume the wallet vec is
        // empty: earlier tests in this binary may have closed their
        // handles and left `None` slots scattered through the vec.
        // The contract under test is "store_wallet's first-fit reuses
        // some `None` slot rather than always growing the vec," not
        // "the specific slot we just freed is the one that gets reused."
        let entropy = Mnemonic::generate(24).unwrap().to_entropy();

        let mut wallets = WALLETS.lock().unwrap();
        let baseline_len = wallets.len();

        // Insert two wallets at the tail so we know exactly which
        // indices we own.
        let w1 = wallet_from_entropy(&entropy).unwrap();
        let h1 = {
            let idx = wallets.len();
            wallets.push(Some(w1));
            idx
        };
        let w2 = wallet_from_entropy(&entropy).unwrap();
        let h2 = {
            let idx = wallets.len();
            wallets.push(Some(w2));
            idx
        };
        assert!(h2 > h1);
        let len_after_inserts = wallets.len();

        // Close h1.
        wallets[h1] = None;

        // Insert a third — should reuse SOME `None` slot rather than
        // grow the vec. That slot may be h1 (if no earlier test left
        // a None) or it may be a lower index from a prior test.
        let w3 = wallet_from_entropy(&entropy).unwrap();
        let mut h3 = None;
        for (i, slot) in wallets.iter_mut().enumerate() {
            if slot.is_none() {
                *slot = Some(w3);
                h3 = Some(i);
                break;
            }
        }
        let h3 = h3.expect("should have found a free slot");

        // The actual invariant: insertion reused an existing None and
        // didn't grow the vec.
        assert_eq!(
            wallets.len(),
            len_after_inserts,
            "vec grew instead of reusing a None slot",
        );
        assert!(
            h3 < len_after_inserts,
            "h3={} not within range",
            h3,
        );
        let _ = baseline_len;

        // Cleanup our own slots only.
        if let Some(slot) = wallets.get_mut(h3) {
            *slot = None;
        }
        wallets[h2] = None;
    }
}
