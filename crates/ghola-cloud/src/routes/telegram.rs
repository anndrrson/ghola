use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Serialize)]
pub struct TelegramLinkCodeResponse {
    pub code: String,
    pub expires_at: String,
    pub bot_username: String,
}

#[derive(Serialize)]
pub struct TelegramStatusResponse {
    pub linked: bool,
    pub telegram_username: Option<String>,
    pub linked_at: Option<String>,
}

/// POST /api/telegram/link-code — Generate a 6-char linking code
pub async fn create_link_code(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<TelegramLinkCodeResponse>, CloudError> {
    // Generate 6-char alphanumeric code (uppercase, no ambiguous chars)
    let code = generate_code();
    let expires_at = chrono::Utc::now() + chrono::Duration::minutes(15);

    // Invalidate any existing unused codes for this user
    sqlx::query("UPDATE telegram_link_codes SET used = true WHERE user_id = $1 AND used = false")
        .bind(claims.sub)
        .execute(&state.db)
        .await?;

    // Insert new code
    sqlx::query("INSERT INTO telegram_link_codes (user_id, code, expires_at) VALUES ($1, $2, $3)")
        .bind(claims.sub)
        .bind(&code)
        .bind(expires_at)
        .execute(&state.db)
        .await?;

    Ok(Json(TelegramLinkCodeResponse {
        code,
        expires_at: expires_at.to_rfc3339(),
        bot_username: "GholaBot".to_string(),
    }))
}

/// GET /api/telegram/status — Check if Telegram is linked
pub async fn get_status(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<TelegramStatusResponse>, CloudError> {
    let row = sqlx::query_as::<_, (Option<String>, chrono::DateTime<chrono::Utc>)>(
        "SELECT telegram_username, linked_at FROM telegram_links WHERE user_id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?;

    match row {
        Some((username, linked_at)) => Ok(Json(TelegramStatusResponse {
            linked: true,
            telegram_username: username,
            linked_at: Some(linked_at.to_rfc3339()),
        })),
        None => Ok(Json(TelegramStatusResponse {
            linked: false,
            telegram_username: None,
            linked_at: None,
        })),
    }
}

/// DELETE /api/telegram/unlink — Remove Telegram link
pub async fn unlink(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<serde_json::Value>, CloudError> {
    sqlx::query("DELETE FROM telegram_links WHERE user_id = $1")
        .bind(claims.sub)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Generate a 6-character alphanumeric code (uppercase, no ambiguous chars like 0/O, 1/I/L)
fn generate_code() -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..6)
        .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
        .collect()
}
