//! x402 Payment Protocol service.
//! Handles payment requirement generation, Solana stablecoin transaction
//! verification, and settlement for anonymous pay-per-request agent access.
//!
//! Multi-currency: USDT primary, USDC secondary. Per-stablecoin pause flags
//! (`STABLECOIN_USDT_PAUSED`, `STABLECOIN_USDC_PAUSED`) act as the runtime
//! lever for depeg / freeze events.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
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

/// Look up a token by its on-chain base58 mint string for the active network.
fn token_for_mint(rpc_url: &str, mint_b58: &str) -> Option<(StableToken, String)> {
    active_tokens(rpc_url)
        .into_iter()
        .find(|(_, m)| m == mint_b58)
}

// ---------------------------------------------------------------------------
// Types — x402 Protocol
// ---------------------------------------------------------------------------

/// Payment requirement sent in the PAYMENT-REQUIRED header (base64-encoded JSON).
#[derive(Debug, Serialize)]
pub struct PaymentRequirements {
    pub accepts: Vec<PaymentOption>,
}

#[derive(Debug, Serialize)]
pub struct PaymentOption {
    pub scheme: String,
    pub network: String,
    pub amount: String,
    pub asset: String,
    pub destination: String,
    pub description: String,
    pub extra: PaymentExtra,
}

#[derive(Debug, Serialize)]
pub struct PaymentExtra {
    pub agent_id: String,
    pub agent_slug: String,
    pub model_id: String,
    pub max_tokens: u32,
    pub price_per_1k_input: i64,
    pub price_per_1k_output: i64,
    pub payment_rail: String,
    pub privacy_disclosure: String,
    pub shielded_available: bool,
    pub shielded_unavailable_reason: Option<String>,
}

/// Payment proof decoded from the PAYMENT-SIGNATURE header.
#[derive(Debug, Deserialize)]
pub struct PaymentProof {
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
    pub settled: bool,
    pub actual_cost: i64,
    pub tx_signature: String,
    pub settlement_rail: String,
    pub privacy_disclosure: String,
    pub currency: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaymentRailKind {
    SolanaPublicStablecoin,
    ShieldedStablecoin,
}

impl PaymentRailKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PaymentRailKind::SolanaPublicStablecoin => "solana_public_stablecoin",
            PaymentRailKind::ShieldedStablecoin => "shielded_stablecoin",
        }
    }
}

const PUBLIC_STABLECOIN_DISCLOSURE: &str =
    "Public Solana settlement reveals payer, provider, amount, asset, and timing on-chain.";
const SHIELDED_STABLECOIN_DISCLOSURE: &str =
    "Shielded settlement hides payer, provider, token, and amount from public chain observers, subject to timing, bridge, liquidity, and recipient-disclosure correlation.";
const SHIELDED_UNCONFIGURED_REASON: &str = "shielded stablecoin adapter is not configured";

#[derive(Debug, Clone)]
pub struct ShieldedStablecoinConfig {
    pub provider: String,
    pub network: String,
    pub asset: String,
    pub destination: String,
    pub adapter_url: String,
}

#[derive(Debug, Serialize)]
pub struct ShieldedStablecoinRuntimeStatus {
    pub configured: bool,
    pub adapter_configured: bool,
    pub destination_configured: bool,
    pub provider: String,
    pub network: String,
    pub asset: String,
    pub rail: &'static str,
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
        "" | "solana" | "solana_x402" | "solana_public_stablecoin" => {
            Ok(PaymentRailKind::SolanaPublicStablecoin)
        }
        "shielded" | "shielded_stablecoin" => Ok(PaymentRailKind::ShieldedStablecoin),
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
    let asset = std::env::var("SHIELDED_STABLECOIN_ASSET").unwrap_or_else(|_| "USDC".to_string());
    let destination = std::env::var("SHIELDED_STABLECOIN_RECIPIENT").unwrap_or_default();

    if adapter_url.trim().is_empty() || destination.trim().is_empty() {
        return None;
    }

    Some(ShieldedStablecoinConfig {
        provider,
        network,
        asset,
        destination,
        adapter_url,
    })
}

pub fn shielded_stablecoin_configured() -> bool {
    shielded_config_from_env().is_some()
}

