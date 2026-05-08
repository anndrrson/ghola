use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Insufficient balance")]
    InsufficientBalance,

    /// x402-compliant payment required response.
    /// Carries payment instructions for agents.
    #[error("Payment required (x402)")]
    X402PaymentRequired {
        pay_to: String,
        amount_micro_usdc: i64,
        model_slug: String,
        model_name: String,
    },

    #[error("Too many requests")]
    TooManyRequests(u64),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),

    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match &self {
            AppError::TooManyRequests(retry_after) => {
                let body = axum::Json(json!({
                    "error": "Too many requests",
                    "retry_after": retry_after
                }));
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    [("Retry-After", retry_after.to_string())],
                    body,
                )
                    .into_response();
            }
            AppError::X402PaymentRequired {
                pay_to,
                amount_micro_usdc,
                model_slug,
                model_name,
            } => {
                // Build x402-compliant payment-required header
                let x402_payload = json!({
                    "x402Version": 2,
                    "accepts": [{
                        "scheme": "exact",
                        "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
                        "amount": amount_micro_usdc.to_string(),
                        "asset": "USDC",
                        "payTo": pay_to,
                        "maxTimeoutSeconds": 60,
                        "resource": {
                            "url": format!("/v1/chat/completions?model={}", model_slug),
                            "description": format!("Chat with {} on ghola.xyz", model_name),
                            "mimeType": "text/event-stream"
                        },
                        "extra": {
                            "platform": "ghola.xyz",
                            "model": model_slug,
                        }
                    }]
                });

                let encoded = STANDARD.encode(serde_json::to_vec(&x402_payload).unwrap_or_default());

                // Body must be the full x402 payload for v1 compatibility
                let body = axum::Json(x402_payload);

                return (
                    StatusCode::PAYMENT_REQUIRED,
                    [
                        ("payment-required", encoded.as_str()),
                        ("x-price-micro-usdc", &amount_micro_usdc.to_string()),
                        ("x-currency", "USDC"),
                        ("x-payment-address", pay_to.as_str()),
                    ],
                    body,
                )
                    .into_response();
            }
            AppError::InsufficientBalance => {
                let body = axum::Json(json!({ "error": "Insufficient USDC balance" }));
                return (StatusCode::PAYMENT_REQUIRED, body).into_response();
            }
            _ => {}
        }

        let (status, message) = match &self {
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg.clone()),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, msg.clone()),
            AppError::Internal(msg) => {
                tracing::error!("Internal error: {msg}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".into(),
                )
            }
            AppError::Sqlx(e) => {
                tracing::error!("Database error: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".into(),
                )
            }
            AppError::Reqwest(e) => {
                tracing::error!("HTTP client error: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".into(),
                )
            }
            _ => unreachable!(),
        };

        let body = axum::Json(json!({ "error": message }));
        (status, body).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
