use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use chrono::{Duration, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::CloudError;
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: Uuid, // user_id
    pub email: Option<String>,
    pub name: Option<String>,
    pub tier: String,
    pub exp: i64,
    pub iat: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GoogleTokenPayload {
    pub sub: String, // Google user ID
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
    pub sub: String, // Apple user ID
    pub email: Option<String>,
    pub email_verified: Option<serde_json::Value>,
    pub iss: Option<String>,
    pub aud: Option<String>,
    pub exp: Option<i64>,
}

pub fn create_jwt(
    user_id: Uuid,
    email: Option<&str>,
    name: Option<&str>,
    tier: &str,
    secret: &str,
) -> Result<String, CloudError> {
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

/// Verify an Ed25519 detached signature from a base58 Solana pubkey.
pub fn verify_siws(
    wallet_pubkey: &str,
    message: &[u8],
    signature: &[u8],
) -> Result<(), CloudError> {
    let pubkey_vec = bs58::decode(wallet_pubkey)
        .into_vec()
        .map_err(|e| CloudError::Auth(format!("invalid wallet pubkey: {e}")))?;
    let pubkey_bytes: [u8; 32] = pubkey_vec
        .as_slice()
        .try_into()
        .map_err(|_| CloudError::Auth("wallet pubkey must be 32 bytes".to_string()))?;
    let verifying_key = VerifyingKey::from_bytes(&pubkey_bytes)
        .map_err(|e| CloudError::Auth(format!("invalid wallet pubkey: {e}")))?;

    let sig_bytes: [u8; 64] = signature
        .try_into()
        .map_err(|_| CloudError::Auth("signature must be 64 bytes".to_string()))?;
    let sig = Signature::from_bytes(&sig_bytes);

    verifying_key
        .verify(message, &sig)
        .map_err(|_| CloudError::Auth("signature verification failed".to_string()))
}

/// Extracts authenticated user from the Authorization header.
#[derive(Debug, Clone)]
pub struct AuthUser(pub Claims);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = CloudError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
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
///
/// SECURITY NOTE (L3, deferred): this is a bare SHA-256, not an HMAC keyed with
/// a server-side secret. HMAC-with-server-key is the standard hardening (it
/// stops an attacker who reads the `api_keys.key_hash` column via a DB leak
/// from verifying guessed keys offline without also stealing the server key).
/// We accept the current scheme for now because:
///   1. Keys are high-entropy (`sk-ghola-` + 128 bits of randomness; see
///      `generate_api_key`), so offline precomputation/brute-force is
///      infeasible regardless of the hash.
///   2. Switching to HMAC would change every stored `key_hash`, invalidating
///      all live keys — it requires a re-hash/rotation migration, not a hot
///      swap.
/// Tracked here so the hardening is an explicit, revisitable decision rather
/// than silently accepted. If/when a key migration path exists, move this to
/// HMAC-SHA256 keyed with a dedicated server secret.
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

// ---------------------------------------------------------------------------
// Refresh-token rotation (OAuth2 single-use semantics)
// ---------------------------------------------------------------------------

/// 180-day refresh token TTL. Long enough that a user who opens the app once
/// a quarter still recovers without an interactive SIWS prompt.
pub const REFRESH_TOKEN_TTL_DAYS: i64 = 180;

/// Issue a new refresh token for `user_id` and persist its SHA-256 hash. The
/// raw token (never persisted in plaintext) is what the client stores and
/// presents at refresh time.
pub async fn create_refresh_token(
    state: &AppState,
    user_id: Uuid,
) -> Result<(String, i64), CloudError> {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = hex::encode(&bytes);
    let token_hash = {
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        format!("{:x}", hasher.finalize())
    };
    let now = Utc::now();
    let expires_at = now + Duration::days(REFRESH_TOKEN_TTL_DAYS);

    sqlx::query(
        "INSERT INTO refresh_tokens (token_hash, user_id, issued_at, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(&token_hash)
    .bind(user_id)
    .bind(now)
    .bind(expires_at)
    .execute(&state.db)
    .await
    .map_err(|e| CloudError::Internal(format!("refresh_tokens insert failed: {e}")))?;

    Ok((token, expires_at.timestamp()))
}

/// Consume a refresh token: verify it's present, non-revoked, non-expired;
/// mark it revoked; issue a new one; return (new_refresh_token, new_exp,
/// user_id). Single-use — a token presented twice is invalid the second time.
///
/// If a token is replayed AFTER rotation, callers can detect via the audit
/// trail in `rotated_to_hash` and revoke the entire chain (future work).
pub async fn consume_refresh_token(
    state: &AppState,
    refresh_token: &str,
) -> Result<(String, i64, Uuid), CloudError> {
    use rand::RngCore;

    let token_hash = {
        let mut hasher = Sha256::new();
        hasher.update(refresh_token.as_bytes());
        format!("{:x}", hasher.finalize())
    };

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| CloudError::Internal(format!("refresh_tokens transaction failed: {e}")))?;
    let now = Utc::now();
    let row = sqlx::query_as::<_, (Uuid, chrono::DateTime<Utc>, Option<chrono::DateTime<Utc>>)>(
        "SELECT user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE",
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| CloudError::Internal(format!("refresh_tokens lookup failed: {e}")))?
    .ok_or(CloudError::Auth("unknown refresh token".to_string()))?;

    let (user_id, expires_at, revoked_at) = row;
    if revoked_at.is_some() {
        return Err(CloudError::Auth("refresh token revoked".to_string()));
    }
    if expires_at <= now {
        return Err(CloudError::Auth("refresh token expired".to_string()));
    }

    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let new_token = hex::encode(&bytes);
    let new_hash = {
        let mut hasher = Sha256::new();
        hasher.update(new_token.as_bytes());
        format!("{:x}", hasher.finalize())
    };
    let new_expires_at = now + Duration::days(REFRESH_TOKEN_TTL_DAYS);

    sqlx::query(
        "INSERT INTO refresh_tokens (token_hash, user_id, issued_at, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(&new_hash)
    .bind(user_id)
    .bind(now)
    .bind(new_expires_at)
    .execute(&mut *tx)
    .await
    .map_err(|e| CloudError::Internal(format!("refresh_tokens insert failed: {e}")))?;

    let updated = sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = $1, rotated_to_hash = $2 WHERE token_hash = $3 AND revoked_at IS NULL",
    )
    .bind(now)
    .bind(&new_hash)
    .bind(&token_hash)
    .execute(&mut *tx)
    .await
    .map_err(|e| CloudError::Internal(format!("refresh_tokens rotate failed: {e}")))?;

    if updated.rows_affected() != 1 {
        return Err(CloudError::Auth("refresh token revoked".to_string()));
    }

    tx.commit()
        .await
        .map_err(|e| CloudError::Internal(format!("refresh_tokens commit failed: {e}")))?;

    Ok((new_token, new_expires_at.timestamp(), user_id))
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

#[derive(Debug, Deserialize)]
struct AppleJwks {
    keys: Vec<AppleJwk>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct AppleJwk {
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

    let header: serde_json::Value = serde_json::from_slice(&header_bytes).map_err(|e| {
        tracing::warn!("Google token header JSON parse failed: {e}");
        CloudError::Auth(format!("invalid token header: {e}"))
    })?;

    let kid = header["kid"].as_str().ok_or_else(|| {
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

    let jwks: GoogleJwks = jwks_resp.json().await.map_err(|e| {
        tracing::error!("Failed to parse Google JWKS response: {e}");
        CloudError::Internal(format!("failed to parse Google JWKS: {e}"))
    })?;

    // Step 3: Find the matching key
    let key = jwks.keys.iter().find(|k| k.kid == kid).ok_or_else(|| {
        tracing::warn!("No matching Google JWKS key for kid={kid}");
        CloudError::Auth("no matching Google key for kid".to_string())
    })?;

    // Step 4: Build the RSA public key and verify
    let decoding_key = DecodingKey::from_rsa_components(&key.n, &key.e).map_err(|e| {
        tracing::warn!("Invalid RSA key from Google JWKS: {e}");
        CloudError::Auth(format!("invalid RSA key: {e}"))
    })?;

    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&["accounts.google.com", "https://accounts.google.com"]);

    let token_data =
        jsonwebtoken::decode::<GoogleTokenPayload>(id_token, &decoding_key, &validation).map_err(
            |e| {
                tracing::warn!("Google token verification failed (aud={client_id}): {e}");
                CloudError::Auth(format!("Google token verification failed: {e}"))
            },
        )?;

    let payload = token_data.claims;

    // Step 5: Additional checks
    if let Some(ref email_verified) = payload.email_verified {
        if !email_verified {
            tracing::warn!(
                "Google sign-in rejected: email not verified for {}",
                payload.email
            );
            return Err(CloudError::Auth("email not verified".to_string()));
        }
    }

    Ok(payload)
}

/// Verify a native Sign in with Apple identity token by validating Apple's
/// RS256 signature, issuer, audience, and expiration.
pub async fn verify_apple_token(
    identity_token: &str,
    client_id: &str,
) -> Result<AppleTokenPayload, CloudError> {
    use base64::Engine;

    let parts: Vec<&str> = identity_token.split('.').collect();
    if parts.len() != 3 {
        tracing::warn!("Apple token has {} parts, expected 3", parts.len());
        return Err(CloudError::Auth("invalid Apple token format".to_string()));
    }

    let header_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|e| {
            tracing::warn!("Apple token header base64 decode failed: {e}");
            CloudError::Auth(format!("header base64 decode failed: {e}"))
        })?;

    let header: serde_json::Value = serde_json::from_slice(&header_bytes).map_err(|e| {
        tracing::warn!("Apple token header JSON parse failed: {e}");
        CloudError::Auth(format!("invalid token header: {e}"))
    })?;

    let kid = header["kid"].as_str().ok_or_else(|| {
        tracing::warn!("Apple token header missing 'kid' field");
        CloudError::Auth("no kid in token header".to_string())
    })?;

    let client = reqwest::Client::new();
    let jwks_resp = client
        .get("https://appleid.apple.com/auth/keys")
        .send()
        .await
        .map_err(|e| {
            tracing::error!("Failed to fetch Apple JWKS: {e}");
            CloudError::Internal(format!("failed to fetch Apple JWKS: {e}"))
        })?;

    let jwks: AppleJwks = jwks_resp.json().await.map_err(|e| {
        tracing::error!("Failed to parse Apple JWKS response: {e}");
        CloudError::Internal(format!("failed to parse Apple JWKS: {e}"))
    })?;

    let key = jwks.keys.iter().find(|k| k.kid == kid).ok_or_else(|| {
        tracing::warn!("No matching Apple JWKS key for kid={kid}");
        CloudError::Auth("no matching Apple key for kid".to_string())
    })?;

    let decoding_key = DecodingKey::from_rsa_components(&key.n, &key.e).map_err(|e| {
        tracing::warn!("Invalid RSA key from Apple JWKS: {e}");
        CloudError::Auth(format!("invalid RSA key: {e}"))
    })?;

    let mut validation = Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&["https://appleid.apple.com"]);

    let token_data = decode::<AppleTokenPayload>(identity_token, &decoding_key, &validation)
        .map_err(|e| {
            tracing::warn!("Apple token verification failed (aud={client_id}): {e}");
            CloudError::Auth(format!("Apple token verification failed: {e}"))
        })?;

    let payload = token_data.claims;
    if apple_email_verified_is_false(payload.email_verified.as_ref()) {
        return Err(CloudError::Auth("Apple email is not verified".to_string()));
    }

    Ok(payload)
}

fn apple_email_verified_is_false(value: Option<&serde_json::Value>) -> bool {
    match value {
        Some(serde_json::Value::Bool(false)) => true,
        Some(serde_json::Value::String(raw)) if raw.eq_ignore_ascii_case("false") => true,
        _ => false,
    }
}
