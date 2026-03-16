use std::convert::Infallible;
use std::pin::Pin;

use axum::extract::State;
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::stream::Stream;
use futures::StreamExt;
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::services::llm_router::{self, ChatMsg};
use crate::services::wallet_service;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ChatRequest {
    pub session_id: Option<Uuid>,
    pub message: String,
}

type SseStream = Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;

/// Convert internal LLM errors into user-friendly, actionable messages.
fn friendly_llm_error(err: &CloudError) -> String {
    let msg = err.to_string().to_lowercase();

    if msg.contains("api key not configured") || msg.contains("not configured") {
        "No AI model configured. Go to Settings > AI Model to set up your preferred provider and API key.".into()
    } else if msg.contains("decryption failed") || msg.contains("could not be decrypted") {
        "Your saved API key could not be decrypted. Please re-enter it in Settings > AI Model.".into()
    } else if msg.contains("401") || msg.contains("403") || msg.contains("unauthorized") {
        "Your API key was rejected. Please check it in Settings > AI Model.".into()
    } else if msg.contains("429") || msg.contains("rate limit") {
        "Rate limited. Please wait a moment and try again.".into()
    } else if msg.contains("request failed") || msg.contains("connect") {
        "Could not reach the AI provider. Check your connection.".into()
    } else {
        "Something went wrong. Please try again, or check Settings > AI Model.".into()
    }
}

/// Check chat usage against tier limits.
async fn check_chat_limit(state: &AppState, user_id: Uuid, tier: &str) -> Result<(), CloudError> {
    let max_messages: i64 = match tier {
        "pro" => 1000,
        "unlimited" | "enterprise" => i64::MAX,
        _ => 50, // free
    };

    let period_start = chrono::Utc::now().date_naive().format("%Y-%m-01").to_string();
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*) FROM chat_messages
        WHERE user_id = $1 AND role = 'user'
        AND created_at >= $2::date
        "#,
    )
    .bind(user_id)
    .bind(&period_start)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    if count >= max_messages {
        return Err(CloudError::PaymentRequired(
            "monthly chat limit reached — upgrade your plan".to_string(),
        ));
    }
    Ok(())
}

