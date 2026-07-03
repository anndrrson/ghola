use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Cookie name carrying the session JWT in browser contexts. Mirrors
/// thumper-cloud + orni-models-api so the SPA can use the same cookie across
/// all three backends.
///
/// reason: deferred to common-auth crate — byte-identical to the constants in
/// thumper-cloud and orni-models-api. Keep in sync.
pub const SESSION_COOKIE_NAME: &str = "ghola_session";
pub const CSRF_COOKIE_NAME: &str = "ghola_csrf";
pub const CSRF_HEADER_NAME: &str = "x-csrf-token";

/// Extract the session JWT from either `Authorization: Bearer …` (mobile/CLI)
/// or the `ghola_session` cookie (browser). Header preferred when both are
/// present.
pub fn extract_session_token(headers: &HeaderMap) -> Option<String> {
    if let Some(auth_val) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(bearer) = auth_val.strip_prefix("Bearer ") {
            return Some(bearer.to_string());
        }
    }
    extract_cookie_value(headers, SESSION_COOKIE_NAME)
}

pub fn extract_cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())?;
    for pair in raw.split(';') {
        let pair = pair.trim();
        if let Some((k, v)) = pair.split_once('=') {
            if k == name {
                return Some(v.to_string());
            }
        }
    }
    None
}

pub fn cookies_secure() -> bool {
    !matches!(
        std::env::var("COOKIES_INSECURE_DEV").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

pub fn build_session_cookie(jwt: &str, max_age_seconds: i64) -> String {
    let secure = if cookies_secure() { "; Secure" } else { "" };
    let max_age = max_age_seconds.max(0);
    format!(
        "{SESSION_COOKIE_NAME}={jwt}; HttpOnly{secure}; SameSite=Lax; Path=/; Max-Age={max_age}"
    )
}

pub fn build_csrf_cookie(csrf_token: &str, max_age_seconds: i64) -> String {
    let secure = if cookies_secure() { "; Secure" } else { "" };
    let max_age = max_age_seconds.max(0);
    format!("{CSRF_COOKIE_NAME}={csrf_token}{secure}; SameSite=Lax; Path=/; Max-Age={max_age}")
}

pub fn build_clear_cookies() -> [String; 2] {
    let secure = if cookies_secure() { "; Secure" } else { "" };
    [
        format!("{SESSION_COOKIE_NAME}=; HttpOnly{secure}; SameSite=Lax; Path=/; Max-Age=0"),
        format!("{CSRF_COOKIE_NAME}={secure}; SameSite=Lax; Path=/; Max-Age=0"),
    ]
}

pub fn generate_csrf_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const JWT_EXPIRY: u64 = 2_592_000; // 30 days, matches thumper-cloud
pub const REFRESH_TOKEN_TTL_SECONDS: u64 = 180 * 86400; // 180 days

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,   // user_id (UUID as string)
    pub email: String,
    pub exp: u64,
    pub iat: u64,
}

pub fn issue_jwt(user_id: &uuid::Uuid, email: &str, secret: &str) -> AppResult<String> {
    let now = chrono::Utc::now().timestamp() as u64;
    let claims = Claims {
        sub: user_id.to_string(),
        email: email.to_string(),
        exp: now + JWT_EXPIRY,
        iat: now,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("JWT encode failed: {e}")))
}

pub fn validate_jwt(token: &str, secret: &str) -> AppResult<Claims> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|_| AppError::Unauthorized("Invalid or expired token".into()))
}

// ---------------------------------------------------------------------------
// Refresh-token rotation (OAuth2 single-use semantics)
//
// Mirrors thumper-cloud's implementation. The Android client signs in once
// via SIWS and gets back BOTH an access JWT (30d) and a refresh token (180d).
// When the access token approaches expiry, the client POSTs the refresh token
// to /v1/auth/refresh and gets a new pair. Old refresh row is marked revoked
// and `rotated_to_hash` records the forward link for theft detection.
// ---------------------------------------------------------------------------

