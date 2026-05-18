//! x402 discovery routes — unauthenticated endpoints for browsing agents
//! with x402 payment pricing.

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

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

/// GET /.well-known/x402.json — crawler-friendly x402 discovery manifest.
pub async fn well_known_manifest(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, CloudError> {
    let resources = discovery_resources_value(&state).await?;
    let base_url = state.config.base_url.trim_end_matches('/').to_string();

    Ok(Json(json!({
        "x402Version": 2,
        "name": "Ghola",
        "description": "Ghola agent marketplace and intent front-end for paid agent execution over x402.",
        "homepage": base_url,
        "resourceServer": base_url,
        "discovery": {
            "resources": format!("{base_url}/x402/resources"),
            "agents": format!("{base_url}/x402/agents")
        },
        "endpoints": {
            "openaiCompatible": format!("{base_url}/v1/chat/completions"),
            "models": format!("{base_url}/v1/models"),
            "agents": format!("{base_url}/x402/agents")
        },
        "extensions": {
            "bazaar": {
                "supported": true,
                "resources": format!("{base_url}/x402/resources")
            },
            "payment-identifier": {
                "supported": true,
                "required": false
            }
        },
        "resources": resources,
    })))
}

/// GET /x402/resources — Bazaar-style paid resources for x402 clients.
pub async fn list_resources(State(state): State<AppState>) -> Result<Json<Value>, CloudError> {
    let resources = discovery_resources_value(&state).await?;
    Ok(Json(json!({
        "x402Version": 2,
        "items": resources,
    })))
}

async fn discovery_resources_value(state: &AppState) -> Result<Value, CloudError> {
    let base_url = state.config.base_url.trim_end_matches('/').to_string();
    let agents = x402_service::list_agent_pricing(&state.db, state, None, Some("rating")).await?;
    let mut items = Vec::with_capacity(agents.len());

    for agent in agents {
        let agent_info =
            crate::services::agent_service::get_public_agent(&state.db, &agent.slug).await?;
        let resource = format!("{base_url}/v1/chat/completions");
        let requirements = x402_service::build_payment_requirements_for_resource(
            state,
            agent_info.id,
            &agent.slug,
            &agent.model_id,
            agent.price_per_1k_input,
            agent.price_per_1k_output,
            1000,
            &resource,
            "POST",
            None,
        );

        items.push(json!({
            "type": "api",
            "name": format!("ghola.agent.{}", agent.slug),
            "title": agent.display_name,
            "description": agent.description,
            "url": resource,
            "method": "POST",
            "mimeType": "application/json",
            "accepts": requirements.accepts,
            "extensions": requirements.extensions,
            "metadata": {
                "provider": "ghola",
                "agentSlug": agent.slug,
                "model": format!("agent:{}", agent.slug),
                "modelId": agent.model_id,
                "tags": agent.tags,
                "tools": agent.tools,
                "providerReputation": agent.provider_reputation,
                "pricePerRequestMicroUsdc": agent.price_per_request_usdc
            },
            "input": {
                "model": format!("agent:{}", agent.slug),
                "messages": [
                    {
                        "role": "user",
                        "content": "Describe what you can do."
                    }
                ]
            },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "model": {
                        "type": "string",
                        "const": format!("agent:{}", agent.slug)
                    },
                    "messages": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "role": {
                                    "type": "string",
                                    "enum": ["system", "user", "assistant"]
                                },
                                "content": {
                                    "type": "string"
                                }
                            },
                            "required": ["role", "content"]
                        }
                    },
                    "max_tokens": {
                        "type": "integer",
                        "minimum": 1
                    }
                },
                "required": ["model", "messages"]
            }
        }));
    }

    Ok(Value::Array(items))
}
