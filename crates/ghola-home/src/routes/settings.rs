use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::auth::PairedDevice;
use crate::error::HomeError;
use crate::state::HomeState;

async fn load_settings(state: &HomeState) -> Result<serde_json::Value, HomeError> {
    let rows = sqlx::query_as::<_, (String, String)>("SELECT key, value FROM settings")
        .fetch_all(&state.db)
        .await?;

    let mut settings = serde_json::Map::new();
    for (key, value) in rows {
        settings.insert(key, serde_json::Value::String(value));
    }
    settings.insert(
        "server_name".to_string(),
        serde_json::Value::String(state.config.server_name.clone()),
    );

    Ok(serde_json::Value::Object(settings))
}

pub async fn get_settings(
    State(state): State<HomeState>,
    PairedDevice(_device): PairedDevice,
) -> Result<Json<serde_json::Value>, HomeError> {
    Ok(Json(load_settings(&state).await?))
}

#[derive(Deserialize)]
pub struct UpdateSettings {
    #[serde(flatten)]
    pub values: std::collections::HashMap<String, String>,
}

pub async fn update_settings(
    State(state): State<HomeState>,
    PairedDevice(_device): PairedDevice,
    Json(req): Json<UpdateSettings>,
) -> Result<Json<serde_json::Value>, HomeError> {
    for (key, value) in &req.values {
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        )
        .bind(key)
        .bind(value)
        .execute(&state.db)
        .await?;
    }

    Ok(Json(load_settings(&state).await?))
}
