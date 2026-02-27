use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RelayError {
    #[error("authentication failed: {0}")]
    Auth(String),

    #[error("rate limit exceeded")]
    RateLimit,

    #[error("message too large")]
    MessageTooLarge,

    #[error("device not connected: {0}")]
    DeviceNotConnected(String),

    #[error("invalid message: {0}")]
    InvalidMessage(String),

    #[error("internal error: {0}")]
    Internal(String),
}

impl IntoResponse for RelayError {
    fn into_response(self) -> Response {
        let status = match &self {
            RelayError::Auth(_) => StatusCode::UNAUTHORIZED,
            RelayError::RateLimit => StatusCode::TOO_MANY_REQUESTS,
            RelayError::MessageTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            RelayError::DeviceNotConnected(_) => StatusCode::NOT_FOUND,
            RelayError::InvalidMessage(_) => StatusCode::BAD_REQUEST,
            RelayError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };

        let body = match &self {
            RelayError::Auth(_) => "authentication failed",
            RelayError::RateLimit => "rate limit exceeded",
            RelayError::MessageTooLarge => "message too large",
            RelayError::DeviceNotConnected(_) => "device not connected",
            RelayError::InvalidMessage(_) => "invalid message",
            RelayError::Internal(_) => "internal error",
        };

        (status, body.to_string()).into_response()
    }
}