/// POST /api/chat — Send a message, get SSE stream back.
/// When the user has a wallet provisioned, includes crypto tools for Claude to use.
pub async fn chat(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<ChatRequest>,
) -> Result<Sse<SseStream>, CloudError> {
    let session_id = req.session_id.unwrap_or_else(Uuid::new_v4);
    let user_id = claims.sub;

    // Check chat usage limit
    check_chat_limit(&state, user_id, &claims.tier).await?;

    // Save user message
    sqlx::query(
        "INSERT INTO chat_messages (user_id, session_id, role, content) VALUES ($1, $2, 'user', $3)",
    )
    .bind(user_id)
    .bind(session_id)
    .bind(&req.message)
    .execute(&state.db)
    .await
    .map_err(|e| CloudError::Internal(format!("failed to save message: {e}")))?;

    // Check if user has a wallet (enables crypto tools)
    let has_wallet: bool = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM user_wallets WHERE user_id = $1)",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(false);

    // Load recent conversation history (last 20 messages in session)
    let history = sqlx::query_as::<_, (String, String)>(
        r#"
        SELECT role, content FROM chat_messages
        WHERE session_id = $1
        ORDER BY created_at ASC
        LIMIT 20
        "#,
    )
    .bind(session_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let messages: Vec<ChatMsg> = history
        .into_iter()
        .filter(|(role, _)| role == "user" || role == "assistant")
        .map(|(role, content)| ChatMsg { role, content })
        .collect();

    let system = if has_wallet {
        "You are Ghola, a helpful AI personal assistant. Be concise, friendly, and action-oriented. \
         When the user wants to make a call, send an email, or manage their calendar, help them do it. \
         You have access to the user's Solana wallet. Use the wallet tools to check balances, \
         get the wallet address, or send crypto when asked. Always confirm transfer details before sending."
    } else {
        "You are Ghola, a helpful AI personal assistant. Be concise, friendly, and action-oriented. \
         When the user wants to make a call, send an email, or manage their calendar, help them do it."
    };

    // If user has wallet, use tool-use path (non-streaming but with tool calls)
    if has_wallet {
        let tools = wallet_service::wallet_tool_definitions();
        let state_clone = state.clone();
        let db = state.db.clone();

        let sse_stream: SseStream = Box::pin(async_stream::stream! {
            // Send session_id as first event
            yield Ok(Event::default()
                .event("session")
                .data(serde_json::json!({ "session_id": session_id }).to_string()));

            match llm_router::generate_with_tools(&state_clone, user_id, &messages, Some(system), &tools).await {
                Ok(result) => {
                    // Emit tool call events
                    for tc in &result.tool_calls {
                        if tc.status == "executing" {
                            yield Ok(Event::default()
                                .event("tool_use")
                                .data(serde_json::json!({
                                    "tool": tc.tool_name,
                                    "status": "executing"
                                }).to_string()));
                        } else {
                            yield Ok(Event::default()
                                .event("tool_result")
                                .data(serde_json::json!({
                                    "tool": tc.tool_name,
                                    "status": tc.status,
                                    "result": tc.result,
                                }).to_string()));
                        }
                    }

                    // Emit the final text as a single delta
                    if !result.text.is_empty() {
                        yield Ok(Event::default()
                            .event("text_delta")
                            .data(serde_json::json!({ "text": &result.text }).to_string()));

                        // Save assistant response
                        let _ = sqlx::query(
                            "INSERT INTO chat_messages (user_id, session_id, role, content) VALUES ($1, $2, 'assistant', $3)",
                        )
                        .bind(user_id)
                        .bind(session_id)
                        .bind(&result.text)
                        .execute(&db)
                        .await;
                    }
                }
                Err(e) => {
                    let friendly = friendly_llm_error(&e);
                    tracing::warn!("chat tool-use error for user {user_id}: {e}");
                    yield Ok(Event::default()
                        .event("error")
                        .data(serde_json::json!({ "error": friendly }).to_string()));
                }
            }

            // Send done event
            yield Ok(Event::default()
                .event("done")
                .data(serde_json::json!({ "session_id": session_id }).to_string()));
        });

        return Ok(Sse::new(sse_stream));
    }

    // Standard streaming path (no wallet tools)
    let stream_result = llm_router::generate_stream(&state, user_id, &messages, Some(system)).await;
    let db = state.db.clone();

    let sse_stream: SseStream = Box::pin(async_stream::stream! {
        let mut full_response = String::new();

        // Send session_id as first event
        yield Ok(Event::default()
            .event("session")
            .data(serde_json::json!({ "session_id": session_id }).to_string()));

        match stream_result {
            Ok(text_stream) => {
                // Stream text deltas
                let mut text_stream = text_stream;
                while let Some(result) = text_stream.next().await {
                    match result {
                        Ok(text) => {
                            full_response.push_str(&text);
                            yield Ok(Event::default()
                                .event("text_delta")
                                .data(serde_json::json!({ "text": text }).to_string()));
                        }
                        Err(e) => {
                            let friendly = friendly_llm_error(&e);
                            tracing::warn!("chat stream error for user {user_id}: {e}");
                            yield Ok(Event::default()
                                .event("error")
                                .data(serde_json::json!({ "error": friendly }).to_string()));
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                // LLM setup failed (no API key, decryption error, etc.)
                let friendly = friendly_llm_error(&e);
                tracing::warn!("chat LLM init error for user {user_id}: {e}");
                yield Ok(Event::default()
                    .event("error")
                    .data(serde_json::json!({ "error": friendly }).to_string()));
            }
        }

        // Send done event
        yield Ok(Event::default()
            .event("done")
            .data(serde_json::json!({ "session_id": session_id }).to_string()));

        // Save assistant response to DB only if non-empty
        if !full_response.is_empty() {
            let _ = sqlx::query(
                "INSERT INTO chat_messages (user_id, session_id, role, content) VALUES ($1, $2, 'assistant', $3)",
            )
            .bind(user_id)
            .bind(session_id)
            .bind(&full_response)
            .execute(&db)
            .await;
        }
    });

    Ok(Sse::new(sse_stream))
}
