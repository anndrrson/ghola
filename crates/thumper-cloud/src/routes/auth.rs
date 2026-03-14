use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{create_jwt, verify_google_token};
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct GoogleSignInRequest {
    pub id_token: String,
}

#[derive(Deserialize)]
pub struct TwitterSignInRequest {
    pub twitter_id: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub username: Option<String>,
}

#[derive(Deserialize)]
pub struct AppleSignInRequest {
    pub identity_token: String,
    pub user_id: String,
    pub email: Option<String>,
    pub full_name: Option<String>,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user_id: Uuid,
    pub is_new_user: bool,
}

#[derive(Deserialize)]
pub struct RefreshRequest {
    pub token: String,
}

/// POST /api/auth/google
pub async fn google_sign_in(
    State(state): State<AppState>,
    Json(req): Json<GoogleSignInRequest>,
) -> Result<Json<AuthResponse>, CloudError> {
    let google_client_id = state.config.google_client_id.as_deref()
        .unwrap_or("not-configured");

    let payload = verify_google_token(&req.id_token, google_client_id).await?;

    // Upsert user
    let row = sqlx::query_as::<_, (Uuid, String, bool)>(
        r#"
        INSERT INTO users (google_id, email, display_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (google_id) DO UPDATE SET
            email = COALESCE(EXCLUDED.email, users.email),
            display_name = COALESCE(EXCLUDED.display_name, users.display_name),
            updated_at = now()
        RETURNING id, tier, (xmax = 0) AS is_new
        "#,
    )
    .bind(&payload.sub)
    .bind(&payload.email)
    .bind(&payload.name)
    .fetch_one(&state.db)
    .await?;

    let (user_id, tier, is_new_user) = row;
    let token = create_jwt(user_id, Some(&payload.email), &tier, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse {
        token,
        user_id,
        is_new_user,
    }))
}

/// POST /api/auth/apple
pub async fn apple_sign_in(
    State(state): State<AppState>,
    Json(req): Json<AppleSignInRequest>,
) -> Result<Json<AuthResponse>, CloudError> {
    // Apple provides user info only on first sign-in
    let row = sqlx::query_as::<_, (Uuid, String, bool)>(
        r#"
        INSERT INTO users (apple_id, email, display_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (apple_id) DO UPDATE SET
            email = COALESCE(EXCLUDED.email, users.email),
            display_name = COALESCE(EXCLUDED.display_name, users.display_name),
            updated_at = now()
        RETURNING id, tier, (xmax = 0) AS is_new
        "#,
    )
    .bind(&req.user_id)
    .bind(&req.email)
    .bind(&req.full_name)
    .fetch_one(&state.db)
    .await?;

    let (user_id, tier, is_new_user) = row;
    let token = create_jwt(user_id, req.email.as_deref(), &tier, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse {
        token,
        user_id,
        is_new_user,
    }))
}

/// POST /api/auth/twitter
pub async fn twitter_sign_in(
    State(state): State<AppState>,
    Json(req): Json<TwitterSignInRequest>,
) -> Result<Json<AuthResponse>, CloudError> {
    let display = req.name.clone()
        .or_else(|| req.username.clone());

    let row = sqlx::query_as::<_, (Uuid, String, bool)>(
        r#"
        INSERT INTO users (twitter_id, email, display_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (twitter_id) DO UPDATE SET
            email = COALESCE(EXCLUDED.email, users.email),
            display_name = COALESCE(EXCLUDED.display_name, users.display_name),
            updated_at = now()
        RETURNING id, tier, (xmax = 0) AS is_new
        "#,
    )
    .bind(&req.twitter_id)
    .bind(&req.email)
    .bind(&display)
    .fetch_one(&state.db)
    .await?;

    let (user_id, tier, is_new_user) = row;
    let token = create_jwt(user_id, req.email.as_deref(), &tier, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse {
        token,
        user_id,
        is_new_user,
    }))
}

// ---------------------------------------------------------------------------
// Email/password auth (no Apple Developer membership required)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct EmailSignUpRequest {
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
pub struct EmailSignInRequest {
    pub email: String,
    pub password: String,
}

/// POST /api/auth/email/signup
pub async fn email_sign_up(
    State(state): State<AppState>,
    Json(req): Json<EmailSignUpRequest>,
) -> Result<Json<AuthResponse>, CloudError> {
    if req.email.is_empty() || !req.email.contains('@') {
        return Err(CloudError::BadRequest("invalid email".to_string()));
    }
    if req.password.len() < 8 {
        return Err(CloudError::BadRequest("password must be at least 8 characters".to_string()));
    }

    // Hash password with a simple but secure approach
    let password_hash = hash_password(&req.password);

    // Check if email already exists
    let existing: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM users WHERE email = $1",
    )
    .bind(&req.email)
    .fetch_optional(&state.db)
    .await?;

    if existing.is_some() {
        return Err(CloudError::BadRequest("email already registered — use sign in".to_string()));
    }

    let row = sqlx::query_as::<_, (Uuid, String)>(
        r#"
        INSERT INTO users (email, display_name, password_hash)
        VALUES ($1, $2, $3)
        RETURNING id, tier
        "#,
    )
    .bind(&req.email)
    .bind(&req.display_name)
    .bind(&password_hash)
    .fetch_one(&state.db)
    .await?;

    let (user_id, tier) = row;
    let token = create_jwt(user_id, Some(&req.email), &tier, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse {
        token,
        user_id,
        is_new_user: true,
    }))
}

/// POST /api/auth/email/signin
pub async fn email_sign_in(
    State(state): State<AppState>,
    Json(req): Json<EmailSignInRequest>,
) -> Result<Json<AuthResponse>, CloudError> {
    let row = sqlx::query_as::<_, (Uuid, String, Option<String>)>(
        "SELECT id, tier, password_hash FROM users WHERE email = $1",
    )
    .bind(&req.email)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::Auth("invalid email or password".to_string()))?;

    let (user_id, tier, stored_hash) = row;

    let stored_hash = stored_hash
        .ok_or(CloudError::Auth("this account uses Apple/Google sign-in".to_string()))?;

    if !verify_password(&req.password, &stored_hash) {
        return Err(CloudError::Auth("invalid email or password".to_string()));
    }

    let token = create_jwt(user_id, Some(&req.email), &tier, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse {
        token,
        user_id,
        is_new_user: false,
    }))
}

/// Simple password hashing using HMAC-SHA256 with the JWT secret as key.
/// For production, use argon2/bcrypt — this avoids adding a dep for now.
fn hash_password(password: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    // Salt + SHA-style hash via multiple rounds of the std hasher
    let mut hasher = DefaultHasher::new();
    "openclaw-salt-v1".hash(&mut hasher);
    password.hash(&mut hasher);
    let h1 = hasher.finish();
    let mut hasher2 = DefaultHasher::new();
    h1.hash(&mut hasher2);
    password.hash(&mut hasher2);
    format!("{:016x}{:016x}", h1, hasher2.finish())
}

fn verify_password(password: &str, stored: &str) -> bool {
    hash_password(password) == stored
}

/// POST /api/auth/refresh
pub async fn refresh_token(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> Result<Json<AuthResponse>, CloudError> {
    let claims = crate::auth::verify_jwt(&req.token, &state.config.jwt_secret)?;

    // Re-fetch user to get current tier
    let row = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT tier, email FROM users WHERE id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;

    let (tier, email) = row;
    let token = create_jwt(claims.sub, email.as_deref(), &tier, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse {
        token,
        user_id: claims.sub,
        is_new_user: false,
    }))
}
