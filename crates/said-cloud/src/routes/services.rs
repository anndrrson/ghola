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
pub struct RegisterServiceRequest {
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub base_url: String,
    pub health_check_url: Option<String>,
    pub openapi_url: Option<String>,
    pub auth_type: Option<String>,
    pub auth_details: Option<serde_json::Value>,
    pub pricing_model: Option<String>,
    pub price_micro_usdc: Option<i64>,
    pub pricing_tiers: Option<serde_json::Value>,
    pub free_tier_requests: Option<i32>,
    pub sla_uptime_percent: Option<f32>,
    pub sla_latency_p50_ms: Option<i32>,
    pub sla_latency_p99_ms: Option<i32>,
    pub regions: Option<Vec<String>>,
    pub endpoints: Option<serde_json::Value>,
    pub receive_address: Option<String>,
    pub platform_fee_bps: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateServiceRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub base_url: Option<String>,
    pub health_check_url: Option<String>,
    pub openapi_url: Option<String>,
    pub auth_type: Option<String>,
    pub auth_details: Option<serde_json::Value>,
    pub pricing_model: Option<String>,
    pub price_micro_usdc: Option<i64>,
    pub pricing_tiers: Option<serde_json::Value>,
    pub free_tier_requests: Option<i32>,
    pub sla_uptime_percent: Option<f32>,
    pub sla_latency_p50_ms: Option<i32>,
    pub sla_latency_p99_ms: Option<i32>,
    pub regions: Option<Vec<String>>,
    pub endpoints: Option<serde_json::Value>,
    pub receive_address: Option<String>,
    pub platform_fee_bps: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct ServiceQuery {
    pub q: Option<String>,
    pub category: Option<String>,
    pub tags: Option<String>,
    pub max_price: Option<i64>,
    pub min_uptime: Option<f32>,
    pub min_rating: Option<f32>,
    pub auth_type: Option<String>,
    pub region: Option<String>,
    pub pricing_model: Option<String>,
    pub sort: Option<String>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ResolveServiceQuery {
    pub task: String,
    pub category: Option<String>,
    pub max_price_micro_usdc: Option<i64>,
    pub min_uptime: Option<f32>,
    pub min_rating: Option<f32>,
    pub min_trust_score: Option<f32>,
    pub auth_type: Option<String>,
    pub region: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct HeartbeatRequest {
    pub status: String,
    pub latency_ms: Option<i32>,
    pub status_code: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct ReviewRequest {
    pub rating: i32,
    pub comment: Option<String>,
    pub quality_score: Option<i32>,
    pub reliability_score: Option<i32>,
    pub latency_score: Option<i32>,
    pub value_score: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct ServicePaymentRequest {
    pub payer_did: Option<String>,
    pub endpoint_name: Option<String>,
    pub amount_micro_usdc: i64,
    pub merchant_share_micro_usdc: i64,
    pub platform_share_micro_usdc: i64,
    pub tx_signature: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PaginationQuery {
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

// ── Response Types ──

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ServiceListingResponse {
    pub id: Uuid,
    pub owner_did: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub logo_url: Option<String>,
    pub website: Option<String>,
    pub category: String,
    pub tags: Vec<String>,
    pub base_url: String,
    pub auth_type: String,
    pub pricing_model: String,
    pub price_micro_usdc: i64,
    pub status: String,
    pub uptime_percent: f32,
    pub avg_latency_ms: f32,
    pub total_requests: i64,
    pub avg_rating: Option<f32>,
    pub review_count: i32,
    pub regions: Vec<String>,
    pub endpoints: serde_json::Value,
    pub receive_address: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ServiceDetailResponse {
    pub id: Uuid,
    pub owner_did: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub logo_url: Option<String>,
    pub website: Option<String>,
    pub category: String,
    pub tags: Vec<String>,
    pub base_url: String,
    pub health_check_url: Option<String>,
    pub openapi_url: Option<String>,
    pub auth_type: String,
    pub auth_details: serde_json::Value,
    pub pricing_model: String,
    pub price_micro_usdc: i64,
    pub pricing_tiers: Option<serde_json::Value>,
    pub free_tier_requests: Option<i32>,
    pub sla_uptime_percent: Option<f32>,
    pub sla_latency_p50_ms: Option<i32>,
    pub sla_latency_p99_ms: Option<i32>,
    pub regions: Vec<String>,
    pub endpoints: serde_json::Value,
    pub status: String,
    pub uptime_percent: f32,
    pub avg_latency_ms: f32,
    pub total_requests: i64,
    pub total_revenue_micro_usdc: i64,
    pub avg_rating: Option<f32>,
    pub review_count: i32,
    pub receive_address: Option<String>,
    pub platform_fee_bps: i32,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ResolvedServiceResponse {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub base_url: String,
    pub auth_type: String,
    pub auth_details: serde_json::Value,
    pub price_micro_usdc: i64,
    pub pricing_model: String,
    pub uptime_percent: f32,
    pub avg_latency_ms: f32,
    pub avg_rating: Option<f32>,
    pub endpoints: serde_json::Value,
    pub relevance_score: Option<f32>,
}

// ── Handlers ──

/// POST /v1/services/register (JWT protected)
pub async fn register_service(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<RegisterServiceRequest>,
) -> AppResult<(StatusCode, Json<ServiceListingResponse>)> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Validate slug format: ^[a-z0-9][a-z0-9-]*[a-z0-9]$
    if req.slug.len() < 3 || req.slug.len() > 64 {
        return Err(AppError::BadRequest(
            "Slug must be between 3 and 64 characters".into(),
        ));
    }
    if !req
        .slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || req.slug.starts_with('-')
        || req.slug.ends_with('-')
    {
        return Err(AppError::BadRequest(
            "Slug must contain only lowercase letters, digits, and hyphens, and cannot start/end with a hyphen".into(),
        ));
    }

    // Validate base_url
    if !req.base_url.starts_with("http://") && !req.base_url.starts_with("https://") {
        return Err(AppError::BadRequest(
            "base_url must start with http:// or https://".into(),
        ));
    }

    // Validate description length
    if req.description.as_ref().map_or(false, |d| d.len() > 2000) {
        return Err(AppError::BadRequest(
            "Description must be under 2000 characters".into(),
        ));
    }

    // Validate tags count
    if req.tags.as_ref().map_or(false, |t| t.len() > 20) {
        return Err(AppError::BadRequest(
            "Maximum 20 tags allowed".into(),
        ));
    }

    // Validate category
    let valid_categories = [
        "general", "inference", "data", "commerce", "finance",
        "logistics", "communication", "search", "media", "developer-tools",
    ];
    let category = req.category.as_deref().unwrap_or("general");
    if !valid_categories.contains(&category) {
        return Err(AppError::BadRequest(format!(
            "Invalid category. Must be one of: {}",
            valid_categories.join(", ")
        )));
    }

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

    // Ping health check URL to determine initial status
    let health_url = req.health_check_url.as_deref().unwrap_or_else(|| "");
    let check_url = if health_url.is_empty() {
        format!("{}/health", req.base_url.trim_end_matches('/'))
    } else {
        health_url.to_string()
    };

    let initial_status = match state
        .http_client
        .get(&check_url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => "active",
        _ => "pending",
    };

    let auth_type = req.auth_type.as_deref().unwrap_or("api_key");
    let auth_details = req.auth_details.unwrap_or(serde_json::json!({}));
    let pricing_model = req.pricing_model.as_deref().unwrap_or("per_request");
    let category = req.category.as_deref().unwrap_or("general");
    let tags: Vec<String> = req.tags.unwrap_or_default();
    let regions: Vec<String> = req.regions.unwrap_or_default();
    let endpoints = req.endpoints.unwrap_or(serde_json::json!([]));

    let service = sqlx::query_as::<_, ServiceListingResponse>(
        r#"INSERT INTO service_listings (
            owner_id, owner_did, name, slug, description, category, tags,
            base_url, health_check_url, openapi_url,
            auth_type, auth_details, pricing_model, price_micro_usdc,
            pricing_tiers, free_tier_requests,
            sla_uptime_percent, sla_latency_p50_ms, sla_latency_p99_ms,
            regions, endpoints, status, receive_address, platform_fee_bps
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16,
            $17, $18, $19,
            $20, $21, $22, $23, $24
        )
        RETURNING id, owner_did, name, slug, description, logo_url, website,
                  category, tags, base_url, auth_type::text, pricing_model::text,
                  price_micro_usdc, status::text, uptime_percent, avg_latency_ms,
                  total_requests, avg_rating, review_count, regions, endpoints,
                  receive_address, created_at"#,
    )
    .bind(user_id)
    .bind(&did)
    .bind(&req.name)
    .bind(&req.slug)
    .bind(req.description.as_deref().unwrap_or(""))
    .bind(category)
    .bind(&tags)
    .bind(&req.base_url)
    .bind(&req.health_check_url)
    .bind(&req.openapi_url)
    .bind(auth_type)
    .bind(&auth_details)
    .bind(pricing_model)
    .bind(req.price_micro_usdc.unwrap_or(0))
    .bind(&req.pricing_tiers)
    .bind(req.free_tier_requests)
    .bind(req.sla_uptime_percent)
    .bind(req.sla_latency_p50_ms)
    .bind(req.sla_latency_p99_ms)
    .bind(&regions)
    .bind(&endpoints)
    .bind(initial_status)
    .bind(&req.receive_address)
    .bind(req.platform_fee_bps.unwrap_or(300))
    .fetch_one(&state.db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db_err)
            if db_err.constraint() == Some("service_listings_slug_key") =>
        {
            AppError::Conflict("A service with this slug already exists".into())
        }
        _ => AppError::from(e),
    })?;

    Ok((StatusCode::CREATED, Json(service)))
}

/// GET /v1/services (public for page 1 / limit ≤10; auth required for bulk)
pub async fn list_services(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(params): Query<ServiceQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let page = params.page.unwrap_or(1).max(1);
    let limit = params.limit.unwrap_or(10).min(100);

    // Bulk / paginated access requires authentication
    let needs_auth = page > 1 || params.limit.map_or(false, |l| l > 10);
    if needs_auth && !crate::auth::check_bulk_auth(&headers, &state).await {
        return Err(crate::error::AppError::Forbidden(
            "Bulk and paginated access to the service catalog requires authentication. \
             Obtain a SAID identity at https://ghola.xyz and pass a Bearer token \
             or X-Service-Key header."
                .into(),
        ));
    }
    let offset = (page - 1) * limit;

    // Build query based on whether full-text search is requested
    let services = if let Some(ref q) = params.q {
        sqlx::query_as::<_, ServiceListingResponse>(
            r#"SELECT id, owner_did, name, slug, description, logo_url, website,
                      category, tags, base_url, auth_type::text, pricing_model::text,
                      price_micro_usdc, status::text, uptime_percent, avg_latency_ms,
                      total_requests, avg_rating, review_count, regions, endpoints,
                      receive_address, created_at
            FROM service_listings
            WHERE status::text != 'offline'
                AND search_vector @@ plainto_tsquery('english', $1)
                AND ($2::text IS NULL OR category = $2)
                AND ($3::bigint IS NULL OR price_micro_usdc <= $3)
                AND ($4::real IS NULL OR uptime_percent >= $4)
                AND ($5::real IS NULL OR avg_rating >= $5)
                AND ($6::text IS NULL OR auth_type::text = $6)
                AND ($7::text IS NULL OR $7 = ANY(regions))
            ORDER BY ts_rank(search_vector, plainto_tsquery('english', $1)) DESC,
                     uptime_percent DESC
            LIMIT $8 OFFSET $9"#,
        )
        .bind(q)
        .bind(params.category.as_deref())
        .bind(params.max_price)
        .bind(params.min_uptime)
        .bind(params.min_rating)
        .bind(params.auth_type.as_deref())
        .bind(params.region.as_deref())
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    } else {
        let order_clause = match params.sort.as_deref() {
            Some("price_asc") => "price_micro_usdc ASC",
            Some("price_desc") => "price_micro_usdc DESC",
            Some("rating") => "avg_rating DESC NULLS LAST",
            Some("uptime") => "uptime_percent DESC",
            Some("newest") => "created_at DESC",
            _ => "total_requests DESC",
        };

        // Build dynamic query with ordering
        let query = format!(
            r#"SELECT id, owner_did, name, slug, description, logo_url, website,
                      category, tags, base_url, auth_type::text, pricing_model::text,
                      price_micro_usdc, status::text, uptime_percent, avg_latency_ms,
                      total_requests, avg_rating, review_count, regions, endpoints,
                      receive_address, created_at
            FROM service_listings
            WHERE status::text != 'offline'
                AND ($1::text IS NULL OR category = $1)
                AND ($2::bigint IS NULL OR price_micro_usdc <= $2)
                AND ($3::real IS NULL OR uptime_percent >= $3)
                AND ($4::real IS NULL OR avg_rating >= $4)
                AND ($5::text IS NULL OR auth_type::text = $5)
                AND ($6::text IS NULL OR $6 = ANY(regions))
            ORDER BY {order_clause}
            LIMIT $7 OFFSET $8"#
        );

        sqlx::query_as::<_, ServiceListingResponse>(&query)
            .bind(params.category.as_deref())
            .bind(params.max_price)
            .bind(params.min_uptime)
            .bind(params.min_rating)
            .bind(params.auth_type.as_deref())
            .bind(params.region.as_deref())
            .bind(limit)
            .bind(offset)
            .fetch_all(&state.db)
            .await?
    };

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM service_listings
        WHERE status::text != 'offline'
            AND ($1::text IS NULL OR category = $1)
            AND ($2::bigint IS NULL OR price_micro_usdc <= $2)
            AND ($3::real IS NULL OR uptime_percent >= $3)
            AND ($4::real IS NULL OR avg_rating >= $4)"#,
    )
    .bind(params.category.as_deref())
    .bind(params.max_price)
    .bind(params.min_uptime)
    .bind(params.min_rating)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "services": services,
        "total": total,
        "page": page,
        "limit": limit,
    })))
}

