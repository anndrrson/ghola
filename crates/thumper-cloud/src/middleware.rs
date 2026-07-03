use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::error::CloudError;
use crate::state::AppState;

/// In-memory rate limiter: tracks request counts per user per minute window.
#[derive(Clone, Default)]
pub struct RateLimiter {
    /// Map of user_id -> (window_start_epoch_minute, request_count)
    windows: Arc<Mutex<HashMap<uuid::Uuid, (i64, u32)>>>,
}

/// IP-based rate limiter for unauthenticated requests (x402, discovery).
#[derive(Clone, Default)]
pub struct IpRateLimiter {
    windows: Arc<Mutex<HashMap<std::net::IpAddr, (i64, u32)>>>,
}

impl IpRateLimiter {
    const MAX_PER_MIN: u32 = 30;

    pub async fn check(&self, ip: std::net::IpAddr) -> Result<(), CloudError> {
        let now_minute = chrono::Utc::now().timestamp() / 60;
        let mut windows = self.windows.lock().await;
        let entry = windows.entry(ip).or_insert((now_minute, 0));
        if entry.0 != now_minute {
            *entry = (now_minute, 1);
            return Ok(());
        }
        entry.1 += 1;
        if entry.1 > Self::MAX_PER_MIN {
            return Err(CloudError::RateLimit);
        }
        Ok(())
    }

    pub async fn cleanup(&self) {
        let now_minute = chrono::Utc::now().timestamp() / 60;
        let mut windows = self.windows.lock().await;
        windows.retain(|_, (window, _)| *window >= now_minute - 1);
    }
}

impl RateLimiter {
    /// Check if a request is allowed for the given user and tier.
    /// Returns Ok(()) if allowed, Err(CloudError::RateLimit) if exceeded.
    pub async fn check(&self, user_id: uuid::Uuid, tier: &str) -> Result<(), CloudError> {
        let max_per_min = match tier {
            "trial_pack" => 120,
            "starter" => 180,
            "pro" | "private_agent" => 300,
            "unlimited" | "enterprise" => 1000,
            _ => 60, // free
        };

        let now_minute = chrono::Utc::now().timestamp() / 60;
        let mut windows = self.windows.lock().await;

        let entry = windows.entry(user_id).or_insert((now_minute, 0));
        if entry.0 != now_minute {
            // New window — reset
            *entry = (now_minute, 1);
            return Ok(());
        }

        entry.1 += 1;
        if entry.1 > max_per_min {
            return Err(CloudError::RateLimit);
        }

        Ok(())
    }

    /// Periodically clean up stale entries (call from a background task).
    pub async fn cleanup(&self) {
        let now_minute = chrono::Utc::now().timestamp() / 60;
        let mut windows = self.windows.lock().await;
        windows.retain(|_, (window, _)| *window >= now_minute - 1);
    }
}

