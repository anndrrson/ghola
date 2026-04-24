//! GPU compute marketplace service for Ghola.
//! Manages community GPU providers, escrow, inference dispatch, quality
//! validation, reputation, and background maintenance tasks.

use std::collections::{HashMap, HashSet};
use std::pin::Pin;

use chrono::{NaiveDate, Utc};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::CloudError;
use crate::privacy::log_id;
use crate::state::{AppState, CommunityProviderInfo};

// ---------------------------------------------------------------------------
// Types — Provider Management
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct ProviderRegistration {
    pub relay_pubkey: String,
    pub display_name: String,
    pub models: serde_json::Value,
    pub vram_mb: i32,
    pub max_concurrent: i32,
    pub wallet_address: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: Uuid,
    pub user_id: Uuid,
    pub relay_pubkey: String,
    pub display_name: String,
    pub models: serde_json::Value,
    pub vram_mb: i32,
    pub max_concurrent: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallet_address: Option<String>,
    pub status: String,
    pub total_requests: i64,
    pub total_tokens_served: i64,
    pub total_earned_usdc: i64,
    pub total_withdrawn_usdc: i64,
    pub success_rate: f64,
    pub avg_latency_ms: f64,
    pub reputation_score: f64,
    pub last_heartbeat_at: Option<chrono::DateTime<Utc>>,
    pub created_at: chrono::DateTime<Utc>,
}

