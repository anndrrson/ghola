use crate::error::CloudError;
use crate::state::AppState;

/// Handle a calendar-related request.
/// Currently a placeholder — will integrate with Google Calendar API.
pub async fn handle_calendar_request(
    state: &AppState,
    params: &serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    let action = params["action"]
        .as_str()
        .unwrap_or("create_event");

    match action {
        "create_event" => create_event(state, params).await,
        "list_events" => list_events(state, params).await,
        "update_event" => update_event(state, params).await,
        "delete_event" => delete_event(state, params).await,
        _ => Err(CloudError::BadRequest(format!("unknown calendar action: {action}"))),
    }
}

async fn create_event(
    _state: &AppState,
    params: &serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    let title = params["title"].as_str().unwrap_or("New Event");
    let start = params["start"].as_str().unwrap_or("");
    let end = params["end"].as_str().unwrap_or("");
    let description = params["description"].as_str().unwrap_or("");

    // TODO: Call Google Calendar API
    // POST https://www.googleapis.com/calendar/v3/calendars/primary/events

    tracing::info!(title, start, end, "calendar event creation requested");

    Ok(serde_json::json!({
        "action": "create_event",
        "status": "pending_integration",
        "event": {
            "title": title,
            "start": start,
            "end": end,
            "description": description,
        }
    }))
}

async fn list_events(
    _state: &AppState,
    params: &serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    let date = params["date"].as_str().unwrap_or("today");

    tracing::info!(date, "calendar event list requested");

    Ok(serde_json::json!({
        "action": "list_events",
        "status": "pending_integration",
        "date": date,
    }))
}

async fn update_event(
    _state: &AppState,
    params: &serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    Ok(serde_json::json!({
        "action": "update_event",
        "status": "pending_integration",
        "params": params,
    }))
}

async fn delete_event(
    _state: &AppState,
    params: &serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    Ok(serde_json::json!({
        "action": "delete_event",
        "status": "pending_integration",
        "params": params,
    }))
}
