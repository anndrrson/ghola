use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::Extension;
use axum::Json;
use base64::Engine;
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{
    build_csrf_cookie, build_session_cookie, generate_csrf_token, hash_password, issue_jwt, Claims,
};
use crate::db::DbPublicProfile;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ── Register ──

#[derive(Debug, Deserialize)]
pub struct ConsumerRegisterRequest {
    pub email: String,
    pub password: String,
    pub display_name: String,
}

#[derive(Debug, Serialize)]
pub struct ConsumerAuthResponse {
    pub token: String,
    pub user: ConsumerAuthUser,
}

#[derive(Debug, Serialize)]
pub struct ConsumerAuthUser {
    pub id: Uuid,
    pub email: String,
}

/// POST /v1/consumer/register
pub async fn register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ConsumerRegisterRequest>,
) -> AppResult<Response> {
    // Validate input
    if req.email.is_empty() || !req.email.contains('@') {
        return Err(AppError::BadRequest("Invalid email address".into()));
    }
    if req.password.len() < 8 {
        return Err(AppError::BadRequest(
            "Password must be at least 8 characters".into(),
        ));
    }
    if req.display_name.is_empty() {
        return Err(AppError::BadRequest("Display name is required".into()));
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

    // Create user with account_type = "consumer"
    let user_id: (Uuid,) = sqlx::query_as(
        "INSERT INTO users (email, password_hash, account_type) VALUES ($1, $2, 'consumer') RETURNING id",
    )
    .bind(&req.email)
    .bind(&password_hash)
    .fetch_one(&state.db)
    .await?;

    let user_id = user_id.0;

    // Create public profile
    sqlx::query(
        r#"INSERT INTO public_profiles (user_id, did, display_name)
           VALUES ($1, $2, $3)"#,
    )
    .bind(user_id)
    .bind(&did)
    .bind(&req.display_name)
    .execute(&state.db)
    .await?;

    // Issue JWT
    let token = issue_jwt(&user_id, &req.email, &state.config.jwt_secret)?;

    let payload = ConsumerAuthResponse {
        token: token.clone(),
        user: ConsumerAuthUser {
            id: user_id,
            email: req.email,
        },
    };

    // Attach the same `ghola_session` + `ghola_csrf` cookies that
    // /v1/auth/register sets, so browser callers transition off the
    // localStorage-stored JWT here too. Mobile/CLI still read `token` from
    // the JSON body.
    let session_cookie = build_session_cookie(&token, 2_592_000);
    let csrf_token = generate_csrf_token();
    let csrf_cookie = build_csrf_cookie(&csrf_token, 2_592_000);

    let mut response = Json(payload).into_response();
    let headers = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&session_cookie) {
        headers.append(header::SET_COOKIE, v);
    }
    if let Ok(v) = HeaderValue::from_str(&csrf_cookie) {
        headers.append(header::SET_COOKIE, v);
    }
    Ok(response)
}

// ── Get Profile ──

