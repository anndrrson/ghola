//! # said-turnkey
//!
//! Credential vault adapter for Ghola's merchant gateway.
//!
//! A [`Vault`] is the boundary between Ghola's process memory and merchant
//! upstream credentials. Two concrete backends ship in this crate:
//!
//! - [`LocalVault`] — AES-256-GCM envelope encryption with a Ghola-held KEK
//!   (env var `GHOLA_VAULT_KEY`, 32 bytes hex). Matches the AES pattern already
//!   used by thumper-cloud for Gmail OAuth tokens. This is the default, and is
//!   sufficient for dev + Round-1 prod.
//! - [`TurnkeyVault`] — Turnkey-backed vault. Activates when
//!   `TURNKEY_API_PRIVATE_KEY` (or legacy `TURNKEY_API_KEY`) is set and
//!   `TURNKEY_SIGN_WITH` is configured. Uses Turnkey's signed operations to
//!   derive per-credential envelope keys.
//!
//! [`vault_from_env`] returns a routed implementation that always keeps
//! `LocalVault` available for backward compatibility, while preferring Turnkey
//! for new writes whenever Turnkey initializes cleanly.
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

struct RoutedVault {
    local: LocalVault,
    turnkey: Option<TurnkeyVault>,
    strict_turnkey: bool,
}

impl RoutedVault {
    fn new(local: LocalVault, turnkey: Option<TurnkeyVault>, strict_turnkey: bool) -> Self {
        Self {
            local,
            turnkey,
            strict_turnkey,
        }
    }
}

#[async_trait]
impl Vault for RoutedVault {
    fn backend_name(&self) -> &'static str {
        if self.turnkey.is_some() {
            "turnkey+local"
        } else {
            "local"
        }
    }

    async fn mint_suborg(&self, merchant_slug: &str) -> Result<SuborgHandle, VaultError> {
        if let Some(turnkey) = &self.turnkey {
            match turnkey.mint_suborg(merchant_slug).await {
                Ok(handle) => return Ok(handle),
                Err(err) => {
                    if self.strict_turnkey {
                        return Err(err);
                    }
                    tracing::warn!(
                        merchant_slug,
                        "turnkey mint_suborg failed, falling back to LocalVault: {err}"
                    );
                }
            }
        }
        self.local.mint_suborg(merchant_slug).await
    }

    async fn encrypt(
        &self,
        mode: AuthMode,
        plaintext: &str,
    ) -> Result<StoredCredential, VaultError> {
        if let Some(turnkey) = &self.turnkey {
            match turnkey.encrypt(mode, plaintext).await {
                Ok(stored) => return Ok(stored),
                Err(err) => {
                    if self.strict_turnkey {
                        return Err(err);
                    }
                    tracing::warn!(
                        mode = mode.as_str(),
                        "turnkey encrypt failed, falling back to LocalVault: {err}"
                    );
                }
            }
        }
        self.local.encrypt(mode, plaintext).await
    }

    async fn decrypt(&self, stored: &StoredCredential) -> Result<String, VaultError> {
        match stored.backend {
            "local" => self.local.decrypt(stored).await,
            "turnkey" => {
                if let Some(turnkey) = &self.turnkey {
                    return turnkey.decrypt(stored).await;
                }
                Err(VaultError::NotConfigured(
                    "credential backend is 'turnkey' but Turnkey is not configured".into(),
                ))
            }
            other => Err(VaultError::Backend(format!(
                "unknown credential backend '{other}'"
            ))),
        }
    }
}

fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

/// Build the default vault from environment variables.
///
/// - Always loads `LocalVault` from `GHOLA_VAULT_KEY` (or ephemeral key in dev).
/// - If Turnkey env vars are present and valid, enables Turnkey as the preferred
///   backend for new writes while still decrypting legacy `local` records.
/// - If Turnkey initialization fails and `TURNKEY_STRICT` is truthy (`1/true`),
///   startup fails. Otherwise startup continues with LocalVault-only mode.
pub fn vault_from_env() -> Result<std::sync::Arc<dyn Vault>, VaultError> {
    let local = LocalVault::from_env()?;
    let strict_turnkey = env_truthy("TURNKEY_STRICT");
    let turnkey_env_present = std::env::var("TURNKEY_API_PRIVATE_KEY").is_ok()
        || std::env::var("TURNKEY_API_KEY").is_ok();

    let turnkey = if turnkey_env_present {
        match TurnkeyVault::from_env() {
            Ok(vault) => {
                tracing::info!("Turnkey env detected — using Turnkey as preferred vault backend");
                Some(vault)
            }
            Err(err) => {
                if strict_turnkey {
                    return Err(err);
                }
                tracing::warn!(
                    "Turnkey env detected but TurnkeyVault init failed, \
                     continuing with LocalVault compatibility mode: {err}"
                );
                None
            }
        }
    } else {
        None
    };

    if turnkey.is_none() {
        tracing::info!("using LocalVault backend");
    }
    Ok(std::sync::Arc::new(RoutedVault::new(
        local,
        turnkey,
        strict_turnkey,
    )))
}
