use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Claims;
use crate::db::{DbChatAgent, DbChatSnapshot};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

// ── Request/Response types ──

#[derive(Deserialize)]
pub struct CreateAgentRequest {
    pub encrypted_config: String,
    pub display_order: Option<i32>,
}

#[derive(Deserialize)]
pub struct UpdateAgentRequest {
    pub encrypted_config: Option<String>,
    pub display_order: Option<i32>,
    pub last_message_at: Option<String>,
}

#[derive(Deserialize)]
pub struct SaveSnapshotRequest {
    pub encrypted_messages: String,
    pub message_count: i32,
}

#[derive(Deserialize)]
pub struct RelayRequest {
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub messages: Vec<RelayMessage>,
    pub system: Option<String>,
    pub stream: Option<bool>,
    pub base_url: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct RelayMessage {
    pub role: String,
    pub content: String,
}

// ── Agent CRUD ──

pub async fn list_agents(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<DbChatAgent>>, AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::BadRequest("Invalid user ID".into()))?;

    let agents = sqlx::query_as::<_, DbChatAgent>(
        "SELECT * FROM chat_agents WHERE user_id = $1 ORDER BY last_message_at DESC NULLS LAST, display_order ASC",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(agents))
}

pub async fn create_agent(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateAgentRequest>,
) -> Result<(StatusCode, Json<DbChatAgent>), AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::BadRequest("Invalid user ID".into()))?;

    let agent = sqlx::query_as::<_, DbChatAgent>(
        "INSERT INTO chat_agents (user_id, encrypted_config, display_order) VALUES ($1, $2, $3) RETURNING *",
    )
    .bind(user_id)
    .bind(&req.encrypted_config)
    .bind(req.display_order.unwrap_or(0))
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(agent)))
}

pub async fn update_agent(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateAgentRequest>,
) -> Result<Json<DbChatAgent>, AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::BadRequest("Invalid user ID".into()))?;

    // Verify ownership
    let existing = sqlx::query_as::<_, DbChatAgent>(
        "SELECT * FROM chat_agents WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Agent not found".into()))?;

    let encrypted_config = req.encrypted_config.unwrap_or(existing.encrypted_config);
    let display_order = req.display_order.unwrap_or(existing.display_order);
    let last_message_at = if let Some(ts) = req.last_message_at {
        Some(
            ts.parse::<chrono::DateTime<chrono::Utc>>()
                .map_err(|_| AppError::BadRequest("Invalid timestamp".into()))?,
        )
    } else {
        existing.last_message_at
    };

    let agent = sqlx::query_as::<_, DbChatAgent>(
        "UPDATE chat_agents SET encrypted_config = $1, display_order = $2, last_message_at = $3 WHERE id = $4 AND user_id = $5 RETURNING *",
    )
    .bind(&encrypted_config)
    .bind(display_order)
    .bind(last_message_at)
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(agent))
}

pub async fn delete_agent(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::BadRequest("Invalid user ID".into()))?;

    let result = sqlx::query("DELETE FROM chat_agents WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Agent not found".into()));
    }

    // Also delete any snapshots
    sqlx::query("DELETE FROM chat_snapshots WHERE agent_id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(&state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

// ── History Snapshots ──

pub async fn get_history(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(agent_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::BadRequest("Invalid user ID".into()))?;

    let snapshot = sqlx::query_as::<_, DbChatSnapshot>(
        "SELECT * FROM chat_snapshots WHERE agent_id = $1 AND user_id = $2 ORDER BY snapshot_at DESC LIMIT 1",
    )
    .bind(agent_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    match snapshot {
        Some(s) => Ok(Json(serde_json::json!(s))),
        None => Ok(Json(serde_json::json!(null))),
    }
}

pub async fn save_history(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Path(agent_id): Path<Uuid>,
    Json(req): Json<SaveSnapshotRequest>,
) -> Result<(StatusCode, Json<DbChatSnapshot>), AppError> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::BadRequest("Invalid user ID".into()))?;

    // Upsert: delete old snapshot, insert new one
    sqlx::query("DELETE FROM chat_snapshots WHERE agent_id = $1 AND user_id = $2")
        .bind(agent_id)
        .bind(user_id)
        .execute(&state.db)
        .await?;

    let snapshot = sqlx::query_as::<_, DbChatSnapshot>(
        "INSERT INTO chat_snapshots (user_id, agent_id, encrypted_messages, message_count) VALUES ($1, $2, $3, $4) RETURNING *",
    )
    .bind(user_id)
    .bind(agent_id)
    .bind(&req.encrypted_messages)
    .bind(req.message_count)
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(snapshot)))
}

// ── SSE Relay ──

