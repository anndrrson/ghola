//! IP-based rate limiting middleware.
//!
//! Unauthenticated (public) requests: 30 req/min per IP.
//! Authenticated requests (Bearer token present): 300 req/min per IP.
//!
//! IP is extracted from X-Forwarded-For (for reverse-proxied deployments)
//! with fallback to ConnectInfo<SocketAddr>.

use axum::extract::{ConnectInfo, Request};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::net::SocketAddr;
use std::sync::Arc;

use crate::error::AppError;
use crate::state::AppState;

pub async fn ip_rate_limit(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    let ip = client_ip(&req);

    let is_authenticated = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.starts_with("Bearer "))
        .unwrap_or(false);

    let (limit, tier) = if is_authenticated {
        (300u32, "auth")
    } else {
        (30u32, "pub")
    };

    let rate_key = format!("ip:{tier}:{ip}");

    match state.rate_limiter.check(&rate_key, limit) {
        Ok(()) => next.run(req).await,
        Err(retry_after) => AppError::TooManyRequests(retry_after).into_response(),
    }
}

fn client_ip(req: &Request) -> String {
    // Prefer the leftmost IP from X-Forwarded-For (the original client IP)
    req.headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .or_else(|| {
            req.extensions()
                .get::<ConnectInfo<SocketAddr>>()
                .map(|ci| ci.0.ip().to_string())
        })
        .unwrap_or_else(|| "unknown".to_string())
}