/// GET /v1/services/{id_or_slug} (public)
pub async fn get_service(
    State(state): State<Arc<AppState>>,
    Path(id_or_slug): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    // Try parsing as UUID first, then fall back to slug lookup
    let service = if let Ok(id) = id_or_slug.parse::<Uuid>() {
        sqlx::query_as::<_, ServiceDetailResponse>(
            r#"SELECT id, owner_did, name, slug, description, logo_url, website,
                      category, tags, base_url, health_check_url, openapi_url,
                      auth_type::text, auth_details, pricing_model::text,
                      price_micro_usdc, pricing_tiers, free_tier_requests,
                      sla_uptime_percent, sla_latency_p50_ms, sla_latency_p99_ms,
                      regions, endpoints, status::text, uptime_percent, avg_latency_ms,
                      total_requests, total_revenue_micro_usdc, avg_rating, review_count,
                      receive_address, platform_fee_bps, created_at, updated_at
            FROM service_listings WHERE id = $1"#,
        )
        .bind(id)
        .fetch_optional(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, ServiceDetailResponse>(
            r#"SELECT id, owner_did, name, slug, description, logo_url, website,
                      category, tags, base_url, health_check_url, openapi_url,
                      auth_type::text, auth_details, pricing_model::text,
                      price_micro_usdc, pricing_tiers, free_tier_requests,
                      sla_uptime_percent, sla_latency_p50_ms, sla_latency_p99_ms,
                      regions, endpoints, status::text, uptime_percent, avg_latency_ms,
                      total_requests, total_revenue_micro_usdc, avg_rating, review_count,
                      receive_address, platform_fee_bps, created_at, updated_at
            FROM service_listings WHERE slug = $1"#,
        )
        .bind(&id_or_slug)
        .fetch_optional(&state.db)
        .await?
    };

    let service = service.ok_or_else(|| AppError::NotFound("Service not found".into()))?;

    // Fetch recent heartbeats
    let heartbeats: Vec<serde_json::Value> = sqlx::query_scalar(
        r#"SELECT json_build_object(
            'status', status, 'latency_ms', latency_ms,
            'status_code', status_code, 'error_message', error_message,
            'created_at', created_at
        )
        FROM service_heartbeats WHERE service_id = $1
        ORDER BY created_at DESC LIMIT 50"#,
    )
    .bind(service.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "service": service,
        "heartbeats": heartbeats,
    })))
}