/// Public-facing provider info (omits wallet_address and last_heartbeat_at).
/// Metrics are quantized to prevent fingerprinting.
#[derive(Debug, Serialize, Deserialize)]
pub struct PublicProviderInfo {
    pub id: Uuid,
    pub display_name: String,
    pub models: serde_json::Value,
    pub vram_mb: i32,
    pub status: String,
    pub total_requests: i64,
    pub success_rate: f64,
    pub avg_latency_ms: f64,
    pub reputation_score: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProviderUpdate {
    pub models: Option<serde_json::Value>,
    pub max_concurrent: Option<i32>,
    pub vram_mb: Option<i32>,
    pub status: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelOffer {
    pub model_id: String,
    pub price_per_1k_input: u64,
    pub price_per_1k_output: u64,
}

#[derive(Debug, Deserialize)]
pub struct EarningsEstimateRequest {
    #[serde(default = "default_avg_input_tokens")]
    pub avg_input_tokens: u32,
    #[serde(default = "default_avg_output_tokens")]
    pub avg_output_tokens: u32,
    #[serde(default = "default_requests_per_hour_per_slot")]
    pub requests_per_hour_per_slot: f64,
    #[serde(default = "default_uptime_hours_per_day")]
    pub uptime_hours_per_day: f64,
    #[serde(default = "default_utilization_ratio")]
    pub utilization_ratio: f64,
    #[serde(default = "default_projection_days")]
    pub projection_days: u32,
}

fn default_avg_input_tokens() -> u32 {
    1000
}

fn default_avg_output_tokens() -> u32 {
    800
}

fn default_requests_per_hour_per_slot() -> f64 {
    12.0
}

fn default_uptime_hours_per_day() -> f64 {
    12.0
}

fn default_utilization_ratio() -> f64 {
    0.65
}

fn default_projection_days() -> u32 {
    30
}

#[derive(Debug, Serialize)]
pub struct EarningsAssumptions {
    pub avg_input_tokens: u32,
    pub avg_output_tokens: u32,
    pub requests_per_hour_per_slot: f64,
    pub uptime_hours_per_day: f64,
    pub utilization_ratio: f64,
    pub projection_days: u32,
    pub max_concurrent: i32,
    pub provider_revenue_share_pct: f64,
}

#[derive(Debug, Serialize)]
pub struct ModelEarningsEstimate {
    pub model_id: String,
    pub price_per_1k_input: u64,
    pub price_per_1k_output: u64,
    pub estimated_requests_per_day: f64,
    pub gross_usdc_per_day: i64,
    pub provider_usdc_per_day: i64,
    pub provider_usdc_projection: i64,
    pub provider_usd_per_day: f64,
    pub provider_usd_projection: f64,
}

#[derive(Debug, Serialize)]
pub struct EarningsEstimateResponse {
    pub assumptions: EarningsAssumptions,
    pub models: Vec<ModelEarningsEstimate>,
}

#[derive(Debug, Serialize)]
pub struct CommunityModel {
    pub model_id: String,
    pub providers_online: usize,
    pub min_price_input: u64,
    pub min_price_output: u64,
}

// ---------------------------------------------------------------------------
// Types — Provider Selection
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct SelectedProvider {
    pub provider_id: Uuid,
    pub relay_pubkey: String,
    pub model_id: String,
    pub price_per_1k_input: u64,
    pub price_per_1k_output: u64,
}

// ---------------------------------------------------------------------------
// Types — Escrow
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct EscrowSettlement {
    pub escrow_id: Uuid,
    pub actual_cost: i64,
    pub provider_amount: i64,
    pub platform_fee: i64,
}

#[derive(Debug, Serialize)]
pub struct EscrowInfo {
    pub id: Uuid,
    pub provider_id: Uuid,
    pub amount_usdc: i64,
    pub created_at: chrono::DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// Types — Inference
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct InferenceResult {
    pub text: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub latency_ms: u64,
}

pub type InferenceTextStream =
    Pin<Box<dyn futures::Stream<Item = Result<String, CloudError>> + Send>>;

// ---------------------------------------------------------------------------
// Types — Quality
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct ResponseQuality {
    pub valid: bool,
    pub score: f64,
    pub reason: Option<String>,
}

// ---------------------------------------------------------------------------
// Types — Stats
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct DailyStats {
    pub stat_date: NaiveDate,
    pub requests_total: i32,
    pub requests_success: i32,
    pub requests_failed: i32,
    pub tokens_served: i64,
    pub earned_usdc: i64,
    pub avg_latency_ms: f64,
}

#[derive(Debug, Serialize)]
pub struct RecentJob {
    pub id: Uuid,
    pub model_id: String,
    pub status: String,
    pub input_tokens: i32,
    pub output_tokens: i32,
    pub latency_ms: Option<i32>,
    pub agent_id: Option<Uuid>,
    pub created_at: chrono::DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// Types — Provider Withdrawals
// ---------------------------------------------------------------------------

const MIN_WITHDRAWAL_USDC: i64 = 1_000_000; // $1.00
const PROVIDER_REVENUE_SHARE_BPS: u64 = 8500;
const MAX_MODELS_PER_PROVIDER: usize = 64;
const MAX_MODEL_ID_LEN: usize = 128;
const MAX_PRICE_PER_1K_USDC: u64 = 5_000_000_000; // $5,000 / 1K tokens cap
const MIN_VRAM_MB: i32 = 1024;
const MAX_VRAM_MB: i32 = 2_097_152; // 2TB logical cap
const MIN_MAX_CONCURRENT: i32 = 1;
const MAX_MAX_CONCURRENT: i32 = 512;
const RECEIPT_SOURCE_COMPUTE_ESCROW: &str = "compute_escrow";
const RECEIPT_VERIFY_SCAN_LIMIT: i64 = 5000;
const REVIEW_HARD_THRESHOLD_USDC: i64 = 250_000_000; // $250
const REVIEW_NEW_PROVIDER_DAYS: i64 = 7;
const REVIEW_NEW_PROVIDER_MAX_USDC: i64 = 50_000_000; // $50
const REVIEW_LOW_SUCCESS_RATE: f64 = 0.90;
const REVIEW_LOW_SUCCESS_MAX_USDC: i64 = 20_000_000; // $20
const REVIEW_BALANCE_SHARE_BPS: i64 = 9000; // 90%
const REVIEW_MAX_PAYOUTS_24H: i64 = 2;

#[derive(Debug, Deserialize)]
pub struct WithdrawalRequest {
    pub amount_usdc: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct WithdrawalResponse {
    pub payout_id: Uuid,
    pub amount_usdc: i64,
    pub to_address: String,
    pub signature: String,
    pub explorer_url: String,
}

#[derive(Debug, Serialize)]
pub struct PayoutInfo {
    pub id: Uuid,
    pub amount_usdc: i64,
    pub to_address: String,
    pub signature: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: chrono::DateTime<Utc>,
    pub completed_at: Option<chrono::DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct PayoutSummary {
    pub total_earned_usdc: i64,
    pub receipt_verified_earned_usdc: i64,
    pub total_withdrawn_usdc: i64,
    pub available_usdc: i64,
    pub receipt_verified_available_usdc: i64,
    pub min_withdrawal_usdc: i64,
}

#[derive(Debug, Serialize)]
pub struct ReceiptVerificationSummary {
    pub checked: usize,
    pub valid: usize,
    pub invalid: usize,
    pub invalid_receipt_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct UsageReceiptInfo {
    pub id: Uuid,
    pub source: String,
    pub source_ref: Uuid,
    pub model_id: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub provider_amount_usdc: i64,
    pub platform_fee_usdc: i64,
    pub total_cost_usdc: i64,
    pub proof_hash: String,
    pub receipt_sig: String,
    pub verified: bool,
    pub created_at: chrono::DateTime<Utc>,
}

fn normalize_display_name(display_name: &str) -> Result<String, CloudError> {
    let name = display_name.trim();
    if name.len() < 2 || name.len() > 80 {
        return Err(CloudError::BadRequest(
            "display_name must be 2..80 characters".to_string(),
        ));
    }
    Ok(name.to_string())
}

fn validate_wallet_address(wallet_address: &str) -> Result<String, CloudError> {
    let trimmed = wallet_address.trim();
    let raw = bs58::decode(trimmed).into_vec().map_err(|_| {
        CloudError::BadRequest("wallet_address must be a valid base58 Solana address".to_string())
    })?;
    if raw.len() != 32 {
        return Err(CloudError::BadRequest(
            "wallet_address must decode to 32 bytes".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_vram_mb(vram_mb: i32) -> Result<(), CloudError> {
    if !(MIN_VRAM_MB..=MAX_VRAM_MB).contains(&vram_mb) {
        return Err(CloudError::BadRequest(format!(
            "vram_mb must be between {MIN_VRAM_MB} and {MAX_VRAM_MB}"
        )));
    }
    Ok(())
}

fn validate_max_concurrent(max_concurrent: i32) -> Result<(), CloudError> {
    if !(MIN_MAX_CONCURRENT..=MAX_MAX_CONCURRENT).contains(&max_concurrent) {
        return Err(CloudError::BadRequest(format!(
            "max_concurrent must be between {MIN_MAX_CONCURRENT} and {MAX_MAX_CONCURRENT}"
        )));
    }
    Ok(())
}

fn normalize_provider_status(status: &str) -> Result<String, CloudError> {
    let normalized = status.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "online" | "offline" => Ok(normalized),
        _ => Err(CloudError::BadRequest(
            "status must be one of: online, offline".to_string(),
        )),
    }
}

fn is_valid_model_id(model_id: &str) -> bool {
    if model_id.is_empty() || model_id.len() > MAX_MODEL_ID_LEN {
        return false;
    }
    model_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':'))
}

fn parse_model_offers(models: &serde_json::Value) -> Result<Vec<ModelOffer>, CloudError> {
    let mut offers: Vec<ModelOffer> = serde_json::from_value(models.clone()).map_err(|_| {
        CloudError::BadRequest(
            "models must be a JSON array of {model_id, price_per_1k_input, price_per_1k_output}"
                .to_string(),
        )
    })?;

    if offers.is_empty() {
        return Err(CloudError::BadRequest(
            "at least one model is required".to_string(),
        ));
    }

    if offers.len() > MAX_MODELS_PER_PROVIDER {
        return Err(CloudError::BadRequest(format!(
            "too many models; max is {MAX_MODELS_PER_PROVIDER}"
        )));
    }

    let mut seen = HashSet::new();
    for offer in &mut offers {
        offer.model_id = offer.model_id.trim().to_string();
        if !is_valid_model_id(&offer.model_id) {
            return Err(CloudError::BadRequest(format!(
                "invalid model_id '{}': use 1..{} chars from [A-Za-z0-9-_.:/]",
                offer.model_id, MAX_MODEL_ID_LEN
            )));
        }
        if !seen.insert(offer.model_id.to_ascii_lowercase()) {
            return Err(CloudError::BadRequest(format!(
                "duplicate model_id '{}'",
                offer.model_id
            )));
        }
        if offer.price_per_1k_input == 0 || offer.price_per_1k_output == 0 {
            return Err(CloudError::BadRequest(format!(
                "model '{}' prices must be > 0",
                offer.model_id
            )));
        }
        if offer.price_per_1k_input > MAX_PRICE_PER_1K_USDC
            || offer.price_per_1k_output > MAX_PRICE_PER_1K_USDC
        {
            return Err(CloudError::BadRequest(format!(
                "model '{}' price too high; max is {} micro-USDC per 1k tokens",
                offer.model_id, MAX_PRICE_PER_1K_USDC
            )));
        }
    }

    Ok(offers)
}

fn normalize_models_json(models: &serde_json::Value) -> Result<serde_json::Value, CloudError> {
    let offers = parse_model_offers(models)?;
    serde_json::to_value(offers)
        .map_err(|e| CloudError::Internal(format!("failed to encode models: {e}")))
}

fn round_to_i64(value: f64) -> i64 {
    value
        .round()
        .clamp(i64::MIN as f64, i64::MAX as f64)
        .trunc() as i64
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};

    let block_size = 64;
    let mut k = vec![0u8; block_size];
    if key.len() > block_size {
        let hash = Sha256::digest(key);
        k[..32].copy_from_slice(&hash);
    } else {
        k[..key.len()].copy_from_slice(key);
    }

    let mut ipad = vec![0x36u8; block_size];
    let mut opad = vec![0x5cu8; block_size];
    for i in 0..block_size {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }

    let mut inner = Sha256::new();
    inner.update(&ipad);
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(inner_hash);
    let result = outer.finalize();

    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(data);
    to_hex(&digest)
}

fn sign_receipt_hex(secret: &str, payload: &[u8]) -> String {
    let sig = hmac_sha256(secret.as_bytes(), payload);
    to_hex(&sig)
}

pub struct UsageReceiptInsert {
    pub provider_id: Uuid,
    pub user_id: Option<Uuid>,
    pub job_id: Option<Uuid>,
    pub escrow_id: Option<Uuid>,
    pub source: &'static str,
    pub source_ref: Uuid,
    pub model_id: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub provider_amount_usdc: i64,
    pub platform_fee_usdc: i64,
    pub total_cost_usdc: i64,
    pub metadata: serde_json::Value,
}

fn usage_receipt_payload(
    provider_id: Uuid,
    user_id: Option<Uuid>,
    job_id: Option<Uuid>,
    escrow_id: Option<Uuid>,
    source: &str,
    source_ref: Uuid,
    model_id: Option<&str>,
    input_tokens: i64,
    output_tokens: i64,
    provider_amount_usdc: i64,
    platform_fee_usdc: i64,
    total_cost_usdc: i64,
    metadata: &serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "provider_id": provider_id,
        "user_id": user_id,
        "job_id": job_id,
        "escrow_id": escrow_id,
        "source": source,
        "source_ref": source_ref,
        "model_id": model_id,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "provider_amount_usdc": provider_amount_usdc,
        "platform_fee_usdc": platform_fee_usdc,
        "total_cost_usdc": total_cost_usdc,
        "metadata": metadata,
    })
}

pub(crate) async fn record_usage_receipt_inner<'e, E>(
    executor: E,
    usage_receipt_secret: &str,
    receipt: UsageReceiptInsert,
) -> Result<Uuid, CloudError>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    if usage_receipt_secret.is_empty() {
        return Err(CloudError::Internal(
            "usage receipt secret must not be empty".to_string(),
        ));
    }

    let payload = usage_receipt_payload(
        receipt.provider_id,
        receipt.user_id,
        receipt.job_id,
        receipt.escrow_id,
        receipt.source,
        receipt.source_ref,
        receipt.model_id.as_deref(),
        receipt.input_tokens,
        receipt.output_tokens,
        receipt.provider_amount_usdc,
        receipt.platform_fee_usdc,
        receipt.total_cost_usdc,
        &receipt.metadata,
    );

    let payload_bytes = serde_json::to_vec(&payload)
        .map_err(|e| CloudError::Internal(format!("failed to serialize receipt payload: {e}")))?;
    let proof_hash = sha256_hex(&payload_bytes);
    let receipt_sig = sign_receipt_hex(usage_receipt_secret, &payload_bytes);

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO compute_usage_receipts (
            provider_id, user_id, job_id, escrow_id,
            source, source_ref, model_id,
            input_tokens, output_tokens,
            provider_amount_usdc, platform_fee_usdc, total_cost_usdc,
            proof_hash, receipt_sig, verified, metadata
        ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7,
            $8, $9,
            $10, $11, $12,
            $13, $14, true, $15
        )
        ON CONFLICT (source, source_ref) DO UPDATE SET
            provider_id = EXCLUDED.provider_id,
            user_id = EXCLUDED.user_id,
            job_id = EXCLUDED.job_id,
            escrow_id = EXCLUDED.escrow_id,
            model_id = EXCLUDED.model_id,
            input_tokens = EXCLUDED.input_tokens,
            output_tokens = EXCLUDED.output_tokens,
            provider_amount_usdc = EXCLUDED.provider_amount_usdc,
            platform_fee_usdc = EXCLUDED.platform_fee_usdc,
            total_cost_usdc = EXCLUDED.total_cost_usdc,
            proof_hash = EXCLUDED.proof_hash,
            receipt_sig = EXCLUDED.receipt_sig,
            verified = true,
            metadata = EXCLUDED.metadata
        RETURNING id
        "#,
    )
    .bind(receipt.provider_id)
    .bind(receipt.user_id)
    .bind(receipt.job_id)
    .bind(receipt.escrow_id)
    .bind(receipt.source)
    .bind(receipt.source_ref)
    .bind(receipt.model_id)
    .bind(receipt.input_tokens)
    .bind(receipt.output_tokens)
    .bind(receipt.provider_amount_usdc)
    .bind(receipt.platform_fee_usdc)
    .bind(receipt.total_cost_usdc)
    .bind(proof_hash)
    .bind(receipt_sig)
    .bind(receipt.metadata)
    .fetch_one(executor)
    .await?;

    Ok(id)
}

pub async fn record_usage_receipt(
    db: &PgPool,
    usage_receipt_secret: &str,
    receipt: UsageReceiptInsert,
) -> Result<Uuid, CloudError> {
    record_usage_receipt_inner(db, usage_receipt_secret, receipt).await
}

fn validate_estimate_request(req: &EarningsEstimateRequest) -> Result<(), CloudError> {
    if req.avg_input_tokens == 0 {
        return Err(CloudError::BadRequest(
            "avg_input_tokens must be > 0".to_string(),
        ));
    }
    if req.avg_output_tokens == 0 {
        return Err(CloudError::BadRequest(
            "avg_output_tokens must be > 0".to_string(),
        ));
    }
    if !(0.0..=24.0).contains(&req.uptime_hours_per_day) || req.uptime_hours_per_day == 0.0 {
        return Err(CloudError::BadRequest(
            "uptime_hours_per_day must be > 0 and <= 24".to_string(),
        ));
    }
    if !(0.0..=1.0).contains(&req.utilization_ratio) || req.utilization_ratio == 0.0 {
        return Err(CloudError::BadRequest(
            "utilization_ratio must be > 0 and <= 1".to_string(),
        ));
    }
    if !(0.0..=10000.0).contains(&req.requests_per_hour_per_slot)
        || req.requests_per_hour_per_slot == 0.0
    {
        return Err(CloudError::BadRequest(
            "requests_per_hour_per_slot must be > 0 and <= 10000".to_string(),
        ));
    }
    if req.projection_days == 0 || req.projection_days > 365 {
        return Err(CloudError::BadRequest(
            "projection_days must be in 1..=365".to_string(),
        ));
    }
    Ok(())
}

pub fn estimate_provider_earnings(
    provider: &ProviderInfo,
    req: EarningsEstimateRequest,
) -> Result<EarningsEstimateResponse, CloudError> {
    validate_estimate_request(&req)?;
    let offers = parse_model_offers(&provider.models)?;
    let max_concurrent = provider
        .max_concurrent
        .clamp(MIN_MAX_CONCURRENT, MAX_MAX_CONCURRENT);

    let requests_per_day = req.requests_per_hour_per_slot
        * req.uptime_hours_per_day
        * req.utilization_ratio
        * max_concurrent as f64;

    let mut models: Vec<ModelEarningsEstimate> = offers
        .into_iter()
        .map(|offer| {
            let gross_per_request = ((req.avg_input_tokens as f64 * offer.price_per_1k_input as f64)
                + (req.avg_output_tokens as f64 * offer.price_per_1k_output as f64))
                / 1000.0;
            let gross_per_day = round_to_i64(gross_per_request * requests_per_day);
            let provider_per_day =
                round_to_i64(gross_per_day as f64 * PROVIDER_REVENUE_SHARE_BPS as f64 / 10_000.0);
            let projection = provider_per_day.saturating_mul(req.projection_days as i64);

            ModelEarningsEstimate {
                model_id: offer.model_id,
                price_per_1k_input: offer.price_per_1k_input,
                price_per_1k_output: offer.price_per_1k_output,
                estimated_requests_per_day: requests_per_day,
                gross_usdc_per_day: gross_per_day,
                provider_usdc_per_day: provider_per_day,
                provider_usdc_projection: projection,
                provider_usd_per_day: provider_per_day as f64 / 1_000_000.0,
                provider_usd_projection: projection as f64 / 1_000_000.0,
            }
        })
        .collect();

    models.sort_by(|a, b| b.provider_usdc_projection.cmp(&a.provider_usdc_projection));

    Ok(EarningsEstimateResponse {
        assumptions: EarningsAssumptions {
            avg_input_tokens: req.avg_input_tokens,
            avg_output_tokens: req.avg_output_tokens,
            requests_per_hour_per_slot: req.requests_per_hour_per_slot,
            uptime_hours_per_day: req.uptime_hours_per_day,
            utilization_ratio: req.utilization_ratio,
            projection_days: req.projection_days,
            max_concurrent,
            provider_revenue_share_pct: PROVIDER_REVENUE_SHARE_BPS as f64 / 100.0,
        },
        models,
    })
}

// =========================================================================
// 1. register_provider
// =========================================================================

/// Register (or re-register) a GPU provider for the calling user.
pub async fn register_provider(
    state: &AppState,
    user_id: Uuid,
    req: ProviderRegistration,
) -> Result<ProviderInfo, CloudError> {
    // Verify user has a wallet first
    let has_wallet: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_wallets WHERE user_id = $1)")
            .bind(user_id)
            .fetch_one(&state.db)
            .await?;

    if !has_wallet {
        return Err(CloudError::BadRequest(
            "you must provision a wallet before registering as a compute provider".to_string(),
        ));
    }

    validate_vram_mb(req.vram_mb)?;
    validate_max_concurrent(req.max_concurrent)?;
    let display_name = normalize_display_name(&req.display_name)?;
    let wallet_address = validate_wallet_address(&req.wallet_address)?;
    let models = normalize_models_json(&req.models)?;

    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            String,
            serde_json::Value,
            i32,
            i32,
            String,
            i64,
            i64,
            i64,
            f64,
            f64,
            f64,
            Option<chrono::DateTime<Utc>>,
            chrono::DateTime<Utc>,
            i64,
        ),
    >(
        r#"
        INSERT INTO compute_providers (
            user_id, relay_pubkey, display_name, models, vram_mb,
            max_concurrent, wallet_address, status,
            total_requests, total_tokens_served, total_earned_usdc,
            success_rate, avg_latency_ms, reputation_score
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'online', 0, 0, 0, 1.0, 0.0, 1.0)
        ON CONFLICT (relay_pubkey) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            display_name = EXCLUDED.display_name,
            models = EXCLUDED.models,
            vram_mb = EXCLUDED.vram_mb,
            max_concurrent = EXCLUDED.max_concurrent,
            wallet_address = EXCLUDED.wallet_address,
            status = 'online',
            updated_at = now()
        RETURNING
            id, relay_pubkey, display_name, models,
            vram_mb, max_concurrent, status,
            total_requests, total_tokens_served, total_earned_usdc,
            success_rate, avg_latency_ms, reputation_score,
            last_heartbeat_at, created_at,
            COALESCE(total_withdrawn_usdc, 0)
        "#,
    )
    .bind(user_id)
    .bind(&req.relay_pubkey)
    .bind(&display_name)
    .bind(&models)
    .bind(req.vram_mb)
    .bind(req.max_concurrent)
    .bind(&wallet_address)
    .fetch_one(&state.db)
    .await?;

