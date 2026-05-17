use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use chrono::Utc;
use ed25519_dalek::SigningKey;
use rand::RngCore;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{hash_password, issue_jwt, verify_google_id_token, verify_password, verify_siws};
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
    /// Unix-seconds expiry of `token` (access JWT). New field, optional for
    /// backwards compat with clients on the old shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp: Option<i64>,
    /// Long-lived refresh token (180 days), single-use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix-seconds expiry of `refresh_token`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_exp: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

/// Decode `exp` from a JWT we just minted, without verifying signature.
/// Best-effort — failure simply omits the field from the response.
fn jwt_exp(token: &str, secret: &str) -> Option<i64> {
    crate::auth::validate_jwt(token, secret).ok().map(|c| c.exp as i64)
}

/// Attach a refresh token + access exp to an AuthResponse.
async fn attach_refresh(
    state: &Arc<AppState>,
    access_token: String,
    user_id: Uuid,
    did: String,
) -> AuthResponse {
    let exp = jwt_exp(&access_token, &state.config.jwt_secret);
    let (refresh_token, refresh_exp) =
        match crate::auth::create_refresh_token(&state.db, user_id).await {
            Ok((t, e)) => (Some(t), Some(e)),
            Err(e) => {
                tracing::warn!(error = %e, "said-cloud refresh token mint failed");
                (None, None)
            }
        };
    AuthResponse {
        token: access_token,
        user_id,
        did,
        exp,
        refresh_token,
        refresh_exp,
    }
}

#[derive(Debug, Serialize)]
pub struct SiwsChallengeResponse {
    pub nonce: String,
    pub ts: i64,
    pub expires_at: i64,
    pub challenge: String,
}

#[derive(Debug, Deserialize)]
pub struct SiwsSignInRequest {
    pub wallet_pubkey: String,
    pub nonce: String,
    pub challenge: String,
    /// Base64-encoded 64-byte Ed25519 detached signature.
    pub signature: String,
}

fn random_nonce_hex() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parse_expires_at_from_challenge(challenge: &str) -> Option<i64> {
    challenge
        .lines()
        .find_map(|line| line.strip_prefix("Expires At: "))
        .and_then(|raw| raw.trim().parse::<i64>().ok())
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

    Ok(Json(attach_refresh(&state, token, user_id, did).await))
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

    Ok(Json(attach_refresh(&state, token, user.id, did).await))
}

/// GET /v1/auth/siws/challenge
pub async fn siws_challenge(
    State(state): State<Arc<AppState>>,
) -> AppResult<Json<SiwsChallengeResponse>> {
    let nonce = random_nonce_hex();
    let ts = Utc::now().timestamp();
    // 15 min window: matches thumper-cloud. Challenge is single-use.
    let expires_at = ts + 900;
    let challenge = format!(
        "Sign in to Ghola\nNonce: {nonce}\nIssued At: {ts}\nExpires At: {expires_at}\nURI: https://ghola.xyz\nVersion: 1"
    );

    let mut store = state.siws_challenges.lock().await;
    store.retain(|_, v| *v > ts);
    store.insert(nonce.clone(), expires_at);
    drop(store);

    Ok(Json(SiwsChallengeResponse {
        nonce,
        ts,
        expires_at,
        challenge,
    }))
}

/// POST /v1/auth/siws
pub async fn siws_sign_in(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SiwsSignInRequest>,
) -> AppResult<Json<AuthResponse>> {
    let now = Utc::now().timestamp();
    let expected_expiry = {
        let mut store = state.siws_challenges.lock().await;
        store.retain(|_, v| *v > now);
        store.remove(&req.nonce)
    };
    let effective_expiry = expected_expiry
        .or_else(|| parse_expires_at_from_challenge(&req.challenge))
        .ok_or_else(|| AppError::Unauthorized("invalid or expired SIWS challenge".into()))?;
    if effective_expiry <= now {
        return Err(AppError::Unauthorized("SIWS challenge expired".into()));
    }
    if !req.challenge.contains(&format!("Nonce: {}", req.nonce)) {
        return Err(AppError::Unauthorized("SIWS challenge nonce mismatch".into()));
    }

    let sig_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &req.signature,
    )
    .map_err(|e| AppError::Unauthorized(format!("invalid SIWS signature encoding: {e}")))?;
    verify_siws(&req.wallet_pubkey, req.challenge.as_bytes(), &sig_bytes)?;

    let existing: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT id, email FROM users WHERE siws_pubkey = $1",
    )
    .bind(&req.wallet_pubkey)
    .fetch_optional(&state.db)
    .await?;

    if let Some((user_id, email)) = existing {
        let did = lookup_did_for_user(&state.db, user_id).await?;
        let token = issue_jwt(&user_id, &email, &state.config.jwt_secret)?;
        return Ok(Json(attach_refresh(&state, token, user_id, did).await));
    }

    let synthetic_email = format!("{}.wallet@ghola.local", req.wallet_pubkey);
    let new_user: (Uuid,) = sqlx::query_as(
        "INSERT INTO users (email, password_hash, account_type, siws_pubkey) \
         VALUES ($1, NULL, 'business', $2) \
         ON CONFLICT (siws_pubkey) DO UPDATE SET email = users.email \
         RETURNING id",
    )
    .bind(&synthetic_email)
    .bind(&req.wallet_pubkey)
    .fetch_one(&state.db)
    .await?;
    let user_id = new_user.0;

    let token = issue_jwt(&user_id, &synthetic_email, &state.config.jwt_secret)?;
    Ok(Json(attach_refresh(&state, token, user_id, String::new()).await))
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
        return Ok(Json(attach_refresh(&state, token, user_id, did).await));
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
        return Ok(Json(attach_refresh(&state, token, user_id, did).await));
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

    Ok(Json(attach_refresh(&state, token, user_id, String::new()).await))
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

/// POST /v1/auth/refresh
///
/// Mirrors thumper-cloud's refresh endpoint. Accepts either
/// `{refresh_token}` (preferred, single-use rotation) or `{token}` (legacy
/// access JWT re-mint). Returns a fresh `{token, exp, refresh_token, refresh_exp}`.
pub async fn refresh_token(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RefreshRequest>,
) -> AppResult<Json<AuthResponse>> {
    // Prefer refresh_token if present.
    if let Some(rt) = req.refresh_token.as_deref() {
        let (new_refresh, new_refresh_exp, user_id) =
            crate::auth::consume_refresh_token(&state.db, rt).await?;

        let row: Option<(String,)> =
            sqlx::query_as("SELECT email FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_optional(&state.db)
                .await?;
        let email = row.map(|r| r.0).unwrap_or_default();
        let did = lookup_did_for_user(&state.db, user_id).await?;
        let access = issue_jwt(&user_id, &email, &state.config.jwt_secret)?;
        let exp = jwt_exp(&access, &state.config.jwt_secret);
        return Ok(Json(AuthResponse {
            token: access,
            user_id,
            did,
            exp,
            refresh_token: Some(new_refresh),
            refresh_exp: Some(new_refresh_exp),
        }));
    }

    // Legacy path: re-mint from a still-valid access JWT.
    let legacy = req
        .token
        .ok_or_else(|| AppError::Unauthorized("missing refresh_token or token".into()))?;
    let claims = crate::auth::validate_jwt(&legacy, &state.config.jwt_secret)?;
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("invalid user_id claim".into()))?;
    let did = lookup_did_for_user(&state.db, user_id).await?;
    let token = issue_jwt(&user_id, &claims.email, &state.config.jwt_secret)?;
    Ok(Json(attach_refresh(&state, token, user_id, did).await))
}
