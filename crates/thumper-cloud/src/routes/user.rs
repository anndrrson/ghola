use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Serialize)]
pub struct UserProfile {
    pub id: Uuid,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub phone_number: Option<String>,
    pub timezone: String,
    pub tier: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct UpdateProfileRequest {
    pub display_name: Option<String>,
    pub phone_number: Option<String>,
    pub timezone: Option<String>,
}

#[derive(Serialize)]
pub struct UsageResponse {
    pub call_count: i32,
    pub call_minutes: i32,
    pub email_count: i32,
    pub call_limit: i32,
    pub email_limit: i32,
    pub api_call_count: i32,
    pub api_call_limit: i32,
    pub api_token_count: i32,
}

/// GET /api/user/profile
pub async fn get_profile(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<UserProfile>, CloudError> {
    let row = sqlx::query_as::<_, (Uuid, Option<String>, Option<String>, Option<String>, String, String, DateTime<Utc>)>(
        "SELECT id, email, display_name, phone_number, timezone, tier, created_at FROM users WHERE id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;

    Ok(Json(UserProfile {
        id: row.0,
        email: row.1,
        display_name: row.2,
        phone_number: row.3,
        timezone: row.4,
        tier: row.5,
        created_at: row.6,
    }))
}

/// PATCH /api/user/profile
pub async fn update_profile(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<UpdateProfileRequest>,
) -> Result<Json<UserProfile>, CloudError> {
    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            String,
            DateTime<Utc>,
        ),
    >(
        r#"
        UPDATE users SET
            display_name = COALESCE($2, display_name),
            phone_number = COALESCE($3, phone_number),
            timezone = COALESCE($4, timezone),
            updated_at = now()
        WHERE id = $1
        RETURNING id, email, display_name, phone_number, timezone, tier, created_at
        "#,
    )
    .bind(claims.sub)
    .bind(&req.display_name)
    .bind(&req.phone_number)
    .bind(&req.timezone)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(UserProfile {
        id: row.0,
        email: row.1,
        display_name: row.2,
        phone_number: row.3,
        timezone: row.4,
        tier: row.5,
        created_at: row.6,
    }))
}

/// GET /api/user/usage
pub async fn get_usage(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<UsageResponse>, CloudError> {
    let period_start = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-01")
        .to_string();

    let row = sqlx::query_as::<_, (i32, i32, i32, i32, i32)>(
        r#"
        SELECT COALESCE(call_count, 0), COALESCE(call_minutes, 0), COALESCE(email_count, 0),
               COALESCE(api_call_count, 0), COALESCE(api_token_count, 0)
        FROM usage_tracking WHERE user_id = $1 AND period_start = $2::date
        "#,
    )
    .bind(claims.sub)
    .bind(&period_start)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or((0, 0, 0, 0, 0));

    let (call_limit, email_limit, api_call_limit) = match claims.tier.as_str() {
        "trial_pack" => (10, 15, 1_000),
        "starter" => (20, 30, 5_000),
        "pro" | "private_agent" => (30, 50, 10_000),
        "unlimited" => (999, 999, 100_000),
        "enterprise" => (999, 999, i32::MAX),
        _ => (5, 10, 100),
    };

    Ok(Json(UsageResponse {
        call_count: row.0,
        call_minutes: row.1,
        email_count: row.2,
        call_limit,
        email_limit,
        api_call_count: row.3,
        api_call_limit,
        api_token_count: row.4,
    }))
}