    tracing::info!(
        user = %log_id(&user_id),
        "compute provider registered"
    );

    Ok(ProviderInfo {
        id: row.0,
        user_id,
        relay_pubkey: row.1,
        display_name: row.2,
        models: row.3,
        vram_mb: row.4,
        max_concurrent: row.5,
        wallet_address: Some(wallet_address),
        status: row.6,
        total_requests: row.7,
        total_tokens_served: row.8,
        total_earned_usdc: row.9,
        total_withdrawn_usdc: row.15,
        success_rate: row.10,
        avg_latency_ms: row.11,
        reputation_score: row.12,
        last_heartbeat_at: row.13,
        created_at: row.14,
    })
}

// =========================================================================
// 2. update_provider_status
// =========================================================================

pub async fn update_provider_status(
    db: &PgPool,
    provider_id: Uuid,
    status: &str,
) -> Result<(), CloudError> {
    let result =
        sqlx::query("UPDATE compute_providers SET status = $1, updated_at = now() WHERE id = $2")
            .bind(status)
            .bind(provider_id)
            .execute(db)
            .await?;

    if result.rows_affected() == 0 {
        return Err(CloudError::NotFound("provider not found".to_string()));
    }
    Ok(())
}

// =========================================================================
// 3. get_provider_by_user
// =========================================================================

