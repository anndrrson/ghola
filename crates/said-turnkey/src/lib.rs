//! # said-turnkey
//!
//! Credential vault adapter for Ghola's merchant gateway.
//!
//! A [`Vault`] is the boundary between Ghola's process memory and merchant
//! upstream credentials. Two implementations ship in this crate:
//!
//! - [`LocalVault`] — AES-256-GCM envelope encryption with a Ghola-held KEK
//!   (env var `GHOLA_VAULT_KEY`, 32 bytes hex). Matches the AES pattern already
//!   used by thumper-cloud for Gmail OAuth tokens. This is the default, and is
//!   sufficient for dev + Round-1 prod.
//! - [`TurnkeyVault`] — stubbed HTTP client against Turnkey's API. Activates
//!   when `TURNKEY_API_KEY` is set. Currently returns `VaultError::NotConfigured`
//!   on every call — the wire layer is there so a future build can swap the
//!   backend without touching the gateway, said-cloud, or the DB schema.
//!
//! Both backends agree on one invariant: **the plaintext upstream credential
//! exists in Rust memory for at most one request, and never touches Postgres**.
//! A Ghola database dump is useless without the vault's KEK.
//!
//! ## Usage
//!
//! ```no_run
//! use said_turnkey::{LocalVault, Vault, AuthMode};
//!
//! # async fn f() -> Result<(), said_turnkey::VaultError> {
//! let vault = LocalVault::from_env()?;
//!
//! // Mint a sub-org + wallet for a new merchant.
//! let suborg = vault.mint_suborg("alpha-corp").await?;
//! println!("wallet: {}", suborg.solana_address);
//!
//! // Encrypt their upstream bearer token once at signup.
//! let stored = vault.encrypt(AuthMode::Bearer, "sk-merchant-secret").await?;
//!
//! // On each proxied call, decrypt just-in-time and drop.
//! let plaintext = vault.decrypt(&stored).await?;
//! assert_eq!(plaintext, "sk-merchant-secret");
//! # Ok(()) }
//! ```

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod envelope;
pub mod local;
pub mod turnkey;

pub use local::LocalVault;
pub use turnkey::TurnkeyVault;

/// Every auth mode the gateway knows how to inject on the outbound leg.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    /// Injected as `Authorization: Bearer <token>`.
    Bearer,
    /// Injected as a custom header, e.g. `X-API-Key: <token>`. The header name
    /// is stored on the `service_listings` row, not in the encrypted blob.
    ApiKeyHeader,
    /// Appended as `?api_key=<token>` to every outbound URL.
    ApiKeyQuery,
    /// Injected as `Authorization: Basic base64(user:pass)`. Stored credential
    /// is already the `user:pass` string; the gateway base64-encodes it.
    Basic,
    /// No auth. Still valid — merchants may want to proxy a public API to get
    /// Ghola's x402 billing + reputation layer without any upstream secret.
    None,
}

impl AuthMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthMode::Bearer => "bearer",
            AuthMode::ApiKeyHeader => "api_key_header",
            AuthMode::ApiKeyQuery => "api_key_query",
            AuthMode::Basic => "basic",
            AuthMode::None => "none",
        }
    }

    pub fn parse(s: &str) -> Result<Self, VaultError> {
        match s {
            "bearer" => Ok(AuthMode::Bearer),
            "api_key_header" => Ok(AuthMode::ApiKeyHeader),
            "api_key_query" => Ok(AuthMode::ApiKeyQuery),
            "basic" => Ok(AuthMode::Basic),
            "none" => Ok(AuthMode::None),
            other => Err(VaultError::InvalidAuthMode(other.to_string())),
        }
    }
}

/// An encrypted credential ready to be persisted. Schema:
///
/// - `ciphertext` is the opaque blob written to `merchant_credentials.ciphertext`.
///   For `LocalVault` it's `nonce(12) || aead_ciphertext_with_tag`.
/// - `backend` is the string persisted to `merchant_credentials.vault_backend`
///   so future reads know which [`Vault`] impl to use.
/// - `key_ref` is backend-specific: for `LocalVault` it's the KEK version, for
///   Turnkey it would be the wrapped-DEK handle.
#[derive(Debug, Clone)]
pub struct StoredCredential {
    pub backend: &'static str,
    pub key_version: i32,
    pub key_ref: Option<String>,
    pub ciphertext: Vec<u8>,
    pub auth_mode: AuthMode,
}

/// The merchant-facing result of provisioning a new vault sub-org.
#[derive(Debug, Clone, Serialize)]
pub struct SuborgHandle {
    /// Opaque backend-specific sub-org ID persisted to
    /// `service_listings.vault_suborg_id`.
    pub suborg_id: String,
    /// Solana address where settlement USDC lands. Shown to the merchant
    /// immediately after signup.
    pub solana_address: String,
    /// Which vault implementation minted this sub-org.
    pub backend: &'static str,
}

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("vault not configured: {0}")]
    NotConfigured(String),
    #[error("invalid key material: {0}")]
    InvalidKey(String),
    #[error("encryption failed: {0}")]
    Encrypt(String),
    #[error("decryption failed: {0}")]
    Decrypt(String),
    #[error("invalid auth mode: {0}")]
    InvalidAuthMode(String),
    #[error("backend error: {0}")]
    Backend(String),
}

/// The sole contract between Ghola's hot path and any credential vault.
///
/// Implementations must be `Send + Sync` and cloneable cheaply — the gateway
/// holds one in `AppState` and shares it across every request handler via
/// `Arc<dyn Vault>`.
#[async_trait]
pub trait Vault: Send + Sync {
    /// Human-readable backend name. Must match what's persisted in
    /// `merchant_credentials.vault_backend` so lookups stay routable.
    fn backend_name(&self) -> &'static str;

    /// Mint a new sub-org + Solana wallet for a merchant. Called once at signup.
    async fn mint_suborg(&self, merchant_slug: &str) -> Result<SuborgHandle, VaultError>;

    /// Encrypt an upstream credential. Called once at signup (and again on
    /// rotation). The returned [`StoredCredential`] is ready to be persisted
    /// verbatim to `merchant_credentials`.
    async fn encrypt(
        &self,
        mode: AuthMode,
        plaintext: &str,
    ) -> Result<StoredCredential, VaultError>;

    /// Decrypt a stored credential. Called on every proxied request's hot path.
    /// Implementations SHOULD return the plaintext and drop any intermediate
    /// key material as fast as possible. Callers MUST NOT cache the plaintext.
    async fn decrypt(&self, stored: &StoredCredential) -> Result<String, VaultError>;
}

/// Build the default vault from environment variables.
///
/// - If `TURNKEY_API_KEY` is set → returns `TurnkeyVault`. Currently this still
///   returns `NotConfigured` on every call; the wire layer is only plumbed so
///   the swap is one config-flag change when a real Turnkey account exists.
/// - Otherwise → returns `LocalVault` keyed on `GHOLA_VAULT_KEY` (hex, 32 bytes).
/// - If neither env var is set → returns `LocalVault` with an **ephemeral key**
///   generated at startup and logs a loud warning. Fine for `cargo run`; never
///   use in prod — credentials encrypted under an ephemeral key are unreadable
///   after a restart.
pub fn vault_from_env() -> Result<std::sync::Arc<dyn Vault>, VaultError> {
    if std::env::var("TURNKEY_API_KEY").is_ok() {
        tracing::info!("TURNKEY_API_KEY set — using TurnkeyVault backend");
        return Ok(std::sync::Arc::new(TurnkeyVault::from_env()?));
    }
    Ok(std::sync::Arc::new(LocalVault::from_env()?))
}
