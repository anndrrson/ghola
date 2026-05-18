use uuid::Uuid;

use crate::error::CloudError;
use crate::state::AppState;

/// Tool definition advertised to tool-capable LLMs.
pub fn call_tool_definition() -> serde_json::Value {
    serde_json::json!({
        "name": "initiate_call",
        "description": "Place a phone call on the user's behalf. The user will review the call \
                        objective before it dials.",
        "input_schema": {
            "type": "object",
            "properties": {
                "phone_number": {
                    "type": "string",
                    "description": "Phone number to call in E.164 format, e.g. +15551234567"
                },
                "objective": {
                    "type": "string",
                    "description": "What the AI caller should accomplish during the call."
                }
            },
            "required": ["phone_number", "objective"]
        }
    })
}

/// Start a phone call via Bland AI.
pub async fn start_call(
    state: &AppState,
    _user_id: Uuid,
    call_id: Uuid,
    phone_number: &str,
    objective: &str,
    script: Option<&serde_json::Value>,
) -> Result<String, CloudError> {
    let api_key = state
        .config
        .bland_api_key
        .as_deref()
        .ok_or(CloudError::ServiceUnavailable(
            "Bland AI not configured".to_string(),
        ))?;

    let default_webhook = format!("{}/api/calls/webhook", state.config.base_url);
    let webhook_url = state
        .config
        .bland_webhook_url
        .as_deref()
        .unwrap_or(&default_webhook);

    if webhook_url.contains("localhost") || webhook_url.contains("127.0.0.1") {
        return Err(CloudError::ServiceUnavailable(
            "Bland webhook URL must be public; set BLAND_WEBHOOK_URL or BASE_URL".to_string(),
        ));
    }

    let call_script = if let Some(s) = script {
        s.clone()
    } else {
        serde_json::json!({
            "task": objective,
            "first_sentence": "Hi, I'm calling on behalf of my client.",
        })
    };

    let task = call_script
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or(objective);
    let first_sentence = call_script
        .get("first_sentence")
        .and_then(|v| v.as_str())
        .unwrap_or("Hi, I'm calling on behalf of my client.");

    let body = serde_json::json!({
        "phone_number": phone_number,
        "task": task,
        "first_sentence": first_sentence,
        "wait_for_greeting": true,
        "record": false,
        "webhook": webhook_url,
        "metadata": {
            "call_id": call_id.to_string(),
        },
        "max_duration": 300, // 5 minutes max
        "model": "enhanced",
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| CloudError::Internal(format!("Bland AI client setup failed: {e}")))?;
    let resp = client
        .post("https://api.bland.ai/v1/calls")
        .header("Authorization", api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Bland AI request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let _ = resp.text().await;
        return Err(CloudError::Internal(format!(
            "Bland AI returned status {status}"
        )));
    }

    let resp_body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CloudError::Internal(format!("Bland AI response parse failed: {e}")))?;

    let bland_call_id = resp_body["call_id"]
        .as_str()
        .ok_or(CloudError::Internal(
            "no call_id in Bland AI response".to_string(),
        ))?
        .to_string();

    tracing::info!(%call_id, %bland_call_id, "call initiated via Bland AI");

    Ok(bland_call_id)
}

/// Process the result of a completed call. Updates the linked task with parsed outcome.
pub async fn process_call_result(
    state: &AppState,
    _user_id: Uuid,
    task_id: Uuid,
    transcript: &str,
    outcome: &str,
) -> Result<(), CloudError> {
    let success = outcome == "success";
    let result = serde_json::json!({
        "success": success,
        "outcome": outcome,
        "status": if success { "completed" } else { "failed" },
        "transcript_retained": false,
        "transcript_present": !transcript.is_empty(),
        "redacted": true,
    });
    let status = if success { "completed" } else { "failed" };

    sqlx::query(
        r#"
        UPDATE tasks SET
            status = $1,
            result = $2,
            updated_at = now(),
            completed_at = now()
        WHERE id = $3
        "#,
    )
    .bind(status)
    .bind(&result)
    .bind(task_id)
    .execute(&state.db)
    .await?;

    tracing::info!(%task_id, %status, "call result processed");

    Ok(())
}