pub async fn get_provider_by_user(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Option<ProviderInfo>, CloudError> {
    use sqlx::Row;

    let row = sqlx::query(
        r#"
        SELECT
            id, relay_pubkey, display_name, models,
            vram_mb, max_concurrent, status, wallet_address,
            total_requests, total_tokens_served, total_earned_usdc,
            success_rate, avg_latency_ms, reputation_score,
            last_heartbeat_at, created_at,
            COALESCE(total_withdrawn_usdc, 0) AS total_withdrawn_usdc
        FROM compute_providers
        WHERE user_id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    Ok(row.map(|r| ProviderInfo {
        id: r.get("id"),
        user_id,
        relay_pubkey: r.get("relay_pubkey"),
        display_name: r.get("display_name"),
        models: r.get("models"),
        vram_mb: r.get("vram_mb"),
        max_concurrent: r.get("max_concurrent"),
        wallet_address: r.get("wallet_address"),
        status: r.get("status"),
        total_requests: r.get("total_requests"),
        total_tokens_served: r.get("total_tokens_served"),
        total_earned_usdc: r.get("total_earned_usdc"),
        total_withdrawn_usdc: r.get("total_withdrawn_usdc"),
        success_rate: r.get("success_rate"),
        avg_latency_ms: r.get("avg_latency_ms"),
        reputation_score: r.get("reputation_score"),
        last_heartbeat_at: r.get("last_heartbeat_at"),
        created_at: r.get("created_at"),
    }))
}

// =========================================================================
// 4. get_provider_by_id
// =========================================================================

pub async fn get_provider_by_id(
    db: &PgPool,
    provider_id: Uuid,
) -> Result<Option<ProviderInfo>, CloudError> {
    use sqlx::Row;

    let row = sqlx::query(
        r#"
        SELECT
            id, user_id, relay_pubkey, display_name, models,
            vram_mb, max_concurrent, status,
            total_requests, total_tokens_served, total_earned_usdc,
            success_rate, avg_latency_ms, reputation_score,
            last_heartbeat_at, created_at,
            COALESCE(total_withdrawn_usdc, 0) AS total_withdrawn_usdc
        FROM compute_providers
        WHERE id = $1
        "#,
    )
    .bind(provider_id)
    .fetch_optional(db)
    .await?;

    Ok(row.map(|r| ProviderInfo {
        id: r.get("id"),
        user_id: r.get("user_id"),
        relay_pubkey: r.get("relay_pubkey"),
        display_name: r.get("display_name"),
        models: r.get("models"),
        vram_mb: r.get("vram_mb"),
        max_concurrent: r.get("max_concurrent"),
        wallet_address: None,
        status: r.get("status"),
        total_requests: r.get("total_requests"),
        total_tokens_served: r.get("total_tokens_served"),
        total_earned_usdc: r.get("total_earned_usdc"),
        total_withdrawn_usdc: r.get("total_withdrawn_usdc"),
        success_rate: r.get("success_rate"),
        avg_latency_ms: r.get("avg_latency_ms"),
        reputation_score: r.get("reputation_score"),
        last_heartbeat_at: r.get("last_heartbeat_at"),
        created_at: r.get("created_at"),
    }))
}

// =========================================================================
// 5. list_online_providers
// =========================================================================

pub async fn list_online_providers(db: &PgPool) -> Result<Vec<PublicProviderInfo>, CloudError> {
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            serde_json::Value,
            i32,
            String,
            i64,
            f64,
            f64,
            f64,
        ),
    >(
        r#"
        SELECT
            id, display_name, models,
            vram_mb, status,
            total_requests,
            success_rate, avg_latency_ms, reputation_score
        FROM compute_providers
        WHERE status = 'online'
        ORDER BY reputation_score DESC
        "#,
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| PublicProviderInfo {
            id: r.0,
            display_name: r.1,
            models: r.2,
            vram_mb: r.3,
            status: r.4,
            total_requests: quantize_i64(r.5, 100),
            success_rate: quantize_pct(r.6, 5.0),
            avg_latency_ms: quantize_f64(r.7, 10.0),
            reputation_score: r.8,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Quantization helpers — coarsen metrics to prevent fingerprinting
// ---------------------------------------------------------------------------

fn quantize_i64(val: i64, step: i64) -> i64 {
    (val / step) * step
}

fn quantize_pct(val: f64, step_pct: f64) -> f64 {
    ((val * 100.0 / step_pct).round() * step_pct) / 100.0
}

fn quantize_f64(val: f64, step: f64) -> f64 {
    (val / step).round() * step
}

// =========================================================================
// 6. list_community_models
// =========================================================================

/// Aggregate models across all online providers, returning per-model stats.
pub async fn list_community_models(db: &PgPool) -> Result<Vec<CommunityModel>, CloudError> {
    let rows: Vec<(serde_json::Value,)> =
        sqlx::query_as("SELECT models FROM compute_providers WHERE status = 'online'")
            .fetch_all(db)
            .await?;

    // model_id -> (count, min_input, min_output)
    let mut aggregated: HashMap<String, (usize, u64, u64)> = HashMap::new();

    for (models_json,) in &rows {
        if let Some(arr) = models_json.as_array() {
            for entry in arr {
                let model_id = match entry.get("model_id").and_then(|v| v.as_str()) {
                    Some(id) => id.to_string(),
                    None => continue,
                };
                let price_input = entry
                    .get("price_per_1k_input")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let price_output = entry
                    .get("price_per_1k_output")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                let stat = aggregated
                    .entry(model_id)
                    .or_insert((0, u64::MAX, u64::MAX));
                stat.0 += 1;
                stat.1 = stat.1.min(price_input);
                stat.2 = stat.2.min(price_output);
            }
        }
    }

    let mut models: Vec<CommunityModel> = aggregated
        .into_iter()
        .map(|(model_id, (count, min_in, min_out))| CommunityModel {
            model_id,
            providers_online: count,
            min_price_input: min_in,
            min_price_output: min_out,
        })
        .collect();

    models.sort_by(|a, b| b.providers_online.cmp(&a.providers_online));

    Ok(models)
}

// =========================================================================
// 6b. preview_provider
// =========================================================================

/// Peek at the compute cache and return the display_name + model_id of the
/// provider that would be selected, without creating escrow.
pub async fn preview_provider(state: &AppState) -> Option<(String, String)> {
    let cache = state.compute_cache.lock().await;
    cache.first().map(|p| {
        let model = p
            .models
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|m| m.get("model_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("community")
            .to_string();
        (p.display_name.clone(), model)
    })
}

// =========================================================================
// 7. update_provider
// =========================================================================

pub async fn update_provider(
    db: &PgPool,
    provider_id: Uuid,
    update: ProviderUpdate,
) -> Result<(), CloudError> {
    let mut any_updated = false;

    if let Some(ref models) = update.models {
        let normalized = normalize_models_json(models)?;
        sqlx::query("UPDATE compute_providers SET models = $1, updated_at = now() WHERE id = $2")
            .bind(&normalized)
            .bind(provider_id)
            .execute(db)
            .await?;
        any_updated = true;
    }

    if let Some(max_concurrent) = update.max_concurrent {
        validate_max_concurrent(max_concurrent)?;
        sqlx::query(
            "UPDATE compute_providers SET max_concurrent = $1, updated_at = now() WHERE id = $2",
        )
        .bind(max_concurrent)
        .bind(provider_id)
        .execute(db)
        .await?;
        any_updated = true;
    }

    if let Some(vram_mb) = update.vram_mb {
        validate_vram_mb(vram_mb)?;
        sqlx::query("UPDATE compute_providers SET vram_mb = $1, updated_at = now() WHERE id = $2")
            .bind(vram_mb)
            .bind(provider_id)
            .execute(db)
            .await?;
        any_updated = true;
    }

    if let Some(status) = update.status {
        let normalized = normalize_provider_status(&status)?;
        sqlx::query("UPDATE compute_providers SET status = $1, updated_at = now() WHERE id = $2")
            .bind(&normalized)
            .bind(provider_id)
            .execute(db)
            .await?;
        any_updated = true;
    }

    // If nothing was set, just touch updated_at.
    if !any_updated {
        sqlx::query("UPDATE compute_providers SET updated_at = now() WHERE id = $1")
            .bind(provider_id)
            .execute(db)
            .await?;
    }

    Ok(())
}

// =========================================================================
// 8. select_provider
// =========================================================================

/// Score-based provider selection from the in-memory compute cache.
/// Scoring: reputation * 0.5 + load_factor * 0.3 + price_factor * 0.2
pub async fn select_provider(
    state: &AppState,
    model_id: &str,
    max_cost_per_1k: Option<u64>,
) -> Result<SelectedProvider, CloudError> {
    let cache = state.compute_cache.lock().await;

    if cache.is_empty() {
        return Err(CloudError::ServiceUnavailable(
            "no compute providers online".to_string(),
        ));
    }

    // Candidates: providers that serve the requested model
    struct Candidate {
        provider_id: Uuid,
        relay_pubkey: String,
        model_id: String,
        price_per_1k_input: u64,
        price_per_1k_output: u64,
        reputation: f64,
        load_ratio: f64,
    }

    let mut candidates: Vec<Candidate> = Vec::new();

    for provider in cache.iter() {
        if provider.reputation_score < state.config.min_provider_reputation {
            continue;
        }

        if let Some(arr) = provider.models.as_array() {
            for entry in arr {
                let mid = match entry.get("model_id").and_then(|v| v.as_str()) {
                    Some(id) => id,
                    None => continue,
                };
                if mid != model_id {
                    continue;
                }

                let price_input = entry
                    .get("price_per_1k_input")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let price_output = entry
                    .get("price_per_1k_output")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                // Apply cost filter
                if let Some(max) = max_cost_per_1k {
                    if price_input > max || price_output > max {
                        continue;
                    }
                }

                let load_ratio = if provider.max_concurrent > 0 {
                    provider.current_load as f64 / provider.max_concurrent as f64
                } else {
                    1.0
                };

                candidates.push(Candidate {
                    provider_id: provider.provider_id,
                    relay_pubkey: provider.relay_pubkey.clone(),
                    model_id: mid.to_string(),
                    price_per_1k_input: price_input,
                    price_per_1k_output: price_output,
                    reputation: provider.reputation_score,
                    load_ratio,
                });
            }
        }
    }

    if candidates.is_empty() {
        return Err(CloudError::ServiceUnavailable(format!(
            "no provider online for model '{model_id}'"
        )));
    }

    // Find max price for normalisation
    let max_price = candidates
        .iter()
        .map(|c| c.price_per_1k_input.max(c.price_per_1k_output))
        .max()
        .unwrap_or(1)
        .max(1) as f64;

    // Score each candidate
    let best = candidates
        .iter()
        .max_by(|a, b| {
            let score_a =
                compute_score(a.reputation, a.load_ratio, a.price_per_1k_input, max_price);
            let score_b =
                compute_score(b.reputation, b.load_ratio, b.price_per_1k_input, max_price);
            score_a
                .partial_cmp(&score_b)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap(); // candidates is non-empty

    Ok(SelectedProvider {
        provider_id: best.provider_id,
        relay_pubkey: best.relay_pubkey.clone(),
        model_id: best.model_id.clone(),
        price_per_1k_input: best.price_per_1k_input,
        price_per_1k_output: best.price_per_1k_output,
    })
}

fn compute_score(reputation: f64, load_ratio: f64, price: u64, max_price: f64) -> f64 {
    let load_factor = 1.0 - load_ratio; // lower load is better
    let price_factor = 1.0 - (price as f64 / max_price); // cheaper is better
    reputation * 0.5 + load_factor * 0.3 + price_factor * 0.2
}

// =========================================================================
// 8b. select_providers_batch (for swarm dispatch)
// =========================================================================

/// Distribute `count` work units across matched agents using round-robin,
/// weighted by available capacity. Returns indices into the `agents` slice.
pub fn select_providers_batch(
    agents: &[crate::services::agent_service::MatchedAgent],
    count: usize,
) -> Vec<usize> {
    if agents.is_empty() {
        return Vec::new();
    }

    // Compute available capacity per agent
    let capacities: Vec<usize> = agents
        .iter()
        .map(|a| {
            let available = ((1.0 - a.provider_load_ratio) * 10.0).ceil() as usize;
            available.max(1)
        })
        .collect();

    let mut assignments = Vec::with_capacity(count);
    let mut remaining = capacities.clone();
    let mut idx = 0;

    for _ in 0..count {
        // Find next agent with remaining capacity (round-robin)
        let mut found = false;
        for _ in 0..agents.len() {
            let agent_idx = idx % agents.len();
            idx += 1;
            if remaining[agent_idx] > 0 {
                assignments.push(agent_idx);
                remaining[agent_idx] -= 1;
                found = true;
                break;
            }
        }
        if !found {
            // All agents exhausted estimated capacity — wrap around
            remaining = capacities.clone();
            let agent_idx = idx % agents.len();
            idx += 1;
            assignments.push(agent_idx);
        }
    }

    assignments
}

// =========================================================================
// 9. create_escrow
// =========================================================================

/// Hold funds in escrow before dispatching inference. Verifies the user's
/// daily spending limit can absorb the estimated cost.
pub async fn create_escrow(
    db: &PgPool,
    user_id: Uuid,
    provider_id: Option<Uuid>,
    estimated_cost_usdc: i64,
) -> Result<Uuid, CloudError> {
    // Fetch user's daily spending limit
    let spending_limit: Option<i64> =
        sqlx::query_scalar("SELECT spending_limit_daily_usdc FROM user_wallets WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;

    let daily_limit = spending_limit.ok_or_else(|| {
        CloudError::BadRequest("wallet not provisioned — cannot create escrow".to_string())
    })?;

    // Sum currently active escrow holds for this user
    let active_hold_total: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(amount_usdc), 0)
        FROM escrow_holds
        WHERE user_id = $1 AND status = 'held'
        "#,
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;

    let active_total = active_hold_total.unwrap_or(0);

    if active_total + estimated_cost_usdc > daily_limit {
        return Err(CloudError::PaymentRequired(format!(
            "insufficient spending capacity — active holds: {active_total}, \
             requested: {estimated_cost_usdc}, daily limit: {daily_limit}"
        )));
    }

    // Insert the escrow hold
    let escrow_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO escrow_holds (user_id, provider_id, amount_usdc, status)
        VALUES ($1, $2, $3, 'held')
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(provider_id)
    .bind(estimated_cost_usdc)
    .fetch_one(db)
    .await?;

    tracing::info!(
        user = %log_id(&user_id),
        provider = provider_id.map(|p| log_id(&p)).unwrap_or_else(|| "none".to_string()),
        %escrow_id,
        amount = estimated_cost_usdc,
        "escrow hold created"
    );

    Ok(escrow_id)
}

// =========================================================================
// 10. settle_escrow
// =========================================================================

/// Settle an escrow hold: compute actual cost, apply 85/15 split, mark
/// released.
pub async fn settle_escrow(
    db: &PgPool,
    usage_receipt_secret: &str,
    escrow_id: Uuid,
    actual_input_tokens: i64,
    actual_output_tokens: i64,
    price_per_1k_input: u64,
    price_per_1k_output: u64,
) -> Result<EscrowSettlement, CloudError> {
    let mut tx = db.begin().await?;

    let actual_cost = ((actual_input_tokens as u64 * price_per_1k_input
        + actual_output_tokens as u64 * price_per_1k_output)
        / 1000) as i64;

    let provider_amount = actual_cost * 85 / 100;
    let platform_fee = actual_cost - provider_amount;

    let result = sqlx::query(
        r#"
        UPDATE escrow_holds
        SET status = 'released',
            released_to_provider = $1,
            platform_fee = $2,
            resolved_at = now()
        WHERE id = $3 AND status = 'held'
        "#,
    )
    .bind(provider_amount)
    .bind(platform_fee)
    .bind(escrow_id)
    .execute(&mut *tx)
    .await?;

    if result.rows_affected() == 0 {
        return Err(CloudError::NotFound(
            "escrow not found or already resolved".to_string(),
        ));
    }

    // Update provider's total earned
    sqlx::query(
        "UPDATE compute_providers SET total_earned_usdc = total_earned_usdc + $1
         WHERE id = (SELECT provider_id FROM escrow_holds WHERE id = $2)",
    )
    .bind(provider_amount)
    .bind(escrow_id)
    .execute(&mut *tx)
    .await?;

    let details: (Option<Uuid>, Uuid, Option<Uuid>, Option<String>, i64) = sqlx::query_as(
        r#"
        SELECT
            eh.provider_id,
            eh.user_id,
            cj.id,
            cj.model_id,
            eh.amount_usdc
        FROM escrow_holds eh
        LEFT JOIN compute_jobs cj ON cj.escrow_id = eh.id
        WHERE eh.id = $1
        "#,
    )
    .bind(escrow_id)
    .fetch_one(&mut *tx)
    .await?;

    if let Some(provider_id) = details.0 {
        record_usage_receipt_inner(
            &mut *tx,
            usage_receipt_secret,
            UsageReceiptInsert {
                provider_id,
                user_id: Some(details.1),
                job_id: details.2,
                escrow_id: Some(escrow_id),
                source: RECEIPT_SOURCE_COMPUTE_ESCROW,
                source_ref: escrow_id,
                model_id: details.3.clone(),
                input_tokens: actual_input_tokens,
                output_tokens: actual_output_tokens,
                provider_amount_usdc: provider_amount,
                platform_fee_usdc: platform_fee,
                total_cost_usdc: actual_cost,
                metadata: serde_json::json!({
                    "price_per_1k_input": price_per_1k_input,
                    "price_per_1k_output": price_per_1k_output,
                    "escrow_held_amount_usdc": details.4,
                }),
            },
        )
        .await?;
    }

    tx.commit().await?;

    tracing::info!(
        %escrow_id,
        actual_cost,
        provider_amount,
        platform_fee,
        "escrow settled"
    );

    Ok(EscrowSettlement {
        escrow_id,
        actual_cost,
        provider_amount,
        platform_fee,
    })
}

// =========================================================================
// 11. refund_escrow
// =========================================================================

pub async fn refund_escrow(db: &PgPool, escrow_id: Uuid) -> Result<(), CloudError> {
    let result = sqlx::query(
        r#"
        UPDATE escrow_holds
        SET status = 'refunded', resolved_at = now()
        WHERE id = $1 AND status = 'held'
        "#,
    )
    .bind(escrow_id)
    .execute(db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(CloudError::NotFound(
            "escrow not found or already resolved".to_string(),
        ));
    }

    tracing::info!(%escrow_id, "escrow refunded");
    Ok(())
}

// =========================================================================
// 12. expire_stale_escrows
// =========================================================================

/// Expire escrow holds older than `max_age_secs`. Returns the count expired.
pub async fn expire_stale_escrows(db: &PgPool, max_age_secs: u64) -> Result<u64, CloudError> {
    let interval_str = format!("{max_age_secs} seconds");

    let result = sqlx::query(
        r#"
        UPDATE escrow_holds
        SET status = 'expired', resolved_at = now()
        WHERE status = 'held'
          AND created_at < now() - $1::interval
        "#,
    )
    .bind(&interval_str)
    .execute(db)
    .await?;

    let count = result.rows_affected();
    if count > 0 {
        tracing::info!(count, "stale escrows expired");
    }
    Ok(count)
}

// =========================================================================
// 13. create_job
// =========================================================================

pub async fn create_job(
    db: &PgPool,
    user_id: Uuid,
    provider_id: Uuid,
    escrow_id: Uuid,
    model_id: &str,
) -> Result<Uuid, CloudError> {
    let job_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO compute_jobs (user_id, provider_id, escrow_id, model_id, status)
        VALUES ($1, $2, $3, $4, 'pending')
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(provider_id)
    .bind(escrow_id)
    .bind(model_id)
    .fetch_one(db)
    .await?;

    Ok(job_id)
}

// =========================================================================
// 14. complete_job
// =========================================================================

pub async fn complete_job(
    db: &PgPool,
    job_id: Uuid,
    input_tokens: i64,
    output_tokens: i64,
    latency_ms: i64,
    quality_score: f64,
) -> Result<(), CloudError> {
    // Update the job record
    sqlx::query(
        r#"
        UPDATE compute_jobs
        SET status = 'completed',
            input_tokens = $1,
            output_tokens = $2,
            latency_ms = $3,
            quality_score = $4,
            completed_at = now()
        WHERE id = $5
        "#,
    )
    .bind(input_tokens)
    .bind(output_tokens)
    .bind(latency_ms)
    .bind(quality_score)
    .bind(job_id)
    .execute(db)
    .await?;

    // Update provider aggregate stats (running averages for success_rate + avg_latency_ms)
    sqlx::query(
        r#"
        UPDATE compute_providers
        SET total_requests = total_requests + 1,
            total_tokens_served = total_tokens_served + $1,
            success_rate = (success_rate * total_requests + 1.0) / (total_requests + 1),
            avg_latency_ms = (avg_latency_ms * total_requests + $3::double precision) / (total_requests + 1),
            last_heartbeat_at = now(),
            updated_at = now()
        WHERE id = (SELECT provider_id FROM compute_jobs WHERE id = $2)
        "#,
    )
    .bind(input_tokens + output_tokens)
    .bind(job_id)
    .bind(latency_ms as f64)
    .execute(db)
    .await?;

    Ok(())
}

// =========================================================================
// 15. fail_job
// =========================================================================

pub async fn fail_job(db: &PgPool, job_id: Uuid, error_message: &str) -> Result<(), CloudError> {
    sqlx::query(
        r#"
        UPDATE compute_jobs
        SET status = 'failed',
            error_message = $1,
            completed_at = now()
        WHERE id = $2
        "#,
    )
    .bind(error_message)
    .bind(job_id)
    .execute(db)
    .await?;

    // Increment total_requests even on failure (success_rate decreases, no latency update)
    sqlx::query(
        r#"
        UPDATE compute_providers
        SET total_requests = total_requests + 1,
            success_rate = (success_rate * total_requests) / (total_requests + 1),
            last_heartbeat_at = now(),
            updated_at = now()
        WHERE id = (SELECT provider_id FROM compute_jobs WHERE id = $1)
        "#,
    )
    .bind(job_id)
    .execute(db)
    .await?;

    Ok(())
}

// =========================================================================
// 16. dispatch_inference
// =========================================================================

/// Send a non-streaming inference request to the relay, targeting a specific
/// provider by its relay pubkey.
pub async fn dispatch_inference(
    state: &AppState,
    provider_pubkey: &str,
    messages: &serde_json::Value,
    system: Option<&str>,
    model_id: &str,
    max_tokens: u32,
    job_id: &str,
) -> Result<InferenceResult, CloudError> {
    let relay_url = &state.config.relay_url;
    let url = format!("{relay_url}/inference");

    let mut body = serde_json::json!({
        "provider_pubkey": provider_pubkey,
        "job_id": job_id,
        "model_id": model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": false,
    });

    if let Some(sys) = system {
        body["system"] = serde_json::Value::String(sys.to_string());
    }

    let start = std::time::Instant::now();

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| CloudError::ServiceUnavailable(format!("relay request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(CloudError::ServiceUnavailable(format!(
            "relay returned {status}: {text}"
        )));
    }

    let latency_ms = start.elapsed().as_millis() as u64;

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("failed to parse relay response: {e}")))?;

    let text = result
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let input_tokens = result
        .get("input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let output_tokens = result
        .get("output_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    Ok(InferenceResult {
        text,
        input_tokens,
        output_tokens,
        latency_ms,
    })
}

// =========================================================================
// 17. dispatch_inference_stream
// =========================================================================

/// Send a streaming inference request to the relay. Returns an SSE text stream.
pub async fn dispatch_inference_stream(
    state: &AppState,
    provider_pubkey: &str,
    messages: &serde_json::Value,
    system: Option<&str>,
    model_id: &str,
    max_tokens: u32,
    job_id: &str,
) -> Result<InferenceTextStream, CloudError> {
    let relay_url = &state.config.relay_url;
    let url = format!("{relay_url}/inference-stream");

    let mut body = serde_json::json!({
        "provider_pubkey": provider_pubkey,
        "job_id": job_id,
        "model_id": model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": true,
    });

    if let Some(sys) = system {
        body["system"] = serde_json::Value::String(sys.to_string());
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| CloudError::ServiceUnavailable(format!("relay stream request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(CloudError::ServiceUnavailable(format!(
            "relay returned {status}: {text}"
        )));
    }

    // Parse SSE events from the byte stream
    let byte_stream = resp.bytes_stream();

    let text_stream = async_stream::stream! {
        let mut buffer = String::new();

        tokio::pin!(byte_stream);

        while let Some(chunk_result) = byte_stream.next().await {
            let chunk = match chunk_result {
                Ok(bytes) => bytes,
                Err(e) => {
                    yield Err(CloudError::Internal(format!("stream error: {e}")));
                    break;
                }
            };

            let text = match std::str::from_utf8(&chunk) {
                Ok(s) => s,
                Err(e) => {
                    yield Err(CloudError::Internal(format!("invalid utf8 in stream: {e}")));
                    break;
                }
            };

            buffer.push_str(text);

            // Parse SSE events: "event: <type>\ndata: <json>\n\n"
            // The relay emits event types: "chunk", "done", "error"
            while let Some(pos) = buffer.find("\n\n") {
                let event_block = buffer[..pos].to_string();
                buffer = buffer[pos + 2..].to_string();

                let mut event_type = String::new();
                let mut data_str = String::new();

                for line in event_block.lines() {
                    if let Some(ev) = line.strip_prefix("event: ") {
                        event_type = ev.trim().to_string();
                    } else if let Some(d) = line.strip_prefix("data: ") {
                        data_str = d.to_string();
                    }
                }

                if data_str == "[DONE]" {
                    break;
                }

                match event_type.as_str() {
                    "done" => {
                        // Stream complete — data contains final token counts
                        break;
                    }
                    "error" => {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&data_str) {
                            let msg = json.get("error").and_then(|v| v.as_str()).unwrap_or("unknown error");
                            yield Err(CloudError::Internal(format!("provider error: {msg}")));
                        } else {
                            yield Err(CloudError::Internal(format!("provider error: {data_str}")));
                        }
                        break;
                    }
                    _ => {
                        // "chunk" or untyped — extract text
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&data_str) {
                            if let Some(chunk_text) = json.get("text").and_then(|v| v.as_str()) {
                                yield Ok(chunk_text.to_string());
                            }
                        } else if !data_str.is_empty() {
                            yield Ok(data_str);
                        }
                    }
                }
            }
        }
    };

    Ok(Box::pin(text_stream))
}

