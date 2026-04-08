use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{hash_password, issue_jwt, verify_google_id_token, verify_password};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub business_name: String,
    pub category: Option<String>,
    pub website: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user_id: Uuid,
    pub did: String,
}

pub async fn register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> AppResult<Json<AuthResponse>> {
    if let Err(retry_after) = state.rate_limiter.check(&format!("register:{}", req.email), 5) {
        return Err(AppError::TooManyRequests(retry_after));
    }

    // Validate input
    if req.email.is_empty() || !req.email.contains('@') {
        return Err(AppError::BadRequest("Invalid email address".into()));
    }
    if req.password.len() < 8 {
        return Err(AppError::BadRequest(
            "Password must be at least 8 characters".into(),
        ));
    }
    if req.business_name.is_empty() {
        return Err(AppError::BadRequest("Business name is required".into()));
    }

    // Check if email already exists
    let existing: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM users WHERE email = $1")
            .bind(&req.email)
            .fetch_optional(&state.db)
            .await?;

    if existing.is_some() {
        return Err(AppError::Conflict(
            "An account with this email already exists".into(),
        ));
    }

    // Hash password
    let password_hash = hash_password(&req.password)?;

    // Generate DID from random ed25519 keypair
    let signing_key = SigningKey::generate(&mut OsRng);
    let pub_bytes = signing_key.verifying_key().to_bytes();
    // multicodec ed25519-pub = 0xed, 0x01
    let mut multi = vec![0xed, 0x01];
    multi.extend_from_slice(&pub_bytes);
    let did = format!("did:key:z{}", bs58::encode(&multi).into_string());

    // Create user
    let user_id: (Uuid,) = sqlx::query_as(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
    )
    .bind(&req.email)
    .bind(&password_hash)
    .fetch_one(&state.db)
    .await?;

    let user_id = user_id.0;

    // Create business profile
    let category = req.category.unwrap_or_else(|| "service".into());
    let website = req.website.unwrap_or_default();

    sqlx::query(
        r#"INSERT INTO business_profiles (user_id, did, business_name, category, website)
           VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(user_id)
    .bind(&did)
    .bind(&req.business_name)
    .bind(&category)
    .bind(&website)
    .execute(&state.db)
    .await?;

    // Issue JWT
    let token = issue_jwt(&user_id, &req.email, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse {
        token,
        user_id,
        did,
    }))
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> AppResult<Json<AuthResponse>> {
    if let Err(retry_after) = state.rate_limiter.check(&format!("login:{}", req.email), 10) {
        return Err(AppError::TooManyRequests(retry_after));
    }

    // Look up user
    let user: Option<crate::db::DbUser> =
        sqlx::query_as("SELECT id, email, password_hash, account_type, created_at FROM users WHERE email = $1")
            .bind(&req.email)
            .fetch_optional(&state.db)
            .await?;

    let user = user.ok_or_else(|| AppError::Unauthorized("Invalid email or password".into()))?;

    // Google sign-in users have no password — they must use POST /v1/auth/google
    let password_hash = user.password_hash.as_deref().ok_or_else(|| {
        AppError::Unauthorized(
            "This account uses Google sign-in. Sign in with Google instead.".into(),
        )
    })?;

    // Verify password
    let valid = verify_password(&req.password, password_hash)?;
    if !valid {
        return Err(AppError::Unauthorized("Invalid email or password".into()));
    }

    // Get the user's DID from their profile (business or consumer)
    let did = if user.account_type == "consumer" {
        let profile: Option<(String,)> =
            sqlx::query_as("SELECT did FROM public_profiles WHERE user_id = $1")
                .bind(user.id)
                .fetch_optional(&state.db)
                .await?;
        profile.map(|p| p.0).unwrap_or_default()
    } else {
        let profile: Option<(String,)> =
            sqlx::query_as("SELECT did FROM business_profiles WHERE user_id = $1")
                .bind(user.id)
                .fetch_optional(&state.db)
                .await?;
        profile.map(|p| p.0).unwrap_or_default()
    };

    // Issue JWT
    let token = issue_jwt(&user.id, &user.email, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse {
        token,
        user_id: user.id,
        did,
    }))
}

// ── Google Sign-In (mobile / Seeker) ────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct GoogleSignInRequest {
    pub id_token: String,
}

