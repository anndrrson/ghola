use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
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
            "pro" => 300,
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

use axum::response::IntoResponse;

fn extract_client_ip(request: &Request) -> Option<std::net::IpAddr> {
    // Reverse proxies that append to X-Forwarded-For leave user-controlled
    // values on the left. Prefer the rightmost valid address to avoid trivial
    // unauthenticated rate-limit spoofing.
    request
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').rev().find_map(|part| part.trim().parse().ok()))
        // Fallback: ConnectInfo (direct connection)
        .or_else(|| {
            request
                .extensions()
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                .map(|ci| ci.0.ip())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    fn request_with_headers(headers: &[(&str, &str)]) -> Request {
        let mut builder = Request::builder().uri("https://ghola.test/");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(Body::empty()).expect("request")
    }

    #[test]
    fn client_ip_uses_rightmost_valid_forwarded_address() {
        let request =
            request_with_headers(&[("x-forwarded-for", "203.0.113.10, not-an-ip, 198.51.100.25")]);

        assert_eq!(
            extract_client_ip(&request),
            Some(IpAddr::V4(Ipv4Addr::new(198, 51, 100, 25))),
        );
    }

    #[test]
    fn client_ip_falls_back_to_connect_info() {
        let mut request = request_with_headers(&[("x-forwarded-for", "not-an-ip")]);
        request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 44)),
            443,
        )));

        assert_eq!(
            extract_client_ip(&request),
            Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 44))),
        );
    }
}
