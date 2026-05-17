use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::HomeError;
use crate::state::{HomeState, PairedDevice};

#[derive(Deserialize)]
pub struct PairRequest {
    pub pin: String,
    pub device_name: String,
}

pub async fn pair(
    State(state): State<HomeState>,
    Json(req): Json<PairRequest>,
) -> Result<Json<serde_json::Value>, HomeError> {
    if req.pin != state.config.pin {
        return Err(HomeError::Unauthorized);
    }

    let token = uuid::Uuid::new_v4().to_string();

    state.paired_devices.insert(
        token.clone(),
        PairedDevice {
            device_name: req.device_name.clone(),
            paired_at: chrono::Utc::now(),
        },
    );

    tracing::info!("device paired: {}", req.device_name);

    Ok(Json(serde_json::json!({
        "token": token,
        "server_name": state.config.server_name,
    })))
}
