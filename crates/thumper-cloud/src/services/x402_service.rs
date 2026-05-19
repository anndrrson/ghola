//! x402 Payment Protocol service.
//! Handles payment requirement generation, Solana stablecoin transaction
//! verification, and settlement for anonymous pay-per-request agent access.
//!
//! Multi-currency: USDT primary, USDC secondary. Per-stablecoin pause flags
//! (`STABLECOIN_USDT_PAUSED`, `STABLECOIN_USDC_PAUSED`) act as the runtime
//! lever for depeg / freeze events.

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::CloudError;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Constants (mirror wallet_service)
// ---------------------------------------------------------------------------

const TOKEN_PROGRAM_ID: [u8; 32] = [
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
];

const ATA_PROGRAM_ID: [u8; 32] = [
    0x8c, 0x97, 0x25, 0x8f, 0x4e, 0x24, 0x89, 0xf1, 0xbb, 0x3d, 0x10, 0x29, 0x14, 0x8e, 0x0d, 0x83,
    0x0b, 0x5a, 0x13, 0x99, 0xda, 0xff, 0x10, 0x84, 0x04, 0x8e, 0x7b, 0xd8, 0xdb, 0xe9, 0xf8, 0x59,
];

// ─── Stablecoin registry ─────────────────────────────────────────────────────
//
// Keep this in sync with `said-solana::spl::SUPPORTED_TOKENS`. Thumper-cloud
// lives in a separate workspace from said and orni-models, so the registry
// is duplicated here rather than imported.

#[derive(Debug, Clone, Copy)]
struct StableToken {
    symbol: &'static str,
    mint_mainnet_b58: &'static str,
    mint_devnet_b58: &'static str,
    decimals: u8,
}

const USDT: StableToken = StableToken {
    symbol: "USDT",
    mint_mainnet_b58: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    // No canonical devnet USDT; operators must override via USDT_MINT env on devnet.
    mint_devnet_b58: "",
    decimals: 6,
};
const USDC: StableToken = StableToken {
    symbol: "USDC",
    mint_mainnet_b58: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    mint_devnet_b58: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    decimals: 6,
};

/// USDT first = primary stablecoin. UI / agents picking `accepts[0]` get USDT.
const SUPPORTED_TOKENS: &[StableToken] = &[USDT, USDC];

/// Returns the active set of accepted (non-paused) stablecoins for the given
/// RPC, with their resolved mint addresses. Skips tokens that don't have a
/// canonical mint on the active network (e.g. USDT on devnet without an
/// override).
fn active_tokens(rpc_url: &str) -> Vec<(StableToken, String)> {
    let devnet = rpc_url.contains("devnet") || rpc_url.contains("localhost");
    let mut out = Vec::new();
    for t in SUPPORTED_TOKENS {
        let pause_var = format!("STABLECOIN_{}_PAUSED", t.symbol);
        let paused = std::env::var(&pause_var)
            .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes"))
            .unwrap_or(false);
        if paused {
            continue;
        }
        let env_mint_var = format!("{}_MINT", t.symbol);
        let mint = std::env::var(&env_mint_var).unwrap_or_else(|_| {
            if devnet {
                t.mint_devnet_b58.to_string()
            } else {
                t.mint_mainnet_b58.to_string()
            }
        });
        if mint.is_empty() {
            continue;
        }
        out.push((*t, mint));
    }
    out
}

// ---------------------------------------------------------------------------
// Types — x402 Protocol
// ---------------------------------------------------------------------------

/// Payment requirement sent in the PAYMENT-REQUIRED header (base64-encoded JSON).
#[derive(Debug, Clone, Serialize)]
pub struct PaymentRequirements {
    #[serde(rename = "x402Version")]
    pub x402_version: u8,
    pub accepts: Vec<PaymentOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaymentOption {
    pub scheme: String,
    pub network: String,
    pub amount: String,
    pub asset: String,
    pub destination: String,
    pub price: String,
    #[serde(rename = "payTo")]
    pub pay_to: String,
    #[serde(rename = "maxAmountRequired")]
    pub max_amount_required: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    pub extra: PaymentExtra,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaymentExtra {
    pub agent_id: String,
    pub agent_slug: String,
    pub model_id: String,
    pub max_tokens: u32,
    pub price_per_1k_input: i64,
    pub price_per_1k_output: i64,
    pub payment_rail: String,
    pub canonical_rail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_network: Option<String>,
    pub token_decimals: u8,
    pub payment_identifier_supported: bool,
    pub privacy_disclosure: String,
    pub shielded_available: bool,
    pub shielded_unavailable_reason: Option<String>,
}

fn de_string_or_number<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(s) => Ok(s),
        Value::Number(n) => Ok(n.to_string()),
        other => Err(serde::de::Error::custom(format!(
            "expected string or number, got {other}"
        ))),
    }
}

/// Payment proof decoded from the PAYMENT-SIGNATURE header.
#[derive(Debug, Deserialize)]
pub struct PaymentProof {
    #[serde(
        rename = "x402Version",
        alias = "x402_version",
        deserialize_with = "de_string_or_number"
    )]
    pub x402_version: String,
    pub scheme: String,
    pub network: String,
    pub payload: PaymentPayload,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PaymentPayload {
    pub tx_signature: Option<String>,
    pub shielded_receipt_id: Option<String>,
    pub proof_b64: Option<String>,
    pub nullifier_hex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Value>,
}

/// Result of successful on-chain verification.
pub struct VerifiedPayment {
    pub payment_id: Uuid,
    pub tx_signature: String,
    pub payer_address: String,
    /// Amount paid in the on-chain stablecoin's smallest unit (micro-units
    /// for both USDT and USDC). The legacy field name is kept to avoid
    /// touching every consumer of this struct in the same pass.
    pub amount_usdc: i64,
    /// Stablecoin symbol the agent paid in (e.g. "USDT", "USDC").
    pub currency: String,
    pub settlement_rail: String,
    pub privacy_disclosure: String,
}

/// Public agent pricing info for x402 discovery.
#[derive(Debug, Serialize)]
pub struct AgentPricing {
    pub slug: String,
    pub display_name: String,
    pub description: String,
    pub model_id: String,
    pub tags: Vec<String>,
    pub tools: Vec<String>,
    pub provider_reputation: f64,
    pub price_per_request_usdc: i64,
    pub price_per_1k_input: i64,
    pub price_per_1k_output: i64,
    pub payment_network: String,
    pub payment_asset: String,
    pub payment_destination: String,
}

/// Settlement response included in PAYMENT-RESPONSE header.
#[derive(Debug, Serialize)]
pub struct PaymentResponse {
    #[serde(rename = "x402Version")]
    pub x402_version: u8,
    pub settled: bool,
    pub actual_cost: i64,
    pub tx_signature: String,
    pub settlement_rail: String,
    pub privacy_disclosure: String,
    pub currency: String,
}

pub const SOLANA_PUBLIC_USDC_RAIL: &str = "solana_public_usdc";
pub const ALEO_USDCX_SHIELDED_RAIL: &str = "aleo_usdcx_shielded";
pub const SHIELDED_STABLECOIN_RAIL: &str = "shielded_stablecoin";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaymentRailKind {
    SolanaPublicStablecoin,
    ShieldedStablecoin,
}

impl PaymentRailKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PaymentRailKind::SolanaPublicStablecoin => "solana_public_stablecoin",
            PaymentRailKind::ShieldedStablecoin => SHIELDED_STABLECOIN_RAIL,
        }
    }

    pub fn canonical_rail(self) -> &'static str {
        match self {
            PaymentRailKind::SolanaPublicStablecoin => SOLANA_PUBLIC_USDC_RAIL,
            PaymentRailKind::ShieldedStablecoin => ALEO_USDCX_SHIELDED_RAIL,
        }
    }
}

pub const PUBLIC_STABLECOIN_DISCLOSURE: &str =
    "Public Solana settlement reveals payer, provider, amount, asset, and timing on-chain.";
pub const SHIELDED_STABLECOIN_DISCLOSURE: &str = "Private USDCx settlement on Aleo is designed to hide sender, receiver, and amount from public chain observers, subject to timing, bridge/xReserve, liquidity, recipient-disclosure, and adapter availability.";
const SHIELDED_UNCONFIGURED_REASON: &str = "shielded stablecoin adapter is not configured";
const SHIELDED_ADAPTER_URL_MISSING_REASON: &str =
    "shielded stablecoin adapter URL is not configured";
const SHIELDED_ADAPTER_AUTH_MISSING_REASON: &str =
    "shielded stablecoin adapter auth token is not configured";
const SHIELDED_RECIPIENT_MISSING_REASON: &str = "shielded stablecoin recipient is not configured";
const SHIELDED_ADAPTER_PUBKEY_MISSING_REASON: &str =
    "shielded adapter signing public key is not configured";
const SHIELDED_VERIFIER_NOT_READY_REASON: &str =
    "shielded stablecoin verifier is configured but not marked ready";