/// POST /v1/auth/google — verify a Google ID token and mint a said-cloud JWT.
///
/// Mirrors thumper-cloud's `google_sign_in` handler so the Android app can use
/// the same Google credential to authenticate against both backends.
///
/// Resolution order:
/// 1. Existing user with matching `google_id` → return.
/// 2. Existing user with matching `email` → link the `google_id` and return.
/// 3. New user → insert with `password_hash = NULL`, return.
///
/// Returns the user's DID if they have a `business_profiles` or `public_profiles`
/// row; otherwise returns an empty string. Mobile users typically don't need a
/// user-level DID — their owned agents each have their own.
pub async fn google_sign_in(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GoogleSignInRequest>,
) -> AppResult<Json<AuthResponse>> {
    let google_client_id = state
        .config
        .google_client_id
        .as_deref()
        .ok_or_else(|| {
            AppError::Internal("Google sign-in not configured (GOOGLE_CLIENT_ID missing)".into())
        })?;

    let payload = verify_google_id_token(&req.id_token, google_client_id).await?;

    if let Err(retry_after) = state
        .rate_limiter
        .check(&format!("google_signin:{}", payload.sub), 30)
    {
        return Err(AppError::TooManyRequests(retry_after));
    }

    // 1. Returning user — already linked Google.
    let existing: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM users WHERE google_id = $1")
            .bind(&payload.sub)
            .fetch_optional(&state.db)
            .await?;

    if let Some((user_id,)) = existing {
        // Best-effort profile update — ignore unique-constraint races on email.
        let _ = sqlx::query(
            "UPDATE users SET email = COALESCE($1, email), display_name = COALESCE($2, display_name) WHERE google_id = $3",
        )
        .bind(&payload.email)
        .bind(&payload.name)
        .bind(&payload.sub)
        .execute(&state.db)
        .await;

        let did = lookup_did_for_user(&state.db, user_id).await?;
        let token = issue_jwt(&user_id, &payload.email, &state.config.jwt_secret)?;
        return Ok(Json(AuthResponse {
            token,
            user_id,
            did,
        }));
    }

    // 2. Email already in DB from another auth method — link Google.
    let by_email: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM users WHERE email = $1")
            .bind(&payload.email)
            .fetch_optional(&state.db)
            .await?;

    if let Some((user_id,)) = by_email {
        sqlx::query(
            "UPDATE users SET google_id = $1, display_name = COALESCE($2, display_name) WHERE id = $3",
        )
        .bind(&payload.sub)
        .bind(&payload.name)
        .bind(user_id)
        .execute(&state.db)
        .await?;

        let did = lookup_did_for_user(&state.db, user_id).await?;
        let token = issue_jwt(&user_id, &payload.email, &state.config.jwt_secret)?;
        return Ok(Json(AuthResponse {
            token,
            user_id,
            did,
        }));
    }

    // 3. Brand new user — insert with NULL password_hash. We do NOT auto-create
    // a business_profiles row here; the agent-ownership product (Phase 2) is
    // the canonical identity surface for mobile users, and each agent has its
    // own DID. The user-level DID stays empty until/unless they create one
    // through the legacy /v1/auth/register flow.
    let new_user: (Uuid,) = sqlx::query_as(
        "INSERT INTO users (email, google_id, display_name, account_type) \
         VALUES ($1, $2, $3, 'business') \
         ON CONFLICT (google_id) DO UPDATE SET email = EXCLUDED.email \
         RETURNING id",
    )
    .bind(&payload.email)
    .bind(&payload.sub)
    .bind(&payload.name)
    .fetch_one(&state.db)
    .await?;

    let user_id = new_user.0;
    let token = issue_jwt(&user_id, &payload.email, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse {
        token,
        user_id,
        did: String::new(),
    }))
}

/// Look up a user's DID from `business_profiles` or `public_profiles`.
/// Returns empty string if neither exists (typical for new mobile users).
async fn lookup_did_for_user(db: &sqlx::PgPool, user_id: Uuid) -> AppResult<String> {
    let business: Option<(String,)> =
        sqlx::query_as("SELECT did FROM business_profiles WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    if let Some((did,)) = business {
        return Ok(did);
    }
    let consumer: Option<(String,)> =
        sqlx::query_as("SELECT did FROM public_profiles WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(consumer.map(|p| p.0).unwrap_or_default())
}
