//! GPU compute marketplace service for Ghola.
//! Manages community GPU providers, escrow, inference dispatch, quality
//! validation, reputation, and background maintenance tasks.

use std::collections::HashMap;
use std::pin::Pin;

use chrono::{NaiveDate, Utc};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::CloudError;
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
    pub status: String,
    pub total_requests: i64,
    pub total_tokens_served: i64,
    pub total_earned_usdc: i64,
    pub success_rate: f64,
    pub avg_latency_ms: f64,
    pub reputation_score: f64,
    pub last_heartbeat_at: Option<chrono::DateTime<Utc>>,
    pub created_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProviderUpdate {
    pub models: Option<serde_json::Value>,
    pub max_concurrent: Option<i32>,
    pub vram_mb: Option<i32>,
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
    let has_wallet: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM user_wallets WHERE user_id = $1)",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    if !has_wallet {
        return Err(CloudError::BadRequest(
            "you must provision a wallet before registering as a compute provider".to_string(),
        ));
    }

    let row = sqlx::query_as::<_, (
        Uuid, Uuid, String, String, serde_json::Value,
        i32, i32, String,
        i64, i64, i64,
        f64, f64, f64,
        Option<chrono::DateTime<Utc>>,
        chrono::DateTime<Utc>,
    )>(
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
            id, user_id, relay_pubkey, display_name, models,
            vram_mb, max_concurrent, status,
            total_requests, total_tokens_served, total_earned_usdc,
            success_rate, avg_latency_ms, reputation_score,
            last_heartbeat_at, created_at
        "#,
    )
    .bind(user_id)
    .bind(&req.relay_pubkey)
    .bind(&req.display_name)
    .bind(&req.models)
    .bind(req.vram_mb)
    .bind(req.max_concurrent)
    .bind(&req.wallet_address)
    .fetch_one(&state.db)
    .await?;

    tracing::info!(
        %user_id,
        relay_pubkey = %req.relay_pubkey,
        "compute provider registered"
    );

    Ok(ProviderInfo {
        id: row.0,
        user_id: row.1,
        relay_pubkey: row.2,
        display_name: row.3,
        models: row.4,
        vram_mb: row.5,
        max_concurrent: row.6,
        status: row.7,
        total_requests: row.8,
        total_tokens_served: row.9,
        total_earned_usdc: row.10,
        success_rate: row.11,
        avg_latency_ms: row.12,
        reputation_score: row.13,
        last_heartbeat_at: row.14,
        created_at: row.15,
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
    let result = sqlx::query(
        "UPDATE compute_providers SET status = $1, updated_at = now() WHERE id = $2",
    )
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
    let row = sqlx::query_as::<_, (
        Uuid, Uuid, String, String, serde_json::Value,
        i32, i32, String,
        i64, i64, i64,
        f64, f64, f64,
        Option<chrono::DateTime<Utc>>,
        chrono::DateTime<Utc>,
    )>(
        r#"
        SELECT
            id, user_id, relay_pubkey, display_name, models,
            vram_mb, max_concurrent, status,
            total_requests, total_tokens_served, total_earned_usdc,
            success_rate, avg_latency_ms, reputation_score,
            last_heartbeat_at, created_at
        FROM compute_providers
        WHERE user_id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    Ok(row.map(|r| ProviderInfo {
        id: r.0,
        user_id: r.1,
        relay_pubkey: r.2,
        display_name: r.3,
        models: r.4,
        vram_mb: r.5,
        max_concurrent: r.6,
        status: r.7,
        total_requests: r.8,
        total_tokens_served: r.9,
        total_earned_usdc: r.10,
        success_rate: r.11,
        avg_latency_ms: r.12,
        reputation_score: r.13,
        last_heartbeat_at: r.14,
        created_at: r.15,
    }))
}

// =========================================================================
// 4. get_provider_by_id
// =========================================================================

pub async fn get_provider_by_id(
    db: &PgPool,
    provider_id: Uuid,
) -> Result<Option<ProviderInfo>, CloudError> {
    let row = sqlx::query_as::<_, (
        Uuid, Uuid, String, String, serde_json::Value,
        i32, i32, String,
        i64, i64, i64,
        f64, f64, f64,
        Option<chrono::DateTime<Utc>>,
        chrono::DateTime<Utc>,
    )>(
        r#"
        SELECT
            id, user_id, relay_pubkey, display_name, models,
            vram_mb, max_concurrent, status,
            total_requests, total_tokens_served, total_earned_usdc,
            success_rate, avg_latency_ms, reputation_score,
            last_heartbeat_at, created_at
        FROM compute_providers
        WHERE id = $1
        "#,
    )
    .bind(provider_id)
    .fetch_optional(db)
    .await?;

    Ok(row.map(|r| ProviderInfo {
        id: r.0,
        user_id: r.1,
        relay_pubkey: r.2,
        display_name: r.3,
        models: r.4,
        vram_mb: r.5,
        max_concurrent: r.6,
        status: r.7,
        total_requests: r.8,
        total_tokens_served: r.9,
        total_earned_usdc: r.10,
        success_rate: r.11,
        avg_latency_ms: r.12,
        reputation_score: r.13,
        last_heartbeat_at: r.14,
        created_at: r.15,
    }))
}

// =========================================================================
// 5. list_online_providers
// =========================================================================

pub async fn list_online_providers(db: &PgPool) -> Result<Vec<ProviderInfo>, CloudError> {
    let rows = sqlx::query_as::<_, (
        Uuid, Uuid, String, String, serde_json::Value,
        i32, i32, String,
        i64, i64, i64,
        f64, f64, f64,
        Option<chrono::DateTime<Utc>>,
        chrono::DateTime<Utc>,
    )>(
        r#"
        SELECT
            id, user_id, relay_pubkey, display_name, models,
            vram_mb, max_concurrent, status,
            total_requests, total_tokens_served, total_earned_usdc,
            success_rate, avg_latency_ms, reputation_score,
            last_heartbeat_at, created_at
        FROM compute_providers
        WHERE status = 'online'
        ORDER BY reputation_score DESC
        "#,
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| ProviderInfo {
            id: r.0,
            user_id: r.1,
            relay_pubkey: r.2,
            display_name: r.3,
            models: r.4,
            vram_mb: r.5,
            max_concurrent: r.6,
            status: r.7,
            total_requests: r.8,
            total_tokens_served: r.9,
            total_earned_usdc: r.10,
            success_rate: r.11,
            avg_latency_ms: r.12,
            reputation_score: r.13,
            last_heartbeat_at: r.14,
            created_at: r.15,
        })
        .collect())
}

// =========================================================================
// 6. list_community_models
// =========================================================================

/// Aggregate models across all online providers, returning per-model stats.
pub async fn list_community_models(db: &PgPool) -> Result<Vec<CommunityModel>, CloudError> {
    let rows: Vec<(serde_json::Value,)> = sqlx::query_as(
        "SELECT models FROM compute_providers WHERE status = 'online'",
    )
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
// 7. update_provider
// =========================================================================

pub async fn update_provider(
    db: &PgPool,
    provider_id: Uuid,
    update: ProviderUpdate,
) -> Result<(), CloudError> {
    // Run individual updates per field for simplicity
    if let Some(ref models) = update.models {
        sqlx::query("UPDATE compute_providers SET models = $1, updated_at = now() WHERE id = $2")
            .bind(models)
            .bind(provider_id)
            .execute(db)
            .await?;
    }
    if let Some(max_concurrent) = update.max_concurrent {
        sqlx::query(
            "UPDATE compute_providers SET max_concurrent = $1, updated_at = now() WHERE id = $2",
        )
        .bind(max_concurrent)
        .bind(provider_id)
        .execute(db)
        .await?;
    }
    if let Some(vram_mb) = update.vram_mb {
        sqlx::query(
            "UPDATE compute_providers SET vram_mb = $1, updated_at = now() WHERE id = $2",
        )
        .bind(vram_mb)
        .bind(provider_id)
        .execute(db)
        .await?;
    }

    // If nothing was set, just touch updated_at
    if update.models.is_none() && update.max_concurrent.is_none() && update.vram_mb.is_none() {
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
            let score_a = compute_score(a.reputation, a.load_ratio, a.price_per_1k_input, max_price);
            let score_b = compute_score(b.reputation, b.load_ratio, b.price_per_1k_input, max_price);
            score_a.partial_cmp(&score_b).unwrap_or(std::cmp::Ordering::Equal)
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
// 9. create_escrow
// =========================================================================

/// Hold funds in escrow before dispatching inference. Verifies the user's
/// daily spending limit can absorb the estimated cost.
pub async fn create_escrow(
    db: &PgPool,
    user_id: Uuid,
    provider_id: Uuid,
    estimated_cost_usdc: i64,
) -> Result<Uuid, CloudError> {
    // Fetch user's daily spending limit
    let spending_limit: Option<i64> = sqlx::query_scalar(
        "SELECT spending_limit_daily_usdc FROM user_wallets WHERE user_id = $1",
    )
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
        %user_id,
        %provider_id,
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
    escrow_id: Uuid,
    actual_input_tokens: i64,
    actual_output_tokens: i64,
    price_per_1k_input: u64,
    price_per_1k_output: u64,
) -> Result<EscrowSettlement, CloudError> {
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
    .execute(db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(CloudError::NotFound(
            "escrow not found or already resolved".to_string(),
        ));
    }

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
pub async fn expire_stale_escrows(
    db: &PgPool,
    max_age_secs: u64,
) -> Result<u64, CloudError> {
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

    // Update provider aggregate stats
    sqlx::query(
        r#"
        UPDATE compute_providers
        SET total_requests = total_requests + 1,
            total_tokens_served = total_tokens_served + $1,
            updated_at = now()
        WHERE id = (SELECT provider_id FROM compute_jobs WHERE id = $2)
        "#,
    )
    .bind(input_tokens + output_tokens)
    .bind(job_id)
    .execute(db)
    .await?;

    Ok(())
}

// =========================================================================
// 15. fail_job
// =========================================================================

pub async fn fail_job(
    db: &PgPool,
    job_id: Uuid,
    error_message: &str,
) -> Result<(), CloudError> {
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

    // Increment total_requests even on failure (for success_rate calc)
    sqlx::query(
        r#"
        UPDATE compute_providers
        SET total_requests = total_requests + 1,
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
        .map_err(|e| {
            CloudError::ServiceUnavailable(format!("relay request failed: {e}"))
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(CloudError::ServiceUnavailable(format!(
            "relay returned {status}: {text}"
        )));
    }

    let latency_ms = start.elapsed().as_millis() as u64;

    let result: serde_json::Value = resp.json().await.map_err(|e| {
        CloudError::Internal(format!("failed to parse relay response: {e}"))
    })?;

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
        .map_err(|e| {
            CloudError::ServiceUnavailable(format!("relay stream request failed: {e}"))
        })?;

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
        .map(|(stat_date, total, success, failed, tokens, earned, latency)| DailyStats {
            stat_date,
            requests_total: total,
            requests_success: success,
            requests_failed: failed,
            tokens_served: tokens,
            earned_usdc: earned,
            avg_latency_ms: latency,
        })
        .collect())
}

// =========================================================================
// 22. get_active_escrows
// =========================================================================

pub async fn get_active_escrows(
    db: &PgPool,
    user_id: Uuid,
) -> Result<Vec<EscrowInfo>, CloudError> {
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
        .map(|(id, relay_pubkey, display_name, models, reputation, max_concurrent)| {
            CommunityProviderInfo {
                provider_id: id,
                relay_pubkey,
                display_name,
                models,
                reputation_score: reputation,
                current_load: 0, // reset on refresh; heartbeats update this
                max_concurrent,
            }
        })
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
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(24 * 3600));
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
