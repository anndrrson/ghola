//! Audit trail — structured, hash-chained event log.
//!
//! Every wallet operation, payment, policy change, circuit-breaker trip, and
//! UCAN delegation emits a structured audit event via `emit()`.  Events form a
//! per-tenant hash chain (SHA-256 over prev_hash || id || event_type ||
//! details || created_at) so any gap or mutation is detectable.
//!
//! REST API:
//!   GET  /v1/audit              — query events (tenant-scoped, auth required)
//!   GET  /v1/audit/export       — export as NDJSON (tenant-scoped)
//!   POST /v1/audit/verify-chain — verify the integrity of a tenant's chain

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ── Public emit helper (used throughout the codebase) ─────────────────────────

/// Append an audit event to the chain.  The hash is computed as:
///   SHA-256( prev_hash || event_id || event_type || details_json || created_at_iso )
/// `prev_hash` is the hash of the most recent event for the same tenant (NULL
/// tenant events share a global chain).
///
/// This function is fire-and-forget; errors are logged but not propagated so
/// that business logic is never blocked by audit failures.
pub async fn emit(
    db: &PgPool,
    tenant_id: Option<Uuid>,
    actor_did: &str,
    actor_user_id: Option<Uuid>,
    event_type: &str,
    resource_type: Option<&str>,
    resource_id: Option<&str>,
    details: serde_json::Value,
) {
    if let Err(e) = emit_inner(
        db,
        tenant_id,
        actor_did,
        actor_user_id,
        event_type,
        resource_type,
        resource_id,
        details,
    )
    .await
    {
        tracing::warn!("audit emit error: {e}");
    }
}

async fn emit_inner(
    db: &PgPool,
    tenant_id: Option<Uuid>,
    actor_did: &str,
    actor_user_id: Option<Uuid>,
    event_type: &str,
    resource_type: Option<&str>,
    resource_id: Option<&str>,
    details: serde_json::Value,
) -> Result<(), sqlx::Error> {
    // Fetch the hash of the previous event for this tenant (or global).
    let prev_hash: Option<String> = sqlx::query_scalar(
        r#"SELECT event_hash FROM audit_events
           WHERE ($1::uuid IS NULL AND tenant_id IS NULL)
              OR tenant_id = $1
           ORDER BY created_at DESC
           LIMIT 1"#,
    )
    .bind(tenant_id)
    .fetch_optional(db)
    .await?;

    // Assign a new UUID now so it can be part of the hash.
    let event_id = Uuid::new_v4();
    let now = chrono::Utc::now();
    let details_str = details.to_string();

    let hash_input = format!(
        "{}{}{}{}{}",
        prev_hash.as_deref().unwrap_or(""),
        event_id,
        event_type,
        details_str,
        now.to_rfc3339(),
    );
    let event_hash = sha256_hex(&hash_input);

    sqlx::query(
        r#"INSERT INTO audit_events
            (id, tenant_id, actor_did, actor_user_id, event_type,
             resource_type, resource_id, details, prev_hash, event_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)"#,
    )
    .bind(event_id)
    .bind(tenant_id)
    .bind(actor_did)
    .bind(actor_user_id)
    .bind(event_type)
    .bind(resource_type)
    .bind(resource_id)
    .bind(&details)
    .bind(&prev_hash)
    .bind(&event_hash)
    .bind(now)
    .execute(db)
    .await?;

    Ok(())
}

fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    hex::encode(h.finalize())
}

// ── Response types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AuditEventResponse {
    pub id: Uuid,
    pub tenant_id: Option<Uuid>,
    pub actor_did: String,
    pub actor_user_id: Option<Uuid>,
    pub event_type: String,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    pub details: serde_json::Value,
    pub prev_hash: Option<String>,
    pub event_hash: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

// ── Query types ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub tenant_id: Option<Uuid>,
    pub event_type: Option<String>,
    pub actor_did: Option<String>,
    pub resource_type: Option<String>,
    pub resource_id: Option<String>,
    pub since: Option<chrono::DateTime<chrono::Utc>>,
    pub until: Option<chrono::DateTime<chrono::Utc>>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct VerifyChainRequest {
    pub tenant_id: Option<Uuid>,
    /// Optional limit on how many events to verify (default 1000).
    pub limit: Option<i64>,
}

// ── Handlers ───────────────────────────────────────────────────────────────────