#[derive(Debug, Clone)]
pub struct ShieldedStablecoinConfig {
    pub provider: String,
    pub network: String,
    pub asset: String,
    pub destination: String,
    pub adapter_url: String,
    pub require_signed_receipt: bool,
    pub adapter_pubkey: Option<VerifyingKey>,
    pub verifier_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShieldedStablecoinRuntimeStatus {
    pub configured: bool,
    pub ready: bool,
    pub adapter_configured: bool,
    pub destination_configured: bool,
    pub adapter_auth_configured: bool,
    pub adapter_signature_required: bool,
    pub adapter_signature_configured: bool,
    pub verifier_ready: bool,
    pub arbitrary_recipient_proofs_enabled: bool,
    pub provider: String,
    pub network: String,
    pub asset: String,
    pub recipient_configured: bool,
    pub recipient_preview: Option<String>,
    #[serde(skip_serializing)]
    pub recipient: Option<String>,
    pub rail: &'static str,
    pub canonical_rail: &'static str,
    pub fallback_allowed: bool,
    pub unavailable_reason: Option<&'static str>,
    pub privacy_disclosure: &'static str,
}

pub fn parse_requested_payment_rail(raw: Option<&str>) -> Result<PaymentRailKind, CloudError> {
    match raw
        .unwrap_or("solana_public_stablecoin")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "solana" | "solana_x402" | "solana_public_stablecoin" | "solana_public_usdc" => {
            Ok(PaymentRailKind::SolanaPublicStablecoin)
        }
        "shielded" | "shielded_stablecoin" | "aleo_usdcx_shielded" => {
            Ok(PaymentRailKind::ShieldedStablecoin)
        }
        other => Err(CloudError::BadRequest(format!(
            "unsupported payment rail '{other}'"
        ))),
    }
}

fn shielded_config_from_env() -> Option<ShieldedStablecoinConfig> {
    let adapter_url = std::env::var("SHIELDED_STABLECOIN_ADAPTER_URL").ok()?;
    let provider =
        std::env::var("SHIELDED_STABLECOIN_PROVIDER").unwrap_or_else(|_| "aleo".to_string());
    let network =
        std::env::var("SHIELDED_STABLECOIN_NETWORK").unwrap_or_else(|_| "aleo:mainnet".to_string());
    let asset = std::env::var("SHIELDED_STABLECOIN_ASSET").unwrap_or_else(|_| "USDCx".to_string());
    let destination = std::env::var("SHIELDED_STABLECOIN_RECIPIENT").unwrap_or_default();
    let require_signed_receipt = shielded_adapter_signature_required();
    let adapter_pubkey = shielded_adapter_pubkey_from_env();
    let verifier_ready = shielded_verifier_ready();

    if adapter_url.trim().is_empty()
        || (destination.trim().is_empty() && !shielded_arbitrary_recipient_proofs_enabled())
    {
        return None;
    }
    shielded_adapter_auth_token_from_env()?;
    if require_signed_receipt && adapter_pubkey.is_none() {
        return None;
    }
    if !verifier_ready {
        return None;
    }

    Some(ShieldedStablecoinConfig {
        provider,
        network,
        asset,
        destination,
        adapter_url,
        require_signed_receipt,
        adapter_pubkey,
        verifier_ready,
    })
}

fn shielded_adapter_signature_required() -> bool {
    std::env::var("SHIELDED_STABLECOIN_REQUIRE_SIGNED_RECEIPT")
        .map(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no"))
        .unwrap_or(true)
}

fn shielded_arbitrary_recipient_proofs_enabled() -> bool {
    std::env::var("SHIELDED_STABLECOIN_ARBITRARY_RECIPIENTS_ENABLED")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

fn shielded_adapter_pubkey_from_env() -> Option<VerifyingKey> {
    let raw = std::env::var("SHIELDED_STABLECOIN_ADAPTER_PUBKEY").ok()?;
    parse_ed25519_verifying_key(raw.trim()).ok()
}

fn shielded_adapter_auth_token_from_env() -> Option<String> {
    std::env::var("SHIELDED_STABLECOIN_ADAPTER_AUTH_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn shielded_verifier_ready() -> bool {
    std::env::var("SHIELDED_STABLECOIN_VERIFIER_READY")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

fn parse_ed25519_verifying_key(raw: &str) -> Result<VerifyingKey, CloudError> {
    let key_bytes = if raw.len() == 64 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        hex::decode(raw)
            .map_err(|_| CloudError::Internal("invalid shielded adapter pubkey hex".into()))?
    } else {
        STANDARD
            .decode(raw)
            .map_err(|_| CloudError::Internal("invalid shielded adapter pubkey encoding".into()))?
    };
    let key_bytes: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| CloudError::Internal("shielded adapter pubkey must be 32 bytes".into()))?;
    VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| CloudError::Internal("invalid shielded adapter pubkey".into()))
}

pub fn shielded_stablecoin_configured() -> bool {
    shielded_config_from_env().is_some()
}

pub fn shielded_recipient_preview(recipient: &str) -> String {
    if recipient.len() <= 18 {
        return recipient.to_string();
    }
    format!(
        "{}...{}",
        &recipient[..8],
        &recipient[recipient.len() - 6..]
    )
}

pub fn shielded_stablecoin_runtime_status() -> ShieldedStablecoinRuntimeStatus {
    let adapter_configured = std::env::var("SHIELDED_STABLECOIN_ADAPTER_URL")
        .ok()
        .is_some_and(|s| !s.trim().is_empty());
    let adapter_auth_configured = shielded_adapter_auth_token_from_env().is_some();
    let arbitrary_recipient_proofs_enabled = shielded_arbitrary_recipient_proofs_enabled();
    let destination_configured = std::env::var("SHIELDED_STABLECOIN_RECIPIENT")
        .ok()
        .is_some_and(|s| !s.trim().is_empty());
    let adapter_signature_required = shielded_adapter_signature_required();
    let adapter_signature_configured = shielded_adapter_pubkey_from_env().is_some();
    let verifier_ready = shielded_verifier_ready();
    let provider =
        std::env::var("SHIELDED_STABLECOIN_PROVIDER").unwrap_or_else(|_| "aleo".to_string());
    let network =
        std::env::var("SHIELDED_STABLECOIN_NETWORK").unwrap_or_else(|_| "aleo:mainnet".to_string());
    let asset = std::env::var("SHIELDED_STABLECOIN_ASSET").unwrap_or_else(|_| "USDCx".to_string());
    let recipient = std::env::var("SHIELDED_STABLECOIN_RECIPIENT")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let configured = adapter_configured
        && adapter_auth_configured
        && (destination_configured || arbitrary_recipient_proofs_enabled)
        && (!adapter_signature_required || adapter_signature_configured)
        && verifier_ready;
    let unavailable_reason = if configured {
        None
    } else if !adapter_configured {
        Some(SHIELDED_ADAPTER_URL_MISSING_REASON)
    } else if !adapter_auth_configured {
        Some(SHIELDED_ADAPTER_AUTH_MISSING_REASON)
    } else if !destination_configured && !arbitrary_recipient_proofs_enabled {
        Some(SHIELDED_RECIPIENT_MISSING_REASON)
    } else if adapter_signature_required && !adapter_signature_configured {
        Some(SHIELDED_ADAPTER_PUBKEY_MISSING_REASON)
    } else if !verifier_ready {
        Some(SHIELDED_VERIFIER_NOT_READY_REASON)
    } else {
        Some(SHIELDED_UNCONFIGURED_REASON)
    };

    ShieldedStablecoinRuntimeStatus {
        configured,
        ready: configured,
        adapter_configured,
        destination_configured,
        adapter_auth_configured,
        adapter_signature_required,
        adapter_signature_configured,
        verifier_ready,
        arbitrary_recipient_proofs_enabled,
        provider,
        network,
        asset,
        recipient_configured: recipient.is_some(),
        recipient_preview: recipient.as_deref().map(shielded_recipient_preview),
        recipient,
        rail: PaymentRailKind::ShieldedStablecoin.as_str(),
        canonical_rail: ALEO_USDCX_SHIELDED_RAIL,
        fallback_allowed: false,
        unavailable_reason,
        privacy_disclosure: SHIELDED_STABLECOIN_DISCLOSURE,
    }
}

pub fn build_shielded_unavailable_response() -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    (
        StatusCode::PAYMENT_REQUIRED,
        axum::Json(serde_json::json!({
            "error": "shielded payment unavailable",
            "code": "shielded_adapter_unconfigured",
            "rail": PaymentRailKind::ShieldedStablecoin.as_str(),
            "canonical_rail": ALEO_USDCX_SHIELDED_RAIL,
            "settled": false,
            "fallback_allowed": false,
            "privacy_disclosure": "No shielded settlement was attempted. Ghola will not silently fall back to public Solana settlement.",
            "remediation": SHIELDED_UNCONFIGURED_REASON,
        })),
    )
        .into_response()
}

pub fn build_shielded_fallback_rejected_response() -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    (
        StatusCode::PAYMENT_REQUIRED,
        axum::Json(serde_json::json!({
            "error": "shielded payment required",
            "code": "shielded_public_fallback_rejected",
            "rail": PaymentRailKind::ShieldedStablecoin.as_str(),
            "canonical_rail": ALEO_USDCX_SHIELDED_RAIL,
            "settled": false,
            "fallback_allowed": false,
            "privacy_disclosure": "The caller requested shielded settlement. Ghola rejected the public payment proof instead of downgrading privacy.",
        })),
    )
        .into_response()
}

