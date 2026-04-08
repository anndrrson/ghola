use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::Response;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const JWT_EXPIRY: u64 = 86400; // 24 hours

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

pub async fn auth_middleware(
    State(state): State<std::sync::Arc<crate::state::AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let auth_header = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("Missing authorization header".into()))?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or_else(|| AppError::Unauthorized("Invalid authorization format".into()))?;

    let claims = validate_jwt(token, &state.config.jwt_secret)?;

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
    // Check Bearer JWT
    if let Some(token) = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
    {
        if validate_jwt(token, &state.config.jwt_secret).is_ok() {
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
