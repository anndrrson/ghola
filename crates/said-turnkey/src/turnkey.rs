//! `TurnkeyVault` — stubbed HSM-backed [`Vault`] implementation.
//!
//! This module exists so the hot path (gateway + said-cloud) can be written
//! once against the [`crate::Vault`] trait, and the upgrade from LocalVault to
//! real HSM storage is a single config flag flip.
//!
//! Currently every method returns [`VaultError::NotConfigured`]. The wire
//! layer — env-var config, HTTP client construction, request signing — is
//! plumbed but intentionally empty. When a real Turnkey account is ready,
//! implementing each method is a self-contained patch that touches no other
//! crate in the workspace.
//!
//! ## What the production version will do
//!
//! - **`mint_suborg`** — POST `/public/v1/submit/create_sub_organization` with
//!   the merchant slug as `subOrganizationName` and a fresh ed25519 root user.
//!   Request a Solana `WALLET_ACCOUNT` for `m/44'/501'/0'/0'`. Return
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

use async_trait::async_trait;

use crate::{AuthMode, StoredCredential, SuborgHandle, Vault, VaultError};

#[derive(Clone)]
pub struct TurnkeyVault {
    #[allow(dead_code)]
    api_key: String,
    #[allow(dead_code)]
    api_public_key: String,
    #[allow(dead_code)]
    org_id: String,
    #[allow(dead_code)]
    http: reqwest::Client,
}

impl TurnkeyVault {
    pub fn from_env() -> Result<Self, VaultError> {
        let api_key = std::env::var("TURNKEY_API_KEY")
            .map_err(|_| VaultError::NotConfigured("TURNKEY_API_KEY".into()))?;
        let api_public_key = std::env::var("TURNKEY_API_PUBLIC_KEY")
            .map_err(|_| VaultError::NotConfigured("TURNKEY_API_PUBLIC_KEY".into()))?;
        let org_id = std::env::var("TURNKEY_ORG_ID")
            .map_err(|_| VaultError::NotConfigured("TURNKEY_ORG_ID".into()))?;

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| VaultError::Backend(e.to_string()))?;

        Ok(Self {
            api_key,
            api_public_key,
            org_id,
            http,
        })
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
        _mode: AuthMode,
        _plaintext: &str,
    ) -> Result<StoredCredential, VaultError> {
        // TODO: generate fresh DEK, AES-256-GCM the plaintext, call
        // /public/v1/submit/wrap_private_key to seal the DEK, return
        // StoredCredential { backend: "turnkey", key_ref: Some(wrapped_handle), ... }
        Err(VaultError::NotConfigured(
            "TurnkeyVault::encrypt is stubbed — use LocalVault".into(),
        ))
    }

    async fn decrypt(&self, _stored: &StoredCredential) -> Result<String, VaultError> {
        // TODO: POST /public/v1/submit/unwrap_private_key with stored.key_ref,
        // decrypt the blob under the unwrapped DEK, zeroize, return.
        Err(VaultError::NotConfigured(
            "TurnkeyVault::decrypt is stubbed — use LocalVault".into(),
        ))
    }
}
