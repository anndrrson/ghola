use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::json;

use crate::state::AppState;

pub async fn health(State(state): State<Arc<AppState>>) -> (StatusCode, Json<serde_json::Value>) {
    let db_ok = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
        .is_ok();

    if db_ok {
        // Fetch enriched stats
        let total_services: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM service_listings")
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

        let active_services: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM service_listings WHERE status::text = 'active'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

        let total_verifications: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM auth_verifications")
                .fetch_one(&state.db)
                .await
                .unwrap_or(0);

        let total_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

        (
            StatusCode::OK,
            Json(json!({
                "status": "healthy",
                "version": env!("CARGO_PKG_VERSION"),
                "database": "connected",
                "services": total_services,
                "active_services": active_services,
                "total_verifications": total_verifications,
                "total_users": total_users,
            })),
        )
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "status": "unhealthy",
                "version": env!("CARGO_PKG_VERSION"),
                "database": "disconnected"
            })),
        )
    }
}