// =========================================================================
// 18. validate_response
// =========================================================================

/// Check response quality via length and Shannon entropy.
pub fn validate_response(text: &str, min_tokens: usize) -> ResponseQuality {
    if text.len() < 10 {
        return ResponseQuality {
            valid: false,
            score: 0.0,
            reason: Some("response too short (< 10 chars)".to_string()),
        };
    }

    let entropy = shannon_entropy(text);

    if entropy < 2.0 {
        return ResponseQuality {
            valid: false,
            score: 0.5,
            reason: Some(format!(
                "low Shannon entropy ({entropy:.2}) — likely repetitive/degenerate output"
            )),
        };
    }

    // Word count check against min_tokens (rough approximation)
    let word_count = text.split_whitespace().count();
    if word_count < min_tokens && min_tokens > 0 {
        return ResponseQuality {
            valid: true,
            score: 0.7,
            reason: Some(format!(
                "response shorter than expected ({word_count} words, wanted >= {min_tokens})"
            )),
        };
    }

    ResponseQuality {
        valid: true,
        score: 1.0,
        reason: None,
    }
}

/// Compute Shannon entropy of a string (bits per character).
fn shannon_entropy(text: &str) -> f64 {
    if text.is_empty() {
        return 0.0;
    }

    let mut freq: HashMap<char, usize> = HashMap::new();
    let mut total = 0usize;

    for c in text.chars() {
        *freq.entry(c).or_insert(0) += 1;
        total += 1;
    }

    let total_f = total as f64;
    let mut entropy = 0.0f64;

    for &count in freq.values() {
        let p = count as f64 / total_f;
        if p > 0.0 {
            entropy -= p * p.log2();
        }
    }

    entropy
}