/// PUT /v1/services/manage/{id} (JWT, owner only)
pub async fn update_service(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateServiceRequest>,
) -> AppResult<Json<ServiceListingResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Verify ownership
    let owner_id: Option<Uuid> =
        sqlx::query_scalar("SELECT owner_id FROM service_listings WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;

    match owner_id {
        None => return Err(AppError::NotFound("Service not found".into())),
        Some(oid) if oid != user_id => {
            return Err(AppError::Unauthorized("Not your service".into()))
        }
        _ => {}
    }

    let service = sqlx::query_as::<_, ServiceListingResponse>(
        r#"UPDATE service_listings SET
            name = COALESCE($1, name),
            description = COALESCE($2, description),
            category = COALESCE($3, category),
            tags = COALESCE($4, tags),
            base_url = COALESCE($5, base_url),
            health_check_url = COALESCE($6, health_check_url),
            openapi_url = COALESCE($7, openapi_url),
            auth_type = COALESCE($8, auth_type),
            auth_details = COALESCE($9, auth_details),
            pricing_model = COALESCE($10, pricing_model),
            price_micro_usdc = COALESCE($11, price_micro_usdc),
            pricing_tiers = COALESCE($12, pricing_tiers),
            free_tier_requests = COALESCE($13, free_tier_requests),
            sla_uptime_percent = COALESCE($14, sla_uptime_percent),
            sla_latency_p50_ms = COALESCE($15, sla_latency_p50_ms),
            sla_latency_p99_ms = COALESCE($16, sla_latency_p99_ms),
            regions = COALESCE($17, regions),
            endpoints = COALESCE($18, endpoints),
            receive_address = COALESCE($19, receive_address),
            platform_fee_bps = COALESCE($20, platform_fee_bps)
        WHERE id = $21
        RETURNING id, owner_did, name, slug, description, logo_url, website,
                  category, tags, base_url, auth_type::text, pricing_model::text,
                  price_micro_usdc, status::text, uptime_percent, avg_latency_ms,
                  total_requests, avg_rating, review_count, regions, endpoints,
                  receive_address, created_at"#,
    )
    .bind(req.name.as_deref())
    .bind(req.description.as_deref())
    .bind(req.category.as_deref())
    .bind(req.tags.as_deref())
    .bind(req.base_url.as_deref())
    .bind(req.health_check_url.as_deref())
    .bind(req.openapi_url.as_deref())
    .bind(req.auth_type.as_deref())
    .bind(&req.auth_details)
    .bind(req.pricing_model.as_deref())
    .bind(req.price_micro_usdc)
    .bind(&req.pricing_tiers)
    .bind(req.free_tier_requests)
    .bind(req.sla_uptime_percent)
    .bind(req.sla_latency_p50_ms)
    .bind(req.sla_latency_p99_ms)
    .bind(req.regions.as_deref())
    .bind(&req.endpoints)
    .bind(req.receive_address.as_deref())
    .bind(req.platform_fee_bps)
    .bind(id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(service))
}