/// Issue a new refresh token for `user_id` and persist its SHA-256 hash.
pub async fn create_refresh_token(
    db: &sqlx::PgPool,
    user_id: uuid::Uuid,
) -> AppResult<(String, i64)> {
    use rand::RngCore;
    use sha2::{Digest, Sha256};

    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let token_hash = {
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        format!("{:x}", hasher.finalize())
    };
    let now = chrono::Utc::now();
    let expires_at = now + chrono::Duration::seconds(REFRESH_TOKEN_TTL_SECONDS as i64);

    sqlx::query(
        "INSERT INTO refresh_tokens (token_hash, user_id, issued_at, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(&token_hash)
    .bind(user_id)
    .bind(now)
    .bind(expires_at)
    .execute(db)
    .await
    .map_err(|e| AppError::Internal(format!("refresh_tokens insert failed: {e}")))?;

    Ok((token, expires_at.timestamp()))
}

/// Consume a refresh token: verify, revoke, issue replacement. Single-use.
/// Returns (new_refresh_token, new_exp_seconds, user_id).
pub async fn consume_refresh_token(
    db: &sqlx::PgPool,
    refresh_token: &str,
) -> AppResult<(String, i64, uuid::Uuid)> {
    use sha2::{Digest, Sha256};

    let token_hash = {
        let mut hasher = Sha256::new();
        hasher.update(refresh_token.as_bytes());
        format!("{:x}", hasher.finalize())
    };

    let now = chrono::Utc::now();
    let row = sqlx::query_as::<
        _,
        (
            uuid::Uuid,
            chrono::DateTime<chrono::Utc>,
            Option<chrono::DateTime<chrono::Utc>>,
        ),
    >(
        "SELECT user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1",
    )
    .bind(&token_hash)
    .fetch_optional(db)
    .await
    .map_err(|e| AppError::Internal(format!("refresh_tokens lookup failed: {e}")))?
    .ok_or_else(|| AppError::Unauthorized("unknown refresh token".into()))?;

    let (user_id, expires_at, revoked_at) = row;
    if revoked_at.is_some() {
        return Err(AppError::Unauthorized("refresh token revoked".into()));
    }
    if expires_at <= now {
        return Err(AppError::Unauthorized("refresh token expired".into()));
    }

    let (new_token, new_exp) = create_refresh_token(db, user_id).await?;
    let new_hash = {
        let mut hasher = Sha256::new();
        hasher.update(new_token.as_bytes());
        format!("{:x}", hasher.finalize())
    };

    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = $1, rotated_to_hash = $2 WHERE token_hash = $3",
    )
    .bind(now)
    .bind(&new_hash)
    .bind(&token_hash)
    .execute(db)
    .await
    .map_err(|e| AppError::Internal(format!("refresh_tokens rotate failed: {e}")))?;

    Ok((new_token, new_exp, user_id))
}

/// Verify an Ed25519 detached signature from a base58 Solana pubkey.
pub fn verify_siws(wallet_pubkey: &str, message: &[u8], signature: &[u8]) -> AppResult<()> {
    let pubkey_vec = bs58::decode(wallet_pubkey)
        .into_vec()
        .map_err(|e| AppError::Unauthorized(format!("invalid wallet pubkey: {e}")))?;
    let pubkey_bytes: [u8; 32] = pubkey_vec
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Unauthorized("wallet pubkey must be 32 bytes".into()))?;
    let verifying_key = VerifyingKey::from_bytes(&pubkey_bytes)
        .map_err(|e| AppError::Unauthorized(format!("invalid wallet pubkey: {e}")))?;

    let sig_bytes: [u8; 64] = signature
        .try_into()
        .map_err(|_| AppError::Unauthorized("signature must be 64 bytes".into()))?;
    let sig = Signature::from_bytes(&sig_bytes);

    verifying_key
        .verify(message, &sig)
        .map_err(|_| AppError::Unauthorized("signature verification failed".into()))
}

/// Double-submit CSRF middleware for cookie-authenticated requests. Mirror of
/// the helpers in thumper-cloud and orni-models-api. See thumper-cloud's
/// implementation for the threat model.
///
/// reason: deferred to common-auth crate
pub async fn csrf_protect(req: Request, next: Next) -> Result<Response, AppError> {
    let method = req.method().clone();
    if matches!(
        method,
        axum::http::Method::GET
            | axum::http::Method::HEAD
            | axum::http::Method::OPTIONS
            | axum::http::Method::TRACE
    ) {
        return Ok(next.run(req).await);
    }

    let headers = req.headers();
    let path = req.uri().path().to_string();

    // Bypass sign-in endpoints (no CSRF token exists at that point).
    if path.starts_with("/v1/auth/") {
        return Ok(next.run(req).await);
    }

    let has_bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("Bearer "))
        .unwrap_or(false);
    if has_bearer {
        return Ok(next.run(req).await);
    }

    let session_present = extract_cookie_value(headers, SESSION_COOKIE_NAME).is_some();
    if !session_present {
        return Ok(next.run(req).await);
    }

    let cookie_token = extract_cookie_value(headers, CSRF_COOKIE_NAME);
    let header_token = headers
        .get(CSRF_HEADER_NAME)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    match (cookie_token.as_deref(), header_token.as_deref()) {
        (Some(c), Some(h)) if !c.is_empty() && c == h => Ok(next.run(req).await),
        _ => {
            tracing::warn!(path = %path, "csrf check failed: cookie/header mismatch");
            Err(AppError::Unauthorized("CSRF token missing or mismatched".into()))
        }
    }
}

