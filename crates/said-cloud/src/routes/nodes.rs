use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct RegisterNodeRequest {
    pub endpoint_url: String,
    pub models_served: Vec<String>,
    pub price_per_query_micro_usdc: Option<i64>,
    pub region: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NodeQuery {
    pub model: Option<String>,
    pub region: Option<String>,
    pub sort: Option<String>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateNodeRequest {
    pub endpoint_url: Option<String>,
    pub models_served: Option<Vec<String>>,
    pub price_per_query_micro_usdc: Option<i64>,
    pub region: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HeartbeatRequest {
    pub status: String,
    pub latency_ms: Option<i32>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct NodeResponse {
    pub id: Uuid,
    pub owner_did: String,
    pub endpoint_url: String,
    pub models_served: Vec<String>,
    pub price_per_query_micro_usdc: i64,
    pub status: String,
    pub region: Option<String>,
    pub description: Option<String>,
    pub uptime_percent: f32,
    pub total_queries: i64,
    pub last_heartbeat_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// POST /v1/nodes/register (JWT protected)
pub async fn register_node(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<RegisterNodeRequest>,
) -> AppResult<(StatusCode, Json<NodeResponse>)> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Get user's DID
    let did: String = sqlx::query_scalar(
        "SELECT COALESCE(
            (SELECT did FROM business_profiles WHERE user_id = $1),
            (SELECT did FROM public_profiles WHERE user_id = $1),
            ''
        )",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    if did.is_empty() {
        return Err(AppError::BadRequest(
            "No DID found. Create a profile first.".into(),
        ));
    }

    // Verify endpoint is reachable by pinging /v1/models
    let ping_result = state
        .http_client
        .get(format!(
            "{}/v1/models",
            req.endpoint_url.trim_end_matches('/')
        ))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;

    let initial_status = if ping_result.is_ok() {
        "active"
    } else {
        "pending"
    };

    let node = sqlx::query_as::<_, NodeResponse>(
        r#"INSERT INTO inference_nodes (owner_id, owner_did, endpoint_url, models_served, price_per_query_micro_usdc, status, region, description)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, owner_did, endpoint_url, models_served, price_per_query_micro_usdc, status, region, description, uptime_percent, total_queries, last_heartbeat_at, created_at"#,
    )
    .bind(user_id)
    .bind(&did)
    .bind(&req.endpoint_url)
    .bind(&req.models_served)
    .bind(req.price_per_query_micro_usdc.unwrap_or(100_000))
    .bind(initial_status)
    .bind(&req.region)
    .bind(&req.description)
    .fetch_one(&state.db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db_err)
            if db_err.constraint() == Some("inference_nodes_endpoint_url_key") =>
        {
            AppError::Conflict("A node with this endpoint URL already exists".into())
        }
        _ => AppError::from(e),
    })?;

    Ok((StatusCode::CREATED, Json(node)))
}

/// GET /v1/nodes (public for page 1 / limit ≤10; auth required for bulk)
pub async fn list_nodes(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(params): Query<NodeQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let page = params.page.unwrap_or(1).max(1);
    let limit = params.limit.unwrap_or(10).min(100);

    // Bulk / paginated access requires authentication
    let needs_auth = page > 1 || params.limit.map_or(false, |l| l > 10);
    if needs_auth && !crate::auth::check_bulk_auth(&headers, &state).await {
        return Err(crate::error::AppError::Forbidden(
            "Bulk and paginated access to the node registry requires authentication. \
             Obtain a SAID identity at https://ghola.xyz and pass a Bearer token \
             or X-Service-Key header."
                .into(),
        ));
    }
    let offset = (page - 1) * limit;

    let nodes = sqlx::query_as::<_, NodeResponse>(
        r#"SELECT id, owner_did, endpoint_url, models_served, price_per_query_micro_usdc, status, region, description, uptime_percent, total_queries, last_heartbeat_at, created_at
        FROM inference_nodes
        WHERE status != 'offline'
            AND ($1::text IS NULL OR $1 = ANY(models_served))
            AND ($2::text IS NULL OR region = $2)
        ORDER BY
            CASE WHEN status = 'active' THEN 0 WHEN status = 'degraded' THEN 1 ELSE 2 END,
            uptime_percent DESC
        LIMIT $3 OFFSET $4"#,
    )
    .bind(params.model.as_deref())
    .bind(params.region.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM inference_nodes
        WHERE status != 'offline'
            AND ($1::text IS NULL OR $1 = ANY(models_served))
            AND ($2::text IS NULL OR region = $2)"#,
    )
    .bind(params.model.as_deref())
    .bind(params.region.as_deref())
    .fetch_one(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "nodes": nodes,
        "total": total,
        "page": page,
        "limit": limit,
    })))
}

