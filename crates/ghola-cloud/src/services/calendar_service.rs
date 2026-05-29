use uuid::Uuid;

use crate::error::CloudError;
use crate::state::AppState;

/// Tool definition advertised to tool-capable LLMs.
pub fn calendar_tool_definition() -> serde_json::Value {
    serde_json::json!({
        "name": "create_calendar_event",
        "description": "Create a calendar event on the user's Google Calendar. The user will \
                        review the event before it's created.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "Event title / summary." },
                "start": {
                    "type": "string",
                    "description": "Start time as an RFC3339 timestamp, e.g. 2026-05-13T15:00:00-04:00"
                },
                "end": {
                    "type": "string",
                    "description": "End time as an RFC3339 timestamp."
                },
                "description": { "type": "string", "description": "Optional event description." },
                "location": { "type": "string", "description": "Optional location." },
                "timezone": {
                    "type": "string",
                    "description": "IANA timezone, e.g. America/New_York. Defaults to user's timezone if omitted."
                }
            },
            "required": ["title", "start", "end"]
        }
    })
}

/// Handle a calendar-related request via Google Calendar API.
pub async fn handle_calendar_request(
    state: &AppState,
    user_id: Uuid,
    params: &serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    let action = params["action"].as_str().unwrap_or("create_event");

    match action {
        "create_event" => create_event(state, user_id, params).await,
        "list_events" => list_events(state, user_id, params).await,
        "update_event" => update_event(state, user_id, params).await,
        "delete_event" => delete_event(state, user_id, params).await,
        _ => Err(CloudError::BadRequest(format!(
            "unknown calendar action: {action}"
        ))),
    }
}

/// Get the user's Google Calendar OAuth access token (reuses Gmail connected_accounts).
async fn get_calendar_token(state: &AppState, user_id: Uuid) -> Result<String, CloudError> {
    let row = sqlx::query_as::<_, (Vec<u8>, Vec<u8>, Option<chrono::DateTime<chrono::Utc>>)>(
        r#"
        SELECT encrypted_access_token, encrypted_refresh_token, token_expires_at
        FROM connected_accounts
        WHERE user_id = $1 AND provider = 'gmail'
        "#,
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(CloudError::BadRequest(
        "Google account not connected — connect via Settings to use Calendar".to_string(),
    ))?;

    let access_token = decrypt_token(&row.0, &state.config.encryption_key)?;

    // Auto-refresh if expired
    if let Some(expires_at) = row.2 {
        if expires_at < chrono::Utc::now() {
            let refresh_token = decrypt_token(&row.1, &state.config.encryption_key)?;
            return refresh_google_token(state, user_id, &refresh_token).await;
        }
    }

    Ok(access_token)
}

fn decrypt_token(data: &[u8], key: &[u8; 32]) -> Result<String, CloudError> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };

    if data.len() < 12 {
        return Err(CloudError::Internal("encrypted data too short".to_string()));
    }

    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| CloudError::Internal(format!("decryption failed: {e}")))?;

    String::from_utf8(plaintext)
        .map_err(|e| CloudError::Internal(format!("invalid UTF-8 after decrypt: {e}")))
}

async fn refresh_google_token(
    state: &AppState,
    user_id: Uuid,
    refresh_token: &str,
) -> Result<String, CloudError> {
    let client_id =
        state
            .config
            .gmail_client_id
            .as_deref()
            .ok_or(CloudError::ServiceUnavailable(
                "Google OAuth not configured".to_string(),
            ))?;
    let client_secret =
        state
            .config
            .gmail_client_secret
            .as_deref()
            .ok_or(CloudError::ServiceUnavailable(
                "Google OAuth not configured".to_string(),
            ))?;

    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("token refresh failed: {e}")))?;

    let status = resp.status();
    if !status.is_success() {
        let _ = resp.text().await;
        if status.as_u16() == 401 {
            return Err(CloudError::Auth(
                "Google token expired — re-authenticate".to_string(),
            ));
        }
        return Err(CloudError::Internal(format!(
            "Google token refresh failed with status {status}"
        )));
    }

    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let new_access_token = body["access_token"].as_str().ok_or(CloudError::Internal(
        "no access_token in refresh response".to_string(),
    ))?;
    let expires_in = body["expires_in"].as_i64().unwrap_or(3600);

    // Update stored tokens
    let encrypted = crate::services::email_service::encrypt_token(
        new_access_token,
        &state.config.encryption_key,
    )?;
    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(expires_in);

    sqlx::query(
        r#"
        UPDATE connected_accounts SET
            encrypted_access_token = $1,
            token_expires_at = $2,
            updated_at = now()
        WHERE user_id = $3 AND provider = 'gmail'
        "#,
    )
    .bind(&encrypted)
    .bind(expires_at)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok(new_access_token.to_string())
}

