//! Treasury management — funding pools, departmental budgets, approval workflows.
//!
//! Routes (all JWT-protected):
//!   POST   /v1/treasury/pools                      — create pool (admin)
//!   GET    /v1/treasury/pools?tenant_id=            — list pools (member)
//!   GET    /v1/treasury/pools/{id}                  — get pool (member)
//!   PUT    /v1/treasury/pools/{id}                  — update pool (admin)
//!   POST   /v1/treasury/pools/{id}/budgets          — allocate dept budget (admin)
//!   GET    /v1/treasury/pools/{id}/budgets          — list dept budgets (member)
//!   POST   /v1/treasury/requests                   — request approval (member)
//!   GET    /v1/treasury/requests?tenant_id=         — list requests (member)
//!   POST   /v1/treasury/requests/{id}/approve       — approve (admin)
//!   POST   /v1/treasury/requests/{id}/reject        — reject (admin)
//!   POST   /v1/treasury/requests/{id}/execute       — mark executed (admin)

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

// ── Request types ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreatePoolRequest {
    pub tenant_id: Uuid,
    pub name: String,
    pub funding_wallet_address: String,
    pub total_budget_micro_usdc: Option<i64>,
    /// Transactions above this amount in micro-USDC require approval (default 1_000_000 = 1 USDC).
    pub approval_threshold_micro_usdc: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePoolRequest {
    pub name: Option<String>,
    pub total_budget_micro_usdc: Option<i64>,
    pub approval_threshold_micro_usdc: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct AllocateBudgetRequest {
    pub department_id: Uuid,
    pub allocated_micro_usdc: i64,
    pub period: Option<String>, // daily | weekly | monthly
}

#[derive(Debug, Deserialize)]
pub struct RequestApprovalRequest {
    pub treasury_pool_id: Uuid,
    pub tenant_id: Uuid,
    pub amount_micro_usdc: i64,
    pub recipient_address: String,
    pub purpose: String,
}

#[derive(Debug, Deserialize)]
pub struct ReviewRequest {
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExecuteRequest {
    pub tx_signature: String,
}

#[derive(Debug, Deserialize)]
pub struct ListPoolsQuery {
    pub tenant_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct ListRequestsQuery {
    pub tenant_id: Uuid,
    pub status: Option<String>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

// ── Response types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TreasuryPoolResponse {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub name: String,
    pub funding_wallet_address: String,
    pub total_budget_micro_usdc: i64,
    pub allocated_micro_usdc: i64,
    pub spent_micro_usdc: i64,
    pub approval_threshold_micro_usdc: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct DepartmentBudgetResponse {
    pub id: Uuid,
    pub treasury_pool_id: Uuid,
    pub department_id: Uuid,
    pub allocated_micro_usdc: i64,
    pub spent_micro_usdc: i64,
    pub period: String,
    pub period_start: chrono::DateTime<chrono::Utc>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ApprovalRequestResponse {
    pub id: Uuid,
    pub treasury_pool_id: Uuid,
    pub tenant_id: Uuid,
    pub requester_did: String,
    pub requester_user_id: Option<Uuid>,
    pub amount_micro_usdc: i64,
    pub recipient_address: String,
    pub purpose: String,
    pub status: String,
    pub reviewer_user_id: Option<Uuid>,
    pub reviewer_note: Option<String>,
    pub reviewed_at: Option<chrono::DateTime<chrono::Utc>>,
    pub tx_signature: Option<String>,
    pub executed_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

// ── Auth helpers ───────────────────────────────────────────────────────────────

fn parse_user_id(claims: &Claims) -> AppResult<Uuid> {
    claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))
}

async fn require_tenant_member(
    state: &crate::state::AppState,
    tenant_id: Uuid,
    user_id: Uuid,
) -> AppResult<String> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT role FROM tenant_members WHERE tenant_id = $1 AND user_id = $2")
            .bind(tenant_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;

    row.map(|r| r.0)
        .ok_or_else(|| AppError::Unauthorized("Not a member of this tenant".into()))
}

async fn require_tenant_admin(
    state: &crate::state::AppState,
    tenant_id: Uuid,
    user_id: Uuid,
) -> AppResult<()> {
    let role = require_tenant_member(state, tenant_id, user_id).await?;
    if role != "owner" && role != "admin" {
        return Err(AppError::Unauthorized(
            "Admin or owner role required".into(),
        ));
    }
    Ok(())
}

// ── Treasury pool handlers ─────────────────────────────────────────────────────

/// POST /v1/treasury/pools
pub async fn create_pool(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreatePoolRequest>,
) -> AppResult<(StatusCode, Json<TreasuryPoolResponse>)> {
    let user_id = parse_user_id(&claims)?;
    require_tenant_admin(&state, req.tenant_id, user_id).await?;

    if req.name.is_empty() {
        return Err(AppError::BadRequest("Pool name is required".into()));
    }
    if req.funding_wallet_address.is_empty() {
        return Err(AppError::BadRequest(
            "Funding wallet address is required".into(),
        ));
    }

    let pool = sqlx::query_as::<_, TreasuryPoolResponse>(
        r#"INSERT INTO treasury_pools
            (tenant_id, name, funding_wallet_address, total_budget_micro_usdc,
             approval_threshold_micro_usdc)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *"#,
    )
    .bind(req.tenant_id)
    .bind(&req.name)
    .bind(&req.funding_wallet_address)
    .bind(req.total_budget_micro_usdc.unwrap_or(0))
    .bind(req.approval_threshold_micro_usdc.unwrap_or(1_000_000))
    .fetch_one(&state.db)
    .await?;

    super::audit::emit(
        &state.db,
        Some(req.tenant_id),
        &claims.sub,
        Some(user_id),
        "treasury_pool_created",
        Some("treasury_pool"),
        Some(&pool.id.to_string()),
        serde_json::json!({
            "name": pool.name,
            "total_budget": pool.total_budget_micro_usdc,
        }),
    )
    .await;

    Ok((StatusCode::CREATED, Json(pool)))
}

/// GET /v1/treasury/pools?tenant_id=
pub async fn list_pools(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<ListPoolsQuery>,
) -> AppResult<Json<Vec<TreasuryPoolResponse>>> {
    let user_id = parse_user_id(&claims)?;
    require_tenant_member(&state, params.tenant_id, user_id).await?;

    let pools = sqlx::query_as::<_, TreasuryPoolResponse>(
        "SELECT * FROM treasury_pools WHERE tenant_id = $1 ORDER BY created_at ASC",
    )
    .bind(params.tenant_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(pools))
}

/// GET /v1/treasury/pools/{id}
pub async fn get_pool(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(pool_id): Path<Uuid>,
) -> AppResult<Json<TreasuryPoolResponse>> {
    let user_id = parse_user_id(&claims)?;

    let pool =
        sqlx::query_as::<_, TreasuryPoolResponse>("SELECT * FROM treasury_pools WHERE id = $1")
            .bind(pool_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound("Treasury pool not found".into()))?;

    require_tenant_member(&state, pool.tenant_id, user_id).await?;

    Ok(Json(pool))
}

/// PUT /v1/treasury/pools/{id}
pub async fn update_pool(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(pool_id): Path<Uuid>,
    Json(req): Json<UpdatePoolRequest>,
) -> AppResult<Json<TreasuryPoolResponse>> {
    let user_id = parse_user_id(&claims)?;

    let existing =
        sqlx::query_as::<_, TreasuryPoolResponse>("SELECT * FROM treasury_pools WHERE id = $1")
            .bind(pool_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound("Treasury pool not found".into()))?;

    require_tenant_admin(&state, existing.tenant_id, user_id).await?;

    let pool = sqlx::query_as::<_, TreasuryPoolResponse>(
        r#"UPDATE treasury_pools SET
            name                         = COALESCE($2, name),
            total_budget_micro_usdc      = COALESCE($3, total_budget_micro_usdc),
            approval_threshold_micro_usdc = COALESCE($4, approval_threshold_micro_usdc)
           WHERE id = $1
           RETURNING *"#,
    )
    .bind(pool_id)
    .bind(&req.name)
    .bind(req.total_budget_micro_usdc)
    .bind(req.approval_threshold_micro_usdc)
    .fetch_one(&state.db)
    .await?;

    super::audit::emit(
        &state.db,
        Some(existing.tenant_id),
        &claims.sub,
        Some(user_id),
        "treasury_pool_updated",
        Some("treasury_pool"),
        Some(&pool_id.to_string()),
        serde_json::json!({}),
    )
    .await;

    Ok(Json(pool))
}

// ── Department budget handlers ─────────────────────────────────────────────────

/// POST /v1/treasury/pools/{id}/budgets
pub async fn allocate_budget(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(pool_id): Path<Uuid>,
    Json(req): Json<AllocateBudgetRequest>,
) -> AppResult<(StatusCode, Json<DepartmentBudgetResponse>)> {
    let user_id = parse_user_id(&claims)?;

    let pool: Option<(Uuid, i64, i64)> = sqlx::query_as(
        "SELECT tenant_id, total_budget_micro_usdc, allocated_micro_usdc FROM treasury_pools WHERE id = $1",
    )
    .bind(pool_id)
    .fetch_optional(&state.db)
    .await?;

    let (tenant_id, total, allocated) =
        pool.ok_or_else(|| AppError::NotFound("Treasury pool not found".into()))?;

    require_tenant_admin(&state, tenant_id, user_id).await?;

    if req.allocated_micro_usdc < 0 {
        return Err(AppError::BadRequest(
            "Allocation must be non-negative".into(),
        ));
    }
    if allocated + req.allocated_micro_usdc > total {
        return Err(AppError::BadRequest(
            "Allocation would exceed pool total budget".into(),
        ));
    }

    let period = req.period.as_deref().unwrap_or("monthly");
    let valid_periods = ["daily", "weekly", "monthly"];
    if !valid_periods.contains(&period) {
        return Err(AppError::BadRequest(
            "Period must be one of: daily, weekly, monthly".into(),
        ));
    }

    let budget = sqlx::query_as::<_, DepartmentBudgetResponse>(
        r#"INSERT INTO department_budgets
            (treasury_pool_id, department_id, allocated_micro_usdc, period)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (treasury_pool_id, department_id) DO UPDATE SET
               allocated_micro_usdc = EXCLUDED.allocated_micro_usdc,
               period = EXCLUDED.period
           RETURNING *"#,
    )
    .bind(pool_id)
    .bind(req.department_id)
    .bind(req.allocated_micro_usdc)
    .bind(period)
    .fetch_one(&state.db)
    .await?;

    // Update pool's allocated total.
    sqlx::query(
        "UPDATE treasury_pools SET allocated_micro_usdc = allocated_micro_usdc + $1 WHERE id = $2",
    )
    .bind(req.allocated_micro_usdc)
    .bind(pool_id)
    .execute(&state.db)
    .await?;

    super::audit::emit(
        &state.db,
        Some(tenant_id),
        &claims.sub,
        Some(user_id),
        "department_budget_allocated",
        Some("treasury_pool"),
        Some(&pool_id.to_string()),
        serde_json::json!({
            "department_id": req.department_id,
            "allocated_micro_usdc": req.allocated_micro_usdc,
        }),
    )
    .await;

    Ok((StatusCode::CREATED, Json(budget)))
}

/// GET /v1/treasury/pools/{id}/budgets
pub async fn list_budgets(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(pool_id): Path<Uuid>,
) -> AppResult<Json<Vec<DepartmentBudgetResponse>>> {
    let user_id = parse_user_id(&claims)?;

    let tenant_id: Option<Uuid> =
        sqlx::query_scalar("SELECT tenant_id FROM treasury_pools WHERE id = $1")
            .bind(pool_id)
            .fetch_optional(&state.db)
            .await?;

    let tenant_id =
        tenant_id.ok_or_else(|| AppError::NotFound("Treasury pool not found".into()))?;

    require_tenant_member(&state, tenant_id, user_id).await?;

    let budgets = sqlx::query_as::<_, DepartmentBudgetResponse>(
        "SELECT * FROM department_budgets WHERE treasury_pool_id = $1 ORDER BY created_at ASC",
    )
    .bind(pool_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(budgets))
}

// ── Approval request handlers ──────────────────────────────────────────────────

/// POST /v1/treasury/requests — create an approval request (any member)
pub async fn create_request(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<RequestApprovalRequest>,
) -> AppResult<(StatusCode, Json<ApprovalRequestResponse>)> {
    let user_id = parse_user_id(&claims)?;
    require_tenant_member(&state, req.tenant_id, user_id).await?;

    if req.amount_micro_usdc <= 0 {
        return Err(AppError::BadRequest("Amount must be positive".into()));
    }
    if req.recipient_address.is_empty() {
        return Err(AppError::BadRequest("Recipient address is required".into()));
    }
    if req.purpose.is_empty() {
        return Err(AppError::BadRequest("Purpose is required".into()));
    }

    // Verify the pool belongs to this tenant.
    let pool_tenant: Option<(Uuid, i64)> = sqlx::query_as(
        "SELECT tenant_id, approval_threshold_micro_usdc FROM treasury_pools WHERE id = $1",
    )
    .bind(req.treasury_pool_id)
    .fetch_optional(&state.db)
    .await?;

    let (pool_tenant_id, threshold) =
        pool_tenant.ok_or_else(|| AppError::NotFound("Treasury pool not found".into()))?;

    if pool_tenant_id != req.tenant_id {
        return Err(AppError::Unauthorized(
            "Treasury pool does not belong to this tenant".into(),
        ));
    }

    // Auto-approve if below threshold.
    let initial_status = if req.amount_micro_usdc <= threshold {
        "approved"
    } else {
        "pending"
    };

    let approval = sqlx::query_as::<_, ApprovalRequestResponse>(
        r#"INSERT INTO approval_requests
            (treasury_pool_id, tenant_id, requester_did, requester_user_id,
             amount_micro_usdc, recipient_address, purpose, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *"#,
    )
    .bind(req.treasury_pool_id)
    .bind(req.tenant_id)
    .bind(&claims.sub)
    .bind(user_id)
    .bind(req.amount_micro_usdc)
    .bind(&req.recipient_address)
    .bind(&req.purpose)
    .bind(initial_status)
    .fetch_one(&state.db)
    .await?;

    super::audit::emit(
        &state.db,
        Some(req.tenant_id),
        &claims.sub,
        Some(user_id),
        "approval_request_created",
        Some("approval_request"),
        Some(&approval.id.to_string()),
        serde_json::json!({
            "amount_micro_usdc": req.amount_micro_usdc,
            "auto_approved": initial_status == "approved",
        }),
    )
    .await;

    Ok((StatusCode::CREATED, Json(approval)))
}

/// GET /v1/treasury/requests?tenant_id=
pub async fn list_requests(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(params): Query<ListRequestsQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    require_tenant_member(&state, params.tenant_id, user_id).await?;

    let page = params.page.unwrap_or(1).max(1);
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let offset = (page - 1) * limit;

    let requests = sqlx::query_as::<_, ApprovalRequestResponse>(
        r#"SELECT * FROM approval_requests
           WHERE tenant_id = $1
             AND ($2::text IS NULL OR status = $2)
           ORDER BY created_at DESC
           LIMIT $3 OFFSET $4"#,
    )
    .bind(params.tenant_id)
    .bind(&params.status)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM approval_requests
           WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)"#,
    )
    .bind(params.tenant_id)
    .bind(&params.status)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "requests": requests,
        "total": total,
        "page": page,
        "limit": limit,
    })))
}