/// GET /v1/audit — paginated event query (JWT protected)
pub async fn list_events(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<AuditQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // If a tenant_id is specified, verify the caller is a member.
    if let Some(tid) = params.tenant_id {
        let member: Option<(String,)> =
            sqlx::query_as("SELECT role FROM tenant_members WHERE tenant_id = $1 AND user_id = $2")
                .bind(tid)
                .bind(user_id)
                .fetch_optional(&state.db)
                .await?;

        if member.is_none() {
            return Err(AppError::Unauthorized("Not a member of this tenant".into()));
        }
    }

    let page = params.page.unwrap_or(1).max(1);
    let limit = params.limit.unwrap_or(50).clamp(1, 500);
    let offset = (page - 1) * limit;

    let events = sqlx::query_as::<_, AuditEventResponse>(
        r#"SELECT * FROM audit_events
           WHERE ($1::uuid IS NULL OR tenant_id = $1)
             AND ($2::text IS NULL OR event_type = $2)
             AND ($3::text IS NULL OR actor_did = $3)
             AND ($4::text IS NULL OR resource_type = $4)
             AND ($5::text IS NULL OR resource_id = $5)
             AND ($6::timestamptz IS NULL OR created_at >= $6)
             AND ($7::timestamptz IS NULL OR created_at <= $7)
           ORDER BY created_at DESC
           LIMIT $8 OFFSET $9"#,
    )
    .bind(params.tenant_id)
    .bind(&params.event_type)
    .bind(&params.actor_did)
    .bind(&params.resource_type)
    .bind(&params.resource_id)
    .bind(params.since)
    .bind(params.until)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM audit_events
           WHERE ($1::uuid IS NULL OR tenant_id = $1)
             AND ($2::text IS NULL OR event_type = $2)
             AND ($3::text IS NULL OR actor_did = $3)
             AND ($4::text IS NULL OR resource_type = $4)
             AND ($5::text IS NULL OR resource_id = $5)
             AND ($6::timestamptz IS NULL OR created_at >= $6)
             AND ($7::timestamptz IS NULL OR created_at <= $7)"#,
    )
    .bind(params.tenant_id)
    .bind(&params.event_type)
    .bind(&params.actor_did)
    .bind(&params.resource_type)
    .bind(&params.resource_id)
    .bind(params.since)
    .bind(params.until)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "events": events,
        "total": total,
        "page": page,
        "limit": limit,
    })))
}

/// GET /v1/audit/export — NDJSON streaming export (JWT protected)
///
/// Returns one JSON object per line for easy ingestion into SIEM tools.
pub async fn export_events(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<AuditQuery>,
) -> AppResult<impl IntoResponse> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    if let Some(tid) = params.tenant_id {
        let member: Option<(String,)> =
            sqlx::query_as("SELECT role FROM tenant_members WHERE tenant_id = $1 AND user_id = $2")
                .bind(tid)
                .bind(user_id)
                .fetch_optional(&state.db)
                .await?;

        if member.is_none() {
            return Err(AppError::Unauthorized("Not a member of this tenant".into()));
        }
    }

    let limit = params.limit.unwrap_or(10_000).clamp(1, 100_000);

    let events = sqlx::query_as::<_, AuditEventResponse>(
        r#"SELECT * FROM audit_events
           WHERE ($1::uuid IS NULL OR tenant_id = $1)
             AND ($2::text IS NULL OR event_type = $2)
             AND ($3::text IS NULL OR actor_did = $3)
             AND ($4::timestamptz IS NULL OR created_at >= $4)
             AND ($5::timestamptz IS NULL OR created_at <= $5)
           ORDER BY created_at ASC
           LIMIT $6"#,
    )
    .bind(params.tenant_id)
    .bind(&params.event_type)
    .bind(&params.actor_did)
    .bind(params.since)
    .bind(params.until)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    // Build NDJSON body
    let mut body = String::new();
    for e in &events {
        if let Ok(line) = serde_json::to_string(e) {
            body.push_str(&line);
            body.push('\n');
        }
    }

    Ok((
        [
            ("content-type", "application/x-ndjson"),
            (
                "content-disposition",
                "attachment; filename=\"audit_export.ndjson\"",
            ),
        ],
        body,
    ))
}

/// POST /v1/audit/verify-chain — verify hash chain integrity (JWT protected)
pub async fn verify_chain(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<VerifyChainRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    if let Some(tid) = req.tenant_id {
        let member: Option<(String,)> =
            sqlx::query_as("SELECT role FROM tenant_members WHERE tenant_id = $1 AND user_id = $2")
                .bind(tid)
                .bind(user_id)
                .fetch_optional(&state.db)
                .await?;

        if member.is_none() {
            return Err(AppError::Unauthorized("Not a member of this tenant".into()));
        }
    }

    let limit = req.limit.unwrap_or(1000).clamp(1, 10_000);

    #[derive(sqlx::FromRow)]
    struct RawEvent {
        id: Uuid,
        event_type: String,
        details: serde_json::Value,
        prev_hash: Option<String>,
        event_hash: String,
        created_at: chrono::DateTime<chrono::Utc>,
    }

    let events = sqlx::query_as::<_, RawEvent>(
        r#"SELECT id, event_type, details, prev_hash, event_hash, created_at
           FROM audit_events
           WHERE ($1::uuid IS NULL AND tenant_id IS NULL)
              OR tenant_id = $1
           ORDER BY created_at ASC
           LIMIT $2"#,
    )
    .bind(req.tenant_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    let total = events.len();
    let mut invalid_count = 0usize;
    let mut last_hash: Option<String> = None;

    for event in &events {
        let hash_input = format!(
            "{}{}{}{}{}",
            last_hash.as_deref().unwrap_or(""),
            event.id,
            event.event_type,
            event.details,
            event.created_at.to_rfc3339(),
        );
        let expected_hash = sha256_hex(&hash_input);

        if expected_hash != event.event_hash {
            invalid_count += 1;
        }

        // Check prev_hash pointer consistency
        if event.prev_hash != last_hash {
            invalid_count += 1;
        }

        last_hash = Some(event.event_hash.clone());
    }

    Ok(Json(serde_json::json!({
        "tenant_id": req.tenant_id,
        "events_checked": total,
        "chain_valid": invalid_count == 0,
        "invalid_events": invalid_count,
    })))
}