// =========================================================================
// 19. update_reputation
// =========================================================================

/// Exponential moving average reputation update.
/// new = 0.95 * old + 0.05 * job_score
///   - job_score = 1.0 (success), 0.5 (success but slow >10 s), 0.0 (failed)
pub async fn update_reputation(
    db: &PgPool,
    provider_id: Uuid,
    job_success: bool,
    latency_ms: Option<i64>,
) -> Result<(), CloudError> {
    let job_score: f64 = if !job_success {
        0.0
    } else if latency_ms.map_or(false, |l| l > 10_000) {
        0.5
    } else {
        1.0
    };

    sqlx::query(
        r#"
        UPDATE compute_providers
        SET reputation_score = 0.95 * reputation_score + 0.05 * $1,
            updated_at = now()
        WHERE id = $2
        "#,
    )
    .bind(job_score)
    .bind(provider_id)
    .execute(db)
    .await?;

    Ok(())
}

// =========================================================================
// 20. update_daily_stats
// =========================================================================

pub async fn update_daily_stats(
    db: &PgPool,
    provider_id: Uuid,
    success: bool,
    tokens: i64,
    earned: i64,
    latency_ms: f64,
) -> Result<(), CloudError> {
    let today = Utc::now().date_naive();

    sqlx::query(
        r#"
        INSERT INTO provider_stats (
            provider_id, stat_date,
            requests_total, requests_success, requests_failed,
            tokens_served, earned_usdc, avg_latency_ms
        )
        VALUES ($1, $2, 1, $3, $4, $5, $6, $7)
        ON CONFLICT (provider_id, stat_date) DO UPDATE SET
            requests_total = provider_stats.requests_total + 1,
            requests_success = provider_stats.requests_success + $3,
            requests_failed = provider_stats.requests_failed + $4,
            tokens_served = provider_stats.tokens_served + $5,
            earned_usdc = provider_stats.earned_usdc + $6,
            avg_latency_ms = (provider_stats.avg_latency_ms * provider_stats.requests_total + $7)
                             / (provider_stats.requests_total + 1)
        "#,
    )
    .bind(provider_id)
    .bind(today)
    .bind(if success { 1i32 } else { 0 })
    .bind(if success { 0i32 } else { 1 })
    .bind(tokens)
    .bind(earned)
    .bind(latency_ms)
    .execute(db)
    .await?;

    Ok(())
}

// =========================================================================
// 21. get_provider_stats
// =========================================================================

pub async fn get_provider_stats(
    db: &PgPool,
    provider_id: Uuid,
    days: i32,
) -> Result<Vec<DailyStats>, CloudError> {
    let rows = sqlx::query_as::<_, (NaiveDate, i32, i32, i32, i64, i64, f64)>(
        r#"
        SELECT
            stat_date, requests_total, requests_success, requests_failed,
            tokens_served, earned_usdc, avg_latency_ms
        FROM provider_stats
        WHERE provider_id = $1
          AND stat_date >= CURRENT_DATE - $2::int
        ORDER BY stat_date DESC
        "#,
    )
    .bind(provider_id)
    .bind(days)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(stat_date, total, success, failed, tokens, earned, latency)| DailyStats {
                stat_date,
                requests_total: total,
                requests_success: success,
                requests_failed: failed,
                tokens_served: tokens,
                earned_usdc: earned,
                avg_latency_ms: latency,
            },
        )
        .collect())
}

// =========================================================================
// 22. get_recent_jobs
// =========================================================================

pub async fn get_recent_jobs(
    db: &PgPool,
    provider_id: Uuid,
    limit: i64,
) -> Result<Vec<RecentJob>, CloudError> {
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            String,
            i32,
            i32,
            Option<i32>,
            Option<Uuid>,
            chrono::DateTime<Utc>,
        ),
    >(
        r#"
        SELECT id, model_id, status, input_tokens, output_tokens, latency_ms, agent_id, created_at
        FROM compute_jobs
        WHERE provider_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        "#,
    )
    .bind(provider_id)
    .bind(limit)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                model_id,
                status,
                input_tokens,
                output_tokens,
                latency_ms,
                agent_id,
                created_at,
            )| RecentJob {
                id,
                model_id,
                status,
                input_tokens,
                output_tokens,
                latency_ms,
                agent_id,
                created_at,
            },
        )
        .collect())
}

// =========================================================================
// 23. get_active_escrows
// =========================================================================

pub async fn get_active_escrows(db: &PgPool, user_id: Uuid) -> Result<Vec<EscrowInfo>, CloudError> {
    let rows = sqlx::query_as::<_, (Uuid, Uuid, i64, chrono::DateTime<Utc>)>(
        r#"
        SELECT id, provider_id, amount_usdc, created_at
        FROM escrow_holds
        WHERE user_id = $1 AND status = 'held'
        ORDER BY created_at DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, provider_id, amount_usdc, created_at)| EscrowInfo {
            id,
            provider_id,
            amount_usdc,
            created_at,
        })
        .collect())
}

// =========================================================================
// 23. refresh_provider_cache
// =========================================================================

/// Reload the in-memory provider cache from the DB.
pub async fn refresh_provider_cache(state: &AppState) -> Result<(), CloudError> {
    let rows = sqlx::query_as::<_, (Uuid, String, String, serde_json::Value, f64, i32)>(
        r#"
        SELECT
            id, relay_pubkey, display_name, models,
            reputation_score, max_concurrent
        FROM compute_providers
        WHERE status = 'online'
        ORDER BY reputation_score DESC
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    let providers: Vec<CommunityProviderInfo> = rows
        .into_iter()
        .map(
            |(id, relay_pubkey, display_name, models, reputation, max_concurrent)| {
                CommunityProviderInfo {
                    provider_id: id,
                    relay_pubkey,
                    display_name,
                    models,
                    reputation_score: reputation,
                    current_load: 0, // reset on refresh; heartbeats update this
                    max_concurrent,
                }
            },
        )
        .collect();

    let count = providers.len();
    let mut cache = state.compute_cache.lock().await;
    *cache = providers;

    tracing::debug!(count, "provider cache refreshed");
    Ok(())
}

// =========================================================================
// 24. start_escrow_expiry_task
// =========================================================================

/// Background task: expire stale escrow holds every 5 minutes.
pub fn start_escrow_expiry_task(state: AppState) {
    let max_age = state.config.max_escrow_age_secs;

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
        interval.tick().await; // first tick is immediate — skip it

        loop {
            interval.tick().await;

            match expire_stale_escrows(&state.db, max_age).await {
                Ok(count) if count > 0 => {
                    tracing::info!(count, "escrow expiry sweep complete");
                }
                Err(e) => {
                    tracing::error!("escrow expiry task error: {e}");
                }
                _ => {}
            }
        }
    });
}

