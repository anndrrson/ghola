use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::privacy::{NetworkScope, PrivacyApproval};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateEventRequest {
    pub title: String,
    pub start: String,
    pub end: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub timezone: Option<String>,
    #[serde(flatten)]
    pub approval: PrivacyApproval,
}

#[derive(Deserialize)]
pub struct ListEventsQuery {
    pub time_min: Option<String>,
    pub time_max: Option<String>,
    pub max_results: Option<u64>,
}

/// POST /api/calendar/events
pub async fn create_event(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<CreateEventRequest>,
) -> Result<Json<serde_json::Value>, CloudError> {
    req.approval.require_for(NetworkScope::CalendarExecution)?;

    let params = serde_json::json!({
        "action": "create_event",
        "title": req.title,
        "start": req.start,
        "end": req.end,
        "description": req.description,
        "location": req.location,
        "timezone": req.timezone,
    });
    let result =
        crate::services::calendar_service::handle_calendar_request(&state, claims.sub, &params)
            .await?;
    Ok(Json(result))
}

/// GET /api/calendar/events
pub async fn list_events(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Query(q): Query<ListEventsQuery>,
) -> Result<Json<serde_json::Value>, CloudError> {
    let params = serde_json::json!({
        "action": "list_events",
        "time_min": q.time_min,
        "time_max": q.time_max,
        "max_results": q.max_results,
    });
    let result =
        crate::services::calendar_service::handle_calendar_request(&state, claims.sub, &params)
            .await?;
    Ok(Json(result))
}
