//! Metered middleware — adds pricing headers to API responses.
//!
//! Every response from a paid endpoint includes:
//! - X-Price-Micro-USDC: the price of this call
//! - X-Currency: USDC
//! - X-Free-Remaining: how many free calls remain today for this IP/key
//! - X-Payment-Address: Solana address for USDC payments
//!
//! This is what makes SAID a headless merchant per the MPP pattern.

use axum::extract::Request;
use axum::http::HeaderValue;
use axum::middleware::Next;
use axum::response::Response;
use std::sync::Arc;

use crate::state::AppState;

/// Middleware that adds pricing headers to every response.
/// Doesn't block requests — just informs the caller of the cost.
pub async fn pricing_headers(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();

    let mut response = next.run(req).await;

    // Look up pricing for this endpoint
    let price = match_endpoint_price(&path);

    if let Some((price_micro, free_tier)) = price {
        let headers = response.headers_mut();

        if let Ok(v) = HeaderValue::from_str(&price_micro.to_string()) {
            headers.insert("X-Price-Micro-USDC", v);
        }
        headers.insert("X-Currency", HeaderValue::from_static("USDC"));
        if let Ok(v) = HeaderValue::from_str(&free_tier.to_string()) {
            headers.insert("X-Free-Tier-Daily", v);
        }

        let addr = state.config.base_url.as_str();
        if let Ok(v) = HeaderValue::from_str(&format!("{}/v1/pricing", addr)) {
            headers.insert("X-Pricing-Url", v);
        }

        // Add payment address if configured
        if let Ok(addr) = std::env::var("ESCROW_WALLET_ADDRESS") {
            if let Ok(v) = HeaderValue::from_str(&addr) {
                headers.insert("X-Payment-Address", v);
            }
        }
    }

    response
}

/// Match a request path to its price. Returns (price_micro_usdc, free_tier_per_day).
fn match_endpoint_price(path: &str) -> Option<(i64, i32)> {
    // Exact matches first, then prefix matches for parameterized routes
    match path {
        "/v1/services/resolve" => Some((2000, 50)),
        "/v1/verify/agent" => Some((1000, 100)),
        "/v1/verify/capability" => Some((500, 200)),
        "/v1/delegation/verify-chain" => Some((2000, 50)),
        "/v1/delegation/check" => Some((200, 500)),
        "/v1/discover" => Some((5000, 20)),
        _ => {
            // Parameterized routes
            if path.starts_with("/v1/reputation/") {
                Some((500, 200))
            } else if path.starts_with("/v1/resolve/") {
                Some((1000, 100))
            } else if path.starts_with("/v1/verify/did/") {
                Some((200, 500))
            } else {
                None // Not a priced endpoint
            }
        }
    }
}
