//! x402 discovery routes — unauthenticated endpoints for browsing agents
//! with x402 payment pricing.

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;

use crate::error::CloudError;
use crate::services::x402_service;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct AgentListQuery {
    pub tags: Option<String>,
    pub sort: Option<String>,
}

/// GET /x402/agents — browse all agents with x402 pricing info.
pub async fn list_agents(
    State(state): State<AppState>,
    Query(query): Query<AgentListQuery>,
) -> Result<Json<Vec<x402_service::AgentPricing>>, CloudError> {
    let agents = x402_service::list_agent_pricing(
        &state.db,
        &state,
        query.tags.as_deref(),
        query.sort.as_deref(),
    )
    .await?;

    Ok(Json(agents))
}

/// GET /x402/agents/{slug} — single agent pricing + pre-built payment requirements.
pub async fn get_agent(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Json<serde_json::Value>, CloudError> {
    let pricing = x402_service::get_agent_pricing(&state.db, &state, &slug).await?;

    // Also look up agent_id for the payment requirements
    let agent_info = crate::services::agent_service::get_public_agent(&state.db, &slug).await?;

    let requirements = x402_service::build_payment_requirements(
        &state,
        agent_info.id,
        &pricing.slug,
        &pricing.model_id,
        pricing.price_per_1k_input,
        pricing.price_per_1k_output,
        1000, // default max_tokens for pricing estimate
    );

    Ok(Json(serde_json::json!({
        "agent": pricing,
        "payment_requirements": requirements,
    })))
}
