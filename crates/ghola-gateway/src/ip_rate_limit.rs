use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::RETRY_AFTER;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use dashmap::DashMap;

use crate::state::AppState;

pub struct IpRateLimiter {
    hits: DashMap<String, Vec<Instant>>,
}

impl IpRateLimiter {
    pub fn new() -> Self {
        Self {
            hits: DashMap::new(),
        }
    }

    pub fn check(&self, key: &str, max_per_minute: u32) -> Result<(), u64> {
        let now = Instant::now();
        let window = Duration::from_secs(60);

        let mut entry = self.hits.entry(key.to_string()).or_default();
        entry.retain(|t| now.duration_since(*t) < window);

        if entry.len() >= max_per_minute.max(1) as usize {
            let retry_after = entry
                .first()
                .map(|t| {
                    window
                        .saturating_sub(now.duration_since(*t))
                        .as_secs()
                        .max(1)
                })
                .unwrap_or(1);
            return Err(retry_after);
        }

        entry.push(now);
        Ok(())
    }
}

pub async fn ip_rate_limit(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    let ip = client_ip(&req, state.config.trust_proxy_headers);
    let key = format!("gateway:{ip}");

    match state
        .ip_rate_limiter
        .check(&key, state.config.rate_limit_per_minute)
    {
        Ok(()) => next.run(req).await,
        Err(retry_after) => {
            let mut response = (
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                "rate limit exceeded",
            )
                .into_response();
            if let Ok(v) = axum::http::HeaderValue::from_str(&retry_after.to_string()) {
                response.headers_mut().insert(RETRY_AFTER, v);
            }
            response
        }
    }
}

fn client_ip(req: &Request, trust_proxy_headers: bool) -> String {
    if trust_proxy_headers {
        if let Some(ip) = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').next())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            return ip;
        }
    }

    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}
