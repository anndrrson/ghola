use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct InitiateCallRequest {
    pub phone_number: String,
    pub objective: String,
    /// Optional pre-generated script. If absent, LLM generates one.
    pub script: Option<serde_json::Value>,
    /// Optional task_id to link this call to.
    pub task_id: Option<Uuid>,
}

#[derive(Serialize)]
pub struct CallResponse {
    pub id: Uuid,
    pub bland_call_id: Option<String>,
    pub phone_number: String,
    pub objective: String,
    pub outcome: Option<String>,
    pub transcript: Option<String>,
    pub duration_seconds: Option<i32>,
    pub cost_cents: Option<i32>,
}

/// POST /api/calls
pub async fn initiate_call(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<InitiateCallRequest>,
) -> Result<Json<CallResponse>, CloudError> {
    // Check usage limits
    check_call_limit(&state, claims.sub, &claims.tier).await?;

    // Create call record
    let call_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO calls (user_id, task_id, phone_number, objective, script, outcome)
        VALUES ($1, $2, $3, $4, $5, 'in_progress')
        RETURNING id
        "#,
    )
    .bind(claims.sub)
    .bind(req.task_id)
    .bind(&req.phone_number)
    .bind(&req.objective)
    .bind(&req.script)
    .fetch_one(&state.db)
    .await?;

    // Initiate call via Bland AI
    let bland_call_id = crate::services::call_service::start_call(
        &state,
        claims.sub,
        call_id,
        &req.phone_number,
        &req.objective,
        req.script.as_ref(),
    )
    .await?;

    // Update with Bland call ID
    sqlx::query("UPDATE calls SET bland_call_id = $1 WHERE id = $2")
        .bind(&bland_call_id)
        .bind(call_id)
        .execute(&state.db)
        .await?;

    Ok(Json(CallResponse {
        id: call_id,
        bland_call_id: Some(bland_call_id),
        phone_number: req.phone_number,
        objective: req.objective,
        outcome: Some("in_progress".to_string()),
        transcript: None,
        duration_seconds: None,
        cost_cents: None,
    }))
}

/// POST /api/calls/webhook — Bland AI webhook
#[derive(Deserialize)]
pub struct BlandWebhookPayload {
    pub call_id: Option<String>,
    pub status: Option<String>,
    pub transcript: Option<String>,
    pub recording_url: Option<String>,
    pub duration: Option<f64>,
    pub answered_by: Option<String>,
    pub concatenated_transcript: Option<String>,
    pub completed: Option<bool>,
}