pub async fn relay(
    Extension(claims): Extension<Claims>,
    State(state): State<Arc<AppState>>,
    Json(req): Json<RelayRequest>,
) -> AppResult<Response> {
    let _user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::BadRequest("Invalid user ID".into()))?;

    let (url, body) = build_provider_request(&req)?;

    let upstream_req = state
        .http_client
        .post(&url)
        .header("Content-Type", "application/json");

    let upstream_req = match req.provider.as_str() {
        "anthropic" => upstream_req
            .header("x-api-key", &req.api_key)
            .header("anthropic-version", "2023-06-01"),
        "google" => upstream_req, // key is in the URL
        "ollama" => upstream_req, // no auth needed
        _ => upstream_req.header("Authorization", format!("Bearer {}", req.api_key)),
    };

    let upstream = upstream_req
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Upstream request failed: {e}")))?;

    if !upstream.status().is_success() {
        let status = upstream.status().as_u16();
        let request_id = upstream
            .headers()
            .get("request-id")
            .or_else(|| upstream.headers().get("x-request-id"))
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let error_body = upstream.text().await.unwrap_or_default();
        tracing::warn!(
            "Relay upstream error {status}{}: {error_body}",
            request_id
                .as_ref()
                .map(|id| format!(" (request_id={id})"))
                .unwrap_or_default()
        );
        return Err(AppError::BadRequest(format!(
            "Provider returned {status}{}: {error_body}",
            request_id
                .map(|id| format!(" (request_id={id})"))
                .unwrap_or_default()
        )));
    }

    // Stream the response back
    let stream = upstream.bytes_stream();
    let body = Body::from_stream(stream);

    Ok(Response::builder()
        .status(200)
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .body(body)
        .unwrap())
}

fn build_provider_request(req: &RelayRequest) -> AppResult<(String, String)> {
    match req.provider.as_str() {
        "anthropic" => {
            let url = "https://api.anthropic.com/v1/messages".to_string();

            let mut body = serde_json::json!({
                "model": req.model,
                "max_tokens": 4096,
                "stream": req.stream.unwrap_or(true),
                "messages": req.messages,
            });
            if let Some(system) = &req.system {
                body["system"] = serde_json::json!(system);
            }
            Ok((url, serde_json::to_string(&body).unwrap()))
        }
        "openai" => {
            let url = "https://api.openai.com/v1/chat/completions".to_string();

            let mut messages = req.messages.clone();
            if let Some(system) = &req.system {
                messages.insert(
                    0,
                    RelayMessage {
                        role: "system".to_string(),
                        content: system.clone(),
                    },
                );
            }

            let body = serde_json::json!({
                "model": req.model,
                "stream": req.stream.unwrap_or(true),
                "messages": messages,
            });
            Ok((url, serde_json::to_string(&body).unwrap()))
        }
        "google" => {
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
                req.model, req.api_key
            );

            let contents: Vec<serde_json::Value> = req
                .messages
                .iter()
                .map(|m| {
                    serde_json::json!({
                        "role": if m.role == "assistant" { "model" } else { "user" },
                        "parts": [{ "text": m.content }]
                    })
                })
                .collect();

            let mut body = serde_json::json!({ "contents": contents });
            if let Some(system) = &req.system {
                body["systemInstruction"] = serde_json::json!({
                    "parts": [{ "text": system }]
                });
            }
            Ok((url, serde_json::to_string(&body).unwrap()))
        }
        "mistral" => {
            let url = "https://api.mistral.ai/v1/chat/completions".to_string();

            let mut messages = req.messages.clone();
            if let Some(system) = &req.system {
                messages.insert(
                    0,
                    RelayMessage {
                        role: "system".to_string(),
                        content: system.clone(),
                    },
                );
            }

            let body = serde_json::json!({
                "model": req.model,
                "stream": req.stream.unwrap_or(true),
                "messages": messages,
            });
            Ok((url, serde_json::to_string(&body).unwrap()))
        }
        "groq" | "together" | "ollama" | "deepseek" | "cerebras" | "openrouter" | "kimi"
        | "qwen" | "glm" => {
            let base = req
                .base_url
                .as_deref()
                .unwrap_or(match req.provider.as_str() {
                    "groq" => "https://api.groq.com/openai",
                    "together" => "https://api.together.xyz",
                    "ollama" => "http://localhost:11434",
                    "deepseek" => "https://api.deepseek.com",
                    "cerebras" => "https://api.cerebras.ai",
                    "openrouter" => "https://openrouter.ai/api",
                    "kimi" => "https://api.moonshot.cn",
                    "qwen" => "https://dashscope.aliyuncs.com/compatible-mode",
                    "glm" => "https://open.bigmodel.cn/api/paas",
                    _ => unreachable!(),
                });
            let url = format!("{base}/v1/chat/completions");

            let mut messages = req.messages.clone();
            if let Some(system) = &req.system {
                messages.insert(
                    0,
                    RelayMessage {
                        role: "system".to_string(),
                        content: system.clone(),
                    },
                );
            }

            let body = serde_json::json!({
                "model": req.model,
                "stream": req.stream.unwrap_or(true),
                "messages": messages,
            });
            Ok((url, serde_json::to_string(&body).unwrap()))
        }
        other => Err(AppError::BadRequest(format!(
            "Unsupported provider: {other}"
        ))),
    }
}
