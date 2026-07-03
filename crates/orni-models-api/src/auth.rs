use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Cookie name carrying the session JWT in browser contexts.
///
/// Mobile and CLI clients keep using `Authorization: Bearer <jwt>`. Browser
/// clients store the JWT in an HttpOnly cookie set by the auth endpoints;
/// `extract_session_token` honours both, preferring the explicit header.
pub const SESSION_COOKIE_NAME: &str = "ghola_session";

/// Companion CSRF cookie + header for double-submit defense on cookie-
/// authenticated non-GET requests. See thumper-cloud's auth.rs for the
/// canonical comment — this file duplicates the same constants so the two
/// services stay byte-compatible.
///
/// reason: deferred to common-auth crate
pub const CSRF_COOKIE_NAME: &str = "ghola_csrf";
pub const CSRF_HEADER_NAME: &str = "x-csrf-token";

/// reason: deferred to common-auth crate — byte-identical to
/// `thumper_cloud::auth::extract_session_token`. Keep them in sync.
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

const NONCE_EXPIRY: Duration = Duration::from_secs(300); // 5 minutes
const JWT_EXPIRY: u64 = 86400; // 24 hours

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,           // user id
    pub wallet: Option<String>, // wallet address (None for email users)
    pub exp: u64,
    pub iat: u64,
}

pub struct NonceStore {
    nonces: Mutex<HashMap<String, (String, Instant)>>, // nonce -> (wallet, created_at)
}

impl NonceStore {
    pub fn new() -> Self {
        Self {
            nonces: Mutex::new(HashMap::new()),
        }
    }

    pub fn generate(&self, wallet: &str) -> String {
        let nonce = hex::encode(rand::random::<[u8; 32]>());
        let mut store = self.nonces.lock().unwrap();

        // Cleanup expired
        store.retain(|_, (_, created)| created.elapsed() < NONCE_EXPIRY);

        store.insert(nonce.clone(), (wallet.to_string(), Instant::now()));
        nonce
    }

    pub fn validate_and_remove(&self, nonce: &str, wallet: &str) -> bool {
        let mut store = self.nonces.lock().unwrap();
        if let Some((stored_wallet, created)) = store.remove(nonce) {
            stored_wallet == wallet && created.elapsed() < NONCE_EXPIRY
        } else {
            false
        }
    }
}

pub fn verify_siws(wallet_address: &str, message: &[u8], signature_b64: &str) -> AppResult<()> {
    let sig_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        signature_b64,
    )
    .map_err(|_| AppError::BadRequest("Invalid signature encoding".into()))?;

    let signature = Signature::from_bytes(
        sig_bytes
            .as_slice()
            .try_into()
            .map_err(|_| AppError::BadRequest("Invalid signature length".into()))?,
    );

    let pubkey_bytes = bs58::decode(wallet_address)
        .into_vec()
        .map_err(|_| AppError::BadRequest("Invalid wallet address".into()))?;

    let verifying_key = VerifyingKey::from_bytes(
        pubkey_bytes
            .as_slice()
            .try_into()
            .map_err(|_| AppError::BadRequest("Invalid public key length".into()))?,
    )
    .map_err(|_| AppError::BadRequest("Invalid public key".into()))?;

    verifying_key
        .verify(message, &signature)
        .map_err(|_| AppError::Unauthorized("Signature verification failed".into()))
}

pub fn issue_jwt(user_id: &Uuid, wallet: Option<&str>, secret: &str) -> AppResult<String> {
    let now = chrono::Utc::now().timestamp() as u64;
    let claims = Claims {
        sub: user_id.to_string(),
        wallet: wallet.map(|w| w.to_string()),
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
    State(state): axum::extract::State<std::sync::Arc<crate::state::AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    // Accept the JWT from `Authorization: Bearer …` (mobile/CLI) or the
    // `ghola_session` cookie (web). Header preferred when both exist.
    let token = extract_session_token(req.headers())
        .ok_or_else(|| AppError::Unauthorized("Missing session token".into()))?;

    let claims = validate_jwt(&token, &state.config.jwt_secret)?;
    req.extensions_mut().insert(claims);

    Ok(next.run(req).await)
}

/// Double-submit CSRF middleware for cookie-authenticated requests. Mirror of
/// `thumper_cloud::middleware::csrf_protect`. See that comment for the threat
/// model.
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

    // Bypass auth endpoints (no CSRF token exists at sign-in time).
    if path.starts_with("/api/auth/") {
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