/// GET /v1/consumer/profile
pub async fn get_profile(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<said_types::PublicProfile>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    let profile: DbPublicProfile = sqlx::query_as(
        r#"SELECT id, user_id, did, display_name, handle, avatar_url, bio, timezone,
                  agent_preferences, encrypted_wallet, on_chain_registered,
                  created_at, updated_at
           FROM public_profiles WHERE user_id = $1"#,
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Consumer profile not found".into()))?;

    Ok(Json(profile.into()))
}

// ── Update Profile ──

#[derive(Debug, Deserialize)]
pub struct UpdateConsumerProfileRequest {
    pub display_name: Option<String>,
    pub handle: Option<String>,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub timezone: Option<String>,
    pub agent_preferences: Option<serde_json::Value>,
}

/// PUT /v1/consumer/profile
pub async fn update_profile(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<UpdateConsumerProfileRequest>,
) -> AppResult<Json<said_types::PublicProfile>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    // Check handle uniqueness if provided
    if let Some(ref handle) = req.handle {
        // Check against both public_profiles and business_profiles
        let existing_public: Option<(Uuid,)> = sqlx::query_as(
            "SELECT id FROM public_profiles WHERE handle = $1 AND user_id != $2",
        )
        .bind(handle)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;

        if existing_public.is_some() {
            return Err(AppError::Conflict("Handle is already taken".into()));
        }

        let existing_business: Option<(Uuid,)> = sqlx::query_as(
            "SELECT id FROM business_profiles WHERE handle = $1",
        )
        .bind(handle)
        .fetch_optional(&state.db)
        .await?;

        if existing_business.is_some() {
            return Err(AppError::Conflict("Handle is already taken".into()));
        }
    }

    let profile: DbPublicProfile = sqlx::query_as(
        r#"UPDATE public_profiles SET
            display_name = COALESCE($2, display_name),
            handle = COALESCE($3, handle),
            avatar_url = COALESCE($4, avatar_url),
            bio = COALESCE($5, bio),
            timezone = COALESCE($6, timezone),
            agent_preferences = COALESCE($7, agent_preferences),
            updated_at = now()
           WHERE user_id = $1
           RETURNING id, user_id, did, display_name, handle, avatar_url, bio, timezone,
                     agent_preferences, encrypted_wallet, on_chain_registered,
                     created_at, updated_at"#,
    )
    .bind(user_id)
    .bind(&req.display_name)
    .bind(&req.handle)
    .bind(&req.avatar_url)
    .bind(&req.bio)
    .bind(&req.timezone)
    .bind(&req.agent_preferences)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Consumer profile not found".into()))?;

    Ok(Json(profile.into()))
}

// ── Wallet Upload ──

#[derive(Debug, Deserialize)]
pub struct UploadWalletRequest {
    pub encrypted_wallet: String, // base64-encoded
}

#[derive(Debug, Serialize)]
pub struct UploadWalletResponse {
    pub success: bool,
}

/// POST /v1/consumer/wallet
pub async fn upload_wallet(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<UploadWalletRequest>,
) -> AppResult<Json<UploadWalletResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    let wallet_bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.encrypted_wallet)
        .map_err(|_| AppError::BadRequest("Invalid base64 encoding".into()))?;

    sqlx::query(
        "UPDATE public_profiles SET encrypted_wallet = $2, updated_at = now() WHERE user_id = $1",
    )
    .bind(user_id)
    .bind(&wallet_bytes)
    .execute(&state.db)
    .await?;

    Ok(Json(UploadWalletResponse { success: true }))
}

// ── Wallet Download ──

#[derive(Debug, Serialize)]
pub struct DownloadWalletResponse {
    pub encrypted_wallet: String, // base64-encoded
}

/// GET /v1/consumer/wallet
pub async fn get_wallet(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> AppResult<Json<DownloadWalletResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    let row: Option<(Option<Vec<u8>>,)> = sqlx::query_as(
        "SELECT encrypted_wallet FROM public_profiles WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let wallet_bytes = row
        .and_then(|r| r.0)
        .ok_or_else(|| AppError::NotFound("No encrypted wallet stored".into()))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(&wallet_bytes);

    Ok(Json(DownloadWalletResponse {
        encrypted_wallet: encoded,
    }))
}

// ── Public Profile Lookup (no auth) ──

/// GET /v1/profile/:did — public, agent-facing profile lookup
pub async fn get_public_profile(
    State(state): State<Arc<AppState>>,
    Path(did): Path<String>,
) -> AppResult<Json<said_types::PublicProfile>> {
    let profile: DbPublicProfile = sqlx::query_as(
        r#"SELECT id, user_id, did, display_name, handle, avatar_url, bio, timezone,
                  agent_preferences, encrypted_wallet, on_chain_registered,
                  created_at, updated_at
           FROM public_profiles WHERE did = $1"#,
    )
    .bind(&did)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Public profile not found".into()))?;

    // Log the lookup
    let profile_id = profile.id;
    let _ = sqlx::query(
        "INSERT INTO usage_logs (profile_id, endpoint) VALUES ($1, 'profile_lookup')",
    )
    .bind(profile_id)
    .execute(&state.db)
    .await;

    Ok(Json(profile.into()))
}