pub async fn call_webhook(
    State(state): State<AppState>,
    Json(payload): Json<BlandWebhookPayload>,
) -> Result<Json<serde_json::Value>, CloudError> {
    let bland_call_id = payload.call_id
        .ok_or(CloudError::BadRequest("missing call_id".to_string()))?;

    let transcript = payload.concatenated_transcript
        .or(payload.transcript)
        .unwrap_or_default();

    let duration_seconds = payload.duration.map(|d| d as i32);

    let outcome = if payload.completed.unwrap_or(false) {
        match payload.answered_by.as_deref() {
            Some("voicemail") => "voicemail",
            _ => "success",
        }
    } else {
        match payload.status.as_deref() {
            Some("no-answer") => "no_answer",
            Some("busy") => "busy",
            Some("failed") => "failed",
            _ => "failed",
        }
    };

    // Estimate cost: $0.09/min
    let cost_cents = duration_seconds.map(|d| ((d as f64 / 60.0) * 9.0).ceil() as i32);

    // Update call record
    sqlx::query(
        r#"
        UPDATE calls SET
            transcript = $1,
            outcome = $2,
            duration_seconds = $3,
            cost_cents = $4,
            recording_url = $5,
            completed_at = now()
        WHERE bland_call_id = $6
        "#,
    )
    .bind(&transcript)
    .bind(outcome)
    .bind(duration_seconds)
    .bind(cost_cents)
    .bind(&payload.recording_url)
    .bind(&bland_call_id)
    .execute(&state.db)
    .await?;

    // Update usage tracking
    if let Some(row) = sqlx::query_as::<_, (Uuid,)>(
        "SELECT user_id FROM calls WHERE bland_call_id = $1",
    )
    .bind(&bland_call_id)
    .fetch_optional(&state.db)
    .await?
    {
        let minutes = duration_seconds.map(|d| (d + 59) / 60).unwrap_or(0);
        update_usage(&state, row.0, 1, minutes).await?;
    }

    // Notify via Telegram if user has linked account
    if let Some(row) = sqlx::query_as::<_, (Uuid,)>(
        "SELECT user_id FROM calls WHERE bland_call_id = $1",
    )
    .bind(&bland_call_id)
    .fetch_optional(&state.db)
    .await?
    {
        let call_user_id = row.0;
        if let Ok(Some(tg_link)) = crate::services::telegram::get_telegram_link(&state.db, call_user_id).await {
            if let Some(ref token) = state.config.telegram_bot_token {
                let summary = match outcome {
                    "success" => format!("Call completed! Duration: {}s\n\nTranscript:\n{}", duration_seconds.unwrap_or(0), &transcript[..transcript.len().min(3000)]),
                    "voicemail" => "Call went to voicemail.".to_string(),
                    "no_answer" => "No answer on the call.".to_string(),
                    "busy" => "Line was busy.".to_string(),
                    _ => format!("Call ended with status: {outcome}"),
                };
                let _ = crate::services::telegram::notify_user(token, tg_link.0, &summary).await;
            }
        }
    }

    // If linked to a task, parse the transcript and update the task
    if let Some(row) = sqlx::query_as::<_, (Option<Uuid>, Uuid)>(
        "SELECT task_id, user_id FROM calls WHERE bland_call_id = $1",
    )
    .bind(&bland_call_id)
    .fetch_optional(&state.db)
    .await?
    {
        if let Some(task_id) = row.0 {
            let call_user_id = row.1;
            let state_clone = state.clone();
            let transcript_clone = transcript.clone();
            tokio::spawn(async move {
                if let Err(e) = crate::services::call_service::process_call_result(
                    &state_clone,
                    call_user_id,
                    task_id,
                    &transcript_clone,
                    outcome,
                )
                .await
                {
                    tracing::error!(%task_id, "call result processing failed: {e}");
                }
            });
        }
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn check_call_limit(state: &AppState, user_id: Uuid, tier: &str) -> Result<(), CloudError> {
    let max_calls = match tier {
        "pro" => 30,
        "unlimited" => i64::MAX,
        _ => 5, // free
    };

    let period_start = chrono::Utc::now().date_naive().format("%Y-%m-01").to_string();
    let count: i64 = sqlx::query_scalar(
        "SELECT COALESCE(call_count, 0) FROM usage_tracking WHERE user_id = $1 AND period_start = $2::date",
    )
    .bind(user_id)
    .bind(&period_start)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or(0);

    if count >= max_calls {
        return Err(CloudError::PaymentRequired(
            "monthly call limit reached — upgrade your plan".to_string(),
        ));
    }
    Ok(())
}

async fn update_usage(state: &AppState, user_id: Uuid, calls: i32, minutes: i32) -> Result<(), CloudError> {
    let period_start = chrono::Utc::now().date_naive().format("%Y-%m-01").to_string();
    sqlx::query(
        r#"
        INSERT INTO usage_tracking (user_id, period_start, call_count, call_minutes)
        VALUES ($1, $2::date, $3, $4)
        ON CONFLICT (user_id, period_start) DO UPDATE SET
            call_count = usage_tracking.call_count + $3,
            call_minutes = usage_tracking.call_minutes + $4
        "#,
    )
    .bind(user_id)
    .bind(&period_start)
    .bind(calls)
    .bind(minutes)
    .execute(&state.db)
    .await?;
    Ok(())
}
