use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::services::compute_service::{
    self, CommunityModel, DailyStats, EscrowInfo, ProviderInfo, ProviderRegistration,
    ProviderUpdate, RecentJob,
};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Request / response types (route-layer only)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct StatsQuery {
    #[serde(default = "default_days")]
    pub days: i32,
}

fn default_days() -> i32 {
    30
}

#[derive(Serialize)]
pub struct MessageResponse {
    pub message: String,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /api/compute/providers/register — Register the authenticated user as a
/// compute provider.
pub async fn register_provider(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<ProviderRegistration>,
) -> Result<Json<ProviderInfo>, CloudError> {
    let info = compute_service::register_provider(&state, claims.sub, req).await?;
    Ok(Json(info))
}

/// GET /api/compute/providers/me — Get the current user's provider profile.
pub async fn get_my_provider(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<ProviderInfo>, CloudError> {
    let info = compute_service::get_provider_by_user(&state.db, claims.sub)
        .await?
        .ok_or_else(|| CloudError::NotFound("no provider profile found".to_string()))?;
    Ok(Json(info))
}

/// PATCH /api/compute/providers/me — Update the current user's provider
/// configuration (models, concurrency, VRAM).
pub async fn update_my_provider(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<ProviderUpdate>,
) -> Result<Json<MessageResponse>, CloudError> {
    let provider = compute_service::get_provider_by_user(&state.db, claims.sub)
        .await?
        .ok_or_else(|| CloudError::NotFound("no provider profile found".to_string()))?;

    compute_service::update_provider(&state.db, provider.id, req).await?;

    Ok(Json(MessageResponse {
        message: "provider updated".to_string(),
    }))
}

/// GET /api/compute/providers — List all currently online providers (public).
pub async fn list_providers(
    State(state): State<AppState>,
) -> Result<Json<Vec<ProviderInfo>>, CloudError> {
    let providers = compute_service::list_online_providers(&state.db).await?;
    Ok(Json(providers))
}

/// GET /api/compute/models — List all models offered by the community (public).
pub async fn list_models(
    State(state): State<AppState>,
) -> Result<Json<Vec<CommunityModel>>, CloudError> {
    let models = compute_service::list_community_models(&state.db).await?;
    Ok(Json(models))
}

/// GET /api/compute/stats — Get earning/usage stats for the authenticated
/// provider over the last N days.
pub async fn get_stats(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Query(query): Query<StatsQuery>,
) -> Result<Json<Vec<DailyStats>>, CloudError> {
    let provider = compute_service::get_provider_by_user(&state.db, claims.sub)
        .await?
        .ok_or_else(|| CloudError::NotFound("no provider profile found".to_string()))?;

    let stats = compute_service::get_provider_stats(&state.db, provider.id, query.days).await?;
    Ok(Json(stats))
}

/// GET /api/compute/jobs — Get recent jobs for the authenticated provider.

#[derive(Deserialize)]
pub struct JobsQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    20
}

pub async fn get_recent_jobs(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Query(query): Query<JobsQuery>,
) -> Result<Json<Vec<RecentJob>>, CloudError> {
    let provider = compute_service::get_provider_by_user(&state.db, claims.sub)
        .await?
        .ok_or_else(|| CloudError::NotFound("no provider profile found".to_string()))?;

    let jobs = compute_service::get_recent_jobs(&state.db, provider.id, query.limit.min(100)).await?;
    Ok(Json(jobs))
}

/// GET /api/compute/escrow — Get active escrow entries for the authenticated
/// user.
pub async fn get_escrow(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<Vec<EscrowInfo>>, CloudError> {
    let escrows = compute_service::get_active_escrows(&state.db, claims.sub).await?;
    Ok(Json(escrows))
}

