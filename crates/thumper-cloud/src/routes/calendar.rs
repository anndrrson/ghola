use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateEventRequest {
    pub title: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
}

/// POST /api/calendar/events — wrap the existing calendar_service.
pub async fn create_event(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<CreateEventRequest>,
) -> Result<Json<serde_json::Value>, CloudError> {
    if req.title.trim().is_empty() {
        return Err(CloudError::BadRequest("missing title".into()));
    }
    if req.start.trim().is_empty() || req.end.trim().is_empty() {
        return Err(CloudError::BadRequest("missing start or end".into()));
    }

    let mut params = serde_json::json!({
        "action": "create_event",
        "title": req.title,
        "start": req.start,
        "end": req.end,
    });
    if let Some(d) = req.description {
        params["description"] = serde_json::Value::String(d);
    }
    if let Some(l) = req.location {
        params["location"] = serde_json::Value::String(l);
    }
    if let Some(tz) = req.timezone {
        params["timezone"] = serde_json::Value::String(tz);
    }

    let result =
        crate::services::calendar_service::handle_calendar_request(&state, claims.sub, &params)
            .await?;
    Ok(Json(result))
}
