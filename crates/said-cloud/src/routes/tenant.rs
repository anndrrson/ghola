//! Multi-tenant isolation — tenant CRUD, member management, department hierarchy.
//!
//! All protected routes require a valid Bearer JWT.  Tenant-scoped routes
//! additionally verify that the caller is a member (or owner/admin) of the
//! requested tenant before returning or mutating any data.

use std::sync::Arc;

use axum::extract::{Path, State};
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
pub struct CreateTenantRequest {
    pub name: String,
    pub slug: String,
    /// Settlement interval override in seconds (default 3600).
    pub settlement_interval_secs: Option<i32>,
    /// Maximum records per settlement batch (default 1000).
    pub max_settlement_batch_size: Option<i32>,
    /// Ordered list of fallback Solana RPC URLs.
    pub fallback_rpc_urls: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTenantRequest {
    pub name: Option<String>,
    pub settlement_interval_secs: Option<i32>,
    pub max_settlement_batch_size: Option<i32>,
    pub fallback_rpc_urls: Option<Vec<String>>,
    pub settings: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct AddMemberRequest {
    pub user_id: Uuid,
    pub role: Option<String>,    // owner | admin | member | viewer
    pub department: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMemberRequest {
    pub role: Option<String>,
    pub department: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateDepartmentRequest {
    pub name: String,
    pub budget_micro_usdc: Option<i64>,
    pub parent_department_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDepartmentRequest {
    pub name: Option<String>,
    pub budget_micro_usdc: Option<i64>,
    pub parent_department_id: Option<Uuid>,
}

// ── Response types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TenantResponse {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub owner_user_id: Uuid,
    pub settlement_interval_secs: i32,
    pub max_settlement_batch_size: i32,
    pub fallback_rpc_urls: Vec<String>,
    pub settings: serde_json::Value,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TenantMemberResponse {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub department: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct DepartmentResponse {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub name: String,
    pub budget_micro_usdc: i64,
    pub parent_department_id: Option<Uuid>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

// ── Authorization helpers ──────────────────────────────────────────────────────

/// Returns the caller's role in `tenant_id`, or an auth error if they are not
/// a member.
async fn require_member(
    state: &AppState,
    tenant_id: Uuid,
    user_id: Uuid,
) -> AppResult<String> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT role FROM tenant_members WHERE tenant_id = $1 AND user_id = $2",
    )
    .bind(tenant_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    row.map(|r| r.0)
        .ok_or_else(|| AppError::Unauthorized("Not a member of this tenant".into()))
}

/// Returns the caller's role, requiring at least `admin` level.
async fn require_admin(
    state: &AppState,
    tenant_id: Uuid,
    user_id: Uuid,
) -> AppResult<()> {
    let role = require_member(state, tenant_id, user_id).await?;
    if role != "owner" && role != "admin" {
        return Err(AppError::Unauthorized(
            "Admin or owner role required".into(),
        ));
    }
    Ok(())
}

fn parse_user_id(claims: &Claims) -> AppResult<Uuid> {
    claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))
}

// ── Tenant CRUD ────────────────────────────────────────────────────────────────

/// POST /v1/tenants
pub async fn create_tenant(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<CreateTenantRequest>,
) -> AppResult<(StatusCode, Json<TenantResponse>)> {
    let user_id = parse_user_id(&claims)?;

    if req.name.is_empty() {
        return Err(AppError::BadRequest("Tenant name is required".into()));
    }
    if req.slug.is_empty() || req.slug.contains(' ') {
        return Err(AppError::BadRequest(
            "Slug must be non-empty and contain no spaces".into(),
        ));
    }

    let interval = req.settlement_interval_secs.unwrap_or(3600);
    let batch_size = req.max_settlement_batch_size.unwrap_or(1000);
    let rpc_urls: Vec<String> = req.fallback_rpc_urls.unwrap_or_default();

    let tenant = sqlx::query_as::<_, TenantResponse>(
        r#"INSERT INTO tenants
            (name, slug, owner_user_id, settlement_interval_secs,
             max_settlement_batch_size, fallback_rpc_urls)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *"#,
    )
    .bind(&req.name)
    .bind(&req.slug)
    .bind(user_id)
    .bind(interval)
    .bind(batch_size)
    .bind(&rpc_urls)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") {
            AppError::Conflict("Tenant slug already taken".into())
        } else {
            AppError::Sqlx(e)
        }
    })?;

    // Auto-enrol the creator as owner
    sqlx::query(
        "INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(tenant.id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    super::audit::emit(
        &state.db,
        Some(tenant.id),
        &claims.sub,
        Some(user_id),
        "tenant_created",
        Some("tenant"),
        Some(&tenant.id.to_string()),
        serde_json::json!({ "slug": tenant.slug }),
    )
    .await;

    Ok((StatusCode::CREATED, Json(tenant)))
}

/// GET /v1/tenants  — list tenants the caller belongs to
pub async fn list_tenants(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<Vec<TenantResponse>>> {
    let user_id = parse_user_id(&claims)?;

    let tenants = sqlx::query_as::<_, TenantResponse>(
        r#"SELECT t.*
           FROM tenants t
           JOIN tenant_members m ON m.tenant_id = t.id
           WHERE m.user_id = $1
           ORDER BY t.created_at ASC"#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(tenants))
}

/// GET /v1/tenants/{id}
pub async fn get_tenant(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<Uuid>,
) -> AppResult<Json<TenantResponse>> {
    let user_id = parse_user_id(&claims)?;
    require_member(&state, tenant_id, user_id).await?;

    let tenant = sqlx::query_as::<_, TenantResponse>(
        "SELECT * FROM tenants WHERE id = $1",
    )
    .bind(tenant_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Tenant not found".into()))?;

    Ok(Json(tenant))
}

/// PUT /v1/tenants/{id}
pub async fn update_tenant(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<Uuid>,
    Json(req): Json<UpdateTenantRequest>,
) -> AppResult<Json<TenantResponse>> {
    let user_id = parse_user_id(&claims)?;
    require_admin(&state, tenant_id, user_id).await?;

    let tenant = sqlx::query_as::<_, TenantResponse>(
        r#"UPDATE tenants SET
            name                      = COALESCE($2, name),
            settlement_interval_secs  = COALESCE($3, settlement_interval_secs),
            max_settlement_batch_size = COALESCE($4, max_settlement_batch_size),
            fallback_rpc_urls         = COALESCE($5, fallback_rpc_urls),
            settings                  = COALESCE($6, settings)
           WHERE id = $1
           RETURNING *"#,
    )
    .bind(tenant_id)
    .bind(&req.name)
    .bind(req.settlement_interval_secs)
    .bind(req.max_settlement_batch_size)
    .bind(req.fallback_rpc_urls.as_deref())
    .bind(&req.settings)
    .fetch_one(&state.db)
    .await?;

    super::audit::emit(
        &state.db,
        Some(tenant_id),
        &claims.sub,
        Some(user_id),
        "tenant_updated",
        Some("tenant"),
        Some(&tenant_id.to_string()),
        serde_json::json!({ "fields_changed": req.name.is_some() }),
    )
    .await;

    Ok(Json(tenant))
}

/// DELETE /v1/tenants/{id}
pub async fn delete_tenant(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let user_id = parse_user_id(&claims)?;

    // Only the owner can delete a tenant
    let role = require_member(&state, tenant_id, user_id).await?;
    if role != "owner" {
        return Err(AppError::Unauthorized("Only the owner can delete a tenant".into()));
    }

    sqlx::query("DELETE FROM tenants WHERE id = $1")
        .bind(tenant_id)
        .execute(&state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

// ── Member management ──────────────────────────────────────────────────────────

/// GET /v1/tenants/{id}/members
pub async fn list_members(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<Uuid>,
) -> AppResult<Json<Vec<TenantMemberResponse>>> {
    let user_id = parse_user_id(&claims)?;
    require_member(&state, tenant_id, user_id).await?;

    let members = sqlx::query_as::<_, TenantMemberResponse>(
        "SELECT * FROM tenant_members WHERE tenant_id = $1 ORDER BY created_at ASC",
    )
    .bind(tenant_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(members))
}

/// POST /v1/tenants/{id}/members
pub async fn add_member(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<Uuid>,
    Json(req): Json<AddMemberRequest>,
) -> AppResult<(StatusCode, Json<TenantMemberResponse>)> {
    let user_id = parse_user_id(&claims)?;
    require_admin(&state, tenant_id, user_id).await?;

    let role = req.role.as_deref().unwrap_or("member");
    let valid_roles = ["owner", "admin", "member", "viewer"];
    if !valid_roles.contains(&role) {
        return Err(AppError::BadRequest(
            "Role must be one of: owner, admin, member, viewer".into(),
        ));
    }

    let member = sqlx::query_as::<_, TenantMemberResponse>(
        r#"INSERT INTO tenant_members (tenant_id, user_id, role, department)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, department = EXCLUDED.department
           RETURNING *"#,
    )
    .bind(tenant_id)
    .bind(req.user_id)
    .bind(role)
    .bind(&req.department)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("foreign key") {
            AppError::NotFound("User not found".into())
        } else {
            AppError::Sqlx(e)
        }
    })?;

    super::audit::emit(
        &state.db,
        Some(tenant_id),
        &claims.sub,
        Some(user_id),
        "tenant_member_added",
        Some("user"),
        Some(&req.user_id.to_string()),
        serde_json::json!({ "role": role }),
    )
    .await;

    Ok((StatusCode::CREATED, Json(member)))
}

/// PUT /v1/tenants/{id}/members/{user_id}
pub async fn update_member(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((tenant_id, target_user_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<UpdateMemberRequest>,
) -> AppResult<Json<TenantMemberResponse>> {
    let user_id = parse_user_id(&claims)?;
    require_admin(&state, tenant_id, user_id).await?;

    let member = sqlx::query_as::<_, TenantMemberResponse>(
        r#"UPDATE tenant_members
           SET role       = COALESCE($3, role),
               department = COALESCE($4, department)
           WHERE tenant_id = $1 AND user_id = $2
           RETURNING *"#,
    )
    .bind(tenant_id)
    .bind(target_user_id)
    .bind(&req.role)
    .bind(&req.department)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Member not found in this tenant".into()))?;

    Ok(Json(member))
}

/// DELETE /v1/tenants/{id}/members/{user_id}
pub async fn remove_member(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((tenant_id, target_user_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let user_id = parse_user_id(&claims)?;
    require_admin(&state, tenant_id, user_id).await?;

    let result = sqlx::query(
        "DELETE FROM tenant_members WHERE tenant_id = $1 AND user_id = $2",
    )
    .bind(tenant_id)
    .bind(target_user_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Member not found".into()));
    }

    Ok(StatusCode::NO_CONTENT)
}

// ── Department management ──────────────────────────────────────────────────────

/// GET /v1/tenants/{id}/departments
pub async fn list_departments(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<Uuid>,
) -> AppResult<Json<Vec<DepartmentResponse>>> {
    let user_id = parse_user_id(&claims)?;
    require_member(&state, tenant_id, user_id).await?;

    let depts = sqlx::query_as::<_, DepartmentResponse>(
        "SELECT * FROM tenant_departments WHERE tenant_id = $1 ORDER BY name ASC",
    )
    .bind(tenant_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(depts))
}

/// POST /v1/tenants/{id}/departments
pub async fn create_department(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(tenant_id): Path<Uuid>,
    Json(req): Json<CreateDepartmentRequest>,
) -> AppResult<(StatusCode, Json<DepartmentResponse>)> {
    let user_id = parse_user_id(&claims)?;
    require_admin(&state, tenant_id, user_id).await?;

    if req.name.is_empty() {
        return Err(AppError::BadRequest("Department name is required".into()));
    }

    let dept = sqlx::query_as::<_, DepartmentResponse>(
        r#"INSERT INTO tenant_departments
            (tenant_id, name, budget_micro_usdc, parent_department_id)
           VALUES ($1, $2, $3, $4)
           RETURNING *"#,
    )
    .bind(tenant_id)
    .bind(&req.name)
    .bind(req.budget_micro_usdc.unwrap_or(0))
    .bind(req.parent_department_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") {
            AppError::Conflict("Department name already exists in this tenant".into())
        } else {
            AppError::Sqlx(e)
        }
    })?;

    Ok((StatusCode::CREATED, Json(dept)))
}

/// PUT /v1/tenants/{id}/departments/{dept_id}
pub async fn update_department(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((tenant_id, dept_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<UpdateDepartmentRequest>,
) -> AppResult<Json<DepartmentResponse>> {
    let user_id = parse_user_id(&claims)?;
    require_admin(&state, tenant_id, user_id).await?;

    let dept = sqlx::query_as::<_, DepartmentResponse>(
        r#"UPDATE tenant_departments
           SET name                 = COALESCE($3, name),
               budget_micro_usdc    = COALESCE($4, budget_micro_usdc),
               parent_department_id = COALESCE($5, parent_department_id)
           WHERE id = $1 AND tenant_id = $2
           RETURNING *"#,
    )
    .bind(dept_id)
    .bind(tenant_id)
    .bind(&req.name)
    .bind(req.budget_micro_usdc)
    .bind(req.parent_department_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Department not found".into()))?;

    Ok(Json(dept))
}

/// DELETE /v1/tenants/{id}/departments/{dept_id}
pub async fn delete_department(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((tenant_id, dept_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let user_id = parse_user_id(&claims)?;
    require_admin(&state, tenant_id, user_id).await?;

    let result = sqlx::query(
        "DELETE FROM tenant_departments WHERE id = $1 AND tenant_id = $2",
    )
    .bind(dept_id)
    .bind(tenant_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Department not found".into()));
    }

    Ok(StatusCode::NO_CONTENT)
}