/// POST /v1/treasury/requests/{id}/approve
pub async fn approve_request(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(request_id): Path<Uuid>,
    Json(req): Json<ReviewRequest>,
) -> AppResult<Json<ApprovalRequestResponse>> {
    let user_id = parse_user_id(&claims)?;

    let existing: Option<(Uuid, String)> =
        sqlx::query_as("SELECT tenant_id, status FROM approval_requests WHERE id = $1")
            .bind(request_id)
            .fetch_optional(&state.db)
            .await?;

    let (tenant_id, status) =
        existing.ok_or_else(|| AppError::NotFound("Approval request not found".into()))?;

    require_tenant_admin(&state, tenant_id, user_id).await?;

    if status != "pending" {
        return Err(AppError::BadRequest(format!(
            "Cannot approve a request with status '{status}'"
        )));
    }

    let approval = sqlx::query_as::<_, ApprovalRequestResponse>(
        r#"UPDATE approval_requests SET
            status = 'approved',
            reviewer_user_id = $2,
            reviewer_note = $3,
            reviewed_at = NOW()
           WHERE id = $1
           RETURNING *"#,
    )
    .bind(request_id)
    .bind(user_id)
    .bind(&req.note)
    .fetch_one(&state.db)
    .await?;

    super::audit::emit(
        &state.db,
        Some(tenant_id),
        &claims.sub,
        Some(user_id),
        "approval_request_approved",
        Some("approval_request"),
        Some(&request_id.to_string()),
        serde_json::json!({ "note": req.note }),
    )
    .await;

    Ok(Json(approval))
}

