use axum::extract::State;
use axum::Json;

use crate::ollama;
use crate::state::HomeState;

pub async fn health(State(state): State<HomeState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "server_name": state.config.server_name,
    }))
}

pub async fn health_ollama() -> Json<serde_json::Value> {
    let running = ollama::is_running().await;
    let installed = ollama::is_installed();
    let models = if running {
        ollama::list_models()
            .await
            .map(|ms| ms.into_iter().map(|m| m.name).collect::<Vec<_>>())
            .unwrap_or_default()
    } else {
        vec![]
    };

    Json(serde_json::json!({
        "installed": installed,
        "running": running,
        "models": models,
    }))
}