pub fn build_no_payment_options_response(
    rail: PaymentRailKind,
    reason: Option<&str>,
) -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    (
        StatusCode::PAYMENT_REQUIRED,
        axum::Json(serde_json::json!({
            "error": "payment unavailable",
            "code": "payment_options_unavailable",
            "rail": rail.as_str(),
            "canonical_rail": rail.canonical_rail(),
            "settled": false,
            "fallback_allowed": false,
            "remediation": reason.unwrap_or("no accepted payment option is currently available for the requested rail"),
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Network / Mint helpers
// ---------------------------------------------------------------------------

fn detect_network(rpc_url: &str) -> &'static str {
    if rpc_url.contains("devnet") {
        "solana:devnet"
    } else {
        "solana:mainnet"
    }
}

const SOLANA_MAINNET_CAIP2: &str = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET_CAIP2: &str = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

fn detect_caip2_network(rpc_url: &str) -> &'static str {
    if rpc_url.contains("devnet") {
        SOLANA_DEVNET_CAIP2
    } else {
        SOLANA_MAINNET_CAIP2
    }
}

fn network_matches_active_solana(rpc_url: &str, proof_network: &str) -> bool {
    proof_network == detect_caip2_network(rpc_url) || proof_network == detect_network(rpc_url)
}

fn payment_resource(state: &AppState, path: &str) -> String {
    format!("{}{}", state.config.base_url.trim_end_matches('/'), path)
}

fn decode_mint_bytes(mint_b58: &str) -> Option<[u8; 32]> {
    bs58::decode(mint_b58)
        .into_vec()
        .ok()
        .and_then(|v| v.try_into().ok())
}

/// Derive the Associated Token Account for a wallet + mint (same as wallet_service::find_ata).
fn find_ata(wallet: &[u8; 32], mint: &[u8; 32]) -> [u8; 32] {
    for bump in (0u8..=255).rev() {
        let mut hasher = Sha256::new();
        hasher.update(wallet);
        hasher.update(&TOKEN_PROGRAM_ID);
        hasher.update(mint);
        hasher.update([bump]);
        hasher.update(&ATA_PROGRAM_ID);
        hasher.update(b"ProgramDerivedAddress");
        let hash = hasher.finalize();
        let candidate: [u8; 32] = hash.into();
        if !is_on_curve(&candidate) {
            return candidate;
        }
    }
    panic!("could not find valid ATA bump");
}

fn is_on_curve(bytes: &[u8; 32]) -> bool {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    let compressed = CompressedEdwardsY(*bytes);
    compressed.decompress().is_some()
}

// ---------------------------------------------------------------------------
// Solana RPC helper (duplicated from wallet_service to keep it self-contained)
// ---------------------------------------------------------------------------

async fn rpc_call(
    client: &reqwest::Client,
    rpc_url: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    let resp: serde_json::Value = client
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Solana RPC request failed: {e}")))?
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("Solana RPC response parse failed: {e}")))?;

    if let Some(error) = resp.get("error") {
        return Err(CloudError::Internal(format!("Solana RPC error: {error}")));
    }
    resp.get("result")
        .cloned()
        .ok_or(CloudError::Internal("missing RPC result".into()))
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/// Estimate cost in micro-USDC for one inference request.
pub fn estimate_agent_price(
    price_per_1k_input: i64,
    price_per_1k_output: i64,
    max_tokens: u32,
) -> i64 {
    let input_estimate: i64 = 500; // typical user message + system prompt
    let output_estimate = max_tokens as i64;
    let cost = (input_estimate * price_per_1k_input + output_estimate * price_per_1k_output) / 1000;
    cost.max(1000) // minimum $0.001
}

/// Build payment requirements for an agent request.
pub fn build_payment_requirements(
    state: &AppState,
    agent_id: Uuid,
    agent_slug: &str,
    model_id: &str,
    price_per_1k_input: i64,
    price_per_1k_output: i64,
    max_tokens: u32,
) -> PaymentRequirements {
    let resource = payment_resource(state, "/v1/chat/completions");
    build_payment_requirements_for_resource(
        state,
        agent_id,
        agent_slug,
        model_id,
        price_per_1k_input,
        price_per_1k_output,
        max_tokens,
        &resource,
        "POST",
        None,
    )
}

pub fn build_payment_requirements_for_resource(
    state: &AppState,
    agent_id: Uuid,
    agent_slug: &str,
    model_id: &str,
    price_per_1k_input: i64,
    price_per_1k_output: i64,
    max_tokens: u32,
    resource: &str,
    method: &str,
    payment_identifier: Option<&str>,
) -> PaymentRequirements {
    let amount = estimate_agent_price(price_per_1k_input, price_per_1k_output, max_tokens);
    let rpc_url = &state.config.solana_rpc_url;
    let legacy_network = detect_network(rpc_url).to_string();
    let network = detect_caip2_network(rpc_url).to_string();
    let destination = state
        .config
        .platform_wallet_address
        .clone()
        .unwrap_or_default();
    let amount_s = amount.to_string();
    let price = format!("${:.6}", amount as f64 / 1_000_000.0);
    let mut extensions = serde_json::Map::new();
    extensions.insert(
        "bazaar".to_string(),
        bazaar_discovery_extension(agent_slug, resource, method),
    );
    if payment_identifier.is_some() {
        extensions.insert(
            "payment-identifier".to_string(),
            json!({
                "required": false
            }),
        );
    }

    // One PaymentOption per non-paused stablecoin. USDT comes first in the
    // SUPPORTED_TOKENS slice; agents reading `accepts[0]` get the platform
    // default. If both stablecoins are paused for some reason, accepts is
    // empty and the 402 response correctly tells the agent "nothing accepted
    // right now".
    let shielded_config = shielded_config_from_env();
    let shielded_available = shielded_config.is_some();
    let mut accepts: Vec<PaymentOption> = active_tokens(rpc_url)
        .into_iter()
        .map(|(token, mint)| PaymentOption {
            scheme: "exact".to_string(),
            network: network.clone(),
            amount: amount_s.clone(),
            asset: mint,
            destination: destination.clone(),
            price: price.clone(),
            pay_to: destination.clone(),
            max_amount_required: amount_s.clone(),
            description: format!(
                "Agent: {agent_slug} — 1 inference request ({})",
                token.symbol
            ),
            resource: Some(resource.to_string()),
            method: Some(method.to_string()),
            mime_type: Some("application/json".to_string()),
            extra: PaymentExtra {
                agent_id: agent_id.to_string(),
                agent_slug: agent_slug.to_string(),
                model_id: model_id.to_string(),
                max_tokens,
                price_per_1k_input,
                price_per_1k_output,
                payment_rail: PaymentRailKind::SolanaPublicStablecoin.as_str().to_string(),
                canonical_rail: PaymentRailKind::SolanaPublicStablecoin
                    .canonical_rail()
                    .to_string(),
                legacy_network: Some(legacy_network.clone()),
                token_decimals: token.decimals,
                payment_identifier_supported: payment_identifier.is_some(),
                privacy_disclosure: PUBLIC_STABLECOIN_DISCLOSURE.to_string(),
                shielded_available,
                shielded_unavailable_reason: if shielded_available {
                    None
                } else {
                    Some(SHIELDED_UNCONFIGURED_REASON.to_string())
                },
            },
        })
        .collect();

    if let Some(config) = shielded_config {
        accepts.push(PaymentOption {
            scheme: "shielded_stablecoin".to_string(),
            network: config.network,
            amount: amount_s.clone(),
            asset: config.asset,
            destination: config.destination.clone(),
            price: price.clone(),
            pay_to: config.destination,
            max_amount_required: amount_s.clone(),
            description: format!("Agent: {agent_slug} — 1 private inference request"),
            resource: Some(resource.to_string()),
            method: Some(method.to_string()),
            mime_type: Some("application/json".to_string()),
            extra: PaymentExtra {
                agent_id: agent_id.to_string(),
                agent_slug: agent_slug.to_string(),
                model_id: model_id.to_string(),
                max_tokens,
                price_per_1k_input,
                price_per_1k_output,
                payment_rail: PaymentRailKind::ShieldedStablecoin.as_str().to_string(),
                canonical_rail: PaymentRailKind::ShieldedStablecoin
                    .canonical_rail()
                    .to_string(),
                legacy_network: None,
                token_decimals: 6,
                payment_identifier_supported: payment_identifier.is_some(),
                privacy_disclosure: SHIELDED_STABLECOIN_DISCLOSURE.to_string(),
                shielded_available: true,
                shielded_unavailable_reason: None,
            },
        });
    }

    PaymentRequirements {
        x402_version: 2,
        accepts,
        resource: Some(resource.to_string()),
        method: Some(method.to_string()),
        mime_type: Some("application/json".to_string()),
        description: Some(format!("Agent: {agent_slug} — 1 inference request")),
        extensions: Some(Value::Object(extensions)),
    }
}

pub fn bazaar_discovery_extension(agent_slug: &str, resource: &str, method: &str) -> Value {
    json!({
        "type": "api",
        "serviceName": "Ghola Agent Marketplace",
        "name": format!("ghola.agent.{agent_slug}"),
        "description": format!("Run the public Ghola agent '{agent_slug}' through the OpenAI-compatible paid x402 endpoint."),
        "transport": "http",
        "method": method,
        "url": resource,
        "input": {
            "model": format!("agent:{agent_slug}"),
            "messages": [
                {
                    "role": "user",
                    "content": "Describe what you can do."
                }
            ]
        },
        "inputSchema": {
            "type": "object",
            "properties": {
                "model": {
                    "type": "string",
                    "const": format!("agent:{agent_slug}")
                },
                "messages": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "role": {
                                "type": "string",
                                "enum": ["system", "user", "assistant"]
                            },
                            "content": {
                                "type": "string"
                            }
                        },
                        "required": ["role", "content"]
                    }
                },
                "max_tokens": {
                    "type": "integer",
                    "minimum": 1
                }
            },
            "required": ["model", "messages"]
        }
    })
}

pub fn filter_payment_requirements_for_rail(
    requirements: &mut PaymentRequirements,
    rail: PaymentRailKind,
) {
    requirements
        .accepts
        .retain(|option| option.extra.payment_rail == rail.as_str());
}

pub fn payment_requirements_have_options(requirements: &PaymentRequirements) -> bool {
    !requirements.accepts.is_empty()
}

pub fn proof_matches_rail(proof: &PaymentProof, rail: PaymentRailKind) -> bool {
    match rail {
        PaymentRailKind::SolanaPublicStablecoin => proof.scheme == "exact",
        PaymentRailKind::ShieldedStablecoin => proof.scheme == "shielded_stablecoin",
    }
}

