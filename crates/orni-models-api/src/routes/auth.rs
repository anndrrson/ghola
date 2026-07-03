use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::Json;
use uuid::Uuid;

use crate::auth::{
    build_csrf_cookie, build_session_cookie, extract_session_token, generate_csrf_token,
    issue_jwt, validate_jwt, verify_siws,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use orni_models_types::{AuthResponse, NonceRequest, NonceResponse, User, VerifyRequest};

/// JWT lifetime in seconds — must match `JWT_EXPIRY` in auth.rs.
const JWT_TTL_SECONDS: i64 = 86400;

/// Wrap an `AuthResponse` so browser callers receive the JWT as an HttpOnly
/// `ghola_session` cookie + JS-readable `ghola_csrf` companion. Mobile/CLI
/// callers still read `token` out of the JSON body.
fn auth_response_with_cookies(payload: AuthResponse) -> Response {
    let session_cookie = build_session_cookie(&payload.token, JWT_TTL_SECONDS);
    let csrf_token = generate_csrf_token();
    let csrf_cookie = build_csrf_cookie(&csrf_token, JWT_TTL_SECONDS);

    let mut response = Json(payload).into_response();
    let headers = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&session_cookie) {
        headers.append(header::SET_COOKIE, v);
    }
    if let Ok(v) = HeaderValue::from_str(&csrf_cookie) {
        headers.append(header::SET_COOKIE, v);
    }
    response
}

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
) -> AppResult<Response> {
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

    Ok(auth_response_with_cookies(AuthResponse { token, user }))
}

pub async fn register_email(
    State(state): State<Arc<AppState>>,
    Json(req): Json<orni_models_types::EmailRegisterRequest>,
) -> AppResult<Response> {
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

    Ok(auth_response_with_cookies(AuthResponse { token, user }))
}

pub async fn login_email(
    State(state): State<Arc<AppState>>,
    Json(req): Json<orni_models_types::EmailLoginRequest>,
) -> AppResult<Response> {
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

    Ok(auth_response_with_cookies(AuthResponse { token, user }))
}

/// POST /api/auth/logout — clears the session + csrf cookies. Idempotent.
pub async fn logout() -> Response {
    let mut response = Json(serde_json::json!({"ok": true})).into_response();
    let headers = response.headers_mut();
    for cookie in crate::auth::build_clear_cookies() {
        if let Ok(v) = HeaderValue::from_str(&cookie) {
            headers.append(header::SET_COOKIE, v);
        }
    }
    response
}

/// POST /api/auth/refresh-cookie
///
/// One-shot migration helper: pre-cookie deploys stored the JWT in
/// `localStorage`. The SPA reads it once and posts it here so we can re-emit
/// it as a proper `Set-Cookie`. Verifies the JWT before re-issuing.
pub async fn refresh_cookie(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> AppResult<Response> {
    let header_token = extract_session_token(&headers);
    let body_token = body
        .and_then(|Json(v)| v.get("token").and_then(|t| t.as_str().map(String::from)));
    let token = header_token
        .or(body_token)
        .ok_or_else(|| AppError::Unauthorized("missing JWT in header or body".into()))?;

    let claims = validate_jwt(&token, &state.config.jwt_secret)?;

    // Re-hydrate the user so the SPA response shape matches a normal sign-in.
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("invalid JWT sub claim".into()))?;
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::Unauthorized("user not found".into()))?;

    Ok(auth_response_with_cookies(AuthResponse { token, user }))
}