const CALENDAR_API: &str = "https://www.googleapis.com/calendar/v3";

async fn create_event(
    state: &AppState,
    user_id: Uuid,
    params: &serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    let access_token = get_calendar_token(state, user_id).await?;

    let title = params["title"].as_str().unwrap_or("New Event");
    let start = params["start"].as_str().ok_or(CloudError::BadRequest(
        "missing 'start' time for event".to_string(),
    ))?;
    let end = params["end"].as_str().ok_or(CloudError::BadRequest(
        "missing 'end' time for event".to_string(),
    ))?;
    let description = params["description"].as_str().unwrap_or("");
    let location = params["location"].as_str().unwrap_or("");

    let event_body = serde_json::json!({
        "summary": title,
        "description": description,
        "location": location,
        "start": {
            "dateTime": start,
            "timeZone": params["timezone"].as_str().unwrap_or("America/New_York"),
        },
        "end": {
            "dateTime": end,
            "timeZone": params["timezone"].as_str().unwrap_or("America/New_York"),
        },
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{CALENDAR_API}/calendars/primary/events"))
        .header("Authorization", format!("Bearer {access_token}"))
        .json(&event_body)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Calendar API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let _ = resp.text().await;
        if status.as_u16() == 401 {
            return Err(CloudError::Auth(
                "Google token expired — re-authenticate".to_string(),
            ));
        }
        return Err(CloudError::Internal(format!(
            "Calendar API returned status {status}"
        )));
    }

    let created: serde_json::Value = resp.json().await.unwrap_or_default();

    tracing::info!(
        user = %crate::privacy::log_id(&user_id),
        event_id = created["id"].as_str().unwrap_or(""),
        "calendar event created"
    );

    Ok(serde_json::json!({
        "action": "create_event",
        "status": "created",
        "event": {
            "id": created["id"],
            "title": title,
            "start": start,
            "end": end,
            "html_link": created["htmlLink"],
        }
    }))
}

async fn list_events(
    state: &AppState,
    user_id: Uuid,
    params: &serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    let access_token = get_calendar_token(state, user_id).await?;

    // Default: today's events
    let now = chrono::Utc::now();
    let time_min = params["time_min"]
        .as_str()
        .unwrap_or(&now.format("%Y-%m-%dT00:00:00Z").to_string())
        .to_string();
    let time_max = params["time_max"]
        .as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            (now + chrono::Duration::days(1))
                .format("%Y-%m-%dT23:59:59Z")
                .to_string()
        });
    let max_results = params["max_results"].as_u64().unwrap_or(10);

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{CALENDAR_API}/calendars/primary/events"))
        .header("Authorization", format!("Bearer {access_token}"))
        .query(&[
            ("timeMin", time_min.as_str()),
            ("timeMax", time_max.as_str()),
            ("maxResults", &max_results.to_string()),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
        ])
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Calendar API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let _ = resp.text().await;
        if status.as_u16() == 401 {
            return Err(CloudError::Auth(
                "Google token expired — re-authenticate".to_string(),
            ));
        }
        return Err(CloudError::Internal(format!(
            "Calendar API returned status {status}"
        )));
    }

    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let items = body["items"].as_array().cloned().unwrap_or_default();

    let events: Vec<serde_json::Value> = items
        .iter()
        .map(|e| {
            serde_json::json!({
                "id": e["id"],
                "title": e["summary"],
                "start": e["start"]["dateTime"].as_str().or(e["start"]["date"].as_str()),
                "end": e["end"]["dateTime"].as_str().or(e["end"]["date"].as_str()),
                "location": e["location"],
                "description": e["description"],
                "html_link": e["htmlLink"],
            })
        })
        .collect();

    tracing::info!(
        user = %crate::privacy::log_id(&user_id),
        count = events.len(),
        "calendar events listed"
    );

    Ok(serde_json::json!({
        "action": "list_events",
        "status": "success",
        "events": events,
    }))
}