/// Build the HTTP 402 response with payment requirements.
pub fn build_402_response(requirements: &PaymentRequirements) -> axum::response::Response {
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;

    let json_bytes = serde_json::to_vec(requirements).unwrap_or_default();
    let b64 = STANDARD.encode(&json_bytes);

    let body = serde_json::json!({
        "error": "payment required",
        "payment_requirements": requirements,
    });

    (
        StatusCode::PAYMENT_REQUIRED,
        [(header::HeaderName::from_static("payment-required"), b64)],
        axum::Json(body),
    )
        .into_response()
}

/// Verify an on-chain Solana USDC payment.
pub async fn verify_payment(
    state: &AppState,
    proof: &PaymentProof,
    required_amount: i64,
    agent_id: Uuid,
    provider_id: Uuid,
    model_id: &str,
) -> Result<VerifiedPayment, CloudError> {
    if proof.x402_version != "1" && proof.x402_version != "2" {
        return Err(CloudError::PaymentRequired(format!(
            "unsupported x402 version: {}",
            proof.x402_version
        )));
    }
    if proof.scheme == "shielded_stablecoin" {
        return verify_shielded_payment(
            state,
            proof,
            required_amount,
            agent_id,
            provider_id,
            model_id,
        )
        .await;
    }
    if proof.scheme != "exact" {
        return Err(CloudError::PaymentRequired(format!(
            "unsupported payment scheme: {}",
            proof.scheme
        )));
    }

    let rpc_url = &state.config.solana_rpc_url;
    let expected_network = detect_network(rpc_url);
    let expected_caip2_network = detect_caip2_network(rpc_url);

    // Check network matches
    if !network_matches_active_solana(rpc_url, &proof.network) {
        return Err(CloudError::PaymentRequired(format!(
            "network mismatch: expected {expected_caip2_network} or {expected_network}, got {}",
            proof.network
        )));
    }

    let tx_sig = proof
        .payload
        .tx_signature
        .as_deref()
        .ok_or_else(|| CloudError::PaymentRequired("missing tx_signature".into()))?;

    // Check replay — has this tx already been used?
    // If status is 'failed', allow retry (provider failure after payment).
    // Use atomic UPDATE ... RETURNING to prevent two concurrent retries from both succeeding.
    let retry_payment_id: Option<Uuid> = sqlx::query_scalar(
        "UPDATE x402_payments SET status = 'pending' WHERE tx_signature = $1 AND status = 'failed' RETURNING id",
    )
    .bind(tx_sig)
    .fetch_optional(&state.db)
    .await
    .map_err(CloudError::Database)?;

    if retry_payment_id.is_none() {
        // No failed payment was claimed — check if a non-failed record exists (replay)
        let already_used: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM x402_payments WHERE tx_signature = $1)",
        )
        .bind(tx_sig)
        .fetch_one(&state.db)
        .await
        .unwrap_or(false);

        if already_used {
            return Err(CloudError::PaymentRequired(
                "transaction already used (replay rejected)".to_string(),
            ));
        }
    }

    // Fetch transaction from Solana
    let client = reqwest::Client::new();
    let result = rpc_call(
        &client,
        rpc_url,
        "getTransaction",
        serde_json::json!([
            tx_sig,
            {
                "encoding": "jsonParsed",
                "commitment": "finalized",
                "maxSupportedTransactionVersion": 0
            }
        ]),
    )
    .await
    .map_err(|e| CloudError::PaymentRequired(format!("failed to fetch transaction: {e}")))?;

    // Check that the transaction exists and succeeded
    if result.is_null() {
        return Err(CloudError::PaymentRequired(
            "transaction not finalized yet — retry in 15-30 seconds".to_string(),
        ));
    }

    if result
        .get("meta")
        .and_then(|m| m.get("err"))
        .map(|e| !e.is_null())
        .unwrap_or(true)
    {
        return Err(CloudError::PaymentRequired(
            "transaction failed on-chain".to_string(),
        ));
    }

    // Fix 1: Check transaction recency — must be within last 10 minutes
    let block_time = result.get("blockTime").and_then(|v| v.as_i64());
    let now = chrono::Utc::now().timestamp();
    const MAX_TX_AGE_SECS: i64 = 600; // 10 minutes

    match block_time {
        Some(bt) if (now - bt) > MAX_TX_AGE_SECS => {
            return Err(CloudError::PaymentRequired(format!(
                "transaction too old: {} seconds ago (max {})",
                now - bt,
                MAX_TX_AGE_SECS
            )));
        }
        None => {
            return Err(CloudError::PaymentRequired(
                "transaction missing blockTime — cannot verify recency".to_string(),
            ));
        }
        _ => {} // within window
    }

    // Build the (mint, destination_ata, currency_symbol) acceptance set: one
    // entry per non-paused stablecoin. The agent's transferChecked must hit
    // any of these mint+ATA pairs.
    let platform_wallet = state
        .config
        .platform_wallet_address
        .as_deref()
        .ok_or_else(|| CloudError::Internal("platform wallet not configured".into()))?;
    let platform_bytes: [u8; 32] = bs58::decode(platform_wallet)
        .into_vec()
        .map_err(|e| CloudError::Internal(format!("invalid platform wallet: {e}")))?
        .try_into()
        .map_err(|_| CloudError::Internal("platform wallet wrong length".into()))?;

    let mut accept_set: Vec<(String, String, String)> = Vec::new();
    for (token, mint_b58) in active_tokens(rpc_url) {
        let Some(mint_bytes) = decode_mint_bytes(&mint_b58) else {
            continue;
        };
        let ata = find_ata(&platform_bytes, &mint_bytes);
        accept_set.push((
            mint_b58,
            bs58::encode(ata).into_string(),
            token.symbol.to_string(),
        ));
    }
    if accept_set.is_empty() {
        return Err(CloudError::PaymentRequired(
            "no stablecoins currently accepted (all paused)".to_string(),
        ));
    }

    let (paid_amount, payer_address, currency) = extract_transfer_info(&result, &accept_set)?;

    // Check amount
    if paid_amount < required_amount {
        return Err(CloudError::PaymentRequired(format!(
            "insufficient payment: paid {paid_amount}, required {required_amount}"
        )));
    }

    // Record payment (or reuse existing for retry)
    let payment_id: Uuid = if let Some(rid) = retry_payment_id {
        rid
    } else {
        sqlx::query_scalar(
            r#"
            INSERT INTO x402_payments
                (tx_signature, payer_address, amount_usdc, required_amount_usdc,
                 agent_id, provider_id, model_id, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
            RETURNING id
            "#,
        )
        .bind(tx_sig)
        .bind(&payer_address)
        .bind(paid_amount)
        .bind(required_amount)
        .bind(agent_id)
        .bind(provider_id)
        .bind(model_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| {
            if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
                CloudError::PaymentRequired(
                    "transaction already used (replay rejected)".to_string(),
                )
            } else {
                CloudError::Database(e)
            }
        })?
    };

    tracing::info!(
        %tx_sig, %payer_address, paid_amount, required_amount, %currency,
        %agent_id, "x402 payment verified"
    );

    Ok(VerifiedPayment {
        payment_id,
        tx_signature: tx_sig.to_string(),
        payer_address,
        amount_usdc: paid_amount,
        currency,
        settlement_rail: PaymentRailKind::SolanaPublicStablecoin.as_str().to_string(),
        privacy_disclosure: PUBLIC_STABLECOIN_DISCLOSURE.to_string(),
    })
}

#[derive(Debug, Serialize)]
struct ShieldedVerifyRequest<'a> {
    provider: &'a str,
    network: &'a str,
    asset: &'a str,
    destination: &'a str,
    required_amount: i64,
    purpose: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    intent_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_id: Option<&'a str>,
    proof: &'a PaymentPayload,
}

#[derive(Debug, Deserialize, Serialize)]
struct ShieldedVerifyResponse {
    settled: bool,
    receipt_id: Option<String>,
    nullifier_hex: Option<String>,
    payer_address: Option<String>,
    amount: Option<i64>,
    currency: Option<String>,
    provider: Option<String>,
    network: Option<String>,
    asset: Option<String>,
    destination: Option<String>,
    proof_digest: Option<String>,
    observed_at_unix: Option<i64>,
    expires_at_unix: Option<i64>,
    confirmations: Option<u32>,
    adapter_signature_b64: Option<String>,
    adapter_key_id: Option<String>,
    error: Option<String>,
}

pub struct ShieldedSettlementContext<'a> {
    pub required_amount: i64,
    pub purpose: &'a str,
    pub destination: Option<&'a str>,
    pub intent_id: Option<Uuid>,
    pub agent_id: Option<Uuid>,
    pub provider_id: Option<Uuid>,
    pub model_id: Option<&'a str>,
}

#[derive(Debug)]
pub struct VerifiedShieldedSettlement {
    pub replay_key: String,
    pub receipt_ref: String,
    pub payer_address: String,
    pub amount: i64,
    pub currency: String,
    pub provider: String,
    pub network: String,
    pub asset: String,
    pub destination: String,
    pub proof_digest: String,
}

