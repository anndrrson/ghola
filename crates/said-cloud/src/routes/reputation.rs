use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ── Response Types ──

#[derive(Debug, Serialize)]
pub struct ReputationResponse {
    pub entity_did: String,
    pub entity_type: String,
    pub overall_score: f32,
    pub confidence: f32,
    pub components: ReputationComponents,
    pub summary: ReputationSummary,
    pub computed_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
pub struct ReputationComponents {
    pub identity: f32,
    pub transaction: f32,
    pub quality: f32,
    pub reliability: f32,
    pub history: f32,
}

#[derive(Debug, Serialize)]
pub struct ReputationSummary {
    pub total_transactions: i32,
    pub completed_transactions: i32,
    pub disputed_transactions: i32,
    pub completion_rate: f32,
    pub dispute_rate: f32,
    pub total_volume_micro_usdc: i64,
    pub avg_review_rating: Option<f32>,
    pub review_count: i32,
    pub account_age_days: i32,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ReputationEventResponse {
    pub id: uuid::Uuid,
    pub event_type: String,
    pub counterparty_did: Option<String>,
    pub details: Option<serde_json::Value>,
    pub score_delta: Option<f32>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    pub page: Option<i64>,
    pub limit: Option<i64>,
    pub event_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RecordEventRequest {
    pub entity_did: String,
    pub event_type: String,
    pub counterparty_did: Option<String>,
    pub details: Option<serde_json::Value>,
}

// ── DB Row ──

#[derive(Debug, sqlx::FromRow)]
struct DbReputationScore {
    entity_did: String,
    entity_type: String,
    identity_score: f32,
    transaction_score: f32,
    quality_score: f32,
    reliability_score: f32,
    history_score: f32,
    overall_score: f32,
    confidence: f32,
    total_transactions: i32,
    completed_transactions: i32,
    disputed_transactions: i32,
    total_volume_micro_usdc: i64,
    avg_review_rating: Option<f32>,
    review_count: i32,
    account_age_days: i32,
    computed_at: chrono::DateTime<chrono::Utc>,
}

// ── Handlers ──

/// GET /v1/reputation/{did} (public)
pub async fn get_reputation(
    State(state): State<Arc<AppState>>,
    Path(did): Path<String>,
) -> AppResult<Json<ReputationResponse>> {
    let row = sqlx::query_as::<_, DbReputationScore>(
        r#"SELECT entity_did, entity_type, identity_score, transaction_score,
                  quality_score, reliability_score, history_score,
                  overall_score, confidence,
                  total_transactions, completed_transactions, disputed_transactions,
                  total_volume_micro_usdc, avg_review_rating, review_count,
                  account_age_days, computed_at
        FROM reputation_scores WHERE entity_did = $1"#,
    )
    .bind(&did)
    .fetch_optional(&state.db)
    .await?;

    match row {
        Some(r) => {
            let total = r.total_transactions.max(1) as f32;
            Ok(Json(ReputationResponse {
                entity_did: r.entity_did,
                entity_type: r.entity_type,
                overall_score: r.overall_score,
                confidence: r.confidence,
                components: ReputationComponents {
                    identity: r.identity_score,
                    transaction: r.transaction_score,
                    quality: r.quality_score,
                    reliability: r.reliability_score,
                    history: r.history_score,
                },
                summary: ReputationSummary {
                    total_transactions: r.total_transactions,
                    completed_transactions: r.completed_transactions,
                    disputed_transactions: r.disputed_transactions,
                    completion_rate: r.completed_transactions as f32 / total,
                    dispute_rate: r.disputed_transactions as f32 / total,
                    total_volume_micro_usdc: r.total_volume_micro_usdc,
                    avg_review_rating: r.avg_review_rating,
                    review_count: r.review_count,
                    account_age_days: r.account_age_days,
                },
                computed_at: r.computed_at,
            }))
        }
        None => {
            // No reputation record yet — return zeroed response
            Ok(Json(ReputationResponse {
                entity_did: did,
                entity_type: "unknown".into(),
                overall_score: 0.0,
                confidence: 0.0,
                components: ReputationComponents {
                    identity: 0.0,
                    transaction: 0.0,
                    quality: 0.0,
                    reliability: 0.0,
                    history: 0.0,
                },
                summary: ReputationSummary {
                    total_transactions: 0,
                    completed_transactions: 0,
                    disputed_transactions: 0,
                    completion_rate: 0.0,
                    dispute_rate: 0.0,
                    total_volume_micro_usdc: 0,
                    avg_review_rating: None,
                    review_count: 0,
                    account_age_days: 0,
                },
                computed_at: chrono::Utc::now(),
            }))
        }
    }
}

/// GET /v1/reputation/{did}/history (public)
pub async fn get_reputation_history(
    State(state): State<Arc<AppState>>,
    Path(did): Path<String>,
    Query(params): Query<HistoryQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let page = params.page.unwrap_or(1).max(1);
    let limit = params.limit.unwrap_or(50).min(200);
    let offset = (page - 1) * limit;

    let events = sqlx::query_as::<_, ReputationEventResponse>(
        r#"SELECT id, event_type, counterparty_did, details, score_delta, created_at
        FROM reputation_events
        WHERE entity_did = $1
            AND ($2::text IS NULL OR event_type = $2)
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4"#,
    )
    .bind(&did)
    .bind(params.event_type.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM reputation_events
        WHERE entity_did = $1
            AND ($2::text IS NULL OR event_type = $2)"#,
    )
    .bind(&did)
    .bind(params.event_type.as_deref())
    .fetch_one(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "events": events,
        "total": total,
        "page": page,
        "limit": limit,
    })))
}

