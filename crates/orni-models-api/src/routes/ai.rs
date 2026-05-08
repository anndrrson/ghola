use std::sync::Arc;
use std::time::Instant;

use axum::extract::State;
use axum::http::header::AUTHORIZATION;
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};

use crate::auth::validate_jwt;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const GUEST_RATE_LIMIT: usize = 20;
const GUEST_WINDOW_SECS: u64 = 3600; // 1 hour

/// GET /api/ai
///
/// If JWT present + valid -> returns Anthropic key + claude model + generous limit.
/// If no JWT (guest) -> returns Together.ai key + llama model + tight rate limit.
pub async fn get_ai_key(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    // Try to extract and validate JWT (optional)
    let claims = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .and_then(|token| validate_jwt(token, &state.config.jwt_secret).ok());

    if let Some(_claims) = claims {
        // Authenticated user -> Anthropic key
        if state.config.anthropic_api_key.is_empty() {
            return Err(AppError::Internal(
                "Anthropic API key not configured".into(),
            ));
        }
        return Ok(Json(json!({
            "key": state.config.anthropic_api_key,
            "model": "claude-sonnet-4-6",
        })));
    }

    // Guest path -> Together.ai key with rate limiting
    if state.config.together_api_key.is_empty() {
        return Err(AppError::Internal("Together API key not configured".into()));
    }

    // Rate limit by connecting IP (use X-Forwarded-For if behind proxy, else peer addr)
    let ip = extract_ip(&headers);
    {
        let mut limits = state.guest_rate_limits.lock().await;
        let now = Instant::now();
        let window = std::time::Duration::from_secs(GUEST_WINDOW_SECS);

        let timestamps = limits.entry(ip).or_default();
        timestamps.retain(|t| now.duration_since(*t) < window);

        if timestamps.len() >= GUEST_RATE_LIMIT {
            return Err(AppError::BadRequest(
                "Rate limit reached. Sign in for unlimited access.".into(),
            ));
        }
        timestamps.push(now);
    }

    Ok(Json(json!({
        "key": state.config.together_api_key,
        "model": state.config.default_base_model,
    })))
}

fn extract_ip(headers: &HeaderMap) -> std::net::IpAddr {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or_else(|| "127.0.0.1".parse().unwrap())
}
