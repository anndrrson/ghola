use crate::error::CloudError;
use crate::state::AppState;

/// Run the proactive monitoring loop. Called on startup.
pub async fn start_monitor_loop(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));

    loop {
        interval.tick().await;
        if let Err(e) = run_monitors(&state).await {
            tracing::error!("proactive monitor error: {e}");
        }
    }
}

async fn run_monitors(state: &AppState) -> Result<(), CloudError> {
    // Fetch monitors that are due to run
    let monitors = sqlx::query_as::<_, (uuid::Uuid, uuid::Uuid, String, serde_json::Value)>(
        r#"
        SELECT id, user_id, monitor_type, config
        FROM monitors
        WHERE is_active = true AND (next_run_at IS NULL OR next_run_at <= now())
        LIMIT 10
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    for (monitor_id, user_id, monitor_type, config) in monitors {
        match monitor_type.as_str() {
            "email_reply" => {
                if let Err(e) = check_email_reply(state, user_id, &config).await {
                    tracing::warn!(%monitor_id, "email reply check failed: {e}");
                }
            }
            "email_digest" => {
                if let Err(e) = send_email_digest(state, user_id, &config).await {
                    tracing::warn!(%monitor_id, "email digest failed: {e}");
                }
            }
            "calendar_reminder" => {
                if let Err(e) = check_calendar_reminders(state, user_id, &config).await {
                    tracing::warn!(%monitor_id, "calendar reminder check failed: {e}");
                }
            }
            "notification_watch" => {
                // Notifications are forwarded by the Android app in real-time
                // This monitor checks for patterns/digests
            }
            _ => {
                tracing::warn!(%monitor_id, %monitor_type, "unknown monitor type");
            }
        }

        // Update next_run_at based on monitor type
        let interval_secs = match monitor_type.as_str() {
            "email_reply" => 3600,      // Check every hour
            "email_digest" => 86400,    // Daily
            "calendar_reminder" => 900, // Every 15 min
            _ => 3600,
        };

        sqlx::query(
            r#"
            UPDATE monitors SET
                last_run_at = now(),
                next_run_at = now() + ($1 || ' seconds')::interval
            WHERE id = $2
            "#,
        )
        .bind(interval_secs.to_string())
        .bind(monitor_id)
        .execute(&state.db)
        .await?;
    }

    Ok(())
}

async fn check_email_reply(
    _state: &AppState,
    _user_id: uuid::Uuid,
    _config: &serde_json::Value,
) -> Result<(), CloudError> {
    // TODO: Check Gmail for replies to emails we sent
    // If reply found:
    //   1. Summarize via LLM
    //   2. Push notification to user
    //   3. Optionally create follow-up task
    Ok(())
}

async fn send_email_digest(
    _state: &AppState,
    _user_id: uuid::Uuid,
    _config: &serde_json::Value,
) -> Result<(), CloudError> {
    // TODO: Fetch recent emails from Gmail
    // Summarize via LLM
    // Push notification with digest + one-tap actions
    Ok(())
}

async fn check_calendar_reminders(
    _state: &AppState,
    _user_id: uuid::Uuid,
    _config: &serde_json::Value,
) -> Result<(), CloudError> {
    // TODO: Check Google Calendar for upcoming events
    // Push pre-meeting notifications:
    //   "Meeting in 15 min — pull up notes?"
    // Push post-meeting suggestions:
    //   "Send follow-up to attendees?"
    Ok(())
}