pub async fn auth_middleware(
    State(state): State<std::sync::Arc<crate::state::AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    // Accept the JWT from `Authorization: Bearer …` (mobile/CLI) or the
    // `ghola_session` cookie (web). Header preferred when both exist.
    let token = extract_session_token(req.headers())
        .ok_or_else(|| AppError::Unauthorized("Missing session token".into()))?;

    let claims = validate_jwt(&token, &state.config.jwt_secret)?;

    // Enforce daily usage limits based on subscription tier
    let user_id: uuid::Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Internal("Invalid user ID in token".into()))?;

    let (_tier, limits) = crate::routes::billing::get_effective_tier(&state.db, &user_id)
        .await
        .map_err(|e| AppError::Internal(format!("DB error: {e}")))?;

    let current_usage = crate::routes::billing::get_daily_usage(&state, &user_id).await;

    if current_usage >= limits.resolve_per_day {
        return Err(AppError::TooManyRequests(
            // Seconds until midnight UTC
            {
                let now = chrono::Utc::now();
                let tomorrow = (now + chrono::Duration::days(1)).date_naive().and_hms_opt(0, 0, 0).unwrap();
                let midnight = tomorrow.and_utc();
                (midnight - now).num_seconds().max(1) as u64
            },
        ));
    }

    // Track API usage for billing (after limit check)
    state.usage_meter.increment(&claims.sub);

    req.extensions_mut().insert(claims);

    Ok(next.run(req).await)
}

/// Returns true if the request headers contain a valid JWT Bearer token
/// OR a non-empty X-Service-Key that exists in the database as an active key.
/// Used to gate bulk/paginated list endpoints.
pub async fn check_bulk_auth(
    headers: &axum::http::HeaderMap,
    state: &crate::state::AppState,
) -> bool {
    // Check Bearer JWT (or `ghola_session` cookie equivalent)
    if let Some(token) = extract_session_token(headers) {
        if validate_jwt(&token, &state.config.jwt_secret).is_ok() {
            return true;
        }
    }

    // Check X-Service-Key
    if let Some(raw_key) = headers
        .get("x-service-key")
        .and_then(|v| v.to_str().ok())
    {
        use sha2::{Digest, Sha256};
        let key_hash = hex::encode(Sha256::digest(raw_key.as_bytes()));
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM service_api_keys WHERE key_hash = $1 AND active = true)",
        )
        .bind(&key_hash)
        .fetch_one(&state.db)
        .await
        .unwrap_or(false);
        if exists {
            return true;
        }
    }

    false
}

pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(format!("Password hash failed: {e}")))
}

pub fn verify_password(password: &str, hash: &str) -> AppResult<bool> {
    let parsed = PasswordHash::new(hash)
        .map_err(|e| AppError::Internal(format!("Invalid password hash: {e}")))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

// ── Google ID token verification ────────────────────────────────────────────
//
// Mirrors the implementation in `crates/thumper-cloud/src/auth.rs::verify_google_token`
// (lines 184-274). Used by `routes/auth.rs::google_sign_in` for the mobile app
// (Android/Seeker), which already has a Google ID token from its existing
// thumper-cloud sign-in flow and just needs to mint a parallel said-cloud JWT.

#[derive(Debug, Deserialize)]
pub struct GoogleTokenPayload {
    pub sub: String,
    pub email: String,
    #[serde(default)]
    pub email_verified: Option<bool>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleJwks {
    keys: Vec<GoogleJwk>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct GoogleJwk {
    kid: String,
    n: String,
    e: String,
    alg: Option<String>,
}

pub async fn verify_google_id_token(
    id_token: &str,
    client_id: &str,
) -> AppResult<GoogleTokenPayload> {
    use base64::Engine;

    let parts: Vec<&str> = id_token.split('.').collect();
    if parts.len() != 3 {
        return Err(AppError::Unauthorized("invalid Google token format".into()));
    }

    let header_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|e| AppError::Unauthorized(format!("header base64 decode failed: {e}")))?;

    let header: serde_json::Value = serde_json::from_slice(&header_bytes)
        .map_err(|e| AppError::Unauthorized(format!("invalid token header: {e}")))?;

    let kid = header["kid"]
        .as_str()
        .ok_or_else(|| AppError::Unauthorized("no kid in token header".into()))?;

    let client = reqwest::Client::new();
    let jwks: GoogleJwks = client
        .get("https://www.googleapis.com/oauth2/v3/certs")
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("failed to fetch Google JWKS: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("failed to parse Google JWKS: {e}")))?;

    let key = jwks
        .keys
        .iter()
        .find(|k| k.kid == kid)
        .ok_or_else(|| AppError::Unauthorized("no matching Google key for kid".into()))?;

    let decoding_key = jsonwebtoken::DecodingKey::from_rsa_components(&key.n, &key.e)
        .map_err(|e| AppError::Unauthorized(format!("invalid RSA key: {e}")))?;

    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&["accounts.google.com", "https://accounts.google.com"]);

    let token_data = jsonwebtoken::decode::<GoogleTokenPayload>(id_token, &decoding_key, &validation)
        .map_err(|e| AppError::Unauthorized(format!("Google token verification failed: {e}")))?;

    let payload = token_data.claims;

    if let Some(false) = payload.email_verified {
        return Err(AppError::Unauthorized("email not verified".into()));
    }

    Ok(payload)
}
