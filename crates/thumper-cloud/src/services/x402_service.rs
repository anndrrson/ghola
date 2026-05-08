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
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79,
    0xac, 0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff,
    0x00, 0xa9,
];

const ATA_PROGRAM_ID: [u8; 32] = [
    0x8c, 0x97, 0x25, 0x8f, 0x4e, 0x24, 0x89, 0xf1, 0xbb, 0x3d, 0x10, 0x29, 0x14, 0x8e, 0x0d,
    0x83, 0x0b, 0x5a, 0x13, 0x99, 0xda, 0xff, 0x10, 0x84, 0x04, 0x8e, 0x7b, 0xd8, 0xdb, 0xe9,
    0xf8, 0x59,
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
}

/// Payment proof decoded from the PAYMENT-SIGNATURE header.
#[derive(Debug, Deserialize)]
pub struct PaymentProof {
    pub x402_version: String,
    pub scheme: String,
    pub network: String,
    pub payload: PaymentPayload,
}

#[derive(Debug, Deserialize)]
pub struct PaymentPayload {
    pub tx_signature: String,
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
    bs58::decode(mint_b58).into_vec().ok().and_then(|v| v.try_into().ok())
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
pub fn estimate_agent_price(price_per_1k_input: i64, price_per_1k_output: i64, max_tokens: u32) -> i64 {
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
    let accepts = active_tokens(rpc_url)
        .into_iter()
        .map(|(token, mint)| PaymentOption {
            scheme: "exact".to_string(),
            network: network.clone(),
            amount: amount.to_string(),
            asset: mint,
            destination: destination.clone(),
            description: format!("Agent: {agent_slug} — 1 inference request ({})", token.symbol),
            extra: PaymentExtra {
                agent_id: agent_id.to_string(),
                agent_slug: agent_slug.to_string(),
                model_id: model_id.to_string(),
                max_tokens,
                price_per_1k_input,
                price_per_1k_output,
            },
        })
        .collect();

    PaymentRequirements { accepts }
}

/// Build the HTTP 402 response with payment requirements.
pub fn build_402_response(
    requirements: &PaymentRequirements,
) -> axum::response::Response {
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
    let rpc_url = &state.config.solana_rpc_url;
    let expected_network = detect_network(rpc_url);

    // Check network matches
    if proof.network != expected_network {
        return Err(CloudError::PaymentRequired(format!(
            "network mismatch: expected {expected_network}, got {}",
            proof.network
        )));
    }

    let tx_sig = &proof.payload.tx_signature;

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
    .map_err(|e| {
        CloudError::PaymentRequired(format!("failed to fetch transaction: {e}"))
    })?;

    // Check that the transaction exists and succeeded
    if result.is_null() {
        return Err(CloudError::PaymentRequired(
            "transaction not finalized yet — retry in 15-30 seconds".to_string(),
        ));
    }

    if result.get("meta").and_then(|m| m.get("err")).map(|e| !e.is_null()).unwrap_or(true) {
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
                now - bt, MAX_TX_AGE_SECS
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
        let Some(mint_bytes) = decode_mint_bytes(&mint_b58) else { continue };
        let ata = find_ata(&platform_bytes, &mint_bytes);
        accept_set.push((mint_b58, bs58::encode(ata).into_string(), token.symbol.to_string()));
    }
    if accept_set.is_empty() {
        return Err(CloudError::PaymentRequired(
            "no stablecoins currently accepted (all paused)".to_string(),
        ));
    }

    let (paid_amount, payer_address, currency) =
        extract_transfer_info(&result, &accept_set)?;

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
                CloudError::PaymentRequired("transaction already used (replay rejected)".to_string())
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
        tx_signature: tx_sig.clone(),
        payer_address,
        amount_usdc: paid_amount,
        currency,
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
        let dest = info.get("destination").and_then(|v| v.as_str()).unwrap_or("");
        let matched = accept_set
            .iter()
            .find(|(m, ata, _)| mint == m && dest == ata);
        let Some((_, _, currency)) = matched else { continue };

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
    let actual_cost =
        (input_tokens as i64 * price_per_1k_input + output_tokens as i64 * price_per_1k_output)
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
        tag_filter = if tags_filter.is_some() { "AND a.tags && $1" } else { "" },
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
