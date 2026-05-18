//! Agent rental marketplace routes.

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::services::agent_service::{
    self, AgentInfo, BrowseQuery, CreateAgentRequest, PublicAgentInfo, SessionInfo,
    UpdateAgentRequest,
};
use crate::services::compute_service;
use crate::state::AppState;

#[derive(Serialize)]
pub struct MessageResponse {
    pub message: String,
}

// ---------------------------------------------------------------------------
// Provider endpoints (must own a compute_provider)
// ---------------------------------------------------------------------------

/// POST /api/agents — Create a new agent.
pub async fn create_agent(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<CreateAgentRequest>,
) -> Result<Json<AgentInfo>, CloudError> {
    let provider = compute_service::get_provider_by_user(&state.db, claims.sub)
        .await?
        .ok_or_else(|| {
            CloudError::BadRequest(
                "you must register as a compute provider before creating agents".into(),
            )
        })?;

    let agent = agent_service::create_agent(&state.db, provider.id, req).await?;
    Ok(Json(agent))
}

/// GET /api/agents/mine — List all agents owned by the caller's provider.
pub async fn list_my_agents(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<Vec<AgentInfo>>, CloudError> {
    let provider = compute_service::get_provider_by_user(&state.db, claims.sub)
        .await?
        .ok_or_else(|| CloudError::NotFound("no provider profile found".into()))?;

    let agents = agent_service::list_provider_agents(&state.db, provider.id).await?;
    Ok(Json(agents))
}

/// PATCH /api/agents/{id} — Update an agent (ownership check).
pub async fn update_agent(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateAgentRequest>,
) -> Result<Json<AgentInfo>, CloudError> {
    let provider = compute_service::get_provider_by_user(&state.db, claims.sub)
        .await?
        .ok_or_else(|| CloudError::NotFound("no provider profile found".into()))?;

    let agent = agent_service::update_agent(&state.db, id, provider.id, req).await?;
    Ok(Json(agent))
}

/// DELETE /api/agents/{id} — Soft-delete an agent (ownership check).
pub async fn delete_agent(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<MessageResponse>, CloudError> {
    let provider = compute_service::get_provider_by_user(&state.db, claims.sub)
        .await?
        .ok_or_else(|| CloudError::NotFound("no provider profile found".into()))?;

    agent_service::delete_agent(&state.db, id, provider.id).await?;
    Ok(Json(MessageResponse {
        message: "agent deactivated".into(),
    }))
}

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------

/// GET /api/agents — Browse public agents.
pub async fn list_agents(
    State(state): State<AppState>,
    Query(query): Query<BrowseQuery>,
) -> Result<Json<Vec<PublicAgentInfo>>, CloudError> {
    let agents = agent_service::list_public_agents(&state.db, &query).await?;
    Ok(Json(agents))
}

/// GET /api/agents/{slug_or_id} — Get public agent detail (no system_prompt).
pub async fn get_agent(
    State(state): State<AppState>,
    Path(slug_or_id): Path<String>,
) -> Result<Json<PublicAgentInfo>, CloudError> {
    let agent = agent_service::get_public_agent(&state.db, &slug_or_id).await?;
    Ok(Json(agent))
}

// ---------------------------------------------------------------------------
// User endpoints (auth required)
// ---------------------------------------------------------------------------

/// GET /api/agents/{slug_or_id}/sessions — List user's sessions with this agent.
pub async fn list_sessions(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(slug_or_id): Path<String>,
) -> Result<Json<Vec<SessionInfo>>, CloudError> {
    let agent_id = resolve_agent_id(&state, &slug_or_id).await?;
    let sessions = agent_service::list_user_sessions(&state.db, claims.sub, Some(agent_id)).await?;
    Ok(Json(sessions))
}

#[derive(Deserialize)]
pub struct RateRequest {
    pub session_id: Uuid,
    pub rating: i32,
    pub feedback: Option<String>,
}

/// POST /api/agents/{slug_or_id}/rate — Rate an agent.
pub async fn rate_agent(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(slug_or_id): Path<String>,
    Json(req): Json<RateRequest>,
) -> Result<Json<MessageResponse>, CloudError> {
    let agent_id = resolve_agent_id(&state, &slug_or_id).await?;

    agent_service::rate_agent(
        &state.db,
        claims.sub,
        req.session_id,
        agent_id,
        req.rating,
        req.feedback,
    )
    .await?;

    Ok(Json(MessageResponse {
        message: "rating submitted".into(),
    }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolve a slug or UUID to an agent ID.
async fn resolve_agent_id(state: &AppState, slug_or_id: &str) -> Result<Uuid, CloudError> {
    if let Ok(id) = slug_or_id.parse::<Uuid>() {
        // Verify it exists
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rental_agents WHERE id = $1)")
                .bind(id)
                .fetch_one(&state.db)
                .await
                .unwrap_or(false);

        if exists {
            return Ok(id);
        }
    }

    // Try by slug
    let id: Uuid = sqlx::query_scalar("SELECT id FROM rental_agents WHERE slug = $1")
        .bind(slug_or_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| CloudError::NotFound("agent not found".into()))?;

    Ok(id)
}
