use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ── Request Types ──

#[derive(Debug, Deserialize)]
pub struct SubscribeRequest {
    pub agent_wallet_id: Uuid,
    pub tier_name: Option<String>,
    pub daily_budget_micro_usdc: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct RecordUsageRequest {
    pub agent_did: String,
    pub endpoint_name: Option<String>,
    pub request_count: Option<i32>,
    pub tokens_consumed: Option<i32>,
    pub amount_micro_usdc: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SubscriptionQuery {
    pub agent_wallet_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct SettlementQuery {
    pub status: Option<String>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UsageSummaryQuery {
    pub period: Option<String>, // "hour", "day", "week", "month"
}

// ── Response Types ──

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SubscriptionResponse {
    pub id: Uuid,
    pub agent_wallet_id: Uuid,
    pub service_id: Uuid,
    pub tier_name: Option<String>,
    pub daily_budget_micro_usdc: Option<i64>,
    pub total_spent_micro_usdc: i64,
    pub requests_today: i32,
    pub active: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SettlementResponse {
    pub id: Uuid,
    pub service_id: Uuid,
    pub period_start: chrono::DateTime<chrono::Utc>,
    pub period_end: chrono::DateTime<chrono::Utc>,
    pub total_requests: i32,
    pub total_micro_usdc: i64,
    pub merchant_share_micro_usdc: i64,
    pub platform_share_micro_usdc: i64,
    pub status: String,
    pub tx_signature: Option<String>,
    pub settled_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

// ── Service API Key Helper ──

fn extract_service_key(headers: &axum::http::HeaderMap) -> Result<String, AppError> {
    headers
        .get("X-Service-Key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Unauthorized("Missing X-Service-Key header".into()))
}

fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

async fn validate_service_key(state: &AppState, key: &str) -> Result<Uuid, AppError> {
    let key_hash = sha256_hex(key);

    let row: Option<(Uuid, bool)> = sqlx::query_as(
        "SELECT service_id, active FROM service_api_keys WHERE key_hash = $1",
    )
    .bind(&key_hash)
    .fetch_optional(&state.db)
    .await?;

    match row {
        Some((service_id, true)) => {
            sqlx::query("UPDATE service_api_keys SET last_used_at = NOW() WHERE key_hash = $1")
                .bind(&key_hash)
                .execute(&state.db)
                .await
                .ok();
            Ok(service_id)
        }
        Some((_, false)) => Err(AppError::Unauthorized("API key is deactivated".into())),
        None => Err(AppError::Unauthorized("Invalid API key".into())),
    }
}

// ── Agent-Facing Handlers (JWT auth) ──

/// POST /v1/services/{id}/subscribe (JWT)
pub async fn subscribe_to_service(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(service_id): Path<Uuid>,
    Json(req): Json<SubscribeRequest>,
) -> AppResult<(StatusCode, Json<SubscriptionResponse>)> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Verify user owns the agent wallet
    let wallet_owner: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM agent_wallets WHERE id = $1 AND active = true",
    )
    .bind(req.agent_wallet_id)
    .fetch_optional(&state.db)
    .await?;

    match wallet_owner {
        None => return Err(AppError::NotFound("Agent wallet not found".into())),
        Some(oid) if oid != user_id => {
            return Err(AppError::Unauthorized("Not your wallet".into()))
        }
        _ => {}
    }

    // Verify service exists and is active
    let service_status: Option<String> = sqlx::query_scalar(
        "SELECT status::text FROM service_listings WHERE id = $1",
    )
    .bind(service_id)
    .fetch_optional(&state.db)
    .await?;

    match service_status.as_deref() {
        None => return Err(AppError::NotFound("Service not found".into())),
        Some("active") => {}
        Some(s) => {
            return Err(AppError::BadRequest(format!(
                "Service is not active (status: {s})"
            )))
        }
    }

    let sub = sqlx::query_as::<_, SubscriptionResponse>(
        r#"INSERT INTO agent_service_subscriptions
            (agent_wallet_id, user_id, service_id, tier_name, daily_budget_micro_usdc)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (agent_wallet_id, service_id) DO UPDATE SET
            tier_name = COALESCE(EXCLUDED.tier_name, agent_service_subscriptions.tier_name),
            daily_budget_micro_usdc = COALESCE(EXCLUDED.daily_budget_micro_usdc, agent_service_subscriptions.daily_budget_micro_usdc),
            active = true
        RETURNING *"#,
    )
    .bind(req.agent_wallet_id)
    .bind(user_id)
    .bind(service_id)
    .bind(&req.tier_name)
    .bind(req.daily_budget_micro_usdc)
    .fetch_one(&state.db)
    .await
    .map_err(AppError::from)?;

    Ok((StatusCode::CREATED, Json(sub)))
}

/// GET /v1/services/subscriptions (JWT)
pub async fn list_subscriptions(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<SubscriptionQuery>,
) -> AppResult<Json<Vec<SubscriptionResponse>>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let subs = if let Some(wallet_id) = params.agent_wallet_id {
        sqlx::query_as::<_, SubscriptionResponse>(
            "SELECT * FROM agent_service_subscriptions WHERE user_id = $1 AND agent_wallet_id = $2 ORDER BY created_at DESC",
        )
        .bind(user_id)
        .bind(wallet_id)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, SubscriptionResponse>(
            "SELECT * FROM agent_service_subscriptions WHERE user_id = $1 ORDER BY created_at DESC",
        )
        .bind(user_id)
        .fetch_all(&state.db)
        .await?
    };

    Ok(Json(subs))
}

/// DELETE /v1/services/{id}/unsubscribe (JWT)
pub async fn unsubscribe(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(service_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let result = sqlx::query(
        "UPDATE agent_service_subscriptions SET active = false WHERE service_id = $1 AND user_id = $2",
    )
    .bind(service_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Subscription not found".into()));
    }

    Ok(StatusCode::NO_CONTENT)
}

// ── Merchant-Facing Handlers (Service API Key auth) ──

/// POST /v1/meter (service API key)
/// Core billing-as-a-service: merchants call this after serving a request.
pub async fn record_usage(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<RecordUsageRequest>,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    let service_key = extract_service_key(&headers)?;
    let service_id = validate_service_key(&state, &service_key).await?;

    // Rate limit: 1000 req/min per service key
    let rate_key = format!("svc_meter:{}", service_id);
    if let Err(retry_after) = state.rate_limiter.check(&rate_key, 1000) {
        return Err(AppError::TooManyRequests(retry_after));
    }

    // Calculate amount if not explicitly provided
    let amount = if let Some(amt) = req.amount_micro_usdc {
        amt
    } else {
        // Look up service pricing
        let price: i64 = sqlx::query_scalar(
            "SELECT price_micro_usdc FROM service_listings WHERE id = $1",
        )
        .bind(service_id)
        .fetch_optional(&state.db)
        .await?
        .unwrap_or(0);

        price * req.request_count.unwrap_or(1) as i64
    };

    // Check agent's subscription and spending limits
    let sub: Option<(Uuid, Option<i64>, i64, i32, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as(
            r#"SELECT id, daily_budget_micro_usdc, total_spent_micro_usdc, requests_today, requests_reset_at
            FROM agent_service_subscriptions
            WHERE service_id = $1 AND active = true
                AND agent_wallet_id IN (
                    SELECT aw.id FROM agent_wallets aw
                    JOIN users u ON u.id = aw.user_id
                    WHERE (SELECT did FROM public_profiles WHERE user_id = u.id) = $2
                       OR (SELECT did FROM business_profiles WHERE user_id = u.id) = $2
                )
            LIMIT 1"#,
        )
        .bind(service_id)
        .bind(&req.agent_did)
        .fetch_optional(&state.db)
        .await?;

    if let Some((sub_id, daily_budget, _total_spent, requests_today, reset_at)) = &sub {
        // Reset daily counters if needed
        let now = chrono::Utc::now();
        let today_start = now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc();

        let (effective_requests, needs_reset) = if *reset_at < today_start {
            (0, true)
        } else {
            (*requests_today, false)
        };

        if needs_reset {
            sqlx::query(
                "UPDATE agent_service_subscriptions SET requests_today = 0, requests_reset_at = $1 WHERE id = $2",
            )
            .bind(today_start)
            .bind(sub_id)
            .execute(&state.db)
            .await?;
        }

        // Check daily budget
        if let Some(budget) = daily_budget {
            // Approximate daily spend from today's requests * avg price
            let today_spent = effective_requests as i64 * (amount / req.request_count.unwrap_or(1) as i64).max(1);
            if today_spent + amount > *budget {
                return Err(AppError::BadRequest(
                    "Agent daily budget exceeded for this service".into(),
                ));
            }
        }

        // Update subscription counters
        sqlx::query(
            r#"UPDATE agent_service_subscriptions SET
                requests_today = requests_today + $1,
                total_spent_micro_usdc = total_spent_micro_usdc + $2
            WHERE id = $3"#,
        )
        .bind(req.request_count.unwrap_or(1))
        .bind(amount)
        .bind(sub_id)
        .execute(&state.db)
        .await?;
    }

    // Find agent wallet ID if available
    let agent_wallet_id: Option<Uuid> = sqlx::query_scalar(
        r#"SELECT aw.id FROM agent_wallets aw
        JOIN users u ON u.id = aw.user_id
        WHERE (SELECT did FROM public_profiles WHERE user_id = u.id) = $1
           OR (SELECT did FROM business_profiles WHERE user_id = u.id) = $1
        LIMIT 1"#,
    )
    .bind(&req.agent_did)
    .fetch_optional(&state.db)
    .await?;

    // Insert metered usage record
    sqlx::query(
        r#"INSERT INTO metered_usage
            (service_id, agent_did, agent_wallet_id, endpoint_name, request_count, tokens_consumed, amount_micro_usdc)
        VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
    )
    .bind(service_id)
    .bind(&req.agent_did)
    .bind(agent_wallet_id)
    .bind(&req.endpoint_name)
    .bind(req.request_count.unwrap_or(1))
    .bind(req.tokens_consumed)
    .bind(amount)
    .execute(&state.db)
    .await?;

    // Update service total_requests
    sqlx::query(
        "UPDATE service_listings SET total_requests = total_requests + $1 WHERE id = $2",
    )
    .bind(req.request_count.unwrap_or(1) as i64)
    .bind(service_id)
    .execute(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({
            "metered": true,
            "amount_micro_usdc": amount,
            "service_id": service_id,
        })),
    ))
}

/// GET /v1/meter/summary/{service_id} (service API key)
pub async fn usage_summary(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(service_id): Path<Uuid>,
    Query(params): Query<UsageSummaryQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let service_key = extract_service_key(&headers)?;
    let authed_service_id = validate_service_key(&state, &service_key).await?;

    if authed_service_id != service_id {
        return Err(AppError::Unauthorized(
            "API key does not match this service".into(),
        ));
    }

    let interval = match params.period.as_deref() {
        Some("hour") => "1 hour",
        Some("day") | None => "1 day",
        Some("week") => "7 days",
        Some("month") => "30 days",
        _ => "1 day",
    };

    let query = format!(
        r#"SELECT
            COUNT(*) as total_requests,
            COALESCE(SUM(request_count), 0) as total_api_calls,
            COALESCE(SUM(amount_micro_usdc), 0) as total_amount,
            COUNT(DISTINCT agent_did) as unique_agents,
            COALESCE(SUM(tokens_consumed), 0) as total_tokens
        FROM metered_usage
        WHERE service_id = $1 AND created_at > NOW() - INTERVAL '{interval}'"#,
    );

    let row: (i64, i64, i64, i64, i64) = sqlx::query_as(&query)
        .bind(service_id)
        .fetch_one(&state.db)
        .await?;

    // Top agents by spend
    let top_agents: Vec<serde_json::Value> = sqlx::query_scalar(
        &format!(
            r#"SELECT json_build_object(
                'agent_did', agent_did,
                'total_requests', SUM(request_count),
                'total_amount', SUM(amount_micro_usdc)
            )
            FROM metered_usage
            WHERE service_id = $1 AND created_at > NOW() - INTERVAL '{interval}'
            GROUP BY agent_did
            ORDER BY SUM(amount_micro_usdc) DESC
            LIMIT 10"#,
        ),
    )
    .bind(service_id)
    .fetch_all(&state.db)
    .await?;

    // Unsettled amount
    let unsettled: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount_micro_usdc), 0) FROM metered_usage WHERE service_id = $1 AND settled = false",
    )
    .bind(service_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "service_id": service_id,
        "period": params.period.as_deref().unwrap_or("day"),
        "total_records": row.0,
        "total_api_calls": row.1,
        "total_amount_micro_usdc": row.2,
        "unique_agents": row.3,
        "total_tokens_consumed": row.4,
        "unsettled_micro_usdc": unsettled,
        "top_agents": top_agents,
    })))
}