/// POST /v1/reputation/event (service API key auth)
pub async fn record_reputation_event(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<RecordEventRequest>,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    // Validate service API key
    let service_key = headers
        .get("X-Service-Key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("Missing X-Service-Key header".into()))?;

    let key_hash = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(service_key.as_bytes());
        hex::encode(hasher.finalize())
    };

    let key_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM service_api_keys WHERE key_hash = $1 AND active = true)",
    )
    .bind(&key_hash)
    .fetch_one(&state.db)
    .await?;

    if !key_exists {
        return Err(AppError::Unauthorized("Invalid API key".into()));
    }

    // Validate event type
    let valid_types = [
        "transaction_completed",
        "transaction_disputed",
        "review_received",
        "sla_met",
        "sla_violated",
        "badge_granted",
        "service_registered",
    ];
    if !valid_types.contains(&req.event_type.as_str()) {
        return Err(AppError::BadRequest(format!(
            "Invalid event_type. Must be one of: {}",
            valid_types.join(", ")
        )));
    }

    // Insert event
    let id: uuid::Uuid = sqlx::query_scalar(
        r#"INSERT INTO reputation_events (entity_did, event_type, counterparty_did, details)
        VALUES ($1, $2, $3, $4)
        RETURNING id"#,
    )
    .bind(&req.entity_did)
    .bind(&req.event_type)
    .bind(&req.counterparty_did)
    .bind(&req.details)
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "id": id, "status": "recorded" })),
    ))
}

// ── Background Recomputation ──

/// Runs every 5 minutes, recomputes reputation scores for entities with recent events.
pub async fn recompute_loop(state: Arc<AppState>) {
    let interval = std::time::Duration::from_secs(300); // 5 minutes

    loop {
        tokio::time::sleep(interval).await;

        if let Err(e) = recompute_scores(&state).await {
            tracing::error!("Reputation recompute error: {e}");
        }
    }
}

async fn recompute_scores(state: &AppState) -> anyhow::Result<()> {
    // Find all unique entity DIDs with events in the last 10 minutes,
    // plus any DIDs that have never been computed
    let dids: Vec<String> = sqlx::query_scalar(
        r#"SELECT DISTINCT entity_did FROM reputation_events
        WHERE created_at > NOW() - INTERVAL '10 minutes'
        UNION
        SELECT entity_did FROM reputation_scores
        WHERE computed_at < NOW() - INTERVAL '1 hour'
        LIMIT 500"#,
    )
    .fetch_all(&state.db)
    .await?;

    for did in &dids {
        if let Err(e) = recompute_single(state, did).await {
            tracing::warn!("Failed to recompute reputation for {did}: {e}");
        }
    }

    // Also bootstrap reputation for entities that have profiles but no reputation_scores entry
    bootstrap_new_entities(state).await?;

    Ok(())
}

