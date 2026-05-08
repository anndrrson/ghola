use std::sync::Arc;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::http::{header, StatusCode};

use crate::error::AppResult;
use crate::state::AppState;

/// Minimal model info for agents.txt
#[derive(Debug, sqlx::FromRow)]
struct LiveModel {
    slug: String,
    name: String,
    description: Option<String>,
    category: Option<String>,
    price_per_query: i64,
    free_queries_per_day: i32,
}

/// GET /agents.txt — Dynamic agents.txt listing all live models
pub async fn agents_txt(
    State(state): State<Arc<AppState>>,
) -> AppResult<Response> {
    let models = sqlx::query_as::<_, LiveModel>(
        "SELECT slug, name, description, category, price_per_query, free_queries_per_day FROM models WHERE status = 'live' ORDER BY total_queries DESC",
    )
    .fetch_all(&state.db)
    .await?;

    let base_url = &state.config.frontend_url;
    let platform_did = &state.config.platform_did;

    let mut txt = String::new();
    txt.push_str("# Orni Models - AI Model Marketplace\n");
    txt.push_str(&format!("# {}\n", base_url));
    txt.push_str(&format!("# DID: {}\n", platform_did));
    txt.push_str("#\n");
    txt.push_str("# Each model is an AI agent available via OpenAI-compatible API\n");
    txt.push_str("# Authentication: Bearer API key (obtain at /account)\n\n");

    for model in &models {
        txt.push_str(&format!("## {}\n", model.name));
        if let Some(ref desc) = model.description {
            txt.push_str(&format!("# {}\n", desc.replace('\n', " ")));
        }
        txt.push_str(&format!("Agent: {}\n", model.slug));
        txt.push_str(&format!("Endpoint: {}/v1/chat/completions\n", base_url.trim_end_matches('/')));
        txt.push_str(&format!("Model: {}\n", model.slug));
        txt.push_str("Protocol: openai\n");
        if let Some(ref cat) = model.category {
            txt.push_str(&format!("Category: {}\n", cat));
        }
        let price_usd = model.price_per_query as f64 / 1_000_000.0;
        txt.push_str(&format!("Price: ${:.4}/query\n", price_usd));
        if model.free_queries_per_day > 0 {
            txt.push_str(&format!("FreeTier: {}/day\n", model.free_queries_per_day));
        }
        txt.push('\n');
    }

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        txt,
    ).into_response())
}

/// GET /.well-known/said.json — Machine-readable service definitions
pub async fn well_known_said(
    State(state): State<Arc<AppState>>,
) -> AppResult<axum::Json<serde_json::Value>> {
    let models = sqlx::query_as::<_, LiveModel>(
        "SELECT slug, name, description, category, price_per_query, free_queries_per_day FROM models WHERE status = 'live' ORDER BY total_queries DESC",
    )
    .fetch_all(&state.db)
    .await?;

    let base_url = &state.config.frontend_url;

    let services: Vec<serde_json::Value> = models
        .iter()
        .map(|m| {
            let price_usd = m.price_per_query as f64 / 1_000_000.0;
            serde_json::json!({
                "id": m.slug,
                "name": m.name,
                "description": m.description,
                "category": m.category,
                "endpoint": format!("{}/v1/chat/completions", base_url.trim_end_matches('/')),
                "protocol": "openai",
                "model": m.slug,
                "pricing": {
                    "per_query_usd": price_usd,
                    "free_tier_per_day": m.free_queries_per_day,
                },
                "auth": {
                    "type": "bearer",
                    "description": "API key obtained from Orni Models account",
                }
            })
        })
        .collect();

    Ok(axum::Json(serde_json::json!({
        "did": state.config.platform_did,
        "name": "Orni Models",
        "description": "Creator AI model marketplace",
        "url": base_url,
        "services": services,
    })))
}

/// GET /openapi.json — Minimal OpenAPI spec for x402 agent discovery
pub async fn openapi_json(
    State(state): State<Arc<AppState>>,
) -> axum::Json<serde_json::Value> {
    let pay_to = &state.config.escrow_wallet_address;
    axum::Json(serde_json::json!({
        "openapi": "3.0.3",
        "info": {
            "title": "Ghola AI Inference API",
            "version": "1.0.0",
            "description": "Chat with any open-source AI model. Pay per request via x402.",
            "x-guidance": "Send a POST to /v1/chat/completions with a model name and messages array. Without payment, you get a 402 with stablecoin (USDT/USDC) payment instructions on Solana."
        },
        "servers": [{"url": "https://orni-models-api.onrender.com"}],
        "paths": {
            "/v1/chat/completions": {
                "post": {
                    "summary": "Chat completion (OpenAI-compatible)",
                    "x-payment-info": {
                        "price": {"mode": "fixed", "currency": "USD", "amount": "0.05"},
                        "protocols": [{"x402": {}}]
                    },
                    "requestBody": {
                        "required": true,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["model", "messages"],
                                    "properties": {
                                        "model": {"type": "string", "description": "Model slug (e.g. llama-3-8b, qwen-32b, deepseek-r1-120b)"},
                                        "messages": {
                                            "type": "array",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "role": {"type": "string", "enum": ["system", "user", "assistant"]},
                                                    "content": {"type": "string"}
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {"description": "SSE stream of chat completion chunks"},
                        "402": {"description": "Payment Required — x402 payment instructions in header"}
                    }
                }
            }
        }
    }))
}

/// GET /.well-known/x402 — x402 discovery endpoint
/// Lists all payable routes with pricing info for x402scan registration.
pub async fn well_known_x402(
    State(state): State<Arc<AppState>>,
) -> axum::Json<serde_json::Value> {
    let pay_to = &state.config.escrow_wallet_address;
    let accepted: Vec<String> = state
        .config
        .accepted_tokens
        .iter()
        .filter(|t| !t.paused)
        .map(|t| t.symbol.clone())
        .collect();
    axum::Json(serde_json::json!({
        "version": 1,
        "resources": [
            "POST /v1/chat/completions",
            "GET /v1/chat/completions"
        ],
        "x-payment-info": {
            "price": {
                "mode": "fixed",
                // Pricing is denominated in USD; the platform debits a 1:1
                // amount from whichever stablecoin the user pays in.
                "currency": "USD",
                "amount": "0.05"
            },
            "currencies": accepted,
            "primary_currency": &state.config.primary_token,
            "protocols": [{ "x402": {} }],
            "payTo": pay_to,
            "network": &state.config.x402_network
        }
    }))
}
