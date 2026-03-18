use std::convert::Infallible;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event, Sse};
use axum::Json;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use futures::stream::Stream;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{AuthUser, Claims};
use crate::error::CloudError;
use crate::services::{
    agent_service, compute_service, llm_router::{self, ChatMsg}, x402_service,
};
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

/// Handles three auth paths:
/// 1. Authorization: Bearer <jwt> → existing BYOM/cascade flow
/// 2. Authorization: Bearer <api-key> → existing API key flow
/// 3. model starts with "agent:" + no auth → x402 payment flow
pub async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChatCompletionRequest>,
) -> Result<axum::response::Response, CloudError> {
    // Check if this is an x402 agent request (model starts with "agent:")
    let is_agent_request = req
        .model
        .as_deref()
        .map(|m| m.starts_with("agent:"))
        .unwrap_or(false);

    let has_auth = headers.get("authorization").is_some();

    // If model is "agent:*" and no auth header, use x402 flow
    if is_agent_request && !has_auth {
        return handle_x402_agent_request(&state, &headers, req).await;
    }

    // Otherwise, require auth (JWT or API key) — existing flow
    let claims = extract_auth(&headers, &state).await?;

    // If model is "agent:*" but user IS authenticated, auth takes priority
    // (cheaper via escrow for registered users)

    if req.stream == Some(true) {
        let sse = chat_completions_stream(state, claims, req).await?;
        Ok(sse.into_response())
    } else {
        let json = chat_completions_non_stream(state, claims, req).await?;
        Ok(json.into_response())
    }
}

/// Extract auth claims from the Authorization header (JWT or API key).
async fn extract_auth(headers: &HeaderMap, state: &AppState) -> Result<Claims, CloudError> {
    let auth_header = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or(CloudError::Unauthorized)?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or(CloudError::Auth("expected Bearer token".to_string()))?;

    if token.starts_with("sk-ghola-") {
        // API key path — hash and look up
        let key_hash = crate::auth::hash_api_key(token);
        let row = sqlx::query_as::<_, (Uuid, Uuid)>(
            "SELECT id, user_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
        )
        .bind(&key_hash)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| CloudError::Internal(format!("api key lookup failed: {e}")))?
        .ok_or(CloudError::Auth("invalid or revoked API key".to_string()))?;

        let (_api_key_id, user_id) = row;
        let user_row = sqlx::query_as::<_, (Option<String>, String)>(
            "SELECT email, tier FROM users WHERE id = $1",
        )
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| CloudError::Internal(format!("user lookup failed: {e}")))?
        .ok_or(CloudError::Auth("user not found".to_string()))?;

        let now = Utc::now();
        Ok(Claims {
            sub: user_id,
            email: user_row.0,
            name: None,
            tier: user_row.1,
            exp: (now + chrono::Duration::days(1)).timestamp(),
            iat: now.timestamp(),
        })
    } else {
        crate::auth::verify_jwt(token, &state.config.jwt_secret)
    }
}

use axum::response::IntoResponse;

// ---------------------------------------------------------------------------
// x402 Agent Request Handler
// ---------------------------------------------------------------------------