fn shielded_proof_digest(proof: &PaymentPayload) -> Result<String, CloudError> {
    let tx_signature = serde_json::to_string(&proof.tx_signature)
        .map_err(|e| CloudError::Internal(format!("shielded proof serialization failed: {e}")))?;
    let shielded_receipt_id = serde_json::to_string(&proof.shielded_receipt_id)
        .map_err(|e| CloudError::Internal(format!("shielded proof serialization failed: {e}")))?;
    let proof_b64 = serde_json::to_string(&proof.proof_b64)
        .map_err(|e| CloudError::Internal(format!("shielded proof serialization failed: {e}")))?;
    let nullifier_hex = serde_json::to_string(&proof.nullifier_hex)
        .map_err(|e| CloudError::Internal(format!("shielded proof serialization failed: {e}")))?;
    let canonical = format!(
        "{{\"tx_signature\":{tx_signature},\"shielded_receipt_id\":{shielded_receipt_id},\"proof_b64\":{proof_b64},\"nullifier_hex\":{nullifier_hex}}}"
    );
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

fn require_matching_adapter_field(
    field_name: &str,
    actual: Option<&str>,
    expected: &str,
) -> Result<(), CloudError> {
    let actual = actual.ok_or_else(|| {
        CloudError::PaymentRequired(format!("shielded adapter response missing {field_name}"))
    })?;
    if actual != expected {
        return Err(CloudError::PaymentRequired(format!(
            "shielded adapter {field_name} mismatch"
        )));
    }
    Ok(())
}

fn signed_shielded_receipt_payload(
    config: &ShieldedStablecoinConfig,
    response: &ShieldedVerifyResponse,
    destination: &str,
    required_amount: i64,
    paid_amount: i64,
    receipt_ref: &str,
    proof_digest: &str,
    observed_at_unix: i64,
    expires_at_unix: i64,
) -> String {
    format!(
        concat!(
            "ghola-shielded-stablecoin-v1\n",
            "provider:{provider}\n",
            "network:{network}\n",
            "asset:{asset}\n",
            "destination:{destination}\n",
            "required_amount:{required_amount}\n",
            "paid_amount:{paid_amount}\n",
            "receipt_ref:{receipt_ref}\n",
            "proof_digest:{proof_digest}\n",
            "observed_at_unix:{observed_at_unix}\n",
            "expires_at_unix:{expires_at_unix}\n",
            "confirmations:{confirmations}\n",
            "settled:true"
        ),
        provider = config.provider,
        network = config.network,
        asset = config.asset,
        destination = destination,
        required_amount = required_amount,
        paid_amount = paid_amount,
        receipt_ref = receipt_ref,
        proof_digest = proof_digest,
        observed_at_unix = observed_at_unix,
        expires_at_unix = expires_at_unix,
        confirmations = response.confirmations.unwrap_or(0),
    )
}

fn validate_shielded_adapter_response(
    config: &ShieldedStablecoinConfig,
    response: &ShieldedVerifyResponse,
    expected_destination: &str,
    required_amount: i64,
    proof: &PaymentPayload,
    fallback_receipt_ref: &str,
) -> Result<String, CloudError> {
    require_matching_adapter_field("provider", response.provider.as_deref(), &config.provider)?;
    require_matching_adapter_field("network", response.network.as_deref(), &config.network)?;
    require_matching_adapter_field("asset", response.asset.as_deref(), &config.asset)?;
    require_matching_adapter_field(
        "destination",
        response.destination.as_deref(),
        expected_destination,
    )?;

    let paid_amount = response.amount.unwrap_or(0);
    let canonical_receipt_ref = response
        .nullifier_hex
        .as_deref()
        .or(response.receipt_id.as_deref())
        .unwrap_or(fallback_receipt_ref);
    let expected_digest = shielded_proof_digest(proof)?;
    let response_digest = response.proof_digest.as_deref().ok_or_else(|| {
        CloudError::PaymentRequired("shielded adapter response missing proof_digest".into())
    })?;
    if response_digest != expected_digest {
        return Err(CloudError::PaymentRequired(
            "shielded adapter proof digest mismatch".into(),
        ));
    }

    let observed_at_unix = response.observed_at_unix.ok_or_else(|| {
        CloudError::PaymentRequired("shielded adapter response missing observed_at_unix".into())
    })?;
    let expires_at_unix = response.expires_at_unix.ok_or_else(|| {
        CloudError::PaymentRequired("shielded adapter response missing expires_at_unix".into())
    })?;
    let now = chrono::Utc::now().timestamp();
    if expires_at_unix <= now {
        return Err(CloudError::PaymentRequired(
            "shielded adapter receipt expired".into(),
        ));
    }
    if observed_at_unix > now + 300 {
        return Err(CloudError::PaymentRequired(
            "shielded adapter receipt is from the future".into(),
        ));
    }

    if config.require_signed_receipt {
        response
            .adapter_key_id
            .as_deref()
            .filter(|key_id| !key_id.trim().is_empty())
            .ok_or_else(|| {
                CloudError::PaymentRequired(
                    "shielded adapter response missing adapter_key_id".into(),
                )
            })?;
        let pubkey = config.adapter_pubkey.as_ref().ok_or_else(|| {
            CloudError::PaymentRequired("shielded adapter pubkey is not configured".into())
        })?;
        let signature_b64 = response.adapter_signature_b64.as_deref().ok_or_else(|| {
            CloudError::PaymentRequired(
                "shielded adapter response missing adapter_signature_b64".into(),
            )
        })?;
        let signature_bytes = STANDARD.decode(signature_b64).map_err(|_| {
            CloudError::PaymentRequired("shielded adapter signature is not base64".into())
        })?;
        let signature = Signature::from_slice(&signature_bytes).map_err(|_| {
            CloudError::PaymentRequired("shielded adapter signature is malformed".into())
        })?;
        let signed_payload = signed_shielded_receipt_payload(
            config,
            response,
            expected_destination,
            required_amount,
            paid_amount,
            canonical_receipt_ref,
            &expected_digest,
            observed_at_unix,
            expires_at_unix,
        );
        pubkey
            .verify(signed_payload.as_bytes(), &signature)
            .map_err(|_| {
                CloudError::PaymentRequired("shielded adapter signature verification failed".into())
            })?;
    }

    Ok(canonical_receipt_ref.to_string())
}

pub async fn verify_shielded_stablecoin_settlement(
    _state: &AppState,
    proof: &PaymentProof,
    context: ShieldedSettlementContext<'_>,
) -> Result<VerifiedShieldedSettlement, CloudError> {
    if proof.scheme != SHIELDED_STABLECOIN_RAIL {
        return Err(CloudError::PaymentRequired(format!(
            "unsupported shielded payment scheme: {}",
            proof.scheme
        )));
    }

    let config = shielded_config_from_env().ok_or_else(|| {
        CloudError::PaymentRequired(
            "shielded stablecoin requested but adapter is not configured; refusing public fallback"
                .into(),
        )
    })?;
    let expected_destination = context.destination.unwrap_or(&config.destination);

    if proof.network != config.network {
        return Err(CloudError::PaymentRequired(format!(
            "shielded network mismatch: expected {}, got {}",
            config.network, proof.network
        )));
    }

    let receipt_ref = proof
        .payload
        .nullifier_hex
        .as_deref()
        .or(proof.payload.shielded_receipt_id.as_deref())
        .ok_or_else(|| {
            CloudError::PaymentRequired(
                "missing shielded nullifier_hex or shielded_receipt_id".into(),
            )
        })?;

    let client = reqwest::Client::new();
    let mut adapter_request = client
        .post(format!(
            "{}/verify",
            config.adapter_url.trim_end_matches('/')
        ))
        .json(&ShieldedVerifyRequest {
            provider: &config.provider,
            network: &config.network,
            asset: &config.asset,
            destination: expected_destination,
            required_amount: context.required_amount,
            purpose: context.purpose,
            intent_id: context.intent_id,
            agent_id: context.agent_id,
            provider_id: context.provider_id,
            model_id: context.model_id,
            proof: &proof.payload,
        });
    if let Some(token) = shielded_adapter_auth_token_from_env() {
        adapter_request = adapter_request.bearer_auth(token);
    }

    let adapter_response = adapter_request
        .send()
        .await
        .map_err(|e| CloudError::PaymentRequired(format!("shielded adapter request failed: {e}")))?
        .json::<ShieldedVerifyResponse>()
        .await
        .map_err(|e| {
            CloudError::PaymentRequired(format!("shielded adapter response invalid: {e}"))
        })?;

    if !adapter_response.settled {
        return Err(CloudError::PaymentRequired(
            adapter_response
                .error
                .unwrap_or_else(|| "shielded settlement was not verified".into()),
        ));
    }

    let paid_amount = adapter_response.amount.unwrap_or(0);
    if paid_amount < context.required_amount {
        return Err(CloudError::PaymentRequired(format!(
            "insufficient shielded payment: paid {paid_amount}, required {}",
            context.required_amount
        )));
    }

    let canonical_receipt_ref = validate_shielded_adapter_response(
        &config,
        &adapter_response,
        expected_destination,
        context.required_amount,
        &proof.payload,
        receipt_ref,
    )?;
    let replay_key = format!("shielded:{}:{canonical_receipt_ref}", config.provider);
    let proof_digest = shielded_proof_digest(&proof.payload)?;
    let payer_address = adapter_response
        .payer_address
        .unwrap_or_else(|| "shielded".to_string());
    let currency = adapter_response
        .currency
        .unwrap_or_else(|| config.asset.clone());

    Ok(VerifiedShieldedSettlement {
        replay_key,
        receipt_ref: canonical_receipt_ref,
        payer_address,
        amount: paid_amount,
        currency,
        provider: config.provider,
        network: config.network,
        asset: config.asset,
        destination: expected_destination.to_string(),
        proof_digest,
    })
}

async fn verify_shielded_payment(
    state: &AppState,
    proof: &PaymentProof,
    required_amount: i64,
    agent_id: Uuid,
    provider_id: Uuid,
    model_id: &str,
) -> Result<VerifiedPayment, CloudError> {
    let verified = verify_shielded_stablecoin_settlement(
        state,
        proof,
        ShieldedSettlementContext {
            required_amount,
            purpose: "agent_x402",
            destination: None,
            intent_id: None,
            agent_id: Some(agent_id),
            provider_id: Some(provider_id),
            model_id: Some(model_id),
        },
    )
    .await?;

    let already_used: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM x402_payments WHERE tx_signature = $1)")
            .bind(&verified.replay_key)
            .fetch_one(&state.db)
            .await
            .unwrap_or(false);

    if already_used {
        return Err(CloudError::PaymentRequired(
            "shielded payment already used (replay rejected)".to_string(),
        ));
    }

    let payment_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO x402_payments
            (tx_signature, payer_address, amount_usdc, required_amount_usdc,
             agent_id, provider_id, model_id, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
        RETURNING id
        "#,
    )
    .bind(&verified.replay_key)
    .bind(&verified.payer_address)
    .bind(verified.amount)
    .bind(required_amount)
    .bind(agent_id)
    .bind(provider_id)
    .bind(model_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            CloudError::PaymentRequired(
                "shielded payment already used (replay rejected)".to_string(),
            )
        } else {
            CloudError::Database(e)
        }
    })?;

    tracing::info!(
        rail = ALEO_USDCX_SHIELDED_RAIL,
        %agent_id,
        "shielded stablecoin payment verified"
    );

    Ok(VerifiedPayment {
        payment_id,
        tx_signature: verified.replay_key,
        payer_address: verified.payer_address,
        amount_usdc: verified.amount,
        currency: verified.currency,
        settlement_rail: PaymentRailKind::ShieldedStablecoin.as_str().to_string(),
        privacy_disclosure: SHIELDED_STABLECOIN_DISCLOSURE.to_string(),
    })
}