/// POST /v1/treasury/requests/{id}/reject
pub async fn reject_request(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(request_id): Path<Uuid>,
    Json(req): Json<ReviewRequest>,
) -> AppResult<Json<ApprovalRequestResponse>> {
    let user_id = parse_user_id(&claims)?;

    let existing: Option<(Uuid, String)> =
        sqlx::query_as("SELECT tenant_id, status FROM approval_requests WHERE id = $1")
            .bind(request_id)
            .fetch_optional(&state.db)
            .await?;

    let (tenant_id, status) =
        existing.ok_or_else(|| AppError::NotFound("Approval request not found".into()))?;

    require_tenant_admin(&state, tenant_id, user_id).await?;

    if status != "pending" {
        return Err(AppError::BadRequest(format!(
            "Cannot reject a request with status '{status}'"
        )));
    }

    let approval = sqlx::query_as::<_, ApprovalRequestResponse>(
        r#"UPDATE approval_requests SET
            status = 'rejected',
            reviewer_user_id = $2,
            reviewer_note = $3,
            reviewed_at = NOW()
           WHERE id = $1
           RETURNING *"#,
    )
    .bind(request_id)
    .bind(user_id)
    .bind(&req.note)
    .fetch_one(&state.db)
    .await?;

    super::audit::emit(
        &state.db,
        Some(tenant_id),
        &claims.sub,
        Some(user_id),
        "approval_request_rejected",
        Some("approval_request"),
        Some(&request_id.to_string()),
        serde_json::json!({ "note": req.note }),
    )
    .await;

    Ok(Json(approval))
}