/// DELETE /v1/services/manage/{id} (JWT, owner only — soft delete)
pub async fn delete_service(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let result = sqlx::query(
        "UPDATE service_listings SET status = 'offline' WHERE id = $1 AND owner_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(
            "Service not found or not owned by you".into(),
        ));
    }

    Ok(StatusCode::NO_CONTENT)
}

/// POST /v1/services/{id}/heartbeat (public)
pub async fn service_heartbeat(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<HeartbeatRequest>,
) -> AppResult<StatusCode> {
    sqlx::query(
        "INSERT INTO service_heartbeats (service_id, status, latency_ms, status_code) VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(&req.status)
    .bind(req.latency_ms)
    .bind(req.status_code)
    .execute(&state.db)
    .await?;

    let new_status = if req.status == "ok" {
        "active"
    } else {
        "degraded"
    };

    sqlx::query(
        r#"UPDATE service_listings SET
            last_heartbeat_at = NOW(),
            status = $1::service_status,
            consecutive_failures = CASE WHEN $2 = 'ok' THEN 0 ELSE consecutive_failures END
        WHERE id = $3"#,
    )
    .bind(new_status)
    .bind(&req.status)
    .bind(id)
    .execute(&state.db)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /v1/services/resolve (public) — "DNS for headless merchants"
pub async fn resolve_services(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ResolveServiceQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let limit = params.limit.unwrap_or(5).min(20);

    let services = sqlx::query_as::<_, ResolvedServiceResponse>(
        r#"SELECT sl.id, sl.slug, sl.name, sl.description, sl.base_url, sl.auth_type::text,
                  sl.auth_details, sl.price_micro_usdc, sl.pricing_model::text,
                  sl.uptime_percent, sl.avg_latency_ms, sl.avg_rating, sl.endpoints,
                  ts_rank(sl.search_vector, plainto_tsquery('english', $1)) AS relevance_score
        FROM service_listings sl
        LEFT JOIN reputation_scores rs ON rs.entity_did = sl.owner_did
        WHERE sl.status::text = 'active'
            AND sl.search_vector @@ plainto_tsquery('english', $1)
            AND ($2::text IS NULL OR sl.category = $2)
            AND ($3::bigint IS NULL OR sl.price_micro_usdc <= $3)
            AND ($4::real IS NULL OR sl.uptime_percent >= $4)
            AND ($5::real IS NULL OR sl.avg_rating >= $5)
            AND ($6::text IS NULL OR sl.auth_type::text = $6)
            AND ($7::text IS NULL OR $7 = ANY(sl.regions))
            AND ($8::real IS NULL OR COALESCE(rs.overall_score, 0) >= $8)
        ORDER BY relevance_score DESC, sl.uptime_percent DESC, sl.avg_rating DESC NULLS LAST
        LIMIT $9"#,
    )
    .bind(&params.task)
    .bind(params.category.as_deref())
    .bind(params.max_price_micro_usdc)
    .bind(params.min_uptime)
    .bind(params.min_rating)
    .bind(params.auth_type.as_deref())
    .bind(params.region.as_deref())
    .bind(params.min_trust_score)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "services": services })))
}

