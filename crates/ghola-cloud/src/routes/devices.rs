use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct RegisterDeviceRequest {
    pub platform: String,
    pub device_name: Option<String>,
    pub device_pubkey: Option<String>,
    pub push_token: Option<String>,
}

#[derive(Serialize)]
pub struct DeviceResponse {
    pub id: Uuid,
    pub platform: String,
    pub device_name: Option<String>,
    pub last_seen_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

/// POST /api/devices
pub async fn register_device(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<RegisterDeviceRequest>,
) -> Result<Json<DeviceResponse>, CloudError> {
    if !["android", "ios", "macos"].contains(&req.platform.as_str()) {
        return Err(CloudError::BadRequest(
            "platform must be 'android', 'ios', or 'macos'".to_string(),
        ));
    }

    let row = sqlx::query_as::<_, (Uuid, String, Option<String>, DateTime<Utc>, DateTime<Utc>)>(
        r#"
        INSERT INTO devices (user_id, platform, device_name, device_pubkey, push_token)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, platform, device_name, last_seen_at, created_at
        "#,
    )
    .bind(claims.sub)
    .bind(&req.platform)
    .bind(&req.device_name)
    .bind(&req.device_pubkey)
    .bind(&req.push_token)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(DeviceResponse {
        id: row.0,
        platform: row.1,
        device_name: row.2,
        last_seen_at: row.3,
        created_at: row.4,
    }))
}

/// GET /api/devices
pub async fn list_devices(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<Vec<DeviceResponse>>, CloudError> {
    let rows = sqlx::query_as::<_, (Uuid, String, Option<String>, DateTime<Utc>, DateTime<Utc>)>(
        r#"
        SELECT id, platform, device_name, last_seen_at, created_at
        FROM devices WHERE user_id = $1
        ORDER BY last_seen_at DESC
        "#,
    )
    .bind(claims.sub)
    .fetch_all(&state.db)
    .await?;

    let devices: Vec<DeviceResponse> = rows
        .into_iter()
        .map(|r| DeviceResponse {
            id: r.0,
            platform: r.1,
            device_name: r.2,
            last_seen_at: r.3,
            created_at: r.4,
        })
        .collect();

    Ok(Json(devices))
}

/// DELETE /api/devices/:id
pub async fn remove_device(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, CloudError> {
    let result = sqlx::query("DELETE FROM devices WHERE id = $1 AND user_id = $2")
        .bind(device_id)
        .bind(claims.sub)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(CloudError::NotFound("device not found".to_string()));
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// POST /api/devices/:id/push-token — Update push token (for APNS/FCM)
#[derive(Deserialize)]
pub struct UpdatePushTokenRequest {
    pub push_token: String,
}

pub async fn update_push_token(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Path(device_id): Path<Uuid>,
    Json(req): Json<UpdatePushTokenRequest>,
) -> Result<Json<serde_json::Value>, CloudError> {
    let result = sqlx::query(
        "UPDATE devices SET push_token = $1, last_seen_at = now() WHERE id = $2 AND user_id = $3",
    )
    .bind(&req.push_token)
    .bind(device_id)
    .bind(claims.sub)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(CloudError::NotFound("device not found".to_string()));
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}
