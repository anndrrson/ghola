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
        .ok_or_else(|| {
            tracing::error!("Google sign-in attempted but GOOGLE_CLIENT_ID not configured");
            CloudError::ServiceUnavailable("Google sign-in is not configured".into())
        })?;

    let payload = verify_google_token(&req.id_token, google_client_id).await
        .map_err(|e| {
            tracing::warn!("Google token verification failed: {e}");
            CloudError::Auth("Google sign-in failed — please try again or use email".into())
        })?;

    tracing::info!(google_id = %payload.sub, email = %payload.email, "google auth: checking existing user by google_id");

    // 1. Returning user? (already linked Google)
    let existing = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id, COALESCE(tier, 'free') FROM users WHERE google_id = $1",
    )
    .bind(&payload.sub)
    .fetch_optional(&state.db)
    .await?;

    if let Some((user_id, tier)) = existing {
        tracing::info!(user_id = %user_id, "google auth: returning user, updating profile");
        // Ignore email UNIQUE errors — just skip the email update if it conflicts
        if let Err(e) = sqlx::query(
            "UPDATE users SET email = COALESCE($1, email), display_name = COALESCE($2, display_name), updated_at = now() WHERE google_id = $3"
        )
        .bind(&payload.email)
        .bind(&payload.name)
        .bind(&payload.sub)
        .execute(&state.db)
        .await {
            tracing::warn!(google_id = %payload.sub, "google auth: skipping profile update (email conflict?): {e}");
        }

        let token = create_jwt(user_id, Some(&payload.email), payload.name.as_deref(), &tier, &state.config.jwt_secret)?;
        return Ok(Json(AuthResponse { token, user_id, is_new_user: false }));
    }

    tracing::info!("google auth: no google_id match, checking email");

    // 2. Email already in DB from another auth method? Link Google to that account.
    let email_user = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id, COALESCE(tier, 'free') FROM users WHERE email = $1",
    )
    .bind(&payload.email)
    .fetch_optional(&state.db)
    .await?;

    if let Some((user_id, tier)) = email_user {
        tracing::info!(user_id = %user_id, "google auth: linking google_id to existing email account");
        sqlx::query(
            "UPDATE users SET google_id = $1, display_name = COALESCE($2, display_name), updated_at = now() WHERE id = $3"
        )
        .bind(&payload.sub)
        .bind(&payload.name)
        .bind(user_id)
        .execute(&state.db)
        .await?;

        let token = create_jwt(user_id, Some(&payload.email), payload.name.as_deref(), &tier, &state.config.jwt_secret)?;
        return Ok(Json(AuthResponse { token, user_id, is_new_user: false }));
    }

    tracing::info!("google auth: creating new user");

    // 3. Brand new user
    let row = sqlx::query_as::<_, (Uuid, String)>(
        "INSERT INTO users (google_id, email, display_name) VALUES ($1, $2, $3) RETURNING id, COALESCE(tier, 'free')",
    )
    .bind(&payload.sub)
    .bind(&payload.email)
    .bind(&payload.name)
    .fetch_one(&state.db)
    .await?;

    let (user_id, tier) = row;
    tracing::info!(user_id = %user_id, "google auth: new user created");
    auto_provision_wallet(state.clone(), user_id);
    let token = create_jwt(user_id, Some(&payload.email), payload.name.as_deref(), &tier, &state.config.jwt_secret)?;
    Ok(Json(AuthResponse { token, user_id, is_new_user: true }))
}