/// POST /v1/services/{id}/review (JWT protected)
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

    // Check service exists
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM service_listings WHERE id = $1)")
            .bind(id)
            .fetch_one(&state.db)
            .await?;

    if !exists {
        return Err(AppError::NotFound("Service not found".into()));
    }

    // Get reviewer DID
    let reviewer_did: Option<String> = sqlx::query_scalar(
        "SELECT COALESCE(
            (SELECT did FROM business_profiles WHERE user_id = $1),
            (SELECT did FROM public_profiles WHERE user_id = $1)
        )",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .flatten();

    // Upsert review
    sqlx::query(
        r#"INSERT INTO service_reviews (service_id, reviewer_id, reviewer_did, rating, comment,
            quality_score, reliability_score, latency_score, value_score)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (service_id, reviewer_id) DO UPDATE SET
            rating = $4, comment = $5,
            quality_score = $6, reliability_score = $7,
            latency_score = $8, value_score = $9"#,
    )
    .bind(id)
    .bind(user_id)
    .bind(&reviewer_did)
    .bind(req.rating)
    .bind(&req.comment)
    .bind(req.quality_score)
    .bind(req.reliability_score)
    .bind(req.latency_score)
    .bind(req.value_score)
    .execute(&state.db)
    .await?;

    // Update aggregate
    sqlx::query(
        r#"UPDATE service_listings SET
            avg_rating = (SELECT AVG(rating)::REAL FROM service_reviews WHERE service_id = $1),
            review_count = (SELECT COUNT(*) FROM service_reviews WHERE service_id = $1)
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

/// GET /v1/services/{id}/reviews (public)
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
            'quality_score', r.quality_score, 'reliability_score', r.reliability_score,
            'latency_score', r.latency_score, 'value_score', r.value_score,
            'reviewer_did', r.reviewer_did, 'created_at', r.created_at
        )
        FROM service_reviews r
        WHERE r.service_id = $1
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

