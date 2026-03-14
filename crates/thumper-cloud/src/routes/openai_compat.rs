use std::convert::Infallible;

use axum::extract::State;
use axum::response::sse::{Event, Sse};
use axum::Json;
use chrono::Utc;
use futures::stream::Stream;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::CloudError;
use crate::services::llm_router::{self, ChatMsg};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Request/Response types (OpenAI-compatible)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ChatCompletionRequest {
    pub messages: Vec<MessageInput>,
    pub model: Option<String>,
    pub stream: Option<bool>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f64>,
}

#[derive(Deserialize)]
pub struct MessageInput {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct ChatCompletion {
    pub id: String,
    pub object: &'static str,
    pub created: i64,
    pub model: String,
    pub choices: Vec<Choice>,
    pub usage: Usage,
}

#[derive(Serialize)]
pub struct Choice {
    pub index: u32,
    pub message: ChoiceMessage,
    pub finish_reason: &'static str,
}

#[derive(Serialize)]
pub struct ChoiceMessage {
    pub role: &'static str,
    pub content: String,
}

#[derive(Serialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Serialize)]
pub struct ModelList {
    pub object: &'static str,
    pub data: Vec<ModelInfo>,
}

#[derive(Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub object: &'static str,
    pub created: i64,
    pub owned_by: String,
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions
// ---------------------------------------------------------------------------

pub async fn chat_completions(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
    Json(req): Json<ChatCompletionRequest>,
) -> Result<axum::response::Response, CloudError> {
    if req.stream == Some(true) {
        let sse = chat_completions_stream(state, claims, req).await?;
        Ok(sse.into_response())
    } else {
        let json = chat_completions_non_stream(state, claims, req).await?;
        Ok(json.into_response())
    }
}

use axum::response::IntoResponse;

async fn chat_completions_non_stream(
    state: AppState,
    claims: crate::auth::Claims,
    req: ChatCompletionRequest,
) -> Result<Json<ChatCompletion>, CloudError> {
    let config = llm_router::get_user_llm_config(&state, claims.sub).await?;
    let model_name = config.model.clone();

    // Build messages for the LLM
    let mut system = None;
    let mut messages: Vec<ChatMsg> = Vec::new();
    for msg in &req.messages {
        if msg.role == "system" {
            system = Some(msg.content.clone());
        } else {
            messages.push(ChatMsg {
                role: msg.role.clone(),
                content: msg.content.clone(),
            });
        }
    }

    // Generate using streaming internally, collect full response
    let mut text_stream = llm_router::generate_stream(
        &state,
        claims.sub,
        &messages,
        system.as_deref(),
    )
    .await?;

    let mut full_response = String::new();
    while let Some(result) = text_stream.next().await {
        match result {
            Ok(text) => full_response.push_str(&text),
            Err(e) => return Err(e),
        }
    }

    // Rough token estimate
    let prompt_tokens = req.messages.iter().map(|m| m.content.len() / 4).sum::<usize>() as u32;
    let completion_tokens = (full_response.len() / 4) as u32;

    Ok(Json(ChatCompletion {
        id: format!("chatcmpl-{}", Uuid::new_v4()),
        object: "chat.completion",
        created: Utc::now().timestamp(),
        model: model_name,
        choices: vec![Choice {
            index: 0,
            message: ChoiceMessage {
                role: "assistant",
                content: full_response,
            },
            finish_reason: "stop",
        }],
        usage: Usage {
            prompt_tokens,
            completion_tokens,
            total_tokens: prompt_tokens + completion_tokens,
        },
    }))
}

async fn chat_completions_stream(
    state: AppState,
    claims: crate::auth::Claims,
    req: ChatCompletionRequest,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, CloudError> {
    let config = llm_router::get_user_llm_config(&state, claims.sub).await?;
    let model_name = config.model.clone();

    let mut system = None;
    let mut messages: Vec<ChatMsg> = Vec::new();
    for msg in &req.messages {
        if msg.role == "system" {
            system = Some(msg.content.clone());
        } else {
            messages.push(ChatMsg {
                role: msg.role.clone(),
                content: msg.content.clone(),
            });
        }
    }

    let text_stream = llm_router::generate_stream(
        &state,
        claims.sub,
        &messages,
        system.as_deref(),
    )
    .await?;

    let completion_id = format!("chatcmpl-{}", Uuid::new_v4());
    let created = Utc::now().timestamp();

    let sse_stream = async_stream::stream! {
        let mut text_stream = text_stream;
        while let Some(result) = text_stream.next().await {
            match result {
                Ok(text) => {
                    let chunk = serde_json::json!({
                        "id": &completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": &model_name,
                        "choices": [{
                            "index": 0,
                            "delta": { "content": text },
                            "finish_reason": null
                        }]
                    });
                    yield Ok(Event::default().data(chunk.to_string()));
                }
                Err(_) => break,
            }
        }

        // Final chunk with finish_reason
        let done_chunk = serde_json::json!({
            "id": &completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": &model_name,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "stop"
            }]
        });
        yield Ok(Event::default().data(done_chunk.to_string()));
        yield Ok(Event::default().data("[DONE]".to_string()));
    };

    Ok(Sse::new(sse_stream))
}

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

pub async fn list_models(
    State(state): State<AppState>,
    AuthUser(claims): AuthUser,
) -> Result<Json<ModelList>, CloudError> {
    let config = llm_router::get_user_llm_config(&state, claims.sub).await?;

    let models: Vec<ModelInfo> = config
        .provider
        .available_models()
        .into_iter()
        .map(|m| ModelInfo {
            id: m.to_string(),
            object: "model",
            created: 1700000000,
            owned_by: format!("{:?}", config.provider).to_lowercase(),
        })
        .collect();

    Ok(Json(ModelList {
        object: "list",
        data: models,
    }))
}