/// Extract the stablecoin transfer amount, payer, and currency from a parsed
/// Solana transaction. Matches against any (mint, destination_ata, symbol)
/// tuple in `accept_set`.
fn extract_transfer_info(
    tx_result: &serde_json::Value,
    accept_set: &[(String, String, String)],
) -> Result<(i64, String, String), CloudError> {
    let mut all_instructions = Vec::new();

    if let Some(instructions) = tx_result
        .pointer("/transaction/message/instructions")
        .and_then(|v| v.as_array())
    {
        all_instructions.extend(instructions.iter());
    }
    if let Some(inner) = tx_result
        .pointer("/meta/innerInstructions")
        .and_then(|v| v.as_array())
    {
        for group in inner {
            if let Some(ixs) = group.get("instructions").and_then(|v| v.as_array()) {
                all_instructions.extend(ixs.iter());
            }
        }
    }

    for ix in &all_instructions {
        let parsed = match ix.get("parsed") {
            Some(p) => p,
            None => continue,
        };

        let ix_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ix_type != "transferChecked" {
            continue;
        }
        let info = match parsed.get("info") {
            Some(i) => i,
            None => continue,
        };

        let mint = info.get("mint").and_then(|v| v.as_str()).unwrap_or("");
        let dest = info
            .get("destination")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let matched = accept_set
            .iter()
            .find(|(m, ata, _)| mint == m && dest == ata);
        let Some((_, _, currency)) = matched else {
            continue;
        };

        let amount_str = info
            .pointer("/tokenAmount/amount")
            .and_then(|v| v.as_str())
            .unwrap_or("0");
        let amount: i64 = amount_str.parse().unwrap_or(0);
        let authority = info
            .get("authority")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Ok((amount, authority, currency.clone()));
    }

    Err(CloudError::PaymentRequired(
        "no valid stablecoin transfer to platform wallet found in transaction".to_string(),
    ))
}

