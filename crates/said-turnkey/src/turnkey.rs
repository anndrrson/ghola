//! `TurnkeyVault` — HSM-backed [`Vault`] implementation.
//!
//! This module exists so the hot path (gateway + said-cloud) can be written
//! once against the [`crate::Vault`] trait, and the upgrade from LocalVault to
//! real HSM storage is a single config flag flip.
//!
//! `encrypt`/`decrypt` are real implementations against Turnkey's
//! `wrap_private_key` / `unwrap_private_key` endpoints. `mint_suborg` is still
//! stubbed — out of scope for v2.
//!
//! ## What the production version does
//!
//! - **`mint_suborg`** (stubbed) — POST `/public/v1/submit/create_sub_organization`
//!   with the merchant slug as `subOrganizationName` and a fresh ed25519 root
//!   user. Request a Solana `WALLET_ACCOUNT` for `m/44'/501'/0'/0'`. Return
//!   `(suborg_id, solana_address)` from the response.
//! - **`encrypt`** — generate a fresh 32-byte DEK, AES-256-GCM the plaintext
//!   under it, then call Turnkey's `/wrap_private_key` to seal the DEK with
//!   a sub-org-scoped KEK whose export policy is `NEVER`. Persist
//!   `nonce || aead_ct` as the blob and the wrapped-DEK handle as `key_ref`.
//! - **`decrypt`** — call `/unwrap_private_key` with the stored handle to get
//!   the DEK back for a single request, decrypt the blob, zeroize the DEK.
//!
//! The crucial security property: a Ghola process RCE leaks at most one
//! request's worth of plaintext. A Ghola DB dump leaks zero plaintext — the
//! wrapped DEKs are useless without Turnkey.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use async_trait::async_trait;
use rand::{rngs::OsRng, RngCore};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
use zeroize::Zeroize;

use crate::{stamp, AuthMode, StoredCredential, SuborgHandle, Vault, VaultError};

const DEFAULT_BASE_URL: &str = "https://api.turnkey.com";
const WRAP_PATH: &str = "/public/v1/submit/wrap_private_key";
const UNWRAP_PATH: &str = "/public/v1/submit/unwrap_private_key";

#[derive(Clone)]
pub struct TurnkeyVault {
    /// Hex-encoded P-256 private scalar used to sign API requests.
    api_secret_hex: String,
    /// Hex-encoded P-256 public key bytes. Passed through into the X-Stamp
    /// envelope so Turnkey can identify which API key signed.
    api_public_hex: String,
    org_id: String,
    /// Identifier of the sub-org-scoped KEK (Turnkey private key resource)
    /// used to wrap freshly generated DEKs. Optional in `from_env` so the
    /// vault can still be constructed for `mint_suborg` flows that don't
    /// need it; `encrypt`/`decrypt` return `NotConfigured` if absent.
    private_key_kek_id: Option<String>,
    base_url: String,
    http: reqwest::Client,
}

impl TurnkeyVault {
    pub fn from_env() -> Result<Self, VaultError> {
        let api_secret_hex = std::env::var("TURNKEY_API_KEY")
            .map_err(|_| VaultError::NotConfigured("TURNKEY_API_KEY".into()))?;
        let api_public_hex = std::env::var("TURNKEY_API_PUBLIC_KEY")
            .map_err(|_| VaultError::NotConfigured("TURNKEY_API_PUBLIC_KEY".into()))?;
        let org_id = std::env::var("TURNKEY_ORG_ID")
            .map_err(|_| VaultError::NotConfigured("TURNKEY_ORG_ID".into()))?;
        let private_key_kek_id = std::env::var("TURNKEY_PRIVATE_KEY_KEK_ID").ok();

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| VaultError::Backend(e.to_string()))?;