pub fn shielded_stablecoin_runtime_status() -> ShieldedStablecoinRuntimeStatus {
    let adapter_configured = std::env::var("SHIELDED_STABLECOIN_ADAPTER_URL")
        .ok()
        .is_some_and(|s| !s.trim().is_empty());
    let destination_configured = std::env::var("SHIELDED_STABLECOIN_RECIPIENT")
        .ok()
        .is_some_and(|s| !s.trim().is_empty());
    let provider =
        std::env::var("SHIELDED_STABLECOIN_PROVIDER").unwrap_or_else(|_| "aleo".to_string());
    let network =
        std::env::var("SHIELDED_STABLECOIN_NETWORK").unwrap_or_else(|_| "aleo:mainnet".to_string());
    let asset = std::env::var("SHIELDED_STABLECOIN_ASSET").unwrap_or_else(|_| "USDC".to_string());
    let configured = adapter_configured && destination_configured;

    ShieldedStablecoinRuntimeStatus {
        configured,
        adapter_configured,
        destination_configured,
        provider,
        network,
        asset,
        rail: PaymentRailKind::ShieldedStablecoin.as_str(),
        fallback_allowed: false,
        unavailable_reason: if configured {
            None
        } else {
            Some(SHIELDED_UNCONFIGURED_REASON)
        },
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
            "settled": false,
            "fallback_allowed": false,
            "privacy_disclosure": "The caller requested shielded settlement. Ghola rejected the public payment proof instead of downgrading privacy.",
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
    let amount = estimate_agent_price(price_per_1k_input, price_per_1k_output, max_tokens);
    let rpc_url = &state.config.solana_rpc_url;
    let network = detect_network(rpc_url).to_string();
    let destination = state
        .config
        .platform_wallet_address
        .clone()
        .unwrap_or_default();

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
            amount: amount.to_string(),
            asset: mint,
            destination: destination.clone(),
            description: format!(
                "Agent: {agent_slug} — 1 inference request ({})",
                token.symbol
            ),
            extra: PaymentExtra {
                agent_id: agent_id.to_string(),
                agent_slug: agent_slug.to_string(),
                model_id: model_id.to_string(),
                max_tokens,
                price_per_1k_input,
                price_per_1k_output,
                payment_rail: PaymentRailKind::SolanaPublicStablecoin.as_str().to_string(),
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
            amount: amount.to_string(),
            asset: config.asset,
            destination: config.destination,
            description: format!("Agent: {agent_slug} — 1 private inference request"),
            extra: PaymentExtra {
                agent_id: agent_id.to_string(),
                agent_slug: agent_slug.to_string(),
                model_id: model_id.to_string(),
                max_tokens,
                price_per_1k_input,
                price_per_1k_output,
                payment_rail: PaymentRailKind::ShieldedStablecoin.as_str().to_string(),
                privacy_disclosure: SHIELDED_STABLECOIN_DISCLOSURE.to_string(),
                shielded_available: true,
                shielded_unavailable_reason: None,
            },
        });
    }

    PaymentRequirements { accepts }
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

    // Check network matches
    if proof.network != expected_network {
        return Err(CloudError::PaymentRequired(format!(
            "network mismatch: expected {expected_network}, got {}",
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
    agent_id: Uuid,
    provider_id: Uuid,
    model_id: &'a str,
    proof: &'a PaymentPayload,
}

#[derive(Debug, Deserialize)]
struct ShieldedVerifyResponse {
    settled: bool,
    receipt_id: Option<String>,
    nullifier_hex: Option<String>,
    payer_address: Option<String>,
    amount: Option<i64>,
    currency: Option<String>,
    error: Option<String>,
}

async fn verify_shielded_payment(
    state: &AppState,
    proof: &PaymentProof,
    required_amount: i64,
    agent_id: Uuid,
    provider_id: Uuid,
    model_id: &str,
) -> Result<VerifiedPayment, CloudError> {
    let config = shielded_config_from_env().ok_or_else(|| {
        CloudError::PaymentRequired(
            "shielded stablecoin requested but adapter is not configured; refusing public fallback"
                .into(),
        )
    })?;

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
    let adapter_response = client
        .post(format!(
            "{}/verify",
            config.adapter_url.trim_end_matches('/')
        ))
        .json(&ShieldedVerifyRequest {
            provider: &config.provider,
            network: &config.network,
            asset: &config.asset,
            destination: &config.destination,
            required_amount,
            agent_id,
            provider_id,
            model_id,
            proof: &proof.payload,
        })
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
    if paid_amount < required_amount {
        return Err(CloudError::PaymentRequired(format!(
            "insufficient shielded payment: paid {paid_amount}, required {required_amount}"
        )));
    }

    let canonical_receipt_ref = adapter_response
        .nullifier_hex
        .as_deref()
        .or(adapter_response.receipt_id.as_deref())
        .unwrap_or(receipt_ref);
    let replay_key = format!("shielded:{}:{canonical_receipt_ref}", config.provider);

    let already_used: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM x402_payments WHERE tx_signature = $1)")
            .bind(&replay_key)
            .fetch_one(&state.db)
            .await
            .unwrap_or(false);

    if already_used {
        return Err(CloudError::PaymentRequired(
            "shielded payment already used (replay rejected)".to_string(),
        ));
    }

    let payer_address = adapter_response
        .payer_address
        .unwrap_or_else(|| "shielded".to_string());
    let currency = adapter_response
        .currency
        .unwrap_or_else(|| config.asset.clone());

    let payment_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO x402_payments
            (tx_signature, payer_address, amount_usdc, required_amount_usdc,
             agent_id, provider_id, model_id, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
        RETURNING id
        "#,
    )
    .bind(&replay_key)
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
                "shielded payment already used (replay rejected)".to_string(),
            )
        } else {
            CloudError::Database(e)
        }
    })?;

    tracing::info!(
        %replay_key, %currency, paid_amount, required_amount,
        %agent_id, "shielded stablecoin payment verified"
    );

    Ok(VerifiedPayment {
        payment_id,
        tx_signature: replay_key,
        payer_address,
        amount_usdc: paid_amount,
        currency,
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
    let actual_cost = actual_cost.max(1000); // minimum $0.001

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
    let network = detect_network(rpc_url).to_string();
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
        payment_network: detect_network(rpc_url).to_string(),
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
    }

    #[test]
    fn requested_payment_rail_accepts_shielded_only_mode() {
        assert_eq!(
            parse_requested_payment_rail(Some("shielded_stablecoin")).unwrap(),
            PaymentRailKind::ShieldedStablecoin
        );
    }

    #[test]
    fn requested_payment_rail_rejects_unknown_modes() {
        assert!(parse_requested_payment_rail(Some("public_fallback_allowed")).is_err());
    }
}
