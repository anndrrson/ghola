//! Meter-on-success writes to `metered_usage` and append-only logs to
//! `gateway_call_logs`.
//!
//! The #1 architectural invariant: **the merchant is only paid if the
//! upstream call actually succeeded.** A timeout, a 5xx, a refused
//! connection — none of these result in `metered_usage` rows, and the
//! caller gets an x402 refund header telling their client to void the
//! inbound payment. This is what makes agents trust paying through the
//! gateway instead of building a blocklist.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

/// Append to `gateway_call_logs`. Never charges anything — that's
/// [`record_metered_usage`]'s job.
#[allow(clippy::too_many_arguments)]
pub async fn record_call_log(
    db: &PgPool,
    service_id: Uuid,
    caller_agent_did: Option<&str>,
    caller_user_id: Option<Uuid>,
    method: &str,
    path: &str,
    upstream_status: Option<i32>,
    gateway_status: i32,
    latency_ms: i32,
    bytes_in: i64,
    bytes_out: i64,
    amount_charged_micro_usdc: i64,
    payment_status: &str,
    x402_tx_signature: Option<&str>,
    error_reason: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO gateway_call_logs (
            service_listing_id, caller_agent_did, caller_user_id,
            method, path, upstream_status, gateway_status, latency_ms,
            bytes_in, bytes_out, amount_charged_micro_usdc, payment_status,
            x402_tx_signature, error_reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        "#,
    )
    .bind(service_id)
    .bind(caller_agent_did)
    .bind(caller_user_id)
    .bind(method)
    .bind(path)
    .bind(upstream_status)
    .bind(gateway_status)
    .bind(latency_ms)
    .bind(bytes_in)
    .bind(bytes_out)
    .bind(amount_charged_micro_usdc)
    .bind(payment_status)
    .bind(x402_tx_signature)
    .bind(error_reason)
    .execute(db)
    .await?;
    Ok(())
}

/// Write a row to `metered_usage`. ONLY called on successful upstream
/// responses. The hourly settlement loop in said-cloud picks these up and
/// actually moves USDC to the merchant's vault wallet.
pub async fn record_metered_usage(
    db: &PgPool,
    service_id: Uuid,
    agent_did: &str,
    endpoint_name: &str,
    amount_micro_usdc: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO metered_usage (
            service_id, agent_did, endpoint_name, request_count,
            amount_micro_usdc, period_start, settled
        )
        VALUES ($1, $2, $3, 1, $4, date_trunc('hour', NOW()), false)
        "#,
    )
    .bind(service_id)
    .bind(agent_did)
    .bind(endpoint_name)
    .bind(amount_micro_usdc)
    .execute(db)
    .await?;
    Ok(())
}

/// After too many upstream failures in a short window, open the per-merchant
/// circuit breaker so we stop routing calls to a dead origin. Called from the
/// proxy error path.
pub async fn open_circuit_breaker(
    db: &PgPool,
    service_id: Uuid,
    reopen_at: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE service_listings
        SET circuit_breaker_open = true,
            circuit_breaker_until = $2,
            consecutive_failures = consecutive_failures + 1
        WHERE id = $1
        "#,
    )
    .bind(service_id)
    .bind(reopen_at)
    .execute(db)
    .await?;
    Ok(())
}

/// Reset the circuit breaker after a successful call. Keeps merchants that
/// had a brief blip from staying offline longer than necessary.
pub async fn close_circuit_breaker(db: &PgPool, service_id: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE service_listings
        SET circuit_breaker_open = false,
            circuit_breaker_until = NULL,
            consecutive_failures = 0
        WHERE id = $1 AND (circuit_breaker_open = true OR consecutive_failures > 0)
        "#,
    )
    .bind(service_id)
    .execute(db)
    .await?;
    Ok(())
}
