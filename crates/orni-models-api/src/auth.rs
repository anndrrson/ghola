use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::Response;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

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
    let auth_header = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("Missing authorization header".into()))?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or_else(|| AppError::Unauthorized("Invalid authorization format".into()))?;

    let claims = validate_jwt(token, &state.config.jwt_secret)?;
    req.extensions_mut().insert(claims);

    Ok(next.run(req).await)
}