/// GET /v1/nodes/{id} (public)
pub async fn get_node(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let node = sqlx::query_as::<_, NodeResponse>(
        r#"SELECT id, owner_did, endpoint_url, models_served, price_per_query_micro_usdc, status, region, description, uptime_percent, total_queries, last_heartbeat_at, created_at
        FROM inference_nodes WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Node not found".into()))?;

    // Get recent heartbeats
    let heartbeats: Vec<serde_json::Value> = sqlx::query_scalar(
        r#"SELECT json_build_object('status', status, 'latency_ms', latency_ms, 'error_message', error_message, 'created_at', created_at)
        FROM node_heartbeats WHERE node_id = $1 ORDER BY created_at DESC LIMIT 50"#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "node": node,
        "heartbeats": heartbeats,
    })))
}

/// PUT /v1/nodes/manage/{id} (JWT, owner only)
pub async fn update_node(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateNodeRequest>,
) -> AppResult<Json<NodeResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Verify ownership
    let owner_id: Option<Uuid> =
        sqlx::query_scalar("SELECT owner_id FROM inference_nodes WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;

    match owner_id {
        None => return Err(AppError::NotFound("Node not found".into())),
        Some(oid) if oid != user_id => return Err(AppError::Unauthorized("Not your node".into())),
        _ => {}
    }

    let node = sqlx::query_as::<_, NodeResponse>(
        r#"UPDATE inference_nodes SET
            endpoint_url = COALESCE($1, endpoint_url),
            models_served = COALESCE($2, models_served),
            price_per_query_micro_usdc = COALESCE($3, price_per_query_micro_usdc),
            region = COALESCE($4, region),
            description = COALESCE($5, description)
        WHERE id = $6
        RETURNING id, owner_did, endpoint_url, models_served, price_per_query_micro_usdc, status, region, description, uptime_percent, total_queries, last_heartbeat_at, created_at"#,
    )
    .bind(req.endpoint_url.as_deref())
    .bind(req.models_served.as_deref())
    .bind(req.price_per_query_micro_usdc)
    .bind(req.region.as_deref())
    .bind(req.description.as_deref())
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(node))
}

/// DELETE /v1/nodes/manage/{id} (JWT, owner only -- soft delete)
pub async fn delete_node(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let result = sqlx::query(
        "UPDATE inference_nodes SET status = 'offline' WHERE id = $1 AND owner_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(
            "Node not found or not owned by you".into(),
        ));
    }

    Ok(StatusCode::NO_CONTENT)
}

