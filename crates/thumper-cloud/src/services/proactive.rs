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

/// Check Gmail for replies to emails we sent on behalf of the user.
async fn check_email_reply(
    state: &AppState,
    user_id: uuid::Uuid,
    _config: &serde_json::Value,
) -> Result<(), CloudError> {
    // Get the user's Gmail access token
    let access_token = match get_gmail_token(state, user_id).await {
        Ok(token) => token,
        Err(_) => {
            tracing::debug!(%user_id, "email_reply: no Gmail token, skipping");
            return Ok(());
        }
    };

    // Get recently sent emails (last 24 hours) that we're watching for replies
    let sent_emails = sqlx::query_as::<_, (uuid::Uuid, String, String)>(
        r#"
        SELECT id, gmail_message_id, to_address
        FROM email_actions
        WHERE user_id = $1
          AND status = 'sent'
          AND gmail_message_id IS NOT NULL
          AND sent_at > now() - interval '24 hours'
        ORDER BY sent_at DESC
        LIMIT 10
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    if sent_emails.is_empty() {
        return Ok(());
    }

    let client = reqwest::Client::new();

    for (email_id, gmail_msg_id, to_address) in &sent_emails {
        // Check Gmail for replies using the thread of the original message
        let thread_resp = client
            .get(format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages/{gmail_msg_id}"
            ))
            .header("Authorization", format!("Bearer {access_token}"))
            .query(&[("format", "metadata"), ("metadataHeaders", "Subject")])
            .send()
            .await;

        let thread_id = match thread_resp {
            Ok(resp) if resp.status().is_success() => {
                let body: serde_json::Value = resp.json().await.unwrap_or_default();
                body["threadId"].as_str().map(|s| s.to_string())
            }
            _ => continue,
        };

        let Some(thread_id) = thread_id else {
            continue;
        };

        // Fetch thread messages
        let thread_resp = client
            .get(format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/threads/{thread_id}"
            ))
            .header("Authorization", format!("Bearer {access_token}"))
            .query(&[("format", "metadata")])
            .send()
            .await;

        if let Ok(resp) = thread_resp {
            if resp.status().is_success() {
                let body: serde_json::Value = resp.json().await.unwrap_or_default();
                let messages = body["messages"].as_array();

                if let Some(msgs) = messages {
                    // If there are more messages in the thread than just ours, there's a reply
                    if msgs.len() > 1 {
                        let latest = &msgs[msgs.len() - 1];
                        let latest_id = latest["id"].as_str().unwrap_or("");

                        // Skip if this is our own message
                        if latest_id != gmail_msg_id {
                            tracing::info!(
                                %user_id,
                                %email_id,
                                from = %to_address,
                                "reply detected on sent email"
                            );

                            // Notify via Telegram if linked
                            if let Ok(Some(tg_link)) =
                                crate::services::telegram::get_telegram_link(&state.db, user_id)
                                    .await
                            {
                                if let Some(ref token) = state.config.telegram_bot_token {
                                    let msg = format!(
                                        "You got a reply from {to_address}! Check your inbox."
                                    );
                                    let _ = crate::services::telegram::notify_user(
                                        token, tg_link.0, &msg,
                                    )
                                    .await;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Send a daily email digest — summary of recent inbox activity.
async fn send_email_digest(
    state: &AppState,
    user_id: uuid::Uuid,
    _config: &serde_json::Value,
) -> Result<(), CloudError> {
    let access_token = match get_gmail_token(state, user_id).await {
        Ok(token) => token,
        Err(_) => {
            tracing::debug!(%user_id, "email_digest: no Gmail token, skipping");
            return Ok(());
        }
    };

    // Fetch recent unread messages
    let client = reqwest::Client::new();
    let resp = client
        .get("https://gmail.googleapis.com/gmail/v1/users/me/messages")
        .header("Authorization", format!("Bearer {access_token}"))
        .query(&[
            ("q", "is:unread newer_than:1d"),
            ("maxResults", "20"),
        ])
        .send()
        .await
        .map_err(|e| CloudError::Internal(format!("Gmail API request failed: {e}")))?;

    if !resp.status().is_success() {
        return Ok(()); // Silently skip if API fails
    }

    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let messages = body["messages"].as_array();

    let unread_count = body["resultSizeEstimate"].as_u64().unwrap_or(0);
    if unread_count == 0 {
        return Ok(());
    }

    // Fetch subjects of first few messages for the digest
    let mut subjects = Vec::new();
    if let Some(msgs) = messages {
        for msg in msgs.iter().take(5) {
            let msg_id = msg["id"].as_str().unwrap_or("");
            if msg_id.is_empty() {
                continue;
            }

            let detail_resp = client
                .get(format!(
                    "https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg_id}"
                ))
                .header("Authorization", format!("Bearer {access_token}"))
                .query(&[("format", "metadata"), ("metadataHeaders", "Subject,From")])
                .send()
                .await;

            if let Ok(resp) = detail_resp {
                if resp.status().is_success() {
                    let detail: serde_json::Value = resp.json().await.unwrap_or_default();
                    let headers = detail["payload"]["headers"].as_array();
                    let mut subject = String::new();
                    let mut from = String::new();

                    if let Some(hdrs) = headers {
                        for h in hdrs {
                            match h["name"].as_str() {
                                Some("Subject") => {
                                    subject = h["value"].as_str().unwrap_or("(no subject)").to_string()
                                }
                                Some("From") => {
                                    from = h["value"].as_str().unwrap_or("").to_string()
                                }
                                _ => {}
                            }
                        }
                    }

                    subjects.push(format!("• {from}: {subject}"));
                }
            }
        }
    }

    // Send digest via Telegram
    if let Ok(Some(tg_link)) =
        crate::services::telegram::get_telegram_link(&state.db, user_id).await
    {
        if let Some(ref token) = state.config.telegram_bot_token {
            let digest = if subjects.is_empty() {
                format!("Daily Email Digest\n\n{unread_count} unread emails today.")
            } else {
                format!(
                    "Daily Email Digest\n\n{unread_count} unread emails today. Here are the latest:\n\n{}",
                    subjects.join("\n")
                )
            };
            let _ = crate::services::telegram::notify_user(token, tg_link.0, &digest).await;
        }
    }

    tracing::info!(%user_id, %unread_count, "email digest sent");
    Ok(())
}

/// Check Google Calendar for upcoming events and send reminders.
async fn check_calendar_reminders(
    state: &AppState,
    user_id: uuid::Uuid,
    _config: &serde_json::Value,
) -> Result<(), CloudError> {
    // Use calendar service to list upcoming events (next 30 minutes)
    let now = chrono::Utc::now();
    let soon = now + chrono::Duration::minutes(30);

    let params = serde_json::json!({
        "action": "list_events",
        "time_min": now.to_rfc3339(),
        "time_max": soon.to_rfc3339(),
        "max_results": 5,
    });

    let events_result =
        crate::services::calendar_service::handle_calendar_request(state, user_id, &params).await;

    let events = match events_result {
        Ok(result) => result,
        Err(e) => {
            // Skip silently if no Google account connected
            if e.to_string().contains("not connected") {
                return Ok(());
            }
            return Err(e);
        }
    };

    let event_list = events["events"].as_array();
    let Some(event_list) = event_list else {
        return Ok(());
    };

    if event_list.is_empty() {
        return Ok(());
    }

    // Build reminder message
    let mut reminders = Vec::new();
    for event in event_list {
        let title = event["title"].as_str().unwrap_or("Untitled");
        let start = event["start"].as_str().unwrap_or("");

        // Parse start time to show "in X minutes"
        let minutes_until = if let Ok(start_time) = chrono::DateTime::parse_from_rfc3339(start) {
            let diff = start_time.signed_duration_since(now);
            diff.num_minutes()
        } else {
            -1
        };

        if minutes_until > 0 && minutes_until <= 30 {
            reminders.push(format!("• {title} — in {minutes_until} min"));
        }
    }

    if reminders.is_empty() {
        return Ok(());
    }

    // Notify via Telegram
    if let Ok(Some(tg_link)) =
        crate::services::telegram::get_telegram_link(&state.db, user_id).await
    {
        if let Some(ref token) = state.config.telegram_bot_token {
            let msg = format!(
                "Upcoming events:\n\n{}\n\nNeed to prepare anything?",
                reminders.join("\n")
            );
            let _ = crate::services::telegram::notify_user(token, tg_link.0, &msg).await;
        }
    }

    tracing::info!(%user_id, count = reminders.len(), "calendar reminders sent");
    Ok(())
}

/// Get Gmail access token for the user (reuses connected_accounts).
async fn get_gmail_token(state: &AppState, user_id: uuid::Uuid) -> Result<String, CloudError> {
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
    .ok_or(CloudError::BadRequest("Gmail not connected".to_string()))?;

    let access_token = decrypt_token(&row.0, &state.config.encryption_key)?;

    if let Some(expires_at) = row.2 {
        if expires_at < chrono::Utc::now() {
            let refresh_token = decrypt_token(&row.1, &state.config.encryption_key)?;
            return refresh_gmail_token(state, user_id, &refresh_token).await;
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

async fn refresh_gmail_token(
    state: &AppState,
    user_id: uuid::Uuid,
    refresh_token: &str,
) -> Result<String, CloudError> {
    let client_id = state.config.gmail_client_id.as_deref()
        .ok_or(CloudError::ServiceUnavailable("Gmail OAuth not configured".to_string()))?;
    let client_secret = state.config.gmail_client_secret.as_deref()
        .ok_or(CloudError::ServiceUnavailable("Gmail OAuth not configured".to_string()))?;

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

    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let new_token = body["access_token"]
        .as_str()
        .ok_or(CloudError::Internal("no access_token in refresh response".to_string()))?;
    let expires_in = body["expires_in"].as_i64().unwrap_or(3600);

    let encrypted = crate::services::email_service::encrypt_token(new_token, &state.config.encryption_key)?;
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

    Ok(new_token.to_string())
}