/// POST /api/auth/apple
pub async fn apple_sign_in(
    State(state): State<AppState>,
    Json(req): Json<AppleSignInRequest>,
) -> Result<Json<AuthResponse>, CloudError> {
    // 1. Returning user? (already linked Apple)
    let existing = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id, COALESCE(tier, 'free') FROM users WHERE apple_id = $1",
    )
    .bind(&req.user_id)
    .fetch_optional(&state.db)
    .await?;

    if let Some((user_id, tier)) = existing {
        // Ignore email UNIQUE errors — just skip the email update if it conflicts
        if let Err(e) = sqlx::query(
            "UPDATE users SET email = COALESCE($1, email), display_name = COALESCE($2, display_name), updated_at = now() WHERE apple_id = $3"
        )
        .bind(&req.email)
        .bind(&req.full_name)
        .bind(&req.user_id)
        .execute(&state.db)
        .await {
            tracing::warn!(apple_id = %req.user_id, "apple auth: skipping profile update (email conflict?): {e}");
        }

        let token = create_jwt(user_id, req.email.as_deref(), req.full_name.as_deref(), &tier, &state.config.jwt_secret)?;
        return Ok(Json(AuthResponse { token, user_id, is_new_user: false }));
    }

    // 2. Email already in DB from another auth method? Link Apple to that account.
    if let Some(ref email) = req.email {
        let email_user = sqlx::query_as::<_, (Uuid, String)>(
            "SELECT id, COALESCE(tier, 'free') FROM users WHERE email = $1",
        )
        .bind(email)
        .fetch_optional(&state.db)
        .await?;

        if let Some((user_id, tier)) = email_user {
            sqlx::query(
                "UPDATE users SET apple_id = $1, display_name = COALESCE($2, display_name), updated_at = now() WHERE id = $3"
            )
            .bind(&req.user_id)
            .bind(&req.full_name)
            .bind(user_id)
            .execute(&state.db)
            .await?;

            let token = create_jwt(user_id, Some(email), req.full_name.as_deref(), &tier, &state.config.jwt_secret)?;
            return Ok(Json(AuthResponse { token, user_id, is_new_user: false }));
        }
    }

    // 3. Brand new user
    let row = sqlx::query_as::<_, (Uuid, String)>(
        "INSERT INTO users (apple_id, email, display_name) VALUES ($1, $2, $3) RETURNING id, COALESCE(tier, 'free')",
    )
    .bind(&req.user_id)
    .bind(&req.email)
    .bind(&req.full_name)
    .fetch_one(&state.db)
    .await?;

    let (user_id, tier) = row;
    auto_provision_wallet(state.clone(), user_id);
    let token = create_jwt(user_id, req.email.as_deref(), req.full_name.as_deref(), &tier, &state.config.jwt_secret)?;
    Ok(Json(AuthResponse { token, user_id, is_new_user: true }))
}

