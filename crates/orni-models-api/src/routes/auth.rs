use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use uuid::Uuid;

use crate::auth::{issue_jwt, verify_siws};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use orni_models_types::{AuthResponse, NonceRequest, NonceResponse, User, VerifyRequest};

pub async fn get_nonce(
    State(state): State<Arc<AppState>>,
    Json(req): Json<NonceRequest>,
) -> AppResult<Json<NonceResponse>> {
    let nonce = state.nonce_store.generate(&req.wallet_address);
    let message = format!(
        "Sign in to Orni Models\nWallet: {}\nNonce: {}",
        req.wallet_address, nonce
    );

    Ok(Json(NonceResponse { nonce, message }))
}

pub async fn verify(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VerifyRequest>,
) -> AppResult<Json<AuthResponse>> {
    // Validate nonce
    if !state.nonce_store.validate_and_remove(&req.nonce, &req.wallet_address) {
        return Err(AppError::Unauthorized("Invalid or expired nonce".into()));
    }

    // Verify signature
    let message = format!(
        "Sign in to Orni Models\nWallet: {}\nNonce: {}",
        req.wallet_address, req.nonce
    );
    verify_siws(&req.wallet_address, message.as_bytes(), &req.signature)?;

    // Upsert user
    let user = sqlx::query_as::<_, User>(
        r#"
        INSERT INTO users (id, wallet_address)
        VALUES ($1, $2)
        ON CONFLICT (wallet_address)
        DO UPDATE SET updated_at = NOW()
        RETURNING *
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(&req.wallet_address)
    .fetch_one(&state.db)
    .await?;

    let token = issue_jwt(&user.id, user.wallet_address.as_deref(), &state.config.jwt_secret)?;

    Ok(Json(AuthResponse { token, user }))
}

pub async fn register_email(
    State(state): State<Arc<AppState>>,
    Json(req): Json<orni_models_types::EmailRegisterRequest>,
) -> AppResult<Json<AuthResponse>> {
    use argon2::{password_hash::SaltString, Argon2, PasswordHasher};
    use rand::rngs::OsRng;

    // Validate
    if req.email.is_empty() || !req.email.contains('@') {
        return Err(AppError::BadRequest("Invalid email".into()));
    }
    if req.password.len() < 8 {
        return Err(AppError::BadRequest("Password must be at least 8 characters".into()));
    }

    // Rate limit: 5 registrations per email per hour
    let rate_key = format!("register:{}", req.email.to_lowercase());
    if let Err(retry_after) = state.auth_rate_limiter.check(&rate_key, 5, 3600) {
        return Err(AppError::TooManyRequests(retry_after));
    }

    // Hash password
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(req.password.as_bytes(), &salt)
        .map_err(|e| AppError::Internal(format!("Password hash failed: {e}")))?
        .to_string();

    // Insert user
    let user = sqlx::query_as::<_, User>(
        r#"INSERT INTO users (id, email, password_hash, display_name)
        VALUES ($1, $2, $3, $4)
        RETURNING *"#,
    )
    .bind(Uuid::new_v4())
    .bind(&req.email)
    .bind(&hash)
    .bind(&req.display_name)
    .fetch_one(&state.db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db_err) if db_err.constraint() == Some("users_email_key") => {
            AppError::Conflict("Email already registered".into())
        }
        _ => AppError::from(e),
    })?;

    let token = issue_jwt(&user.id, None, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse { token, user }))
}

pub async fn login_email(
    State(state): State<Arc<AppState>>,
    Json(req): Json<orni_models_types::EmailLoginRequest>,
) -> AppResult<Json<AuthResponse>> {
    use argon2::{Argon2, PasswordHash, PasswordVerifier};

    // Rate limit: 10 login attempts per email per 15 minutes
    let rate_key = format!("login:{}", req.email.to_lowercase());
    if let Err(retry_after) = state.auth_rate_limiter.check(&rate_key, 10, 900) {
        return Err(AppError::TooManyRequests(retry_after));
    }

    let user = sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE email = $1",
    )
    .bind(&req.email)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Unauthorized("Invalid email or password".into()))?;

    let hash = user.password_hash.as_deref()
        .ok_or_else(|| AppError::Unauthorized("Invalid email or password".into()))?;

    let parsed = PasswordHash::new(hash)
        .map_err(|_| AppError::Internal("Invalid stored hash".into()))?;

    Argon2::default()
        .verify_password(req.password.as_bytes(), &parsed)
        .map_err(|_| AppError::Unauthorized("Invalid email or password".into()))?;

    let token = issue_jwt(&user.id, user.wallet_address.as_deref(), &state.config.jwt_secret)?;

    Ok(Json(AuthResponse { token, user }))
}
