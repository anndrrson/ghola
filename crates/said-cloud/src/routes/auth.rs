use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{hash_password, issue_jwt, verify_password};
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

    // Verify password
    let valid = verify_password(&req.password, &user.password_hash)?;
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