/// POST /v1/nodes/{id}/heartbeat (public)
pub async fn node_heartbeat(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<HeartbeatRequest>,
) -> AppResult<StatusCode> {
    // Record heartbeat
    sqlx::query("INSERT INTO node_heartbeats (node_id, status, latency_ms) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(&req.status)
        .bind(req.latency_ms)
        .execute(&state.db)
        .await?;

    // Update node last_heartbeat
    let new_status = if req.status == "ok" {
        "active"
    } else {
        "degraded"
    };
    sqlx::query(
        "UPDATE inference_nodes SET last_heartbeat_at = NOW(), status = $1, consecutive_failures = CASE WHEN $2 = 'ok' THEN 0 ELSE consecutive_failures END WHERE id = $3",
    )
    .bind(new_status)
    .bind(&req.status)
    .bind(id)
    .execute(&state.db)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Marketplace: Reviews & Payments
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct PaginationQuery {
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ReviewRequest {
    pub rating: i32,
    pub comment: Option<String>,
}

/// POST /v1/nodes/{id}/review (JWT protected)
pub async fn submit_review(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
    Json(req): Json<ReviewRequest>,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    if req.rating < 1 || req.rating > 5 {
        return Err(AppError::BadRequest(
            "Rating must be between 1 and 5".into(),
        ));
    }

    // Check node exists
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM inference_nodes WHERE id = $1)")
            .bind(id)
            .fetch_one(&state.db)
            .await?;

    if !exists {
        return Err(AppError::NotFound("Node not found".into()));
    }

    // Upsert review
    sqlx::query(
        r#"INSERT INTO node_reviews (node_id, reviewer_id, rating, comment)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (node_id, reviewer_id) DO UPDATE SET rating = $3, comment = $4"#,
    )
    .bind(id)
    .bind(user_id)
    .bind(req.rating)
    .bind(&req.comment)
    .execute(&state.db)
    .await?;

    // Update aggregate
    sqlx::query(
        r#"UPDATE inference_nodes SET
            avg_rating = (SELECT AVG(rating)::REAL FROM node_reviews WHERE node_id = $1),
            review_count = (SELECT COUNT(*) FROM node_reviews WHERE node_id = $1)
        WHERE id = $1"#,
    )
    .bind(id)
    .execute(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "status": "ok" })),
    ))
}

/// GET /v1/nodes/{id}/reviews (public)
pub async fn get_reviews(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Query(params): Query<PaginationQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let page = params.page.unwrap_or(1).max(1);
    let limit = params.limit.unwrap_or(20).min(100);
    let offset = (page - 1) * limit;

    let reviews: Vec<serde_json::Value> = sqlx::query_scalar(
        r#"SELECT json_build_object(
            'id', r.id, 'rating', r.rating, 'comment', r.comment,
            'created_at', r.created_at
        )
        FROM node_reviews r
        WHERE r.node_id = $1
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3"#,
    )
    .bind(id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "reviews": reviews,
        "page": page,
        "limit": limit,
    })))
}

#[derive(Debug, Deserialize)]
pub struct NodePaymentRequest {
    pub amount_micro_usdc: i64,
    pub node_share_micro_usdc: i64,
    pub creator_share_micro_usdc: i64,
    pub platform_share_micro_usdc: i64,
}

/// POST /v1/nodes/{id}/payment (service-to-service)
pub async fn record_payment(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<NodePaymentRequest>,
) -> AppResult<StatusCode> {
    sqlx::query(
        r#"INSERT INTO node_payments (node_id, amount_micro_usdc, node_share_micro_usdc, creator_share_micro_usdc, platform_share_micro_usdc)
        VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(id)
    .bind(req.amount_micro_usdc)
    .bind(req.node_share_micro_usdc)
    .bind(req.creator_share_micro_usdc)
    .bind(req.platform_share_micro_usdc)
    .execute(&state.db)
    .await?;

    // Update node revenue + query count
    sqlx::query(
        "UPDATE inference_nodes SET total_revenue_micro_usdc = total_revenue_micro_usdc + $1, total_queries = total_queries + 1 WHERE id = $2",
    )
    .bind(req.node_share_micro_usdc)
    .bind(id)
    .execute(&state.db)
    .await?;

    Ok(StatusCode::CREATED)
}

#[derive(Debug, Deserialize)]
pub struct ResolveQuery {
    pub model: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ResolvedNode {
    pub id: Uuid,
    pub endpoint_url: String,
    pub status: String,
    pub uptime_percent: f32,
    pub avg_latency_ms: Option<f32>,
    pub price_per_query_micro_usdc: i64,
}

/// GET /v1/nodes/resolve?model={identifier}
/// Returns up to 5 healthy nodes that serve the given model,
/// ordered by status (active > degraded), then uptime, then latency.
pub async fn resolve_nodes(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ResolveQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let nodes = sqlx::query_as::<_, ResolvedNode>(
        r#"SELECT id, endpoint_url, status, uptime_percent, avg_latency_ms, price_per_query_micro_usdc
        FROM inference_nodes
        WHERE $1 = ANY(models_served) AND status IN ('active', 'degraded')
        ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, uptime_percent DESC, avg_latency_ms ASC NULLS LAST
        LIMIT 5"#,
    )
    .bind(&params.model)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "nodes": nodes })))
}
