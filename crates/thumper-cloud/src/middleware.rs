use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use sha2::{Digest, Sha256};

use crate::state::AppState;

/// Middleware that tracks API usage for requests authenticated with API keys.
/// Increments api_call_count in usage_tracking for the current billing period.
pub async fn track_api_usage(
    state: AppState,
    request: Request,
    next: Next,
) -> Response {
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

    let response = next.run(request).await;

    // Fire-and-forget: increment API call count
    if let Some(uid) = user_id {
        let db = state.db.clone();
        tokio::spawn(async move {
            let period_start = chrono::Utc::now().date_naive().format("%Y-%m-01").to_string();
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