// =========================================================================
// 25. start_reputation_decay_task
// =========================================================================

/// Background task: decay reputation for offline providers every 24 hours.
pub fn start_reputation_decay_task(db: PgPool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(24 * 3600));
        interval.tick().await; // skip immediate tick

        loop {
            interval.tick().await;

            let result = sqlx::query(
                r#"
                UPDATE compute_providers
                SET reputation_score = reputation_score * 0.95,
                    updated_at = now()
                WHERE status = 'offline'
                  AND last_heartbeat_at < now() - interval '24 hours'
                "#,
            )
            .execute(&db)
            .await;

            match result {
                Ok(r) => {
                    let affected = r.rows_affected();
                    if affected > 0 {
                        tracing::info!(affected, "reputation decay applied to offline providers");
                    }
                }
                Err(e) => {
                    tracing::error!("reputation decay task error: {e}");
                }
            }
        }
    });
}

// =========================================================================
// Provider Withdrawals
// =========================================================================

pub async fn verify_provider_receipts(
    db: &PgPool,
    usage_receipt_secret: &str,
    provider_id: Uuid,
    limit: i64,
) -> Result<ReceiptVerificationSummary, CloudError> {
    if usage_receipt_secret.is_empty() {
        return Err(CloudError::Internal(
            "usage receipt secret must not be empty".to_string(),
        ));
    }

    let capped_limit = limit.clamp(1, RECEIPT_VERIFY_SCAN_LIMIT);

    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            Option<Uuid>,
            Option<Uuid>,
            Option<Uuid>,
            String,
            Uuid,
            Option<String>,
            i64,
            i64,
            i64,
            i64,
            i64,
            serde_json::Value,
            String,
            String,
            bool,
        ),
    >(
        r#"
        SELECT
            id, user_id, job_id, escrow_id,
            source, source_ref, model_id,
            input_tokens, output_tokens,
            provider_amount_usdc, platform_fee_usdc, total_cost_usdc,
            metadata, proof_hash, receipt_sig, verified
        FROM compute_usage_receipts
        WHERE provider_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        "#,
    )
    .bind(provider_id)
    .bind(capped_limit)
    .fetch_all(db)
    .await?;

    let mut checked = 0usize;
    let mut valid = 0usize;
    let mut invalid = 0usize;
    let mut invalid_receipt_ids = Vec::new();

    for row in rows {
        checked += 1;
        let payload = usage_receipt_payload(
            provider_id,
            row.1,
            row.2,
            row.3,
            &row.4,
            row.5,
            row.6.as_deref(),
            row.7,
            row.8,
            row.9,
            row.10,
            row.11,
            &row.12,
        );

        let payload_bytes = serde_json::to_vec(&payload).map_err(|e| {
            CloudError::Internal(format!("failed to serialize verification payload: {e}"))
        })?;
        let expected_hash = sha256_hex(&payload_bytes);
        let expected_sig = sign_receipt_hex(usage_receipt_secret, &payload_bytes);
        let is_valid = row.13 == expected_hash && row.14 == expected_sig;

        if row.15 != is_valid {
            sqlx::query("UPDATE compute_usage_receipts SET verified = $1 WHERE id = $2")
                .bind(is_valid)
                .bind(row.0)
                .execute(db)
                .await?;
        }

        if is_valid {
            valid += 1;
        } else {
            invalid += 1;
            invalid_receipt_ids.push(row.0);
        }
    }

    Ok(ReceiptVerificationSummary {
        checked,
        valid,
        invalid,
        invalid_receipt_ids,
    })
}

async fn get_provider_receipted_earned_usdc(db: &PgPool, provider_id: Uuid) -> Result<i64, CloudError> {
    let earned: i64 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(provider_amount_usdc), 0)
        FROM compute_usage_receipts
        WHERE provider_id = $1 AND verified = true
        "#,
    )
    .bind(provider_id)
    .fetch_one(db)
    .await?;

    Ok(earned.max(0))
}

async fn assess_withdrawal_risk(
    db: &PgPool,
    provider: &ProviderInfo,
    amount_usdc: i64,
    verified_available_usdc: i64,
    receipt_check: &ReceiptVerificationSummary,
) -> Result<Vec<String>, CloudError> {
    let mut reasons = Vec::new();

    if receipt_check.invalid > 0 {
        reasons.push("receipt integrity mismatch detected".to_string());
    }

    if amount_usdc >= REVIEW_HARD_THRESHOLD_USDC {
        reasons.push(format!(
            "withdrawal amount exceeds automatic review threshold (${:.2})",
            REVIEW_HARD_THRESHOLD_USDC as f64 / 1_000_000.0
        ));
    }

    let provider_age_days = (Utc::now() - provider.created_at).num_days().max(0);
    if provider_age_days < REVIEW_NEW_PROVIDER_DAYS && amount_usdc > REVIEW_NEW_PROVIDER_MAX_USDC {
        reasons.push(format!(
            "new provider profile (<{} days) requested larger-than-allowed withdrawal",
            REVIEW_NEW_PROVIDER_DAYS
        ));
    }

    if provider.success_rate < REVIEW_LOW_SUCCESS_RATE && amount_usdc > REVIEW_LOW_SUCCESS_MAX_USDC {
        reasons.push(format!(
            "provider success rate {:.1}% below {:.1}% for requested amount",
            provider.success_rate * 100.0,
            REVIEW_LOW_SUCCESS_RATE * 100.0
        ));
    }

    if verified_available_usdc > 0
        && amount_usdc.saturating_mul(10_000)
            >= verified_available_usdc.saturating_mul(REVIEW_BALANCE_SHARE_BPS)
    {
        reasons.push("withdrawal drains most verified available balance".to_string());
    }

    let payouts_24h: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM provider_payouts
        WHERE provider_id = $1
          AND created_at >= now() - interval '24 hours'
          AND status IN ('pending', 'confirmed', 'review_required')
        "#,
    )
    .bind(provider.id)
    .fetch_one(db)
    .await?;
    if payouts_24h >= REVIEW_MAX_PAYOUTS_24H {
        reasons.push("high payout frequency in the last 24 hours".to_string());
    }

    let receipts_24h: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM compute_usage_receipts
        WHERE provider_id = $1
          AND verified = true
          AND created_at >= now() - interval '24 hours'
        "#,
    )
    .bind(provider.id)
    .fetch_one(db)
    .await?;
    if receipts_24h < 2 && amount_usdc > REVIEW_LOW_SUCCESS_MAX_USDC {
        reasons.push("sparse recent signed usage for requested payout size".to_string());
    }

    Ok(reasons)
}

async fn create_review_required_payout(
    db: &PgPool,
    provider_id: Uuid,
    user_id: Uuid,
    amount_usdc: i64,
    to_address: &str,
    reasons: &[String],
) -> Result<Uuid, CloudError> {
    let reason_text = format!("security review hold: {}", reasons.join("; "));
    let payout_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO provider_payouts
            (provider_id, user_id, amount_usdc, to_address, status, error_message)
        VALUES
            ($1, $2, $3, $4, 'review_required', $5)
        RETURNING id
        "#,
    )
    .bind(provider_id)
    .bind(user_id)
    .bind(amount_usdc)
    .bind(to_address)
    .bind(reason_text)
    .fetch_one(db)
    .await?;
    Ok(payout_id)
}