        Ok(Self {
            api_secret_hex,
            api_public_hex,
            org_id,
            private_key_kek_id,
            base_url: DEFAULT_BASE_URL.to_string(),
            http,
        })
    }

    /// Override the Turnkey API base URL. Used by integration tests against
    /// a `wiremock` mock server.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    /// Explicit-config constructor (used by tests). Production code paths
    /// should prefer `from_env`.
    pub fn new(
        api_secret_hex: impl Into<String>,
        api_public_hex: impl Into<String>,
        org_id: impl Into<String>,
        private_key_kek_id: Option<String>,
    ) -> Result<Self, VaultError> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| VaultError::Backend(e.to_string()))?;
        Ok(Self {
            api_secret_hex: api_secret_hex.into(),
            api_public_hex: api_public_hex.into(),
            org_id: org_id.into(),
            private_key_kek_id,
            base_url: DEFAULT_BASE_URL.to_string(),
            http,
        })
    }

    fn now_ms() -> String {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().to_string())
            .unwrap_or_else(|_| "0".to_string())
    }

    /// Stamp + POST a JSON body to a Turnkey API path.
    async fn signed_post(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, VaultError> {
        let body_bytes = serde_json::to_vec(body)
            .map_err(|e| VaultError::Backend(format!("serialize request: {e}")))?;
        let stamp = stamp::build_stamp(&self.api_secret_hex, &self.api_public_hex, &body_bytes)
            .map_err(|e| VaultError::Backend(format!("build x-stamp: {e}")))?;

        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let resp = self
            .http
            .post(&url)
            .header("Content-Type", "application/json")
            .header("X-Stamp", stamp)
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| VaultError::Backend(format!("http send: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| VaultError::Backend(format!("read response: {e}")))?;

        if !status.is_success() {
            return Err(VaultError::Backend(format!(
                "turnkey {} returned {}: {}",
                path, status, text
            )));
        }

        serde_json::from_str(&text)
            .map_err(|e| VaultError::Backend(format!("parse response json: {e}: {text}")))
    }
}

#[async_trait]
impl Vault for TurnkeyVault {
    fn backend_name(&self) -> &'static str {
        "turnkey"
    }

    async fn mint_suborg(&self, _merchant_slug: &str) -> Result<SuborgHandle, VaultError> {
        // TODO: POST https://api.turnkey.com/public/v1/submit/create_sub_organization
        // with subOrganizationName = merchant_slug, rootUsers = [ghola-service],
        // wallet = { name, accounts: [{ curve: CURVE_ED25519, pathFormat: PATH_FORMAT_BIP32,
        //            path: "m/44'/501'/0'/0'", addressFormat: ADDRESS_FORMAT_SOLANA }] }.
        // Parse returned suborg ID + wallet address and return.
        Err(VaultError::NotConfigured(
            "TurnkeyVault::mint_suborg is stubbed — set TURNKEY_API_KEY and implement \
             the HTTP call, or use LocalVault (default)"
                .into(),
        ))
    }

    async fn encrypt(
        &self,
        mode: AuthMode,
        plaintext: &str,
    ) -> Result<StoredCredential, VaultError> {
        let kek_id = self.private_key_kek_id.as_ref().ok_or_else(|| {
            VaultError::NotConfigured(
                "TURNKEY_PRIVATE_KEY_KEK_ID is required for TurnkeyVault::encrypt".into(),
            )
        })?;

        // 1. Fresh 32-byte DEK + 12-byte nonce.
        let mut dek = [0u8; 32];
        OsRng.fill_bytes(&mut dek);
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);

        // 2. AES-256-GCM seal locally.
        let cipher = Aes256Gcm::new_from_slice(&dek)
            .map_err(|e| VaultError::Encrypt(format!("init aes: {e}")))?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct_with_tag = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| VaultError::Encrypt(format!("aes-gcm seal: {e}")))?;

        let mut blob = Vec::with_capacity(12 + ct_with_tag.len());
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ct_with_tag);

        // 3. Wrap the DEK via Turnkey.
        let body = json!({
            "type": "ACTIVITY_TYPE_WRAP_PRIVATE_KEY_V2",
            "timestampMs": Self::now_ms(),
            "organizationId": self.org_id,
            "parameters": {
                "privateKey": hex::encode(dek),
                "targetPublicKey": kek_id,
            }
        });

        let resp = self.signed_post(WRAP_PATH, &body).await;

        // Drop DEK as early as possible regardless of HTTP result.
        dek.zeroize();

        let resp = resp?;
        let wrapped_handle = resp
            .pointer("/activity/result/wrapPrivateKeyResult/wrappedPrivateKey")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                VaultError::Backend(format!(
                    "wrap_private_key response missing wrappedPrivateKey: {resp}"
                ))
            })?
            .to_string();

        Ok(StoredCredential {
            backend: "turnkey",
            key_version: 1,
            key_ref: Some(wrapped_handle),
            ciphertext: blob,
            auth_mode: mode,
        })
    }

    async fn decrypt(&self, stored: &StoredCredential) -> Result<String, VaultError> {
        if stored.backend != "turnkey" {
            return Err(VaultError::Backend(format!(
                "TurnkeyVault cannot decrypt blob from backend '{}'",
                stored.backend
            )));
        }
        let handle = stored.key_ref.as_ref().ok_or_else(|| {
            VaultError::Decrypt("stored credential missing key_ref (wrapped DEK handle)".into())
        })?;
        if stored.ciphertext.len() < 12 + 16 {
            return Err(VaultError::Decrypt(format!(
                "stored ciphertext too short: {} bytes",
                stored.ciphertext.len()
            )));
        }

        // 1. Unwrap the DEK via Turnkey.
        let body = json!({
            "type": "ACTIVITY_TYPE_UNWRAP_PRIVATE_KEY",
            "timestampMs": Self::now_ms(),
            "organizationId": self.org_id,
            "parameters": {
                "wrappedPrivateKey": handle,
            }
        });

        let resp = self.signed_post(UNWRAP_PATH, &body).await?;
        let dek_hex = resp
            .pointer("/activity/result/unwrapPrivateKeyResult/privateKey")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                VaultError::Backend(format!(
                    "unwrap_private_key response missing privateKey: {resp}"
                ))
            })?;
        let mut dek = hex::decode(dek_hex)
            .map_err(|e| VaultError::Decrypt(format!("dek hex decode: {e}")))?;
        if dek.len() != 32 {
            dek.zeroize();
            return Err(VaultError::Decrypt(format!(
                "unwrapped DEK is {} bytes, expected 32",
                dek.len()
            )));
        }

        // 2. AES-256-GCM open.
        let cipher = match Aes256Gcm::new_from_slice(&dek) {
            Ok(c) => c,
            Err(e) => {
                dek.zeroize();
                return Err(VaultError::Decrypt(format!("init aes: {e}")));
            }
        };
        let (nonce_bytes, ct_with_tag) = stored.ciphertext.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);
        let pt = cipher
            .decrypt(nonce, ct_with_tag)
            .map_err(|e| VaultError::Decrypt(format!("aes-gcm open: {e}")));

        dek.zeroize();
        let pt = pt?;
        String::from_utf8(pt)
            .map_err(|e| VaultError::Decrypt(format!("non-utf8 plaintext: {e}")))
    }
}