/// POST /v1/services/{id}/payment (service-to-service)
pub async fn record_payment(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<ServicePaymentRequest>,
) -> AppResult<StatusCode> {
    sqlx::query(
        r#"INSERT INTO service_payments (service_id, payer_did, endpoint_name,
            amount_micro_usdc, merchant_share_micro_usdc, platform_share_micro_usdc,
            tx_signature)
        VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
    )
    .bind(id)
    .bind(&req.payer_did)
    .bind(&req.endpoint_name)
    .bind(req.amount_micro_usdc)
    .bind(req.merchant_share_micro_usdc)
    .bind(req.platform_share_micro_usdc)
    .bind(&req.tx_signature)
    .execute(&state.db)
    .await?;

    // Update service revenue + request count
    sqlx::query(
        "UPDATE service_listings SET total_revenue_micro_usdc = total_revenue_micro_usdc + $1, total_requests = total_requests + 1 WHERE id = $2",
    )
    .bind(req.merchant_share_micro_usdc)
    .bind(id)
    .execute(&state.db)
    .await?;

    Ok(StatusCode::CREATED)
}

/// GET /v1/services/{id}/openapi (public)
pub async fn get_openapi_spec(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let openapi_url: Option<String> =
        sqlx::query_scalar("SELECT openapi_url FROM service_listings WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?
            .flatten();

    match openapi_url {
        Some(url) => {
            // Fetch and proxy the OpenAPI spec
            let resp = state
                .http_client
                .get(&url)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| AppError::Internal(format!("Failed to fetch OpenAPI spec: {e}")))?;

            let spec: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| AppError::Internal(format!("Invalid OpenAPI JSON: {e}")))?;

            Ok(Json(spec))
        }
        None => Err(AppError::NotFound(
            "No OpenAPI spec URL configured for this service".into(),
        )),
    }
}