/// GET /v1/settlements/{service_id} (service API key)
pub async fn list_settlements(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(service_id): Path<Uuid>,
    Query(params): Query<SettlementQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let service_key = extract_service_key(&headers)?;
    let authed_service_id = validate_service_key(&state, &service_key).await?;

    if authed_service_id != service_id {
        return Err(AppError::Unauthorized(
            "API key does not match this service".into(),
        ));
    }

    let page = params.page.unwrap_or(1).max(1);
    let limit = params.limit.unwrap_or(20).min(100);
    let offset = (page - 1) * limit;

    let settlements = sqlx::query_as::<_, SettlementResponse>(
        r#"SELECT id, service_id, period_start, period_end, total_requests,
                  total_micro_usdc, merchant_share_micro_usdc, platform_share_micro_usdc,
                  status, tx_signature, settled_at, created_at
        FROM settlement_batches
        WHERE service_id = $1
            AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4"#,
    )
    .bind(service_id)
    .bind(params.status.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "settlements": settlements,
        "page": page,
        "limit": limit,
    })))
}

// ── Settlement Background Task ──

/// Runs on the global default interval (3600 s) and dispatches per-tenant
/// settlement runs with their own configurable intervals and RPC failover.
pub async fn settlement_loop(state: Arc<AppState>) {
    // Global tick: every 60 s, check which tenants are due for settlement.
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        interval.tick().await;

        // Collect tenant settlement configs.
        #[derive(sqlx::FromRow)]
        struct TenantCfg {
            id: Option<Uuid>,  // NULL = "global" (no tenant)
            settlement_interval_secs: i32,
            fallback_rpc_urls: Vec<String>,
        }

        let tenants: Vec<TenantCfg> = sqlx::query_as(
            r#"SELECT id,
                      settlement_interval_secs,
                      fallback_rpc_urls
               FROM tenants
               UNION ALL
               -- Always include a "global" row for services without a tenant
               SELECT NULL::uuid, 3600, ARRAY[]::text[]"#,
        )
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();

        let now_ts = chrono::Utc::now().timestamp();

        for cfg in tenants {
            // Check if this tenant's settlement interval has elapsed since the
            // last settlement batch.
            let last_settled: Option<i64> = sqlx::query_scalar(
                r#"SELECT EXTRACT(EPOCH FROM MAX(created_at))::bigint
                   FROM settlement_batches sb
                   JOIN service_listings sl ON sl.id = sb.service_id
                   WHERE ($1::uuid IS NULL AND sl.owner_did NOT IN (
                             SELECT did FROM business_profiles WHERE user_id IN (
                                 SELECT user_id FROM tenant_members
                             )
                         ))
                      OR EXISTS (
                             SELECT 1 FROM tenant_members tm
                             JOIN users u ON u.id = tm.user_id
                             JOIN business_profiles bp ON bp.user_id = u.id
                             WHERE bp.did = sl.owner_did AND tm.tenant_id = $1
                         )"#,
            )
            .bind(cfg.id)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None)
            .flatten();

            let elapsed = now_ts - last_settled.unwrap_or(0);
            if elapsed < cfg.settlement_interval_secs as i64 {
                continue;
            }

            // Determine which RPC URL to use (with failover).
            let rpc_url = pick_healthy_rpc(&state, &cfg.fallback_rpc_urls).await;

            if let Err(e) = process_settlements(&state, cfg.id, rpc_url.as_deref()).await {
                tracing::error!(tenant_id = ?cfg.id, "Settlement processing error: {e}");
            }
        }
    }
}