/// Withdraw provider earnings to their Solana wallet.
pub async fn withdraw_provider_earnings(
    state: &AppState,
    user_id: Uuid,
    req: WithdrawalRequest,
) -> Result<WithdrawalResponse, CloudError> {
    // 1. Check treasury mnemonic is configured
    let mnemonic = state.config.treasury_mnemonic.as_deref().ok_or_else(|| {
        CloudError::ServiceUnavailable("withdrawals are not configured yet".to_string())
    })?;

    // 2. Load provider
    let provider = get_provider_by_user(&state.db, user_id)
        .await?
        .ok_or_else(|| CloudError::NotFound("no provider profile found".to_string()))?;

    // 3. Check wallet address
    let wallet_address = provider
        .wallet_address
        .as_deref()
        .filter(|w| !w.is_empty())
        .ok_or_else(|| {
            CloudError::BadRequest(
                "set a wallet address on your provider profile before withdrawing".to_string(),
            )
        })?
        .to_string();

    // 3b. Reconcile receipt integrity before using verified earnings for payout.
    let receipt_check = verify_provider_receipts(
        &state.db,
        &state.config.usage_receipt_secret,
        provider.id,
        RECEIPT_VERIFY_SCAN_LIMIT,
    )
    .await?;

    // 4. Compute available balance
    let receipted_earned = get_provider_receipted_earned_usdc(&state.db, provider.id).await?;
    let capped_receipted_earned = receipted_earned.min(provider.total_earned_usdc).max(0);
    let available = capped_receipted_earned.saturating_sub(provider.total_withdrawn_usdc);

    // 5. Determine withdrawal amount
    let amount = req.amount_usdc.unwrap_or(available);

    // 6. Validate
    if amount <= 0 {
        return Err(CloudError::BadRequest(
            "amount must be positive".to_string(),
        ));
    }
    if amount < MIN_WITHDRAWAL_USDC {
        return Err(CloudError::BadRequest(format!(
            "minimum withdrawal is ${:.2} USDC",
            MIN_WITHDRAWAL_USDC as f64 / 1_000_000.0
        )));
    }
    if amount > available {
        return Err(CloudError::BadRequest(format!(
            "insufficient verified balance: ${:.6} available",
            available as f64 / 1_000_000.0
        )));
    }

    // 7. Check no pending payouts
    let pending_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_payouts WHERE provider_id = $1 AND status IN ('pending', 'review_required')",
    )
    .bind(provider.id)
    .fetch_one(&state.db)
    .await?;

    if pending_count > 0 {
        return Err(CloudError::BadRequest(
            "you have a pending withdrawal — wait for it to complete".to_string(),
        ));
    }

    // 7a. Security hold if anomaly/risk rules trigger.
    let risk_reasons =
        assess_withdrawal_risk(&state.db, &provider, amount, available, &receipt_check).await?;
    if !risk_reasons.is_empty() {
        let payout_id = create_review_required_payout(
            &state.db,
            provider.id,
            user_id,
            amount,
            &wallet_address,
            &risk_reasons,
        )
        .await?;
        return Err(CloudError::BadRequest(format!(
            "withdrawal placed in security review (payout_id: {payout_id})"
        )));
    }

    // 7b. Assign payout_index if not yet set (for HD intermediate wallet derivation)
    let payout_index: i32 = {
        let existing: Option<Option<i32>> =
            sqlx::query_scalar("SELECT payout_index FROM compute_providers WHERE id = $1")
                .bind(provider.id)
                .fetch_optional(&state.db)
                .await?;

        match existing.flatten() {
            Some(idx) => idx,
            None => {
                let idx: i32 = sqlx::query_scalar(
                    r#"
                    UPDATE compute_providers
                    SET payout_index = nextval('payout_index_seq')
                    WHERE id = $1
                    RETURNING payout_index
                    "#,
                )
                .bind(provider.id)
                .fetch_one(&state.db)
                .await?;
                idx
            }
        }
    };

    // 8. Insert pending payout
    let payout_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO provider_payouts (provider_id, user_id, amount_usdc, to_address, status)
        VALUES ($1, $2, $3, $4, 'pending')
        RETURNING id
        "#,
    )
    .bind(provider.id)
    .bind(user_id)
    .bind(amount)
    .bind(&wallet_address)
    .fetch_one(&state.db)
    .await?;

    // 9. Send USDC via HD-derived intermediate wallet (breaks on-chain treasury link)
    let rpc_url = &state.config.solana_rpc_url;
    match crate::services::wallet_service::send_via_intermediate(
        mnemonic,
        payout_index as u32,
        &wallet_address,
        amount as u64,
        rpc_url,
    )
    .await
    {
        Ok(tx) => {
            // 10. Mark confirmed, update withdrawn total
            sqlx::query(
                r#"
                UPDATE provider_payouts
                SET status = 'confirmed', signature = $1, completed_at = now()
                WHERE id = $2
                "#,
            )
            .bind(&tx.signature)
            .bind(payout_id)
            .execute(&state.db)
            .await?;

            sqlx::query(
                "UPDATE compute_providers SET total_withdrawn_usdc = COALESCE(total_withdrawn_usdc, 0) + $1 WHERE id = $2",
            )
            .bind(amount)
            .bind(provider.id)
            .execute(&state.db)
            .await?;

            tracing::info!(
                user = %log_id(&user_id),
                provider = %log_id(&provider.id),
                amount,
                "provider withdrawal confirmed"
            );
            tracing::debug!(
                user = %log_id(&user_id),
                signature = %tx.signature,
                "withdrawal tx signature"
            );

            Ok(WithdrawalResponse {
                payout_id,
                amount_usdc: amount,
                to_address: wallet_address,
                signature: tx.signature,
                explorer_url: tx.explorer_url,
            })
        }
        Err(e) => {
            // 11. Mark failed
            let err_msg = e.to_string();
            sqlx::query(
                r#"
                UPDATE provider_payouts
                SET status = 'failed', error_message = $1, completed_at = now()
                WHERE id = $2
                "#,
            )
            .bind(&err_msg)
            .bind(payout_id)
            .execute(&state.db)
            .await?;

            tracing::error!(
                user = %log_id(&user_id),
                provider = %log_id(&provider.id),
                "provider withdrawal failed"
            );
            tracing::debug!(
                user = %log_id(&user_id),
                error = %err_msg,
                "withdrawal error detail"
            );

            Err(CloudError::Internal(format!(
                "withdrawal failed: {err_msg}"
            )))
        }
    }
}

/// Get payout history for a provider.
pub async fn get_provider_payouts(
    db: &PgPool,
    provider_id: Uuid,
    limit: i64,
) -> Result<Vec<PayoutInfo>, CloudError> {
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            i64,
            String,
            Option<String>,
            String,
            Option<String>,
            chrono::DateTime<Utc>,
            Option<chrono::DateTime<Utc>>,
        ),
    >(
        r#"
        SELECT id, amount_usdc, to_address, signature, status,
               error_message, created_at, completed_at
        FROM provider_payouts
        WHERE provider_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        "#,
    )
    .bind(provider_id)
    .bind(limit)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| PayoutInfo {
            id: r.0,
            amount_usdc: r.1,
            to_address: r.2,
            signature: r.3,
            status: r.4,
            error_message: r.5,
            created_at: r.6,
            completed_at: r.7,
        })
        .collect())
}

/// Get payout summary for a provider.
pub async fn get_payout_summary(
    db: &PgPool,
    provider_id: Uuid,
) -> Result<PayoutSummary, CloudError> {
    let (earned, withdrawn): (i64, i64) = sqlx::query_as(
        r#"
        SELECT
            COALESCE(total_earned_usdc, 0),
            COALESCE(total_withdrawn_usdc, 0)
        FROM compute_providers
        WHERE id = $1
        "#,
    )
    .bind(provider_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| CloudError::NotFound("provider not found".to_string()))?;

    let receipt_verified_earned_usdc = get_provider_receipted_earned_usdc(db, provider_id).await?;
    let capped_receipted_earned = receipt_verified_earned_usdc.min(earned).max(0);

    Ok(PayoutSummary {
        total_earned_usdc: earned,
        receipt_verified_earned_usdc,
        total_withdrawn_usdc: withdrawn,
        available_usdc: earned.saturating_sub(withdrawn),
        receipt_verified_available_usdc: capped_receipted_earned.saturating_sub(withdrawn),
        min_withdrawal_usdc: MIN_WITHDRAWAL_USDC,
    })
}

pub async fn get_provider_usage_receipts(
    db: &PgPool,
    provider_id: Uuid,
    limit: i64,
) -> Result<Vec<UsageReceiptInfo>, CloudError> {
    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            Uuid,
            Option<String>,
            i64,
            i64,
            i64,
            i64,
            i64,
            String,
            String,
            bool,
            chrono::DateTime<Utc>,
        ),
    >(
        r#"
        SELECT
            id, source, source_ref, model_id,
            input_tokens, output_tokens,
            provider_amount_usdc, platform_fee_usdc, total_cost_usdc,
            proof_hash, receipt_sig, verified, created_at
        FROM compute_usage_receipts
        WHERE provider_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        "#,
    )
    .bind(provider_id)
    .bind(limit)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                source,
                source_ref,
                model_id,
                input_tokens,
                output_tokens,
                provider_amount_usdc,
                platform_fee_usdc,
                total_cost_usdc,
                proof_hash,
                receipt_sig,
                verified,
                created_at,
            )| UsageReceiptInfo {
                id,
                source,
                source_ref,
                model_id,
                input_tokens,
                output_tokens,
                provider_amount_usdc,
                platform_fee_usdc,
                total_cost_usdc,
                proof_hash,
                receipt_sig,
                verified,
                created_at,
            },
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_provider(models: serde_json::Value) -> ProviderInfo {
        ProviderInfo {
            id: Uuid::nil(),
            user_id: Uuid::nil(),
            relay_pubkey: "relay".to_string(),
            display_name: "Provider".to_string(),
            models,
            vram_mb: 24_000,
            max_concurrent: 2,
            wallet_address: Some("11111111111111111111111111111111".to_string()),
            status: "online".to_string(),
            total_requests: 0,
            total_tokens_served: 0,
            total_earned_usdc: 0,
            total_withdrawn_usdc: 0,
            success_rate: 1.0,
            avg_latency_ms: 0.0,
            reputation_score: 1.0,
            last_heartbeat_at: None,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn parse_model_offers_rejects_duplicates() {
        let models = json!([
            {"model_id":"llama-70b","price_per_1k_input":1000,"price_per_1k_output":2000},
            {"model_id":"llama-70b","price_per_1k_input":1000,"price_per_1k_output":2000}
        ]);
        let err = parse_model_offers(&models).expect_err("duplicate model ids must fail");
        assert!(err.to_string().contains("duplicate model_id"));
    }

    #[test]
    fn parse_model_offers_rejects_invalid_id() {
        let models = json!([
            {"model_id":"bad model id","price_per_1k_input":1000,"price_per_1k_output":2000}
        ]);
        let err = parse_model_offers(&models).expect_err("invalid model id must fail");
        assert!(err.to_string().contains("invalid model_id"));
    }

    #[test]
    fn estimate_provider_earnings_computes_expected_values() {
        let provider = sample_provider(json!([
            {"model_id":"llama-70b","price_per_1k_input":1000,"price_per_1k_output":1000}
        ]));
        let req = EarningsEstimateRequest {
            avg_input_tokens: 1000,
            avg_output_tokens: 1000,
            requests_per_hour_per_slot: 1.0,
            uptime_hours_per_day: 1.0,
            utilization_ratio: 1.0,
            projection_days: 1,
        };

        let estimate = estimate_provider_earnings(&provider, req).expect("estimate should succeed");
        assert_eq!(estimate.models.len(), 1);
        let model = &estimate.models[0];
        assert_eq!(model.gross_usdc_per_day, 4000);
        assert_eq!(model.provider_usdc_per_day, 3400);
        assert_eq!(model.provider_usdc_projection, 3400);
    }

    #[test]
    fn receipt_signature_is_deterministic_and_payload_bound() {
        let secret = "test-secret";
        let payload_a = br#"{"a":1,"b":2}"#;
        let payload_b = br#"{"a":1,"b":3}"#;
        let sig_a1 = sign_receipt_hex(secret, payload_a);
        let sig_a2 = sign_receipt_hex(secret, payload_a);
        let sig_b = sign_receipt_hex(secret, payload_b);
        assert_eq!(sig_a1, sig_a2);
        assert_ne!(sig_a1, sig_b);
    }
}
