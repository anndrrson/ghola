use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CloudError {
    #[error("authentication failed: {0}")]
    Auth(String),

    #[error("unauthorized")]
    Unauthorized,

    #[error("not found: {0}")]
    NotFound(String),

    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("rate limit exceeded")]
    RateLimit,

    #[error("payment required: {0}")]
    PaymentRequired(String),

    #[error("service unavailable: {0}")]
    ServiceUnavailable(String),

    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("internal error: {0}")]
    Internal(String),
}

impl IntoResponse for CloudError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            CloudError::Auth(msg) => {
                let public_msg = if msg.starts_with("Google token verification failed") {
                    "Google sign-in failed".to_string()
                } else if msg.starts_with("invalid token:") {
                    "session expired — please sign in again".to_string()
                } else {
                    msg.clone()
                };
                if public_msg != *msg {
                    tracing::warn!("auth error (sanitized): {msg}");
                }
                (StatusCode::UNAUTHORIZED, public_msg)
            }
            CloudError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            CloudError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            CloudError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            CloudError::RateLimit => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate limit exceeded".to_string(),
            ),
            CloudError::PaymentRequired(msg) => (StatusCode::PAYMENT_REQUIRED, msg.clone()),
            CloudError::ServiceUnavailable(msg) => (StatusCode::SERVICE_UNAVAILABLE, msg.clone()),
            CloudError::Database(e) => {
                tracing::error!("database error: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                )
            }
            CloudError::Internal(msg) => {
                tracing::error!("internal error: {msg}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                )
            }
        };

        let body = json!({ "error": message });
        (status, axum::Json(body)).into_response()
    }
}