/// Select the first healthy RPC URL from the fallback list.
/// Falls back to `None` (caller uses on-chain defaults) if none are healthy.
async fn pick_healthy_rpc(state: &AppState, urls: &[String]) -> Option<String> {
    for url in urls {
        // Simple liveness check: HEAD or GET the health probe endpoint.
        let probe_url = format!("{url}");
        let ok = state
            .http_client
            .post(&probe_url)
            .timeout(std::time::Duration::from_secs(3))
            .json(&serde_json::json!({"jsonrpc":"2.0","id":1,"method":"getHealth"}))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);

        if ok {
            return Some(url.clone());
        } else {
            tracing::warn!(rpc_url = %url, "RPC health check failed, trying next fallback");
        }
    }
    None
}

async fn process_settlements(
    state: &AppState,
    tenant_id: Option<Uuid>,
    rpc_url: Option<&str>,
) -> anyhow::Result<()> {
    let now = chrono::Utc::now();
    let period_end = now;
    let period_start = now - chrono::Duration::hours(1);

    // Find all services with unsettled usage scoped to this tenant (or global).
    let services: Vec<(Uuid, i32, Option<String>)> = sqlx::query_as(
        r#"SELECT mu.service_id,
                  COALESCE(sl.platform_fee_bps, 300),
                  sl.owner_did
           FROM metered_usage mu
           JOIN service_listings sl ON sl.id = mu.service_id
           WHERE mu.settled = false
             AND (
                 ($1::uuid IS NULL AND NOT EXISTS (
                     SELECT 1 FROM tenant_members tm
                     JOIN users u ON u.id = tm.user_id
                     JOIN business_profiles bp ON bp.user_id = u.id
                     WHERE bp.did = sl.owner_did
                 ))
                 OR EXISTS (
                     SELECT 1 FROM tenant_members tm
                     JOIN users u ON u.id = tm.user_id
                     JOIN business_profiles bp ON bp.user_id = u.id
                     WHERE bp.did = sl.owner_did AND tm.tenant_id = $1
                 )
             )
           GROUP BY mu.service_id, sl.platform_fee_bps, sl.owner_did
           HAVING SUM(mu.amount_micro_usdc) > 0"#,
    )
    .bind(tenant_id)
    .fetch_all(&state.db)
    .await?;

    let mut settled_count = 0usize;

    for (service_id, fee_bps, owner_did) in services {
        let (total_requests, total_amount): (i64, i64) = sqlx::query_as(
            r#"SELECT COALESCE(SUM(request_count), 0), COALESCE(SUM(amount_micro_usdc), 0)
            FROM metered_usage
            WHERE service_id = $1 AND settled = false"#,
        )
        .bind(service_id)
        .fetch_one(&state.db)
        .await?;

        if total_amount == 0 {
            continue;
        }

        let platform_share = (total_amount * fee_bps as i64) / 10000;
        let merchant_share = total_amount - platform_share;

        let batch_id: (Uuid,) = sqlx::query_as(
            r#"INSERT INTO settlement_batches
                (service_id, period_start, period_end, total_requests, total_micro_usdc,
                 merchant_share_micro_usdc, platform_share_micro_usdc, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
            RETURNING id"#,
        )
        .bind(service_id)
        .bind(period_start)
        .bind(period_end)
        .bind(total_requests as i32)
        .bind(total_amount)
        .bind(merchant_share)
        .bind(platform_share)
        .fetch_one(&state.db)
        .await?;

        // Emit settlement receipt notification.
        sqlx::query(
            r#"INSERT INTO settlement_receipts
                (settlement_batch_id, tenant_id, service_id, total_micro_usdc,
                 merchant_share_micro_usdc, platform_share_micro_usdc, rpc_url_used)
               VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        )
        .bind(batch_id.0)
        .bind(tenant_id)
        .bind(service_id)
        .bind(total_amount)
        .bind(merchant_share)
        .bind(platform_share)
        .bind(rpc_url)
        .execute(&state.db)
        .await
        .ok();

        sqlx::query(
            "UPDATE metered_usage SET settled = true WHERE service_id = $1 AND settled = false",
        )
        .bind(service_id)
        .execute(&state.db)
        .await?;

        sqlx::query(
            "UPDATE service_listings SET total_revenue_micro_usdc = total_revenue_micro_usdc + $1 WHERE id = $2",
        )
        .bind(merchant_share)
        .bind(service_id)
        .execute(&state.db)
        .await?;

        if let Some(did) = &owner_did {
            sqlx::query(
                r#"INSERT INTO reputation_events (entity_did, event_type, details)
                VALUES ($1, 'transaction_completed', $2)"#,
            )
            .bind(did)
            .bind(serde_json::json!({
                "settlement_amount": total_amount,
                "merchant_share": merchant_share,
                "requests": total_requests,
            }))
            .execute(&state.db)
            .await
            .ok();
        }

        // Emit audit event for the settlement.
        super::audit::emit(
            &state.db,
            tenant_id,
            owner_did.as_deref().unwrap_or("system"),
            None,
            "settlement_completed",
            Some("service"),
            Some(&service_id.to_string()),
            serde_json::json!({
                "total_amount": total_amount,
                "merchant_share": merchant_share,
                "requests": total_requests,
                "rpc_url": rpc_url,
            }),
        )
        .await;

        settled_count += 1;
        tracing::info!(
            tenant_id = ?tenant_id,
            service_id = %service_id,
            total_requests,
            total_amount,
            "Settlement created"
        );
    }

    if settled_count > 0 {
        tracing::info!(
            tenant_id = ?tenant_id,
            count = settled_count,
            "Settlement run completed"
        );
    }

    Ok(())
}
