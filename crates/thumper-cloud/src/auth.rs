use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::CloudError;
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: Uuid,       // user_id
    pub email: Option<String>,
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

pub fn create_jwt(user_id: Uuid, email: Option<&str>, tier: &str, secret: &str) -> Result<String, CloudError> {
    let now = Utc::now();
    let claims = Claims {
        sub: user_id,
        email: email.map(|s| s.to_string()),
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

        let claims = verify_jwt(token, &state.config.jwt_secret)?;
        Ok(AuthUser(claims))
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
        return Err(CloudError::Auth("invalid Google token format".to_string()));
    }

    let header_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|e| CloudError::Auth(format!("header base64 decode failed: {e}")))?;

    let header: serde_json::Value = serde_json::from_slice(&header_bytes)
        .map_err(|e| CloudError::Auth(format!("invalid token header: {e}")))?;

    let kid = header["kid"]
        .as_str()
        .ok_or(CloudError::Auth("no kid in token header".to_string()))?;

    // Step 2: Fetch Google's public keys
    let client = reqwest::Client::new();
    let jwks_resp = client
        .get("https://www.googleapis.com/oauth2/v3/certs")
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("failed to fetch Google JWKS: {e}")))?;

    let jwks: GoogleJwks = jwks_resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("failed to parse Google JWKS: {e}")))?;

    // Step 3: Find the matching key
    let key = jwks
        .keys
        .iter()
        .find(|k| k.kid == kid)
        .ok_or(CloudError::Auth("no matching Google key for kid".to_string()))?;

    // Step 4: Build the RSA public key and verify
    let decoding_key = DecodingKey::from_rsa_components(&key.n, &key.e)
        .map_err(|e| CloudError::Auth(format!("invalid RSA key: {e}")))?;

    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&["accounts.google.com", "https://accounts.google.com"]);

    let token_data = jsonwebtoken::decode::<GoogleTokenPayload>(id_token, &decoding_key, &validation)
        .map_err(|e| CloudError::Auth(format!("Google token verification failed: {e}")))?;

    let payload = token_data.claims;

    // Step 5: Additional checks
    if let Some(ref email_verified) = payload.email_verified {
        if !email_verified {
            return Err(CloudError::Auth("email not verified".to_string()));
        }
    }

    Ok(payload)
}
