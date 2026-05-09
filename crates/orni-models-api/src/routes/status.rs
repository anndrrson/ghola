//! Public liveness/health endpoint.
//!
//! `GET /api/_status` returns 200 when the API can serve traffic and the
//! database is reachable, 503 otherwise. The response intentionally
//! exposes no version, build, or commit metadata — just enough for a
//! load balancer or uptime probe to make a routing decision.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
pub struct StatusResponse {
    pub status: &'static str,
}

pub async fn get_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.db).await {
        Ok(_) => (StatusCode::OK, Json(StatusResponse { status: "ok" })).into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(StatusResponse { status: "degraded" }),
        )
            .into_response(),
    }
}
