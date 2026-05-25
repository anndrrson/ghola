//! Relayer error type.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("config error: {0}")]
    Config(String),

    #[error("queue error: {0}")]
    Queue(String),

    #[error("storage error: {0}")]
    Storage(#[from] sled::Error),

    #[error("invalid request: {0}")]
    BadRequest(String),

    #[error("not found")]
    NotFound,

    #[error("submission error: {0}")]
    Submit(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("rpc error: {0}")]
    Rpc(String),

    #[error("internal error: {0}")]
    Internal(String),
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        // CRITICAL: do NOT leak internal details to clients. A request id
        // would be nice, but tying request->response timing is already a
        // weak side-channel; keep responses uniform.
        let (status, msg) = match &self {
            Error::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad request"),
            Error::NotFound => (StatusCode::NOT_FOUND, "not found"),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
        };
        // Log the full error at DEBUG only (we never want recipient/amount
        // info bubbling to INFO). The handler-call site logs at DEBUG too.
        tracing::debug!(error = %self, "request failed");
        (status, msg).into_response()
    }
}
