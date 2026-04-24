use uuid::Uuid;

use crate::error::CloudError;
use crate::state::AppState;

/// Start a phone call via Bland AI.
pub async fn start_call(
    state: &AppState,
    user_id: Uuid,
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

    // Generate a call script via LLM if not provided
    let call_script = if let Some(s) = script {
        s.clone()
    } else {
        generate_call_script(state, user_id, objective).await?
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
        "record": true,
        "webhook": webhook_url,
        "metadata": {
            "call_id": call_id.to_string(),
        },
        "max_duration": 300, // 5 minutes max
        "model": "enhanced",
    });

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.bland.ai/v1/calls")
        .header("Authorization", api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Bland AI request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let error_body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Internal(format!(
            "Bland AI returned {status}: {error_body}"
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

    tracing::info!(%call_id, %bland_call_id, %phone_number, "call initiated via Bland AI");

    Ok(bland_call_id)
}

/// Generate a call script using the user's configured LLM.
async fn generate_call_script(
    state: &AppState,
    user_id: Uuid,
    objective: &str,
) -> Result<serde_json::Value, CloudError> {
    let prompt = format!(
        r#"Generate a phone call script for the following objective:

Objective: {objective}

Return a JSON object with:
- "task": A detailed instruction for the AI caller (what to say, what information to gather, how to handle objections)
- "first_sentence": The opening line of the call
- "success_criteria": What constitutes a successful call
- "fallback_responses": Common objections and how to handle them

Be professional, friendly, and concise. The caller should sound natural, not robotic."#
    );

    let result =
        crate::services::llm_router::generate(state, user_id, &prompt, Some("json")).await?;

    Ok(serde_json::from_str(&result).unwrap_or_else(|_| {
        serde_json::json!({
            "task": objective,
            "first_sentence": format!("Hi, I'm calling to {}", objective.to_lowercase()),
        })
    }))
}

/// Process the result of a completed call. Updates the linked task with parsed outcome.
pub async fn process_call_result(
    state: &AppState,
    user_id: Uuid,
    task_id: Uuid,
    transcript: &str,
    outcome: &str,
) -> Result<(), CloudError> {
    if transcript.is_empty() {
        sqlx::query(
            r#"
            UPDATE tasks SET
                status = 'completed',
                result = $1,
                updated_at = now(),
                completed_at = now()
            WHERE id = $2
            "#,
        )
        .bind(serde_json::json!({ "outcome": outcome, "details": "no transcript" }))
        .bind(task_id)
        .execute(&state.db)
        .await?;
        return Ok(());
    }

    // Use LLM to parse the transcript
    let prompt = format!(
        r#"Parse this phone call transcript and extract the result.

Transcript:
{transcript}

Call outcome status: {outcome}

Return a JSON object with:
- "success": boolean — was the objective achieved?
- "summary": string — one-sentence summary of the outcome
- "details": object — any specific details extracted (confirmation number, appointment time, etc.)
- "follow_up_needed": boolean — does the user need to take any action?"#
    );

    let parsed =
        crate::services::llm_router::generate(state, user_id, &prompt, Some("json")).await?;

    let result: serde_json::Value = serde_json::from_str(&parsed).unwrap_or_else(|_| {
        serde_json::json!({
            "success": outcome == "success",
            "summary": format!("Call {outcome}"),
        })
    });

    let status = if result["success"].as_bool().unwrap_or(false) {
        "completed"
    } else {
        "failed"
    };

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
