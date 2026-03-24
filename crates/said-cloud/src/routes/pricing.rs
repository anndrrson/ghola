use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::state::AppState;

/// SAID API pricing catalog — machine-readable pricing for all paid endpoints.
/// This is what makes Ghola a headless merchant.

#[derive(Debug, Clone, Serialize)]
pub struct PricedEndpoint {
    pub path: &'static str,
    pub method: &'static str,
    pub description: &'static str,
    pub price_micro_usdc: i64,
    pub free_tier_per_day: i32,
    pub auth: &'static str,
}

/// The canonical pricing table for SAID's own APIs.
pub fn pricing_catalog() -> Vec<PricedEndpoint> {
    vec![
        PricedEndpoint {
            path: "/v1/verify/agent",
            method: "POST",
            description: "Verify an agent's identity, UCAN capabilities, and trust score",
            price_micro_usdc: 1000, // $0.001
            free_tier_per_day: 100,
            auth: "X-Service-Key",
        },
        PricedEndpoint {
            path: "/v1/verify/capability",
            method: "POST",
            description: "Quick check: does this agent's UCAN grant a specific capability",
            price_micro_usdc: 500, // $0.0005
            free_tier_per_day: 200,
            auth: "X-Service-Key",
        },
        PricedEndpoint {
            path: "/v1/reputation/{did}",
            method: "GET",
            description: "Get composite trust score and reputation breakdown for any DID",
            price_micro_usdc: 500, // $0.0005
            free_tier_per_day: 200,
            auth: "none",
        },
        PricedEndpoint {
            path: "/v1/services/resolve",
            method: "GET",
            description: "Search and rank services by task, price, quality, trust score",
            price_micro_usdc: 2000, // $0.002
            free_tier_per_day: 50,
            auth: "none",
        },
        PricedEndpoint {
            path: "/v1/resolve/{did_or_handle}",
            method: "GET",
            description: "Resolve an identity by DID or handle, including registered services",
            price_micro_usdc: 1000, // $0.001
            free_tier_per_day: 100,
            auth: "none",
        },
        PricedEndpoint {
            path: "/v1/delegation/verify-chain",
            method: "POST",
            description: "Verify a full UCAN delegation chain with revocation checking",
            price_micro_usdc: 2000, // $0.002
            free_tier_per_day: 50,
            auth: "X-Service-Key",
        },
        PricedEndpoint {
            path: "/v1/delegation/check",
            method: "GET",
            description: "Check if a specific UCAN token has been revoked",
            price_micro_usdc: 200, // $0.0002
            free_tier_per_day: 500,
            auth: "none",
        },
        PricedEndpoint {
            path: "/v1/verify/did/{did}",
            method: "GET",
            description: "Simple DID existence lookup — does this identity exist in SAID",
            price_micro_usdc: 200, // $0.0002
            free_tier_per_day: 500,
            auth: "none",
        },
        PricedEndpoint {
            path: "/v1/discover",
            method: "GET",
            description: "Discover a business by domain — fetch agents.txt and .well-known/said.json",
            price_micro_usdc: 5000, // $0.005
            free_tier_per_day: 20,
            auth: "none",
        },
    ]
}

/// GET /v1/pricing (public)
/// Machine-readable pricing catalog. This is the headless merchant schema.
pub async fn get_pricing(
    State(_state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let catalog = pricing_catalog();
    let total_endpoints = catalog.len();

    Json(serde_json::json!({
        "protocol": "ghola",
        "version": "1.0",
        "currency": "USDC",
        "currency_decimals": 6,
        "settlement": "solana",
        "payment_methods": ["service_key_metered", "usdc_prepaid"],
        "platform_address": std::env::var("ESCROW_WALLET_ADDRESS").unwrap_or_default(),
        "total_endpoints": total_endpoints,
        "endpoints": catalog,
        "free_tier": {
            "description": "All endpoints have a daily free tier. No API key required for free tier.",
            "reset": "daily at 00:00 UTC",
        },
        "metering": {
            "description": "Usage beyond free tier is metered via service API keys. Settlements processed hourly.",
            "docs_url": "https://ghola.xyz/developers",
        },
    }))
}

/// GET /v1/pricing/{endpoint_path} (public)
/// Get pricing for a specific endpoint.
pub async fn get_endpoint_pricing(
    State(_state): State<Arc<AppState>>,
    axum::extract::Path(path): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    let catalog = pricing_catalog();
    let normalized = format!("/v1/{}", path);

    let endpoint = catalog.iter().find(|e| {
        // Match exact or with path params stripped
        e.path == normalized
            || e.path.split('{').next().unwrap_or("").trim_end_matches('/') == normalized
    });

    match endpoint {
        Some(ep) => Json(serde_json::json!({
            "path": ep.path,
            "method": ep.method,
            "description": ep.description,
            "price_micro_usdc": ep.price_micro_usdc,
            "price_usdc": ep.price_micro_usdc as f64 / 1_000_000.0,
            "free_tier_per_day": ep.free_tier_per_day,
            "auth": ep.auth,
        })),
        None => Json(serde_json::json!({
            "error": "Endpoint not found in pricing catalog",
            "path": normalized,
        })),
    }
}