async fn handle_x402_agent_request(
    state: &AppState,
    headers: &HeaderMap,
    req: ChatCompletionRequest,
) -> Result<axum::response::Response, CloudError> {
    // Parse agent slug from model: "agent:research-bot" → "research-bot"
    let model_str = req.model.as_deref().unwrap_or("");
    let slug = model_str
        .strip_prefix("agent:")
        .ok_or_else(|| CloudError::BadRequest("invalid agent model format".into()))?;

    // Look up agent — 404 before 402
    let agent_info = agent_service::get_public_agent(&state.db, slug).await?;

    // Get the matched agent details (need provider relay_pubkey, system_prompt, etc.)
    let matched = agent_service::match_agents(
        &state.db,
        &agent_service::AgentMatchCriteria {
            require_tags: vec![],
            require_tools: vec![],
            prefer_model: None,
            min_reputation: 0.0,
            limit: 100,
        },
    )
    .await?;

    let matched_agent = matched
        .iter()
        .find(|a| a.agent_id == agent_info.id)
        .ok_or_else(|| {
            CloudError::ServiceUnavailable("agent's provider is offline".into())
        })?;

    let max_tokens = req.max_tokens.unwrap_or(matched_agent.max_tokens as u32);
    let required_amount = x402_service::estimate_agent_price(
        matched_agent.price_per_1k_input,
        matched_agent.price_per_1k_output,
        max_tokens,
    );

    // Check for PAYMENT-SIGNATURE header
    let payment_header = headers
        .get("payment-signature")
        .and_then(|v| v.to_str().ok());

    let payment_header = match payment_header {
        Some(h) => h,
        None => {
            // No payment — return 402 with requirements
            let requirements = x402_service::build_payment_requirements(
                state,
                agent_info.id,
                &agent_info.slug,
                &agent_info.model_id,
                matched_agent.price_per_1k_input,
                matched_agent.price_per_1k_output,
                max_tokens,
            );
            return Ok(x402_service::build_402_response(&requirements));
        }
    };

    // Decode and parse payment proof
    let proof_bytes = STANDARD.decode(payment_header).map_err(|_| {
        CloudError::PaymentRequired("invalid PAYMENT-SIGNATURE: bad base64".into())
    })?;
    let proof: x402_service::PaymentProof =
        serde_json::from_slice(&proof_bytes).map_err(|e| {
            CloudError::PaymentRequired(format!("invalid PAYMENT-SIGNATURE: {e}"))
        })?;

    // Verify payment on-chain
    let verified = x402_service::verify_payment(
        state,
        &proof,
        required_amount,
        agent_info.id,
        matched_agent.provider_id,
        &matched_agent.model_id,
    )
    .await?;

    // Payment verified — dispatch inference
    // Use a random job_id for relay routing (no compute_jobs DB record needed)
    let job_id = Uuid::new_v4();

    // Build messages for inference
    let mut system = Some(matched_agent.system_prompt.clone());
    let mut messages_json = Vec::new();
    for msg in &req.messages {
        if msg.role == "system" {
            // Prepend user's system message to agent's system prompt
            if let Some(ref mut sys) = system {
                *sys = format!("{}\n\n{}", sys, msg.content);
            }
        } else {
            messages_json.push(serde_json::json!({
                "role": msg.role,
                "content": msg.content,
            }));
        }
    }

    let messages_value = serde_json::Value::Array(messages_json);

    // Dispatch inference to provider via relay
    let inference_result = match compute_service::dispatch_inference(
        state,
        &matched_agent.relay_pubkey,
        &messages_value,
        system.as_deref(),
        &matched_agent.model_id,
        max_tokens,
        &job_id.to_string(),
    )
    .await
    {
        Ok(result) => result,
        Err(e) => {
            // Mark payment as failed — client can retry with same tx_signature
            sqlx::query("UPDATE x402_payments SET status = 'failed' WHERE id = $1")
                .bind(verified.payment_id)
                .execute(&state.db)
                .await
                .ok();

            let body = serde_json::json!({
                "error": format!("inference failed: {e}"),
                "payment_id": verified.payment_id,
                "tx_signature": verified.tx_signature,
                "retry": "resubmit the same request with the same PAYMENT-SIGNATURE to retry"
            });
            return Ok((
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(body),
            )
                .into_response());
        }
    };

    // Build OpenAI-compatible response
    let prompt_tokens = req.messages.iter().map(|m| m.content.len() / 4).sum::<usize>() as u32;
    let completion_tokens = (inference_result.text.len() / 4) as u32;

    let completion = ChatCompletion {
        id: format!("chatcmpl-{}", Uuid::new_v4()),
        object: "chat.completion",
        created: Utc::now().timestamp(),
        model: model_str.to_string(),
        choices: vec![Choice {
            index: 0,
            message: ChoiceMessage {
                role: "assistant",
                content: inference_result.text,
            },
            finish_reason: "stop",
        }],
        usage: Usage {
            prompt_tokens: inference_result.input_tokens.max(prompt_tokens),
            completion_tokens: inference_result.output_tokens.max(completion_tokens),
            total_tokens: inference_result.input_tokens.max(prompt_tokens)
                + inference_result.output_tokens.max(completion_tokens),
        },
    };

    // Settle payment in background (85/15 split)
    let actual_input = inference_result.input_tokens.max(prompt_tokens) as i32;
    let actual_output = inference_result.output_tokens.max(completion_tokens) as i32;
    let latency = inference_result.latency_ms as i32;
    let price_in = matched_agent.price_per_1k_input;
    let price_out = matched_agent.price_per_1k_output;
    let payment_id = verified.payment_id;
    let provider_id = matched_agent.provider_id;
    let db = state.db.clone();
    tokio::spawn(async move {
        let _ = x402_service::settle_x402_payment(
            &db,
            payment_id,
            actual_input,
            actual_output,
            latency,
            price_in,
            price_out,
        )
        .await;
        let _ = compute_service::update_reputation(
            &db,
            provider_id,
            true,
            Some(latency as i64),
        )
        .await;
    });

    // Build PAYMENT-RESPONSE header
    let actual_cost = x402_service::estimate_agent_price(price_in, price_out, actual_output as u32);
    let payment_response = x402_service::PaymentResponse {
        settled: true,
        actual_cost,
        tx_signature: verified.tx_signature,
    };
    let pr_json = serde_json::to_vec(&payment_response).unwrap_or_default();
    let pr_b64 = STANDARD.encode(&pr_json);

    Ok((
        [(
            axum::http::header::HeaderName::from_static("payment-response"),
            pr_b64,
        )],
        Json(completion),
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// Authenticated flows (existing)
// ---------------------------------------------------------------------------

async fn chat_completions_non_stream(
    state: AppState,
    claims: Claims,
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
    claims: Claims,
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
