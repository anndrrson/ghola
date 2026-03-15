use std::convert::Infallible;

use axum::extract::State;
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::stream::Stream;
use futures::StreamExt;
use serde::Deserialize;

use crate::auth::PairedDevice;
use crate::error::HomeError;
use crate::llm::{self, ChatMsg};
use crate::state::HomeState;

#[derive(Deserialize)]
pub struct ChatRequest {
    pub session_id: Option<String>,
    pub message: String,
    pub model: Option<String>,
}

fn friendly_llm_error(err: &HomeError) -> String {
    let msg = err.to_string().to_lowercase();

    if msg.contains("request failed") || msg.contains("connect") || msg.contains("not reachable") {
        "Could not reach Ollama. Make sure it's running.".into()
    } else if msg.contains("429") || msg.contains("rate limit") {
        "Rate limited. Please wait a moment and try again.".into()
    } else {
        "Something went wrong with the AI model. Please try again.".into()
    }
}

pub async fn chat(
    State(state): State<HomeState>,
    PairedDevice(_device): PairedDevice,
    Json(req): Json<ChatRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, HomeError> {
    let session_id = req
        .session_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Determine model: request override > settings table > default
    let model = if let Some(m) = req.model {
        m
    } else {
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'default_model'")
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| "llama3.2".to_string())
    };

    // Save user message
    sqlx::query(
        "INSERT INTO chat_messages (session_id, role, content) VALUES (?1, 'user', ?2)",
    )
    .bind(&session_id)
    .bind(&req.message)
    .execute(&state.db)
    .await
    .map_err(|e| HomeError::Internal(format!("failed to save message: {e}")))?;

    // Load conversation history (last 20 messages)
    let history = sqlx::query_as::<_, (String, String)>(
        "SELECT role, content FROM chat_messages WHERE session_id = ?1 ORDER BY created_at ASC LIMIT 20",
    )
    .bind(&session_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let messages: Vec<ChatMsg> = history
        .into_iter()
        .filter(|(role, _)| role == "user" || role == "assistant")
        .map(|(role, content)| ChatMsg { role, content })
        .collect();

    let system = "You are Ghola, a helpful AI assistant running locally on your owner's Mac. Be concise, friendly, and helpful.";

    let stream_result = llm::generate_stream(&model, &messages, Some(system)).await;

    let db = state.db.clone();
    let sid = session_id.clone();

    let sse_stream = async_stream::stream! {
        let mut full_response = String::new();

        // Send session_id as first event
        yield Ok(Event::default()
            .event("session")
            .data(serde_json::json!({ "session_id": session_id }).to_string()));

        match stream_result {
            Ok(text_stream) => {
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
                            tracing::warn!("chat stream error: {e}");
                            yield Ok(Event::default()
                                .event("error")
                                .data(serde_json::json!({ "error": friendly }).to_string()));
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                let friendly = friendly_llm_error(&e);
                tracing::warn!("chat init error: {e}");
                yield Ok(Event::default()
                    .event("error")
                    .data(serde_json::json!({ "error": friendly }).to_string()));
            }
        }

        // Send done event
        yield Ok(Event::default()
            .event("done")
            .data(serde_json::json!({ "session_id": sid }).to_string()));

        // Save assistant response
        if !full_response.is_empty() {
            let _ = sqlx::query(
                "INSERT INTO chat_messages (session_id, role, content) VALUES (?1, 'assistant', ?2)",
            )
            .bind(&sid)
            .bind(&full_response)
            .execute(&db)
            .await;
        }
    };

    Ok(Sse::new(sse_stream))
}