async fn bootstrap_new_entities(state: &AppState) -> anyhow::Result<()> {
    // Business profiles without reputation scores
    let biz_dids: Vec<String> = sqlx::query_scalar(
        r#"SELECT bp.did FROM business_profiles bp
        LEFT JOIN reputation_scores rs ON rs.entity_did = bp.did
        WHERE rs.id IS NULL
        LIMIT 100"#,
    )
    .fetch_all(&state.db)
    .await?;

    for did in &biz_dids {
        if let Err(e) = recompute_single(state, did).await {
            tracing::warn!("Failed to bootstrap reputation for business {did}: {e}");
        }
    }

    // Consumer profiles without reputation scores
    let consumer_dids: Vec<String> = sqlx::query_scalar(
        r#"SELECT pp.did FROM public_profiles pp
        LEFT JOIN reputation_scores rs ON rs.entity_did = pp.did
        WHERE rs.id IS NULL
        LIMIT 100"#,
    )
    .fetch_all(&state.db)
    .await?;

    for did in &consumer_dids {
        if let Err(e) = recompute_single(state, did).await {
            tracing::warn!("Failed to bootstrap reputation for consumer {did}: {e}");
        }
    }

    Ok(())
}

async fn recompute_single(state: &AppState, did: &str) -> anyhow::Result<()> {
    // Determine entity type
    let is_business: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM business_profiles WHERE did = $1)",
    )
    .bind(did)
    .fetch_one(&state.db)
    .await?;

    let is_consumer: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM public_profiles WHERE did = $1)",
    )
    .bind(did)
    .fetch_one(&state.db)
    .await?;

    let entity_type = if is_business {
        "business"
    } else if is_consumer {
        "consumer"
    } else {
        "unknown"
    };

    // ── Identity Score (0.0 - 1.0) ──
    let has_profile = is_business || is_consumer;
    let on_chain: bool = if is_consumer {
        sqlx::query_scalar(
            "SELECT COALESCE(on_chain_registered, false) FROM public_profiles WHERE did = $1",
        )
        .bind(did)
        .fetch_optional(&state.db)
        .await?
        .unwrap_or(false)
    } else {
        false
    };

    let has_verified_badge: bool = sqlx::query_scalar(
        r#"SELECT EXISTS(
            SELECT 1 FROM verified_badges vb
            JOIN business_profiles bp ON bp.id = vb.profile_id
            WHERE bp.did = $1 AND vb.expires_at > NOW()
        )"#,
    )
    .bind(did)
    .fetch_one(&state.db)
    .await?;

    let has_verified_domain: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM business_profiles WHERE did = $1 AND verified_domain IS NOT NULL)",
    )
    .bind(did)
    .fetch_one(&state.db)
    .await?;

    let identity_score: f32 = {
        let mut s = 0.0f32;
        if has_profile {
            s += 0.3;
        }
        if on_chain {
            s += 0.3;
        }
        if has_verified_badge {
            s += 0.2;
        }
        if has_verified_domain {
            s += 0.2;
        }
        s.min(1.0)
    };

    // ── Transaction Score (0.0 - 1.0) ──
    // Count service_payments where this DID is payer or owner
    let completed_tx: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM service_payments
        WHERE (payer_did = $1 OR service_id IN (SELECT id FROM service_listings WHERE owner_did = $1))
            AND status = 'completed'"#,
    )
    .bind(did)
    .fetch_one(&state.db)
    .await?;

    let disputed_tx: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM reputation_events
        WHERE entity_did = $1 AND event_type = 'transaction_disputed'"#,
    )
    .bind(did)
    .fetch_one(&state.db)
    .await?;

    let total_tx = completed_tx + disputed_tx;
    let completion_rate = if total_tx > 0 {
        completed_tx as f32 / total_tx as f32
    } else {
        0.0
    };

    let transaction_score: f32 = {
        let volume_factor = (completed_tx as f32 / 100.0).min(1.0);
        (volume_factor * 0.5 + completion_rate * 0.5).min(1.0)
    };

    // ── Quality Score (0.0 - 1.0) ──
    // Average review rating across services owned by this DID
    #[derive(sqlx::FromRow)]
    struct ReviewStats {
        avg_rating: Option<f32>,
        count: Option<i64>,
    }

    let review_stats = sqlx::query_as::<_, ReviewStats>(
        r#"SELECT AVG(sr.rating)::REAL as avg_rating, COUNT(*)::BIGINT as count
        FROM service_reviews sr
        JOIN service_listings sl ON sl.id = sr.service_id
        WHERE sl.owner_did = $1"#,
    )
    .bind(did)
    .fetch_optional(&state.db)
    .await?;

    let avg_rating = review_stats.as_ref().and_then(|r| r.avg_rating);
    let review_count = review_stats
        .as_ref()
        .and_then(|r| r.count)
        .unwrap_or(0) as i32;

    let quality_score: f32 = avg_rating.map(|r| r / 5.0).unwrap_or(0.0).min(1.0);

    // ── Reliability Score (0.0 - 1.0) ──
    // For service owners: average uptime of their services
    let avg_uptime: Option<f32> = sqlx::query_scalar(
        "SELECT AVG(uptime_percent)::REAL FROM service_listings WHERE owner_did = $1 AND status::text != 'offline'",
    )
    .bind(did)
    .fetch_optional(&state.db)
    .await?
    .flatten();

    let reliability_score: f32 = avg_uptime.map(|u| u / 100.0).unwrap_or(0.0).min(1.0);

    // ── History Score (0.0 - 1.0) ──
    let account_age_days: f64 = sqlx::query_scalar(
        r#"SELECT EXTRACT(EPOCH FROM (NOW() - LEAST(
            COALESCE((SELECT created_at FROM public_profiles WHERE did = $1), NOW()),
            COALESCE((SELECT created_at FROM business_profiles WHERE did = $1), NOW())
        ))) / 86400.0"#,
    )
    .bind(did)
    .fetch_one(&state.db)
    .await?;

    let history_score: f32 = (account_age_days as f32 / 365.0).min(1.0);

    // ── Overall Score (weighted) ──
    let overall_score: f32 = identity_score * 0.20
        + transaction_score * 0.25
        + quality_score * 0.20
        + reliability_score * 0.20
        + history_score * 0.15;

    // ── Confidence (0.0 - 1.0) ──
    let data_points = (total_tx + review_count as i64 + if has_profile { 1 } else { 0 }) as f32;
    let confidence: f32 = (data_points / 50.0).min(1.0);

    // ── Total volume ──
    let total_volume: i64 = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(amount_micro_usdc), 0) FROM service_payments
        WHERE payer_did = $1 OR service_id IN (SELECT id FROM service_listings WHERE owner_did = $1)"#,
    )
    .bind(did)
    .fetch_one(&state.db)
    .await?;

    // ── Upsert reputation_scores ──
    sqlx::query(
        r#"INSERT INTO reputation_scores (
            entity_did, entity_type,
            identity_score, transaction_score, quality_score, reliability_score, history_score,
            overall_score, confidence,
            total_transactions, completed_transactions, disputed_transactions,
            total_volume_micro_usdc, avg_review_rating, review_count,
            account_age_days, computed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
        ON CONFLICT (entity_did) DO UPDATE SET
            entity_type = EXCLUDED.entity_type,
            identity_score = EXCLUDED.identity_score,
            transaction_score = EXCLUDED.transaction_score,
            quality_score = EXCLUDED.quality_score,
            reliability_score = EXCLUDED.reliability_score,
            history_score = EXCLUDED.history_score,
            overall_score = EXCLUDED.overall_score,
            confidence = EXCLUDED.confidence,
            total_transactions = EXCLUDED.total_transactions,
            completed_transactions = EXCLUDED.completed_transactions,
            disputed_transactions = EXCLUDED.disputed_transactions,
            total_volume_micro_usdc = EXCLUDED.total_volume_micro_usdc,
            avg_review_rating = EXCLUDED.avg_review_rating,
            review_count = EXCLUDED.review_count,
            account_age_days = EXCLUDED.account_age_days,
            computed_at = NOW()"#,
    )
    .bind(did)
    .bind(entity_type)
    .bind(identity_score)
    .bind(transaction_score)
    .bind(quality_score)
    .bind(reliability_score)
    .bind(history_score)
    .bind(overall_score)
    .bind(confidence)
    .bind(total_tx as i32)
    .bind(completed_tx as i32)
    .bind(disputed_tx as i32)
    .bind(total_volume)
    .bind(avg_rating)
    .bind(review_count)
    .bind(account_age_days as i32)
    .execute(&state.db)
    .await?;

    Ok(())
}
