use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Conflict: {0}")]
    Conflict(String),

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
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    [("Retry-After", retry_after.to_string())],
                    body,
                )
                    .into_response()
            }
            _ => {
                let (status, message) = match &self {
                    AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
                    AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
                    AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
                    AppError::Conflict(msg) => (StatusCode::CONFLICT, msg.clone()),
                    AppError::TooManyRequests(_) => unreachable!(),
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
                };

                let body = axum::Json(json!({ "error": message }));
                (status, body).into_response()
            }
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
