use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::CloudError;
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: Uuid,       // user_id
    pub email: Option<String>,
    pub name: Option<String>,
    pub tier: String,
    pub exp: i64,
    pub iat: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GoogleTokenPayload {
    pub sub: String,      // Google user ID
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
    pub email_verified: Option<bool>,
    pub iss: Option<String>,
    pub aud: Option<String>,
    pub exp: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AppleTokenPayload {
    pub sub: String,      // Apple user ID
    pub email: Option<String>,
}

pub fn create_jwt(user_id: Uuid, email: Option<&str>, name: Option<&str>, tier: &str, secret: &str) -> Result<String, CloudError> {
    let now = Utc::now();
    let claims = Claims {
        sub: user_id,
        email: email.map(|s| s.to_string()),
        name: name.map(|s| s.to_string()),
        tier: tier.to_string(),
        exp: (now + Duration::days(30)).timestamp(),
        iat: now.timestamp(),
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| CloudError::Internal(format!("JWT encode failed: {e}")))
}

pub fn verify_jwt(token: &str, secret: &str) -> Result<Claims, CloudError> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|e| CloudError::Auth(format!("invalid token: {e}")))?;

    Ok(data.claims)
}

/// Extracts authenticated user from the Authorization header.
#[derive(Debug, Clone)]
pub struct AuthUser(pub Claims);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = CloudError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .ok_or(CloudError::Unauthorized)?;

        let token = auth_header
            .strip_prefix("Bearer ")
            .ok_or(CloudError::Auth("expected Bearer token".to_string()))?;

        // Dual-path: API key or JWT
        if token.starts_with("sk-ghola-") {
            let claims = verify_api_key(token, state).await?;
            Ok(AuthUser(claims))
        } else {
            let claims = verify_jwt(token, &state.config.jwt_secret)?;
            Ok(AuthUser(claims))
        }
    }
}

/// Verify an API key by hashing it and looking up the hash in the database.
async fn verify_api_key(key: &str, state: &AppState) -> Result<Claims, CloudError> {
    let key_hash = hash_api_key(key);

    let row = sqlx::query_as::<_, (Uuid, Uuid)>(
        "SELECT id, user_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
    )
    .bind(&key_hash)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| CloudError::Internal(format!("api key lookup failed: {e}")))?
    .ok_or(CloudError::Auth("invalid or revoked API key".to_string()))?;

    let (api_key_id, user_id) = row;

    // Load user claims
    let user_row = sqlx::query_as::<_, (Option<String>, String)>(
        "SELECT email, tier FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| CloudError::Internal(format!("user lookup failed: {e}")))?
    .ok_or(CloudError::Auth("user not found".to_string()))?;

    let now = Utc::now();
    let claims = Claims {
        sub: user_id,
        email: user_row.0,
        name: None,
        tier: user_row.1,
        exp: (now + Duration::days(1)).timestamp(),
        iat: now.timestamp(),
    };

    // Fire-and-forget: update last_used_at
    let db = state.db.clone();
    tokio::spawn(async move {
        let _ = sqlx::query("UPDATE api_keys SET last_used_at = now() WHERE id = $1")
            .bind(api_key_id)
            .execute(&db)
            .await;
    });

    Ok(claims)
}

/// SHA-256 hash an API key for storage/lookup.
pub fn hash_api_key(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Generate a new API key: `sk-ghola-{32 hex chars}`.
pub fn generate_api_key() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("sk-ghola-{}", hex::encode(&bytes))
}

mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// Google JWKS key response
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

/// Verify a Google ID token by fetching Google's public keys and validating
/// the RS256 signature, issuer, audience, and expiration.
pub async fn verify_google_token(
    id_token: &str,
    client_id: &str,
) -> Result<GoogleTokenPayload, CloudError> {
    use base64::Engine;

    // Step 1: Decode the header to get the key ID (kid)
    let parts: Vec<&str> = id_token.split('.').collect();
    if parts.len() != 3 {
        tracing::warn!("Google token has {} parts, expected 3", parts.len());
        return Err(CloudError::Auth("invalid Google token format".to_string()));
    }

    let header_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|e| {
            tracing::warn!("Google token header base64 decode failed: {e}");
            CloudError::Auth(format!("header base64 decode failed: {e}"))
        })?;

    let header: serde_json::Value = serde_json::from_slice(&header_bytes)
        .map_err(|e| {
            tracing::warn!("Google token header JSON parse failed: {e}");
            CloudError::Auth(format!("invalid token header: {e}"))
        })?;

    let kid = header["kid"]
        .as_str()
        .ok_or_else(|| {
            tracing::warn!("Google token header missing 'kid' field");
            CloudError::Auth("no kid in token header".to_string())
        })?;

    // Step 2: Fetch Google's public keys
    let client = reqwest::Client::new();
    let jwks_resp = client
        .get("https://www.googleapis.com/oauth2/v3/certs")
        .send()
        .await
        .map_err(|e| {
            tracing::error!("Failed to fetch Google JWKS: {e}");
            CloudError::Internal(format!("failed to fetch Google JWKS: {e}"))
        })?;

    let jwks: GoogleJwks = jwks_resp
        .json()
        .await
        .map_err(|e| {
            tracing::error!("Failed to parse Google JWKS response: {e}");
            CloudError::Internal(format!("failed to parse Google JWKS: {e}"))
        })?;

    // Step 3: Find the matching key
    let key = jwks
        .keys
        .iter()
        .find(|k| k.kid == kid)
        .ok_or_else(|| {
            tracing::warn!("No matching Google JWKS key for kid={kid}");
            CloudError::Auth("no matching Google key for kid".to_string())
        })?;

    // Step 4: Build the RSA public key and verify
    let decoding_key = DecodingKey::from_rsa_components(&key.n, &key.e)
        .map_err(|e| {
            tracing::warn!("Invalid RSA key from Google JWKS: {e}");
            CloudError::Auth(format!("invalid RSA key: {e}"))
        })?;

    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&["accounts.google.com", "https://accounts.google.com"]);

    let token_data = jsonwebtoken::decode::<GoogleTokenPayload>(id_token, &decoding_key, &validation)
        .map_err(|e| {
            tracing::warn!("Google token verification failed (aud={client_id}): {e}");
            CloudError::Auth(format!("Google token verification failed: {e}"))
        })?;

    let payload = token_data.claims;

    // Step 5: Additional checks
    if let Some(ref email_verified) = payload.email_verified {
        if !email_verified {
            tracing::warn!("Google sign-in rejected: email not verified for {}", payload.email);
            return Err(CloudError::Auth("email not verified".to_string()));
        }
    }

    Ok(payload)
}