/// POST /v1/treasury/requests/{id}/execute
pub async fn execute_request(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(request_id): Path<Uuid>,
    Json(req): Json<ExecuteRequest>,
) -> AppResult<Json<ApprovalRequestResponse>> {
    let user_id = parse_user_id(&claims)?;

    let existing: Option<(Uuid, String, i64, Uuid)> = sqlx::query_as(
        "SELECT tenant_id, status, amount_micro_usdc, treasury_pool_id FROM approval_requests WHERE id = $1",
    )
    .bind(request_id)
    .fetch_optional(&state.db)
    .await?;

    let (tenant_id, status, amount, pool_id) =
        existing.ok_or_else(|| AppError::NotFound("Approval request not found".into()))?;

    require_tenant_admin(&state, tenant_id, user_id).await?;

    if status != "approved" {
        return Err(AppError::BadRequest(format!(
            "Cannot execute a request with status '{status}' — it must be approved first"
        )));
    }

    let approval = sqlx::query_as::<_, ApprovalRequestResponse>(
        r#"UPDATE approval_requests SET
            status = 'executed',
            tx_signature = $2,
            executed_at = NOW()
           WHERE id = $1
           RETURNING *"#,
    )
    .bind(request_id)
    .bind(&req.tx_signature)
    .fetch_one(&state.db)
    .await?;

    // Update pool spent total.
    sqlx::query("UPDATE treasury_pools SET spent_micro_usdc = spent_micro_usdc + $1 WHERE id = $2")
        .bind(amount)
        .bind(pool_id)
        .execute(&state.db)
        .await?;

    super::audit::emit(
        &state.db,
        Some(tenant_id),
        &claims.sub,
        Some(user_id),
        "approval_request_executed",
        Some("approval_request"),
        Some(&request_id.to_string()),
        serde_json::json!({
            "tx_signature": req.tx_signature,
            "amount_micro_usdc": amount,
        }),
    )
    .await;

    Ok(Json(approval))
}
