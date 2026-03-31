//! Response signing middleware — attaches X-Ghola-Signature and X-Ghola-Timestamp
//! to every response so that even scraped data carries cryptographic provenance.
//!
//! Signed message: "{timestamp}:{method}:{path}"
//! The signature is the ed25519 signature over that UTF-8 string, hex-encoded.
//!
//! Verification:
//!   1. Parse X-Ghola-Timestamp as Unix seconds.
//!   2. Reconstruct the message: "{ts}:{METHOD}:{path}".
//!   3. Verify X-Ghola-Signature (hex) against the server's public key.
//!
//! The server's ed25519 public key (hex) is exposed at GET /v1/signing-key.

use axum::extract::Request;
use axum::http::HeaderValue;
use axum::middleware::Next;
use axum::response::Response;
use ed25519_dalek::Signer;
use std::sync::Arc;

use crate::state::AppState;

pub async fn sign_responses(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Response {
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();

    let mut response = next.run(req).await;

    let timestamp = chrono::Utc::now().timestamp();
    let message = format!("{timestamp}:{method}:{path}");
    let signature = state.signing_key.sign(message.as_bytes());
    let sig_hex = hex::encode(signature.to_bytes());

    let headers = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&sig_hex) {
        headers.insert("X-Ghola-Signature", v);
    }
    if let Ok(v) = HeaderValue::from_str(&timestamp.to_string()) {
        headers.insert("X-Ghola-Timestamp", v);
    }

    response
}
