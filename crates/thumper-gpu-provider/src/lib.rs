//! `thumper-gpu-provider` — the in-enclave runtime half of Ghola v2's
//! confidential AI path.
//!
//! Lives inside an AWS Nitro Enclave (or, under `--features mock-nitro`,
//! a developer machine). On boot it:
//!
//! 1. Mints a fresh X25519 + Ed25519 keypair in RAM (the secrets never
//!    persist to disk).
//! 2. Asks the Nitro Security Module for an attestation document whose
//!    `user_data` binds both public keys to the boot timestamp.
//! 3. Connects to the Ghola relay over `wss://…/ws` as a `GpuProvider`,
//!    sends `ProviderAdvertise` followed by `ProviderAttest`.
//! 4. Loops on incoming `InferenceRequestSealed` frames — opens each
//!    one with the X25519 secret, runs inference against a local
//!    Ollama-compatible HTTP endpoint, signs a v2 receipt with the
//!    Ed25519 key, and seals the response back to the requester.
//!
//! See `crates/thumper-gpu-provider/tests/integration.rs` for the
//! end-to-end round-trip exercised under `--features mock-nitro`.

#![forbid(unsafe_code)]

use std::sync::Arc;

use anyhow::Result;
use ed25519_dalek::SigningKey as EdSigningKey;

pub mod enclave;
pub mod inference;
pub mod receipt;
pub mod relay_ws;

pub use enclave::{generate_keys, now_ms, request_quote, EnclaveKeys};
pub use receipt::{InferenceResponseWithReceipt, ReceiptV1};
pub use relay_ws::{InferenceRunner, Provider};

use thumper_types::TeeKind;

/// Runtime configuration. Loaded from env in `main.rs`, constructed
/// directly by tests.
#[derive(Clone)]
pub struct ProviderConfig {
    /// WebSocket URL of the relay, e.g. `wss://gateway.ghola.xyz/ws`.
    pub relay_url: String,
    /// Long-lived Ed25519 key identifying this provider to the relay's
    /// auth handshake. Distinct from the enclave Ed25519 key minted at
    /// boot — that one signs receipts; this one signs the auth frame.
    pub auth_signing: EdSigningKey,
    /// Human-readable name surfaced in `ProviderAdvertise`.
    pub provider_name: String,
    /// Model ids the relay should route to us.
    pub models: Vec<String>,
    /// How many concurrent jobs we'll accept.
    pub max_concurrent: u32,
    /// Wallet that receives provider payouts. Free-form string; the
    /// relay does no on-chain validation of it here.
    pub wallet_address: String,
    /// Pre-loaded Ghola allowlist signature over `sha256(measurement)`.
    /// Operators sign this offline once per EIF image and bake it into
    /// the runtime config — the enclave never holds the signing key
    /// itself.
    pub allowlist_sig: Vec<u8>,
    /// `http://localhost:11434` by default. Vsock-forwarded TCP in
    /// production.
    pub ollama_url: String,
    /// Which TEE family we're claiming. Real prod = `Nitro`; mock
    /// builds and dev runs against a `THUMPER_ALLOW_UNATTESTED=1`
    /// relay use `None`.
    pub tee_kind: TeeKind,
}

impl ProviderConfig {
    /// Load config from env vars. Mirrors the variable names the
    /// runbook expects so `aws ssm` parameter mapping is 1:1.
    pub fn from_env() -> Result<Self> {
        use base64::Engine;
        let relay_url =
            std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:7654/ws".into());
        let provider_name =
            std::env::var("PROVIDER_NAME").unwrap_or_else(|_| "ghola-nitro".into());
        let models = std::env::var("MODELS")
            .unwrap_or_else(|_| "llama3:8b".into())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let max_concurrent: u32 = std::env::var("MAX_CONCURRENT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);
        let wallet_address = std::env::var("WALLET_ADDRESS").unwrap_or_default();
        let allowlist_sig = std::env::var("ALLOWLIST_SIG_B64")
            .ok()
            .map(|s| base64::engine::general_purpose::STANDARD.decode(s.trim()))
            .transpose()?
            .unwrap_or_default();
        let ollama_url =
            std::env::var("OLLAMA_URL").unwrap_or_else(|_| "http://localhost:11434".into());

        // PROVIDER_AUTH_KEY: 32-byte raw seed, base64-encoded. Created
        // once per provider by ops and rotated by re-issuing the EIF.
        let auth_signing = match std::env::var("PROVIDER_AUTH_KEY").ok() {
            Some(s) => {
                let bytes = base64::engine::general_purpose::STANDARD.decode(s.trim())?;
                if bytes.len() < 32 {
                    anyhow::bail!("PROVIDER_AUTH_KEY must be at least 32 raw bytes (base64)");
                }
                let seed: [u8; 32] = bytes[..32].try_into().expect("len checked");
                EdSigningKey::from_bytes(&seed)
            }
            None => {
                tracing::warn!(
                    "PROVIDER_AUTH_KEY not set — generating an ephemeral key (DEV ONLY)"
                );
                use rand::RngCore;
                let mut seed = [0u8; 32];
                rand::rngs::OsRng.fill_bytes(&mut seed);
                EdSigningKey::from_bytes(&seed)
            }
        };

        let tee_kind = match std::env::var("TEE_KIND").as_deref() {
            Ok("nitro") => TeeKind::Nitro,
            Ok("none") => TeeKind::None,
            #[cfg(feature = "mock-nitro")]
            _ => TeeKind::None,
            #[cfg(not(feature = "mock-nitro"))]
            _ => TeeKind::Nitro,
        };

        Ok(Self {
            relay_url,
            auth_signing,
            provider_name,
            models,
            max_concurrent,
            wallet_address,
            allowlist_sig,
            ollama_url,
            tee_kind,
        })
    }
}

/// Public entry point used by `main.rs` and by integration tests once
/// they've built a [`ProviderConfig`] pointing at a mock relay.
pub async fn run(cfg: ProviderConfig) -> Result<()> {
    let keys = generate_keys()?;
    tracing::info!(
        x25519_pub = %keys.x25519_pub_hex(),
        ed25519_pub = %keys.ed25519_pub_hex(),
        enclave_key_id = %keys.enclave_key_id().0,
        "enclave keys ready"
    );

    let ts = now_ms();
    let quote = request_quote(&keys, ts)?;
    tracing::info!(quote_bytes = quote.len(), "attestation quote ready");

    let runner: Arc<dyn InferenceRunner> =
        Arc::new(inference::InferenceClient::new(cfg.ollama_url.clone()));
    let provider = Provider {
        allowlist_sig: cfg.allowlist_sig.clone(),
        quote,
        keys: Arc::new(keys),
        runner,
        cfg,
    };
    provider.connect_and_serve().await
}

/// Like [`run`] but lets the caller inject a stub inference runner.
/// Used by integration tests so they don't have to spin up an Ollama
/// server alongside the mock relay.
pub async fn run_with_runner(
    cfg: ProviderConfig,
    runner: Arc<dyn InferenceRunner>,
) -> Result<()> {
    let keys = generate_keys()?;
    let ts = now_ms();
    let quote = request_quote(&keys, ts)?;
    let provider = Provider {
        allowlist_sig: cfg.allowlist_sig.clone(),
        quote,
        keys: Arc::new(keys),
        runner,
        cfg,
    };
    provider.connect_and_serve().await
}