/// GET /v1/services/{id}/analytics (JWT protected, owner only)
pub async fn service_analytics(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Verify ownership
    let owner_id: Option<Uuid> =
        sqlx::query_scalar("SELECT owner_id FROM service_listings WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;

    match owner_id {
        None => return Err(AppError::NotFound("Service not found".into())),
        Some(oid) if oid != user_id => {
            return Err(AppError::Unauthorized("Not your service".into()))
        }
        _ => {}
    }

    // Revenue over last 30 days (daily buckets)
    let revenue_timeline: Vec<serde_json::Value> = sqlx::query_scalar(
        r#"SELECT json_build_object(
            'date', date_trunc('day', created_at)::date,
            'amount', COALESCE(SUM(amount_micro_usdc), 0),
            'requests', COALESCE(SUM(request_count), 0)
        )
        FROM metered_usage
        WHERE service_id = $1 AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY date_trunc('day', created_at)
        ORDER BY date_trunc('day', created_at)"#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    // Top agents by spend (last 30 days)
    let top_agents: Vec<serde_json::Value> = sqlx::query_scalar(
        r#"SELECT json_build_object(
            'agent_did', agent_did,
            'total_requests', SUM(request_count),
            'total_amount', SUM(amount_micro_usdc)
        )
        FROM metered_usage
        WHERE service_id = $1 AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY agent_did
        ORDER BY SUM(amount_micro_usdc) DESC
        LIMIT 10"#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    // Uptime timeline (last 24h heartbeats)
    let uptime_timeline: Vec<serde_json::Value> = sqlx::query_scalar(
        r#"SELECT json_build_object(
            'status', status, 'latency_ms', latency_ms, 'created_at', created_at
        )
        FROM service_heartbeats
        WHERE service_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY created_at"#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    // Review summary
    let review_stats: (Option<f32>, i64) = sqlx::query_as(
        "SELECT AVG(rating)::REAL, COUNT(*) FROM service_reviews WHERE service_id = $1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await
    .unwrap_or((None, 0));

    // Settlement totals
    let settled_total: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(merchant_share_micro_usdc), 0) FROM settlement_batches WHERE service_id = $1 AND status = 'pending'",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    Ok(Json(serde_json::json!({
        "service_id": id,
        "revenue_timeline": revenue_timeline,
        "top_agents": top_agents,
        "uptime_timeline": uptime_timeline,
        "avg_rating": review_stats.0,
        "review_count": review_stats.1,
        "pending_settlement_micro_usdc": settled_total,
    })))
}

/// GET /v1/services/mine (JWT protected) — returns the authenticated user's services
pub async fn my_services(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<serde_json::Value>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let services = sqlx::query_as::<_, ServiceListingResponse>(
        r#"SELECT id, owner_did, name, slug, description, logo_url, website,
                  category, tags, base_url, auth_type::text, pricing_model::text,
                  price_micro_usdc, status::text, uptime_percent, avg_latency_ms,
                  total_requests, avg_rating, review_count, regions, endpoints,
                  receive_address, created_at
        FROM service_listings
        WHERE owner_id = $1
        ORDER BY created_at DESC"#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let total_revenue: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(total_revenue_micro_usdc), 0) FROM service_listings WHERE owner_id = $1",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    let total_requests: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(total_requests), 0) FROM service_listings WHERE owner_id = $1",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "services": services,
        "total_services": services.len(),
        "total_revenue_micro_usdc": total_revenue,
        "total_requests": total_requests,
    })))
}
