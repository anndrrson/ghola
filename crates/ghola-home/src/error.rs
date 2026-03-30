use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum HomeError {
    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("unauthorized")]
    Unauthorized,

    #[error("not found: {0}")]
    NotFound(String),

    #[error("service unavailable: {0}")]
    ServiceUnavailable(String),

    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("internal error: {0}")]
    Internal(String),
}

impl IntoResponse for HomeError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            HomeError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            HomeError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".into()),
            HomeError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            HomeError::ServiceUnavailable(msg) => (StatusCode::SERVICE_UNAVAILABLE, msg.clone()),
            HomeError::Database(e) => {
                tracing::error!("database error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
            HomeError::Internal(msg) => {
                tracing::error!("internal error: {msg}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
        };

        (status, axum::Json(json!({ "error": message }))).into_response()
    }
}