/// POST /api/auth/twitter
pub async fn twitter_sign_in(
    State(state): State<AppState>,
    Json(req): Json<TwitterSignInRequest>,
) -> Result<Json<AuthResponse>, CloudError> {
    let display = req.name.clone()
        .or_else(|| req.username.clone());

    // 1. Returning user? (already linked Twitter)
    let existing = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id, COALESCE(tier, 'free') FROM users WHERE twitter_id = $1",
    )
    .bind(&req.twitter_id)
    .fetch_optional(&state.db)
    .await?;

    if let Some((user_id, tier)) = existing {
        // Ignore email UNIQUE errors — just skip the email update if it conflicts
        if let Err(e) = sqlx::query(
            "UPDATE users SET email = COALESCE($1, email), display_name = COALESCE($2, display_name), updated_at = now() WHERE twitter_id = $3"
        )
        .bind(&req.email)
        .bind(&display)
        .bind(&req.twitter_id)
        .execute(&state.db)
        .await {
            tracing::warn!(twitter_id = %req.twitter_id, "twitter auth: skipping profile update (email conflict?): {e}");
        }

        let token = create_jwt(user_id, req.email.as_deref(), display.as_deref(), &tier, &state.config.jwt_secret)?;
        return Ok(Json(AuthResponse { token, user_id, is_new_user: false }));
    }

    // 2. Email already in DB from another auth method? Link Twitter to that account.
    if let Some(ref email) = req.email {
        let email_user = sqlx::query_as::<_, (Uuid, String)>(
            "SELECT id, COALESCE(tier, 'free') FROM users WHERE email = $1",
        )
        .bind(email)
        .fetch_optional(&state.db)
        .await?;

        if let Some((user_id, tier)) = email_user {
            sqlx::query(
                "UPDATE users SET twitter_id = $1, display_name = COALESCE($2, display_name), updated_at = now() WHERE id = $3"
            )
            .bind(&req.twitter_id)
            .bind(&display)
            .bind(user_id)
            .execute(&state.db)
            .await?;

            let token = create_jwt(user_id, Some(email), display.as_deref(), &tier, &state.config.jwt_secret)?;
            return Ok(Json(AuthResponse { token, user_id, is_new_user: false }));
        }
    }

    // 3. Brand new user
    let row = sqlx::query_as::<_, (Uuid, String)>(
        "INSERT INTO users (twitter_id, email, display_name) VALUES ($1, $2, $3) RETURNING id, COALESCE(tier, 'free')",
    )
    .bind(&req.twitter_id)
    .bind(&req.email)
    .bind(&display)
    .fetch_one(&state.db)
    .await?;

    let (user_id, tier) = row;
    auto_provision_wallet(state.clone(), user_id);
    let token = create_jwt(user_id, req.email.as_deref(), display.as_deref(), &tier, &state.config.jwt_secret)?;
    Ok(Json(AuthResponse { token, user_id, is_new_user: true }))
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

    // Hash password with HMAC-SHA256 + per-user salt
    let password_hash = hash_password_v2(&req.password);

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
        RETURNING id, COALESCE(tier, 'free')
        "#,
    )
    .bind(&req.email)
    .bind(&req.display_name)
    .bind(&password_hash)
    .fetch_one(&state.db)
    .await?;

    let (user_id, tier) = row;
    auto_provision_wallet(state.clone(), user_id);
    let token = create_jwt(user_id, Some(&req.email), req.display_name.as_deref(), &tier, &state.config.jwt_secret)?;

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
    let row = sqlx::query_as::<_, (Uuid, String, Option<String>, Option<String>)>(
        "SELECT id, COALESCE(tier, 'free'), password_hash, display_name FROM users WHERE email = $1",
    )
    .bind(&req.email)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::Auth("invalid email or password".to_string()))?;

    let (user_id, tier, stored_hash, display_name) = row;

    let stored_hash = stored_hash
        .ok_or(CloudError::Auth("this account uses Apple/Google sign-in".to_string()))?;

    if !verify_password(&req.password, &stored_hash) {
        return Err(CloudError::Auth("invalid email or password".to_string()));
    }

    // Migrate legacy hashes to v2 on successful login
    if needs_rehash(&stored_hash) {
        let new_hash = hash_password_v2(&req.password);
        let _ = sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
            .bind(&new_hash)
            .bind(user_id)
            .execute(&state.db)
            .await;
        tracing::info!(%user_id, "migrated password hash to v2");
    }

    let token = create_jwt(user_id, Some(&req.email), display_name.as_deref(), &tier, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse {
        token,
        user_id,
        is_new_user: false,
    }))
}

/// Hash a password with PBKDF2-HMAC-SHA256 (600k iterations) using a per-user random salt.
/// Format: "v3:{hex_salt}:{hex_derived_key}"
fn hash_password_v2(password: &str) -> String {
    use rand::RngCore;

    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let salt_hex: String = salt.iter().map(|b| format!("{b:02x}")).collect();

    let dk = pbkdf2_hmac_sha256(password.as_bytes(), &salt, 600_000);
    let dk_hex: String = dk.iter().map(|b| format!("{b:02x}")).collect();

    format!("v3:{salt_hex}:{dk_hex}")
}