/// Settle an x402 payment after successful inference (85/15 split).
pub async fn settle_x402_payment(
    db: &PgPool,
    payment_id: Uuid,
    input_tokens: i32,
    output_tokens: i32,
    latency_ms: i32,
    price_per_1k_input: i64,
    price_per_1k_output: i64,
) -> Result<(), CloudError> {
    let actual_cost = (input_tokens as i64 * price_per_1k_input
        + output_tokens as i64 * price_per_1k_output)
        / 1000;
    let paid_amount: i64 =
        sqlx::query_scalar("SELECT amount_usdc FROM x402_payments WHERE id = $1")
            .bind(payment_id)
            .fetch_one(db)
            .await?;
    let actual_cost = actual_cost.max(1000).min(paid_amount); // minimum $0.001, capped at prepaid amount

    let provider_amount = actual_cost * 85 / 100;
    let platform_fee = actual_cost - provider_amount;

    sqlx::query(
        r#"
        UPDATE x402_payments SET
            settled = true,
            status = 'settled',
            provider_amount = $1,
            platform_fee = $2,
            input_tokens = $3,
            output_tokens = $4,
            latency_ms = $5,
            settled_at = now()
        WHERE id = $6
        "#,
    )
    .bind(provider_amount)
    .bind(platform_fee)
    .bind(input_tokens)
    .bind(output_tokens)
    .bind(latency_ms)
    .bind(payment_id)
    .execute(db)
    .await?;

    // Credit provider's total_earned_usdc
    sqlx::query(
        r#"
        UPDATE compute_providers
        SET total_earned_usdc = total_earned_usdc + $1, updated_at = now()
        WHERE id = (SELECT provider_id FROM x402_payments WHERE id = $2)
        "#,
    )
    .bind(provider_amount)
    .bind(payment_id)
    .execute(db)
    .await?;

    tracing::info!(
        %payment_id, input_tokens, output_tokens, actual_cost,
        provider_amount, platform_fee, "x402 payment settled"
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// List all active agents with x402 pricing info.
pub async fn list_agent_pricing(
    db: &PgPool,
    state: &AppState,
    tags_filter: Option<&str>,
    sort: Option<&str>,
) -> Result<Vec<AgentPricing>, CloudError> {
    let rpc_url = &state.config.solana_rpc_url;
    let network = detect_caip2_network(rpc_url).to_string();
    // Discovery summary surfaces the platform's *primary* (first non-paused)
    // stablecoin mint. Per-agent detail responses can return the full
    // accepts-array via `build_payment_requirements`.
    let asset = active_tokens(rpc_url)
        .first()
        .map(|(_, m)| m.clone())
        .unwrap_or_default();
    let destination = state
        .config
        .platform_wallet_address
        .clone()
        .unwrap_or_default();

    let order = match sort {
        Some("price") => "price_estimate ASC",
        Some("rating") => "a.avg_rating DESC",
        Some("newest") => "a.created_at DESC",
        _ => "a.total_conversations DESC",
    };

    let base = format!(
        r#"
        SELECT
            a.slug, a.display_name, a.description, a.model_id,
            a.tags, a.tools, a.max_tokens,
            cp.reputation_score, cp.models AS provider_models
        FROM rental_agents a
        JOIN compute_providers cp ON a.provider_id = cp.id
        WHERE a.is_active = true AND a.is_public = true AND cp.status = 'online'
        {tag_filter}
        ORDER BY {order}
        LIMIT 100
        "#,
        tag_filter = if tags_filter.is_some() {
            "AND a.tags && $1"
        } else {
            ""
        },
        order = order,
    );

    let rows = if let Some(tags_str) = tags_filter {
        let tags: Vec<String> = tags_str.split(',').map(|s| s.trim().to_string()).collect();
        sqlx::query(&base).bind(&tags).fetch_all(db).await?
    } else {
        sqlx::query(&base).fetch_all(db).await?
    };

    use sqlx::Row;
    Ok(rows
        .iter()
        .map(|row| {
            let model_id: String = row.get("model_id");
            let provider_models: serde_json::Value = row.get("provider_models");
            let max_tokens: i32 = row.get("max_tokens");
            let (price_in, price_out) = extract_model_pricing(&provider_models, &model_id);
            let price_estimate = estimate_agent_price(price_in, price_out, max_tokens as u32);

            AgentPricing {
                slug: row.get("slug"),
                display_name: row.get("display_name"),
                description: row.get("description"),
                model_id,
                tags: row.get("tags"),
                tools: row.get("tools"),
                provider_reputation: row.get("reputation_score"),
                price_per_request_usdc: price_estimate,
                price_per_1k_input: price_in,
                price_per_1k_output: price_out,
                payment_network: network.clone(),
                payment_asset: asset.clone(),
                payment_destination: destination.clone(),
            }
        })
        .collect())
}

/// Get pricing for a single agent by slug.
pub async fn get_agent_pricing(
    db: &PgPool,
    state: &AppState,
    slug: &str,
) -> Result<AgentPricing, CloudError> {
    use sqlx::Row;

    let row = sqlx::query(
        r#"
        SELECT
            a.slug, a.display_name, a.description, a.model_id,
            a.tags, a.tools, a.max_tokens,
            cp.reputation_score, cp.models AS provider_models
        FROM rental_agents a
        JOIN compute_providers cp ON a.provider_id = cp.id
        WHERE a.slug = $1 AND a.is_active = true AND a.is_public = true
        "#,
    )
    .bind(slug)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloudError::NotFound("agent not found".into()))?;

    let rpc_url = &state.config.solana_rpc_url;
    let model_id: String = row.get("model_id");
    let provider_models: serde_json::Value = row.get("provider_models");
    let max_tokens: i32 = row.get("max_tokens");
    let (price_in, price_out) = extract_model_pricing(&provider_models, &model_id);
    let price_estimate = estimate_agent_price(price_in, price_out, max_tokens as u32);

    Ok(AgentPricing {
        slug: row.get("slug"),
        display_name: row.get("display_name"),
        description: row.get("description"),
        model_id,
        tags: row.get("tags"),
        tools: row.get("tools"),
        provider_reputation: row.get("reputation_score"),
        price_per_request_usdc: price_estimate,
        price_per_1k_input: price_in,
        price_per_1k_output: price_out,
        payment_network: detect_caip2_network(rpc_url).to_string(),
        payment_asset: active_tokens(rpc_url)
            .first()
            .map(|(_, m)| m.clone())
            .unwrap_or_default(),
        payment_destination: state
            .config
            .platform_wallet_address
            .clone()
            .unwrap_or_default(),
    })
}

/// Extract pricing for a specific model from provider's models JSONB array.
fn extract_model_pricing(models: &serde_json::Value, model_id: &str) -> (i64, i64) {
    models
        .as_array()
        .and_then(|arr| {
            arr.iter().find(|m| {
                m.get("model_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s == model_id)
                    .unwrap_or(false)
            })
        })
        .map(|m| {
            let input = m
                .get("price_per_1k_input")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let output = m
                .get("price_per_1k_output")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            (input, output)
        })
        .unwrap_or((0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CloudConfig;
    use ed25519_dalek::{Signer, SigningKey};
    use std::sync::{Mutex, OnceLock};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    static SHIELDED_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct EnvRestore {
        previous: Vec<(&'static str, Option<String>)>,
    }

    impl EnvRestore {
        fn set(overrides: &[(&'static str, String)]) -> Self {
            let previous = overrides
                .iter()
                .map(|(key, _)| (*key, std::env::var(key).ok()))
                .collect::<Vec<_>>();
            for (key, value) in overrides {
                std::env::set_var(key, value);
            }
            Self { previous }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            for (key, value) in self.previous.drain(..) {
                if let Some(value) = value {
                    std::env::set_var(key, value);
                } else {
                    std::env::remove_var(key);
                }
            }
        }
    }

    fn minimal_cloud_config() -> CloudConfig {
        CloudConfig {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            database_url: "postgres://user:pass@localhost/test".into(),
            jwt_secret: "test-jwt-secret".into(),
            bland_api_key: None,
            bland_webhook_url: None,
            claude_api_key: None,
            google_client_id: None,
            google_client_secret: None,
            apple_client_id: None,
            gmail_client_id: None,
            gmail_client_secret: None,
            stripe_secret_key: None,
            stripe_webhook_secret: None,
            stripe_price_pro: None,
            stripe_price_unlimited: None,
            base_url: "http://localhost".into(),
            encryption_key: [0u8; 32],
            telegram_bot_token: None,
            solana_rpc_url: "http://localhost".into(),
            groq_api_key: None,
            cerebras_api_key: None,
            google_gemini_api_key: None,
            openrouter_api_key: None,
            relay_url: "http://localhost".into(),
            platform_wallet_address: None,
            treasury_mnemonic: None,
            min_provider_reputation: 0.0,
            max_escrow_age_secs: 0,
            provider_payout_interval_secs: 0,
        }
    }

    fn test_app_state() -> AppState {
        let config = minimal_cloud_config();
        let db = PgPool::connect_lazy(&config.database_url)
            .expect("connect_lazy never opens a connection");
        AppState::new(config, db)
    }

    #[test]
    fn requested_payment_rail_defaults_to_public_solana() {
        assert_eq!(
            parse_requested_payment_rail(None).unwrap(),
            PaymentRailKind::SolanaPublicStablecoin
        );
        assert_eq!(
            parse_requested_payment_rail(Some("solana_x402")).unwrap(),
            PaymentRailKind::SolanaPublicStablecoin
        );
        assert_eq!(
            parse_requested_payment_rail(Some("solana_public_usdc")).unwrap(),
            PaymentRailKind::SolanaPublicStablecoin
        );
        assert_eq!(
            PaymentRailKind::SolanaPublicStablecoin.canonical_rail(),
            SOLANA_PUBLIC_USDC_RAIL
        );
    }

    #[test]
    fn requested_payment_rail_accepts_shielded_only_mode() {
        assert_eq!(
            parse_requested_payment_rail(Some("shielded_stablecoin")).unwrap(),
            PaymentRailKind::ShieldedStablecoin
        );
        assert_eq!(
            parse_requested_payment_rail(Some("aleo_usdcx_shielded")).unwrap(),
            PaymentRailKind::ShieldedStablecoin
        );
        assert_eq!(
            PaymentRailKind::ShieldedStablecoin.canonical_rail(),
            ALEO_USDCX_SHIELDED_RAIL
        );
    }

    #[test]
    fn requested_payment_rail_rejects_unknown_modes() {
        assert!(parse_requested_payment_rail(Some("public_fallback_allowed")).is_err());
    }

    #[test]
    fn shielded_runtime_status_serializes_preview_not_full_recipient() {
        let recipient = "aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
        let status = ShieldedStablecoinRuntimeStatus {
            configured: true,
            ready: true,
            adapter_configured: true,
            destination_configured: true,
            adapter_auth_configured: true,
            adapter_signature_required: true,
            adapter_signature_configured: true,
            verifier_ready: true,
            arbitrary_recipient_proofs_enabled: false,
            provider: "aleo".to_string(),
            network: "aleo:mainnet".to_string(),
            asset: "USDCx".to_string(),
            recipient_configured: true,
            recipient_preview: Some(shielded_recipient_preview(recipient)),
            recipient: Some(recipient.to_string()),
            rail: SHIELDED_STABLECOIN_RAIL,
            canonical_rail: ALEO_USDCX_SHIELDED_RAIL,
            fallback_allowed: false,
            unavailable_reason: None,
            privacy_disclosure: SHIELDED_STABLECOIN_DISCLOSURE,
        };

        let serialized = serde_json::to_value(&status).unwrap();
        assert!(serialized.get("recipient").is_none());
        assert_eq!(serialized["recipient_configured"], true);
        assert_eq!(serialized["recipient_preview"], "aleo1qqq...qqqqqq");
        assert!(!serialized.to_string().contains(recipient));
    }

    #[test]
    fn payment_requirements_filter_to_requested_rail() {
        let mut requirements = PaymentRequirements {
            x402_version: 2,
            accepts: vec![
                PaymentOption {
                    scheme: "exact".to_string(),
                    network: "solana:mainnet".to_string(),
                    amount: "1000".to_string(),
                    asset: "USDC".to_string(),
                    destination: "platform".to_string(),
                    price: "$0.001000".to_string(),
                    pay_to: "platform".to_string(),
                    max_amount_required: "1000".to_string(),
                    description: "public".to_string(),
                    resource: Some("https://example.com/v1/chat/completions".to_string()),
                    method: Some("POST".to_string()),
                    mime_type: Some("application/json".to_string()),
                    extra: PaymentExtra {
                        agent_id: Uuid::nil().to_string(),
                        agent_slug: "agent".to_string(),
                        model_id: "model".to_string(),
                        max_tokens: 100,
                        price_per_1k_input: 1000,
                        price_per_1k_output: 1000,
                        payment_rail: PaymentRailKind::SolanaPublicStablecoin.as_str().to_string(),
                        canonical_rail: PaymentRailKind::SolanaPublicStablecoin
                            .canonical_rail()
                            .to_string(),
                        legacy_network: Some("solana:mainnet".to_string()),
                        token_decimals: 6,
                        payment_identifier_supported: false,
                        privacy_disclosure: PUBLIC_STABLECOIN_DISCLOSURE.to_string(),
                        shielded_available: true,
                        shielded_unavailable_reason: None,
                    },
                },
                PaymentOption {
                    scheme: "shielded_stablecoin".to_string(),
                    network: "aleo:mainnet".to_string(),
                    amount: "1000".to_string(),
                    asset: "USDCx".to_string(),
                    destination: "aleo1recipient".to_string(),
                    price: "$0.001000".to_string(),
                    pay_to: "aleo1recipient".to_string(),
                    max_amount_required: "1000".to_string(),
                    description: "shielded".to_string(),
                    resource: Some("https://example.com/v1/chat/completions".to_string()),
                    method: Some("POST".to_string()),
                    mime_type: Some("application/json".to_string()),
                    extra: PaymentExtra {
                        agent_id: Uuid::nil().to_string(),
                        agent_slug: "agent".to_string(),
                        model_id: "model".to_string(),
                        max_tokens: 100,
                        price_per_1k_input: 1000,
                        price_per_1k_output: 1000,
                        payment_rail: PaymentRailKind::ShieldedStablecoin.as_str().to_string(),
                        canonical_rail: PaymentRailKind::ShieldedStablecoin
                            .canonical_rail()
                            .to_string(),
                        legacy_network: None,
                        token_decimals: 6,
                        payment_identifier_supported: false,
                        privacy_disclosure: SHIELDED_STABLECOIN_DISCLOSURE.to_string(),
                        shielded_available: true,
                        shielded_unavailable_reason: None,
                    },
                },
            ],
            resource: Some("https://example.com/v1/chat/completions".to_string()),
            method: Some("POST".to_string()),
            mime_type: Some("application/json".to_string()),
            description: Some("test".to_string()),
            extensions: None,
        };

        filter_payment_requirements_for_rail(
            &mut requirements,
            PaymentRailKind::ShieldedStablecoin,
        );

        assert!(payment_requirements_have_options(&requirements));
        assert_eq!(requirements.accepts.len(), 1);
        assert_eq!(requirements.accepts[0].scheme, "shielded_stablecoin");
    }

    #[test]
    fn proof_must_match_requested_rail() {
        let public_proof = PaymentProof {
            x402_version: "1".to_string(),
            scheme: "exact".to_string(),
            network: "solana:mainnet".to_string(),
            payload: PaymentPayload {
                tx_signature: Some("sig".to_string()),
                shielded_receipt_id: None,
                proof_b64: None,
                nullifier_hex: None,
                extensions: None,
            },
        };
        let shielded_proof = PaymentProof {
            x402_version: "1".to_string(),
            scheme: "shielded_stablecoin".to_string(),
            network: "aleo:mainnet".to_string(),
            payload: test_shielded_proof(),
        };

        assert!(proof_matches_rail(
            &public_proof,
            PaymentRailKind::SolanaPublicStablecoin
        ));
        assert!(!proof_matches_rail(
            &public_proof,
            PaymentRailKind::ShieldedStablecoin
        ));
        assert!(proof_matches_rail(
            &shielded_proof,
            PaymentRailKind::ShieldedStablecoin
        ));
        assert!(!proof_matches_rail(
            &shielded_proof,
            PaymentRailKind::SolanaPublicStablecoin
        ));
    }

    fn test_shielded_config(pubkey: VerifyingKey) -> ShieldedStablecoinConfig {
        ShieldedStablecoinConfig {
            provider: "aleo".to_string(),
            network: "aleo:mainnet".to_string(),
            asset: "USDCx".to_string(),
            destination: "aleo1recipient".to_string(),
            adapter_url: "https://adapter.example".to_string(),
            require_signed_receipt: true,
            adapter_pubkey: Some(pubkey),
            verifier_ready: true,
        }
    }

    fn test_shielded_proof() -> PaymentPayload {
        PaymentPayload {
            tx_signature: None,
            shielded_receipt_id: Some("receipt-1".to_string()),
            proof_b64: Some(STANDARD.encode("proof bytes")),
            nullifier_hex: Some("abc123".to_string()),
            extensions: None,
        }
    }

    fn signed_shielded_response(
        config: &ShieldedStablecoinConfig,
        signer: &SigningKey,
        proof: &PaymentPayload,
        paid_amount: i64,
    ) -> ShieldedVerifyResponse {
        let proof_digest = shielded_proof_digest(proof).unwrap();
        let observed_at_unix = chrono::Utc::now().timestamp() - 10;
        let expires_at_unix = chrono::Utc::now().timestamp() + 300;
        let mut response = ShieldedVerifyResponse {
            settled: true,
            receipt_id: Some("receipt-1".to_string()),
            nullifier_hex: Some("abc123".to_string()),
            payer_address: Some("shielded".to_string()),
            amount: Some(paid_amount),
            currency: Some("USDC".to_string()),
            provider: Some(config.provider.clone()),
            network: Some(config.network.clone()),
            asset: Some(config.asset.clone()),
            destination: Some(config.destination.clone()),
            proof_digest: Some(proof_digest.clone()),
            observed_at_unix: Some(observed_at_unix),
            expires_at_unix: Some(expires_at_unix),
            confirmations: Some(4),
            adapter_signature_b64: None,
            adapter_key_id: Some("test-key".to_string()),
            error: None,
        };
        let payload = signed_shielded_receipt_payload(
            config,
            &response,
            &config.destination,
            1000,
            paid_amount,
            "abc123",
            &proof_digest,
            observed_at_unix,
            expires_at_unix,
        );
        response.adapter_signature_b64 =
            Some(STANDARD.encode(signer.sign(payload.as_bytes()).to_bytes()));
        response
    }

    fn shielded_fixture_env(
        server_uri: &str,
        signer: &SigningKey,
        token: &str,
    ) -> EnvRestore {
        EnvRestore::set(&[
            ("SHIELDED_STABLECOIN_ADAPTER_URL", server_uri.to_string()),
            ("SHIELDED_STABLECOIN_PROVIDER", "aleo".to_string()),
            ("SHIELDED_STABLECOIN_NETWORK", "aleo:mainnet".to_string()),
            ("SHIELDED_STABLECOIN_ASSET", "USDCx".to_string()),
            ("SHIELDED_STABLECOIN_RECIPIENT", "aleo1recipient".to_string()),
            (
                "SHIELDED_STABLECOIN_ADAPTER_AUTH_TOKEN",
                token.to_string(),
            ),
            (
                "SHIELDED_STABLECOIN_ADAPTER_PUBKEY",
                hex::encode(VerifyingKey::from(signer).to_bytes()),
            ),
            (
                "SHIELDED_STABLECOIN_REQUIRE_SIGNED_RECEIPT",
                "true".to_string(),
            ),
            ("SHIELDED_STABLECOIN_VERIFIER_READY", "true".to_string()),
            (
                "SHIELDED_STABLECOIN_ARBITRARY_RECIPIENTS_ENABLED",
                "false".to_string(),
            ),
        ])
    }

    fn shielded_fixture_proof(payload: PaymentPayload) -> PaymentProof {
        PaymentProof {
            x402_version: "1".to_string(),
            scheme: SHIELDED_STABLECOIN_RAIL.to_string(),
            network: "aleo:mainnet".to_string(),
            payload,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shielded_fixture_canary_verifies_signed_adapter_response_without_funds() {
        let _guard = SHIELDED_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let server = MockServer::start().await;
        let signer = SigningKey::from_bytes(&[13u8; 32]);
        let config = ShieldedStablecoinConfig {
            adapter_url: server.uri(),
            ..test_shielded_config(VerifyingKey::from(&signer))
        };
        let proof_payload = test_shielded_proof();
        let response = signed_shielded_response(&config, &signer, &proof_payload, 1500);
        let token = "fixture-adapter-token";
        let _env = shielded_fixture_env(&server.uri(), &signer, token);

        Mock::given(method("POST"))
            .and(path("/verify"))
            .and(header("authorization", format!("Bearer {token}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .expect(1)
            .mount(&server)
            .await;

        let verified = verify_shielded_stablecoin_settlement(
            &test_app_state(),
            &shielded_fixture_proof(proof_payload),
            ShieldedSettlementContext {
                required_amount: 1000,
                purpose: "no-funds fixture canary",
                destination: None,
                intent_id: None,
                agent_id: None,
                provider_id: None,
                model_id: Some("fixture-model"),
            },
        )
        .await
        .unwrap();

        assert_eq!(verified.amount, 1500);
        assert_eq!(verified.asset, "USDCx");
        assert_eq!(verified.network, "aleo:mainnet");
        assert_eq!(verified.destination, "aleo1recipient");
        assert_eq!(verified.receipt_ref, "abc123");
        assert!(verified.replay_key.starts_with("shielded:aleo:"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shielded_fixture_canary_rejects_tampered_adapter_receipt() {
        let _guard = SHIELDED_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let server = MockServer::start().await;
        let signer = SigningKey::from_bytes(&[14u8; 32]);
        let config = ShieldedStablecoinConfig {
            adapter_url: server.uri(),
            ..test_shielded_config(VerifyingKey::from(&signer))
        };
        let proof_payload = test_shielded_proof();
        let mut response = signed_shielded_response(&config, &signer, &proof_payload, 1500);
        response.amount = Some(2500);
        let token = "fixture-adapter-token";
        let _env = shielded_fixture_env(&server.uri(), &signer, token);

        Mock::given(method("POST"))
            .and(path("/verify"))
            .and(header("authorization", format!("Bearer {token}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .expect(1)
            .mount(&server)
            .await;

        let err = verify_shielded_stablecoin_settlement(
            &test_app_state(),
            &shielded_fixture_proof(proof_payload),
            ShieldedSettlementContext {
                required_amount: 1000,
                purpose: "tamper fixture canary",
                destination: None,
                intent_id: None,
                agent_id: None,
                provider_id: None,
                model_id: Some("fixture-model"),
            },
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(err.contains("signature verification failed"));
    }

    #[test]
    fn shielded_proof_digest_ignores_extensions_for_recipient_receipt_binding() {
        let proof = test_shielded_proof();
        let mut proof_with_extension = test_shielded_proof();
        proof_with_extension.extensions = Some(json!({
            "recipient_receipt": {
                "version": "ghola-aleo-usdcx-recipient-receipt-v1",
                "recipient": "aleo1recipient",
                "signature": "signature1example"
            }
        }));

        assert_eq!(
            shielded_proof_digest(&proof).unwrap(),
            shielded_proof_digest(&proof_with_extension).unwrap()
        );
    }

    #[test]
    fn shielded_adapter_response_accepts_signed_matching_receipt() {
        let signer = SigningKey::from_bytes(&[7u8; 32]);
        let config = test_shielded_config(VerifyingKey::from(&signer));
        let proof = test_shielded_proof();
        let response = signed_shielded_response(&config, &signer, &proof, 1500);

        let receipt_ref = validate_shielded_adapter_response(
            &config,
            &response,
            &config.destination,
            1000,
            &proof,
            "fallback",
        )
        .unwrap();

        assert_eq!(receipt_ref, "abc123");
    }

    #[test]
    fn shielded_adapter_response_rejects_destination_mismatch() {
        let signer = SigningKey::from_bytes(&[7u8; 32]);
        let config = test_shielded_config(VerifyingKey::from(&signer));
        let proof = test_shielded_proof();
        let mut response = signed_shielded_response(&config, &signer, &proof, 1500);
        response.destination = Some("aleo1attacker".to_string());

        let err = validate_shielded_adapter_response(
            &config,
            &response,
            &config.destination,
            1000,
            &proof,
            "fallback",
        )
        .unwrap_err()
        .to_string();

        assert!(err.contains("destination mismatch"));
    }

    #[test]
    fn shielded_adapter_response_rejects_bad_signature() {
        let signer = SigningKey::from_bytes(&[7u8; 32]);
        let config = test_shielded_config(VerifyingKey::from(&signer));
        let proof = test_shielded_proof();
        let mut response = signed_shielded_response(&config, &signer, &proof, 1500);
        response.amount = Some(2500);

        let err = validate_shielded_adapter_response(
            &config,
            &response,
            &config.destination,
            1000,
            &proof,
            "fallback",
        )
        .unwrap_err()
        .to_string();

        assert!(err.contains("signature verification failed"));
    }

    #[test]
    fn shielded_adapter_response_rejects_proof_digest_mismatch() {
        let signer = SigningKey::from_bytes(&[7u8; 32]);
        let config = test_shielded_config(VerifyingKey::from(&signer));
        let proof = test_shielded_proof();
        let mut response = signed_shielded_response(&config, &signer, &proof, 1500);
        response.proof_digest = Some("bad".to_string());

        let err = validate_shielded_adapter_response(
            &config,
            &response,
            &config.destination,
            1000,
            &proof,
            "fallback",
        )
        .unwrap_err()
        .to_string();

        assert!(err.contains("proof digest mismatch"));
    }
}
