use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

// =========================================================================
// Types
// =========================================================================

#[derive(Serialize)]
pub struct MarketplaceTask {
    pub id: Uuid,
    pub task_type: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: String,
    pub params: serde_json::Value,
    pub bounty_usdc: Option<i64>,
    pub funder_id: Uuid,
    pub executor_id: Option<Uuid>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub claim_expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    // Identity fields (populated separately)
    pub funder_name: Option<String>,
    pub funder_reputation: Option<f64>,
    pub funder_verified: Option<bool>,
    pub funder_bounties_funded: Option<i32>,
    pub min_reputation: Option<f64>,
}

type TaskRow12 = (
    Uuid,
    String,
    Option<String>,
    Option<String>,
    String,
    serde_json::Value,
    Option<i64>,
    Uuid,
    Option<Uuid>,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    DateTime<Utc>,
);

type IdentityRow = (Option<String>, Option<f64>, Option<bool>, Option<i32>);

fn marketplace_from_row(
    r: TaskRow12,
    identity: Option<IdentityRow>,
    min_rep: Option<f64>,
) -> MarketplaceTask {
    let (fname, frep, fverified, ffunded) = identity.unwrap_or((None, None, None, None));
    MarketplaceTask {
        id: r.0,
        task_type: r.1,
        title: r.2,
        description: r.3,
        status: r.4,
        params: r.5,
        bounty_usdc: r.6,
        funder_id: r.7,
        executor_id: r.8,
        claimed_at: r.9,
        claim_expires_at: r.10,
        created_at: r.11,
        funder_name: fname,
        funder_reputation: frep,
        funder_verified: fverified,
        funder_bounties_funded: ffunded,
        min_reputation: min_rep,
    }
}

const MARKETPLACE_SELECT: &str = "id, task_type, title, description, status, params, bounty_usdc, \
     user_id, executor_id, claimed_at, claim_expires_at, created_at";

// =========================================================================
// Browse
// =========================================================================