/// Double-submit CSRF defense for cookie-authenticated requests.
///
/// Threat model: SameSite=Lax stops most cross-site POSTs, but not every
/// case (top-level form submits, subdomain confusion, future browser
/// quirks). When the request is cookie-authenticated (i.e. carries
/// `ghola_session` but NO `Authorization: Bearer …`) we require the
/// `X-CSRF-Token` header to match the `ghola_csrf` cookie that was set at
/// session creation. Mismatched / missing → 403.
///
/// Bearer-authenticated callers (mobile, CLI, server-to-server, OpenAI-
/// compat clients hitting `/v1/chat/completions` with an API key) bypass
/// the check — they can't be forced into a cross-site request from a
/// victim's browser.
///
/// The auth endpoints themselves (`/api/auth/*`) ALSO bypass because the
/// CSRF token doesn't exist yet at sign-in time; SameSite=Lax + the
/// `cross-site request rejected` origin check in the Next.js layer cover
/// those routes.
pub async fn csrf_protect(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    // Read-only methods don't need protection.
    if matches!(
        method,
        axum::http::Method::GET
            | axum::http::Method::HEAD
            | axum::http::Method::OPTIONS
            | axum::http::Method::TRACE
    ) {
        return next.run(request).await;
    }

    let headers = request.headers();
    let path = request.uri().path().to_string();

    // Bypass auth endpoints (no CSRF token exists at sign-in time).
    if path.starts_with("/api/auth/") {
        return next.run(request).await;
    }

    let has_bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("Bearer "))
        .unwrap_or(false);
    if has_bearer {
        // Bearer-auth callers (mobile/CLI/API-key) are not cookie-authed
        // and therefore not in the CSRF attack surface.
        return next.run(request).await;
    }

    let cookie_token =
        crate::auth::extract_cookie_value(headers, crate::auth::CSRF_COOKIE_NAME);
    let session_present =
        crate::auth::extract_cookie_value(headers, crate::auth::SESSION_COOKIE_NAME).is_some();
    if !session_present {
        // No session → let the normal extractor return its own 401.
        return next.run(request).await;
    }

    let header_token = headers
        .get(crate::auth::CSRF_HEADER_NAME)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let valid = match (cookie_token.as_deref(), header_token.as_deref()) {
        (Some(c), Some(h)) if !c.is_empty() && c == h => true,
        _ => false,
    };

    if !valid {
        tracing::warn!(path = %path, "csrf check failed: cookie/header mismatch");
        return CloudError::Auth("CSRF token missing or mismatched".to_string()).into_response();
    }

    next.run(request).await
}

/// Middleware that tracks API usage for requests authenticated with API keys
/// and enforces per-minute rate limits.
pub async fn track_api_usage(state: AppState, request: Request, next: Next) -> Response {
    // Check if this is an API-key-authenticated request
    let is_api_key = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(|t| t.starts_with("sk-ghola-"))
        .unwrap_or(false);

    let user_id = if is_api_key {
        // Re-extract the API key and look up the user
        let key = request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .map(|s| s.to_string());

        if let Some(key) = key {
            let mut hasher = Sha256::new();
            hasher.update(key.as_bytes());
            let key_hash = format!("{:x}", hasher.finalize());

            sqlx::query_as::<_, (uuid::Uuid,)>(
                "SELECT user_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
            )
            .bind(&key_hash)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .map(|r| r.0)
        } else {
            None
        }
    } else {
        None
    };

    // Enforce rate limiting for API key users
    if let Some(uid) = user_id {
        // Look up tier
        let tier: String =
            sqlx::query_scalar("SELECT COALESCE(tier, 'free') FROM users WHERE id = $1")
                .bind(uid)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten()
                .unwrap_or_else(|| "free".to_string());

        if let Err(e) = state.rate_limiter.check(uid, &tier).await {
            return e.into_response();
        }
    }

    // Rate limit unauthenticated requests by IP (prevents x402 RPC DoS)
    if user_id.is_none() {
        if let Some(ip) = extract_client_ip(&request) {
            if let Err(e) = state.ip_rate_limiter.check(ip).await {
                return e.into_response();
            }
        }
    }

    let response = next.run(request).await;

    // Fire-and-forget: increment API call count
    if let Some(uid) = user_id {
        let db = state.db.clone();
        tokio::spawn(async move {
            let period_start = chrono::Utc::now()
                .date_naive()
                .format("%Y-%m-01")
                .to_string();
            let _ = sqlx::query(
                r#"
                INSERT INTO usage_tracking (user_id, period_start, api_call_count)
                VALUES ($1, $2::date, 1)
                ON CONFLICT (user_id, period_start) DO UPDATE
                SET api_call_count = usage_tracking.api_call_count + 1
                "#,
            )
            .bind(uid)
            .bind(&period_start)
            .execute(&db)
            .await;
        });
    }

    response
}

fn extract_client_ip(request: &Request) -> Option<std::net::IpAddr> {
    // Check x-forwarded-for first (behind reverse proxy)
    request
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.trim().parse().ok())
        // Fallback: ConnectInfo (direct connection)
        .or_else(|| {
            request
                .extensions()
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                .map(|ci| ci.0.ip())
        })
}