/// HMAC-SHA256 (RFC 2104) — used internally by PBKDF2 and for v2 migration.
fn hmac_sha256_password(key: &[u8], data: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};

    let block_size = 64;
    let mut k = vec![0u8; block_size];
    if key.len() > block_size {
        let hash = Sha256::digest(key);
        k[..32].copy_from_slice(&hash);
    } else {
        k[..key.len()].copy_from_slice(key);
    }

    let mut ipad = vec![0x36u8; block_size];
    let mut opad = vec![0x5cu8; block_size];
    for i in 0..block_size {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }

    let mut inner = Sha256::new();
    inner.update(&ipad);
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(&inner_hash);
    let result = outer.finalize();

    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// PBKDF2-HMAC-SHA256 (RFC 8018) — slow key derivation for password storage.
fn pbkdf2_hmac_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    // PBKDF2 with a single block (dkLen = 32 = SHA256 output, so i=1)
    let mut block_salt = Vec::with_capacity(salt.len() + 4);
    block_salt.extend_from_slice(salt);
    block_salt.extend_from_slice(&1u32.to_be_bytes()); // block index 1

    let mut u = hmac_sha256_password(password, &block_salt);
    let mut result = u;

    for _ in 1..iterations {
        u = hmac_sha256_password(password, &u);
        for (r, x) in result.iter_mut().zip(u.iter()) {
            *r ^= x;
        }
    }

    result
}

/// Legacy password hashing (DefaultHasher-based) — kept for migration only.
fn hash_password_legacy(password: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
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
    if stored.starts_with("v3:") {
        // PBKDF2 format: "v3:{salt_hex}:{dk_hex}"
        let parts: Vec<&str> = stored.splitn(3, ':').collect();
        if parts.len() != 3 {
            return false;
        }
        let salt = parse_hex(parts[1]);
        let expected_dk = parse_hex(parts[2]);
        let computed = pbkdf2_hmac_sha256(password.as_bytes(), &salt, 600_000);
        computed.as_slice() == expected_dk.as_slice()
    } else if stored.starts_with("v2:") {
        // Legacy HMAC format: "v2:{salt_hex}:{hmac_hex}"
        let parts: Vec<&str> = stored.splitn(3, ':').collect();
        if parts.len() != 3 {
            return false;
        }
        let salt = parse_hex(parts[1]);
        let expected_hmac = parse_hex(parts[2]);
        let computed = hmac_sha256_password(&salt, password.as_bytes());
        computed.as_slice() == expected_hmac.as_slice()
    } else {
        // Legacy format — verify against old hash
        hash_password_legacy(password) == stored
    }
}

fn parse_hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .filter_map(|i| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()))
        .collect()
}

/// Check if a stored hash needs upgrading to v3 (PBKDF2).
fn needs_rehash(stored: &str) -> bool {
    !stored.starts_with("v3:")
}

/// Auto-provision a Solana wallet for new users (fire-and-forget).
fn auto_provision_wallet(state: AppState, user_id: Uuid) {
    tokio::spawn(async move {
        match crate::services::wallet_service::generate_wallet(&state, user_id).await {
            Ok(info) => {
                tracing::info!(%user_id, address = %info.address, "auto-provisioned wallet on signup");
            }
            Err(e) => {
                tracing::warn!(%user_id, "wallet auto-provision failed (user can retry): {e}");
            }
        }
    });
}

/// POST /api/auth/refresh
pub async fn refresh_token(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> Result<Json<AuthResponse>, CloudError> {
    let claims = crate::auth::verify_jwt(&req.token, &state.config.jwt_secret)?;

    // Re-fetch user to get current tier and display name
    let row = sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
        "SELECT COALESCE(tier, 'free'), email, display_name FROM users WHERE id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::NotFound("user not found".to_string()))?;

    let (tier, email, display_name) = row;
    let token = create_jwt(claims.sub, email.as_deref(), display_name.as_deref(), &tier, &state.config.jwt_secret)?;

    Ok(Json(AuthResponse {
        token,
        user_id: claims.sub,
        is_new_user: false,
    }))
}