#[derive(Deserialize)]
pub struct MarketplaceQuery {
    pub task_type: Option<String>,
    pub min_bounty: Option<i64>,
    pub max_bounty: Option<i64>,
    pub sort: Option<String>, // bounty_desc, bounty_asc, newest (default)
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Fetch funder identity for a single user_id.
async fn fetch_identity(db: &sqlx::PgPool, user_id: Uuid) -> Option<IdentityRow> {
    sqlx::query_as::<_, IdentityRow>(
        "SELECT display_name, reputation_score, verified, bounties_funded FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
}

/// Batch-fetch identities for multiple user IDs. Returns a map of user_id -> identity.
async fn fetch_identities_batch(
    db: &sqlx::PgPool,
    user_ids: &[Uuid],
) -> std::collections::HashMap<Uuid, IdentityRow> {
    if user_ids.is_empty() {
        return std::collections::HashMap::new();
    }
    let rows = sqlx::query_as::<_, (Uuid, Option<String>, Option<f64>, Option<bool>, Option<i32>)>(
        "SELECT id, display_name, reputation_score, verified, bounties_funded FROM users WHERE id = ANY($1)",
    )
    .bind(user_ids)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    rows.into_iter()
        .map(|r| (r.0, (r.1, r.2, r.3, r.4)))
        .collect()
}

/// Fetch min_reputation for a task.
async fn fetch_min_rep(db: &sqlx::PgPool, task_id: Uuid) -> Option<f64> {
    sqlx::query_scalar::<_, Option<f64>>("SELECT min_reputation FROM tasks WHERE id = $1")
        .bind(task_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .flatten()
}

/// GET /api/marketplace/{id} — Get a single marketplace task by ID.
/// Works for any is_open task (public browse, funder, or executor).
pub async fn get_task(
    State(state): State<AppState>,
    Path(task_id): Path<Uuid>,
) -> Result<Json<MarketplaceTask>, CloudError> {
    let row = sqlx::query_as::<_, TaskRow12>(&format!(
        "SELECT {MARKETPLACE_SELECT} FROM tasks WHERE id = $1 AND is_open = true"
    ))
    .bind(task_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("task not found".to_string()))?;

    let identity = fetch_identity(&state.db, row.7).await;
    let min_rep = fetch_min_rep(&state.db, task_id).await;

    Ok(Json(marketplace_from_row(row, identity, min_rep)))
}

/// GET /api/marketplace — Browse open bounty tasks (no auth required).
pub async fn browse(
    State(state): State<AppState>,
    Query(q): Query<MarketplaceQuery>,
) -> Result<Json<Vec<MarketplaceTask>>, CloudError> {
    let limit = q.limit.unwrap_or(20).min(100);
    let offset = q.offset.unwrap_or(0);

    let order = match q.sort.as_deref() {
        Some("bounty_desc") => "bounty_usdc DESC NULLS LAST",
        Some("bounty_asc") => "bounty_usdc ASC NULLS LAST",
        _ => "created_at DESC",
    };

    // Build dynamic WHERE clauses
    let mut conditions = vec![
        "is_open = true".to_string(),
        "status = 'pending'".to_string(),
        "executor_id IS NULL".to_string(),
    ];
    let mut bind_idx = 1u32;
    let mut binds_i64: Vec<i64> = Vec::new();
    let mut bind_str: Option<String> = None;

    if let Some(ref tt) = q.task_type {
        bind_idx += 1;
        conditions.push(format!("task_type = ${bind_idx}"));
        bind_str = Some(tt.clone());
    }
    if let Some(min) = q.min_bounty {
        bind_idx += 1;
        conditions.push(format!("bounty_usdc >= ${bind_idx}"));
        binds_i64.push(min);
    }
    if let Some(max) = q.max_bounty {
        bind_idx += 1;
        conditions.push(format!("bounty_usdc <= ${bind_idx}"));
        binds_i64.push(max);
    }

    let where_clause = conditions.join(" AND ");
    let sql = format!(
        "SELECT {MARKETPLACE_SELECT} FROM tasks WHERE {where_clause} ORDER BY {order} LIMIT {limit} OFFSET {offset}"
    );

    let mut query = sqlx::query_as::<_, TaskRow12>(&sql);

    // Bind in order
    if let Some(ref tt) = bind_str {
        query = query.bind(tt);
    }
    for v in &binds_i64 {
        query = query.bind(*v);
    }

    let rows = query.fetch_all(&state.db).await?;

    // Batch-fetch identities: 1 query instead of N
    let funder_ids: Vec<Uuid> = rows
        .iter()
        .map(|r| r.7)
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let identities = fetch_identities_batch(&state.db, &funder_ids).await;

    // Batch-fetch min_reputation: read directly from the rows via a separate query
    let task_ids: Vec<Uuid> = rows.iter().map(|r| r.0).collect();
    let min_reps: std::collections::HashMap<Uuid, Option<f64>> = if task_ids.is_empty() {
        std::collections::HashMap::new()
    } else {
        sqlx::query_as::<_, (Uuid, Option<f64>)>(
            "SELECT id, min_reputation FROM tasks WHERE id = ANY($1)",
        )
        .bind(&task_ids)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(id, mr)| (id, mr))
        .collect()
    };

    let tasks: Vec<MarketplaceTask> = rows
        .into_iter()
        .map(|r| {
            let identity = identities.get(&r.7).cloned();
            let min_rep = min_reps.get(&r.0).copied().flatten();
            marketplace_from_row(r, identity, min_rep)
        })
        .collect();

    Ok(Json(tasks))
}

// =========================================================================
// Claim
// =========================================================================

#[derive(Serialize)]
pub struct ClaimResponse {
    pub task_id: Uuid,
    pub claimed_at: DateTime<Utc>,
    pub claim_expires_at: DateTime<Utc>,
}

/// POST /api/marketplace/{id}/claim — Executor claims an open task.
pub async fn claim_task(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(task_id): Path<Uuid>,
) -> Result<Json<ClaimResponse>, CloudError> {
    // Check if task has a minimum reputation requirement
    let task_req = sqlx::query_as::<_, (Option<f64>, Uuid)>(
        "SELECT min_reputation, user_id FROM tasks WHERE id = $1 AND is_open = true AND status = 'pending'",
    )
    .bind(task_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloudError::NotFound("task not found or not available".to_string()))?;

    // Prevent self-claim
    if task_req.1 == claims.sub {
        return Err(CloudError::BadRequest(
            "cannot claim your own task".to_string(),
        ));
    }

    // Enforce minimum reputation if set
    if let Some(min_rep) = task_req.0 {
        let user_rep: Option<f64> =
            sqlx::query_scalar("SELECT reputation_score FROM users WHERE id = $1")
                .bind(claims.sub)
                .fetch_optional(&state.db)
                .await?
                .flatten();

        let rep = user_rep.unwrap_or(0.5);
        if rep < min_rep {
            return Err(CloudError::BadRequest(format!(
                "minimum reputation {min_rep:.2} required — yours is {rep:.2}"
            )));
        }
    }

    // Default claim deadline: 24 hours
    let deadline_hours: i64 = 24;

    // Atomically claim: only succeeds if task is open, pending, unclaimed
    let row = sqlx::query_as::<_, (DateTime<Utc>, DateTime<Utc>)>(
        r#"
        UPDATE tasks
        SET executor_id = $1,
            claimed_at = now(),
            claim_expires_at = now() + make_interval(hours => $2),
            status = 'in_progress',
            updated_at = now()
        WHERE id = $3
          AND is_open = true
          AND status = 'pending'
          AND executor_id IS NULL
        RETURNING claimed_at, claim_expires_at
        "#,
    )
    .bind(claims.sub)
    .bind(deadline_hours as f64)
    .bind(task_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        CloudError::BadRequest("task not available — already claimed or not open".to_string())
    })?;

    // Also set executor_id on the bounty
    let _ = sqlx::query(
        "UPDATE task_bounties SET executor_id = $1 WHERE task_id = $2 AND status = 'held'",
    )
    .bind(claims.sub)
    .bind(task_id)
    .execute(&state.db)
    .await;

    tracing::info!(%task_id, executor = %claims.sub, "task claimed");

    Ok(Json(ClaimResponse {
        task_id,
        claimed_at: row.0,
        claim_expires_at: row.1,
    }))
}

// =========================================================================
// Submit
// =========================================================================

#[derive(Deserialize)]
pub struct SubmitRequest {
    pub result: serde_json::Value,
}

/// POST /api/marketplace/{id}/submit — Executor submits completed work.
pub async fn submit_task(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(task_id): Path<Uuid>,
    Json(req): Json<SubmitRequest>,
) -> Result<Json<serde_json::Value>, CloudError> {
    // Verify caller is the assigned executor and task is in_progress
    let result = sqlx::query(
        r#"
        UPDATE tasks
        SET status = 'awaiting_approval',
            result = $1,
            updated_at = now()
        WHERE id = $2
          AND executor_id = $3
          AND status = 'in_progress'
          AND is_open = true
        "#,
    )
    .bind(&req.result)
    .bind(task_id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(CloudError::BadRequest(
            "task not found, not assigned to you, or not in_progress".to_string(),
        ));
    }

    tracing::info!(%task_id, executor = %claims.sub, "task submitted for review");

    Ok(Json(serde_json::json!({
        "task_id": task_id,
        "status": "awaiting_approval",
    })))
}

// =========================================================================
// Release (funder approves and releases bounty)
// =========================================================================

/// POST /api/marketplace/{id}/release — Funder approves work and releases bounty.
pub async fn release_task(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(task_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, CloudError> {
    // Verify caller is the funder (user_id) and task is awaiting_approval
    let row = sqlx::query_as::<_, (Option<Uuid>,)>(
        r#"
        SELECT executor_id FROM tasks
        WHERE id = $1 AND user_id = $2 AND status = 'awaiting_approval' AND is_open = true
        "#,
    )
    .bind(task_id)
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        CloudError::BadRequest("task not found, not yours, or not awaiting approval".to_string())
    })?;

    let executor_id = row
        .0
        .ok_or_else(|| CloudError::Internal("task has no executor assigned".to_string()))?;

    // Mark task completed
    sqlx::query(
        "UPDATE tasks SET status = 'completed', updated_at = now(), completed_at = now() WHERE id = $1",
    )
    .bind(task_id)
    .execute(&state.db)
    .await?;

    // Settle the bounty to the executor
    let settlement =
        crate::services::bounty_service::settle_bounty(&state.db, task_id, executor_id).await?;

    tracing::info!(
        %task_id,
        %executor_id,
        executor_amount = settlement.executor_amount,
        platform_fee = settlement.platform_fee,
        "bounty released to executor"
    );

    Ok(Json(serde_json::json!({
        "task_id": task_id,
        "status": "completed",
        "executor_id": executor_id,
        "executor_amount": settlement.executor_amount,
        "platform_fee": settlement.platform_fee,
    })))
}

// =========================================================================
// Reject (funder rejects submission, task returns to in_progress)
// =========================================================================

#[derive(Deserialize)]
pub struct RejectRequest {
    pub reason: Option<String>,
}

/// POST /api/marketplace/{id}/reject — Funder rejects submission.
pub async fn reject_task(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(task_id): Path<Uuid>,
    Json(req): Json<RejectRequest>,
) -> Result<Json<serde_json::Value>, CloudError> {
    let result = sqlx::query(
        r#"
        UPDATE tasks
        SET status = 'in_progress',
            result = NULL,
            error_message = $1,
            updated_at = now()
        WHERE id = $2 AND user_id = $3 AND status = 'awaiting_approval' AND is_open = true
        "#,
    )
    .bind(req.reason.as_deref().unwrap_or("submission rejected"))
    .bind(task_id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(CloudError::BadRequest(
            "task not found, not yours, or not awaiting approval".to_string(),
        ));
    }

    Ok(Json(serde_json::json!({
        "task_id": task_id,
        "status": "in_progress",
        "message": "submission rejected — executor can resubmit",
    })))
}

// =========================================================================
// Unclaim (executor voluntarily drops a claimed task)
// =========================================================================

/// POST /api/marketplace/{id}/unclaim — Executor drops the task.
pub async fn unclaim_task(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(task_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, CloudError> {
    let result = sqlx::query(
        r#"
        UPDATE tasks
        SET executor_id = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            status = 'pending',
            result = NULL,
            updated_at = now()
        WHERE id = $1 AND executor_id = $2 AND is_open = true
          AND status IN ('in_progress', 'awaiting_approval')
        "#,
    )
    .bind(task_id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(CloudError::BadRequest(
            "task not found or not claimed by you".to_string(),
        ));
    }

    // Clear executor from bounty
    let _ = sqlx::query(
        "UPDATE task_bounties SET executor_id = NULL WHERE task_id = $1 AND status = 'held'",
    )
    .bind(task_id)
    .execute(&state.db)
    .await;

    Ok(Json(serde_json::json!({
        "task_id": task_id,
        "status": "pending",
        "message": "task returned to marketplace",
    })))
}

// =========================================================================
// Claim Expiry (background task)
// =========================================================================

/// Expire stale claims: if claim_expires_at has passed and the task is still
/// in_progress, reset it to pending with no executor.
pub async fn expire_stale_claims(db: &sqlx::PgPool) -> Result<u64, CloudError> {
    let result = sqlx::query(
        r#"
        UPDATE tasks
        SET executor_id = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            status = 'pending',
            result = NULL,
            updated_at = now()
        WHERE is_open = true
          AND status = 'in_progress'
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at < now()
        "#,
    )
    .execute(db)
    .await?;

    let expired = result.rows_affected();

    if expired > 0 {
        tracing::info!(expired, "expired stale marketplace claims");

        // Also clear executor from bounties for those tasks
        let _ = sqlx::query(
            r#"
            UPDATE task_bounties SET executor_id = NULL
            WHERE status = 'held'
              AND task_id IN (
                  SELECT id FROM tasks
                  WHERE is_open = true AND status = 'pending' AND executor_id IS NULL
              )
            "#,
        )
        .execute(db)
        .await;
    }

    Ok(expired)
}

/// Auto-release bounties for tasks stuck in awaiting_approval for >7 days.
/// The funder had their chance to review — executor gets paid.
pub async fn auto_release_stale_approvals(db: &sqlx::PgPool) -> Result<u64, CloudError> {
    // Find tasks awaiting approval for >7 days
    let stale_tasks = sqlx::query_as::<_, (Uuid, Uuid)>(
        r#"
        SELECT id, executor_id FROM tasks
        WHERE is_open = true
          AND status = 'awaiting_approval'
          AND executor_id IS NOT NULL
          AND updated_at < now() - interval '7 days'
        "#,
    )
    .fetch_all(db)
    .await?;

    let count = stale_tasks.len() as u64;

    for (task_id, executor_id) in stale_tasks {
        // Mark completed
        let _ = sqlx::query(
            "UPDATE tasks SET status = 'completed', updated_at = now(), completed_at = now() WHERE id = $1",
        )
        .bind(task_id)
        .execute(db)
        .await;

        // Settle bounty
        if let Err(e) =
            crate::services::bounty_service::settle_bounty(db, task_id, executor_id).await
        {
            tracing::warn!(%task_id, error = %e, "auto-release settlement failed");
        } else {
            tracing::info!(%task_id, %executor_id, "auto-released stale approval — executor paid");
        }
    }

    if count > 0 {
        tracing::info!(count, "auto-released stale approvals");
    }

    Ok(count)
}

/// Background loop that checks for expired claims and stale approvals every 5 minutes.
pub async fn claim_expiry_loop(db: sqlx::PgPool) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
    loop {
        interval.tick().await;
        if let Err(e) = expire_stale_claims(&db).await {
            tracing::warn!(error = %e, "claim expiry check failed");
        }
        if let Err(e) = auto_release_stale_approvals(&db).await {
            tracing::warn!(error = %e, "auto-release check failed");
        }
    }
}