async fn update_event(
    state: &AppState,
    user_id: Uuid,
    params: &serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    let access_token = get_calendar_token(state, user_id).await?;

    let event_id = params["event_id"].as_str().ok_or(CloudError::BadRequest(
        "missing 'event_id' for update".to_string(),
    ))?;

    // Build patch body with only provided fields
    let mut patch = serde_json::Map::new();
    if let Some(title) = params["title"].as_str() {
        patch.insert("summary".into(), serde_json::json!(title));
    }
    if let Some(desc) = params["description"].as_str() {
        patch.insert("description".into(), serde_json::json!(desc));
    }
    if let Some(location) = params["location"].as_str() {
        patch.insert("location".into(), serde_json::json!(location));
    }
    let tz = params["timezone"].as_str().unwrap_or("America/New_York");
    if let Some(start) = params["start"].as_str() {
        patch.insert(
            "start".into(),
            serde_json::json!({"dateTime": start, "timeZone": tz}),
        );
    }
    if let Some(end) = params["end"].as_str() {
        patch.insert(
            "end".into(),
            serde_json::json!({"dateTime": end, "timeZone": tz}),
        );
    }

    let client = reqwest::Client::new();
    let resp = client
        .patch(format!(
            "{CALENDAR_API}/calendars/primary/events/{event_id}"
        ))
        .header("Authorization", format!("Bearer {access_token}"))
        .json(&serde_json::Value::Object(patch))
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Calendar API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let _ = resp.text().await;
        if status.as_u16() == 401 {
            return Err(CloudError::Auth(
                "Google token expired — re-authenticate".to_string(),
            ));
        }
        return Err(CloudError::Internal(format!(
            "Calendar API returned status {status}"
        )));
    }

    let updated: serde_json::Value = resp.json().await.unwrap_or_default();

    tracing::info!(
        user = %crate::privacy::log_id(&user_id),
        "calendar event updated"
    );

    Ok(serde_json::json!({
        "action": "update_event",
        "status": "updated",
        "event": {
            "id": updated["id"],
            "title": updated["summary"],
            "html_link": updated["htmlLink"],
        }
    }))
}

async fn delete_event(
    state: &AppState,
    user_id: Uuid,
    params: &serde_json::Value,
) -> Result<serde_json::Value, CloudError> {
    let access_token = get_calendar_token(state, user_id).await?;

    let event_id = params["event_id"].as_str().ok_or(CloudError::BadRequest(
        "missing 'event_id' for delete".to_string(),
    ))?;

    let client = reqwest::Client::new();
    let resp = client
        .delete(format!(
            "{CALENDAR_API}/calendars/primary/events/{event_id}"
        ))
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Calendar API request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let _ = resp.text().await;
        if status.as_u16() == 401 {
            return Err(CloudError::Auth(
                "Google token expired — re-authenticate".to_string(),
            ));
        }
        if status.as_u16() == 404 || status.as_u16() == 410 {
            return Err(CloudError::NotFound("calendar event not found".to_string()));
        }
        return Err(CloudError::Internal(format!(
            "Calendar API returned status {status}"
        )));
    }

    tracing::info!(
        user = %crate::privacy::log_id(&user_id),
        "calendar event deleted"
    );

    Ok(serde_json::json!({
        "action": "delete_event",
        "status": "deleted",
        "event_id": event_id,
    }))
}
