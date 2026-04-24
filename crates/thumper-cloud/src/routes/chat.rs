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
use crate::services::agent_service;
use crate::services::compute_service;
use crate::services::llm_router::{self, ChatMsg};
use crate::services::wallet_service;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ChatRequest {
    pub session_id: Option<Uuid>,
    pub message: String,
    pub agent_id: Option<Uuid>,
    pub agent_slug: Option<String>,
}

type SseStream = Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;

/// Convert internal LLM errors into user-friendly, actionable messages.
fn friendly_llm_error(err: &CloudError) -> String {
    let msg = err.to_string().to_lowercase();

    if msg.contains("api key not configured") || msg.contains("not configured") {
        "No AI model configured. Go to Settings > AI Model to set up your preferred provider and API key.".into()
    } else if msg.contains("decryption failed") || msg.contains("could not be decrypted") {
        "Your saved API key could not be decrypted. Please re-enter it in Settings > AI Model."
            .into()
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

    let period_start = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-01")
        .to_string();
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
    let user_id = claims.sub;

    // Agent chat branch — if agent_id or agent_slug is set, route to agent_chat()
    if req.agent_id.is_some() || req.agent_slug.is_some() {
        return agent_chat(state, user_id, &claims.tier, req).await;
    }

    let session_id = req.session_id.unwrap_or_else(Uuid::new_v4);

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

    // Check which provider will be used (for community GPU indicator)
    let llm_config = llm_router::get_user_llm_config(&state, user_id).await.ok();
    let is_community = llm_config
        .as_ref()
        .map(|c| c.provider == llm_router::LlmProvider::Community)
        .unwrap_or(false);

    // Standard streaming path (no wallet tools)
    let stream_result = llm_router::generate_stream(&state, user_id, &messages, Some(system)).await;
    let db = state.db.clone();

    let sse_stream: SseStream = Box::pin(async_stream::stream! {
        let mut full_response = String::new();

        // Send session_id as first event
        yield Ok(Event::default()
            .event("session")
            .data(serde_json::json!({ "session_id": session_id }).to_string()));

        // Emit community GPU provider event with real provider/model data
        if is_community {
            let preview = compute_service::preview_provider(&state).await;
            let (provider_name, model_id) = preview.unwrap_or(("Community".into(), "community-gpu".into()));
            yield Ok(Event::default()
                .event("provider")
                .data(serde_json::json!({
                    "type": "community",
                    "model": model_id,
                    "provider_name": provider_name
                }).to_string()));
        }

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

// ---------------------------------------------------------------------------
// Agent Chat — routes chat through a rental agent's provider via the relay
// ---------------------------------------------------------------------------

async fn agent_chat(
    state: AppState,
    user_id: Uuid,
    tier: &str,
    req: ChatRequest,
) -> Result<Sse<SseStream>, CloudError> {
    check_chat_limit(&state, user_id, tier).await?;

    // Resolve agent
    let agent = if let Some(id) = req.agent_id {
        agent_service::get_agent(&state.db, id).await?
    } else if let Some(ref slug) = req.agent_slug {
        agent_service::get_agent_by_slug(&state.db, slug).await?
    } else {
        return Err(CloudError::BadRequest(
            "agent_id or agent_slug required".into(),
        ));
    };

    if !agent.is_active {
        return Err(CloudError::BadRequest(
            "this agent is currently inactive".into(),
        ));
    }

    // Check provider is online and get relay info + pricing
    let provider_row = sqlx::query_as::<_, (String, String, serde_json::Value)>(
        r#"
        SELECT status, relay_pubkey, models
        FROM compute_providers WHERE id = $1
        "#,
    )
    .bind(agent.provider_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| CloudError::NotFound("agent's provider not found".into()))?;

    let (status, relay_pubkey, provider_models) = provider_row;
    if status != "online" {
        return Err(CloudError::ServiceUnavailable(
            "this agent's provider is currently offline — try again later".into(),
        ));
    }

    // Extract pricing for the agent's model
    let (price_input, price_output) = provider_models
        .as_array()
        .and_then(|arr| {
            arr.iter().find(|m| {
                m.get("model_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s == agent.model_id)
                    .unwrap_or(false)
            })
        })
        .map(|m| {
            let i = m
                .get("price_per_1k_input")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let o = m
                .get("price_per_1k_output")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            (i, o)
        })
        .unwrap_or((0, 0));

    // Get or create agent session
    let session_id =
        agent_service::get_or_create_session(&state.db, user_id, agent.id, req.session_id).await?;

    // Save user message with agent linkage
    sqlx::query(
        r#"
        INSERT INTO chat_messages (user_id, session_id, role, content, agent_id, agent_session_id)
        VALUES ($1, $2, 'user', $3, $4, $5)
        "#,
    )
    .bind(user_id)
    .bind(session_id)
    .bind(&req.message)
    .bind(agent.id)
    .bind(session_id)
    .execute(&state.db)
    .await
    .map_err(|e| CloudError::Internal(format!("failed to save message: {e}")))?;

    // Load agent session history
    let history = sqlx::query_as::<_, (String, String)>(
        r#"
        SELECT role, content FROM chat_messages
        WHERE agent_session_id = $1
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

    // Check if agent has wallet tool enabled and user has a wallet
    let use_wallet_tools = agent.tools.iter().any(|t| t == "wallet") && {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM user_wallets WHERE user_id = $1)",
        )
        .bind(user_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(false)
    };

    // Create escrow + job
    let estimated_cost = 100i64; // 100 micro-USDC
    let escrow_id =
        compute_service::create_escrow(&state.db, user_id, Some(agent.provider_id), estimated_cost)
            .await?;
    let job_id = compute_service::create_job(
        &state.db,
        user_id,
        agent.provider_id,
        escrow_id,
        &agent.model_id,
    )
    .await?;

    // Link job to agent
    sqlx::query("UPDATE compute_jobs SET agent_id = $1 WHERE id = $2")
        .bind(agent.id)
        .bind(job_id)
        .execute(&state.db)
        .await?;

    // If wallet tools requested, use non-streaming tool-use path
    if use_wallet_tools {
        let tools = wallet_service::wallet_tool_definitions();
        let agent_name = agent.display_name.clone();
        let agent_id = agent.id;
        let system_prompt = agent.system_prompt.clone();
        let db = state.db.clone();
        let state_clone = state.clone();
        let usage_receipt_secret = state.config.usage_receipt_secret.clone();

        let sse_stream: SseStream = Box::pin(async_stream::stream! {
            // Send session + agent info
            yield Ok(Event::default()
                .event("session")
                .data(serde_json::json!({
                    "session_id": session_id,
                    "agent_id": agent_id,
                    "agent_name": &agent_name,
                }).to_string()));

            match llm_router::generate_with_tools(&state_clone, user_id, &messages, Some(&system_prompt), &tools).await {
                Ok(result) => {
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

                    if !result.text.is_empty() {
                        yield Ok(Event::default()
                            .event("text_delta")
                            .data(serde_json::json!({ "text": &result.text }).to_string()));

                        let _ = sqlx::query(
                            "INSERT INTO chat_messages (user_id, session_id, role, content, agent_id, agent_session_id) VALUES ($1, $2, 'assistant', $3, $4, $5)",
                        )
                        .bind(user_id)
                        .bind(session_id)
                        .bind(&result.text)
                        .bind(agent_id)
                        .bind(session_id)
                        .execute(&db)
                        .await;
                    }

                    // Settle escrow
                    let est_output = (result.text.len() as i64 / 4).max(1);
                    let _ = compute_service::complete_job(&db, job_id, 500, est_output, 0, 0.8).await;
                    if let Ok(ref settlement) = compute_service::settle_escrow(
                        &db,
                        &usage_receipt_secret,
                        escrow_id,
                        500,
                        est_output,
                        price_input,
                        price_output,
                    ).await {
                        let _ = agent_service::increment_agent_stats(&db, agent_id, session_id, settlement.provider_amount).await;
                        let _ = compute_service::update_daily_stats(&db, agent.provider_id, true, 500 + est_output, settlement.provider_amount, 0.0).await;
                    }
                    let _ = compute_service::update_reputation(&db, agent.provider_id, true, None).await;
                }
                Err(e) => {
                    let friendly = friendly_llm_error(&e);
                    tracing::warn!("agent chat tool-use error for user {user_id}: {e}");
                    yield Ok(Event::default()
                        .event("error")
                        .data(serde_json::json!({ "error": friendly }).to_string()));
                    let _ = compute_service::fail_job(&db, job_id, "tool-use error").await;
                    let _ = compute_service::refund_escrow(&db, escrow_id).await;
                }
            }

            yield Ok(Event::default()
                .event("done")
                .data(serde_json::json!({ "session_id": session_id }).to_string()));
        });

        return Ok(Sse::new(sse_stream));
    }

    // Standard streaming path via relay
    let inference_msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();
    let messages_json = serde_json::Value::Array(inference_msgs);

    let max_tokens = agent.max_tokens as u32;
    let system_prompt = agent.system_prompt.clone();
    let agent_name = agent.display_name.clone();
    let agent_model = agent.model_id.clone();
    let agent_id = agent.id;
    let provider_id = agent.provider_id;
    let db = state.db.clone();
    let usage_receipt_secret = state.config.usage_receipt_secret.clone();

    let stream_result = compute_service::dispatch_inference_stream(
        &state,
        &relay_pubkey,
        &messages_json,
        Some(&system_prompt),
        &agent_model,
        max_tokens,
        &job_id.to_string(),
    )
    .await;

    let sse_stream: SseStream = Box::pin(async_stream::stream! {
        let mut full_response = String::new();

        // Send session + agent info
        yield Ok(Event::default()
            .event("session")
            .data(serde_json::json!({
                "session_id": session_id,
                "agent_id": agent_id,
                "agent_name": &agent_name,
            }).to_string()));

        // Emit provider info
        yield Ok(Event::default()
            .event("provider")
            .data(serde_json::json!({
                "type": "agent",
                "model": &agent_model,
                "agent_name": &agent_name,
            }).to_string()));

        match stream_result {
            Ok(text_stream) => {
                let mut pinned = std::pin::Pin::from(text_stream);
                while let Some(result) = futures::StreamExt::next(&mut pinned).await {
                    match result {
                        Ok(text) => {
                            full_response.push_str(&text);
                            yield Ok(Event::default()
                                .event("text_delta")
                                .data(serde_json::json!({ "text": text }).to_string()));
                        }
                        Err(e) => {
                            let friendly = friendly_llm_error(&e);
                            tracing::warn!("agent chat stream error for user {user_id}: {e}");
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
                tracing::warn!("agent chat dispatch error for user {user_id}: {e}");
                yield Ok(Event::default()
                    .event("error")
                    .data(serde_json::json!({ "error": friendly }).to_string()));
            }
        }

        yield Ok(Event::default()
            .event("done")
            .data(serde_json::json!({ "session_id": session_id }).to_string()));

        // Post-stream: save response + settle
        if !full_response.is_empty() {
            let _ = sqlx::query(
                "INSERT INTO chat_messages (user_id, session_id, role, content, agent_id, agent_session_id) VALUES ($1, $2, 'assistant', $3, $4, $5)",
            )
            .bind(user_id)
            .bind(session_id)
            .bind(&full_response)
            .bind(agent_id)
            .bind(session_id)
            .execute(&db)
            .await;

            let est_output = (full_response.len() as i64 / 4).max(1);
            let est_input = 500i64;

            let _ = compute_service::complete_job(&db, job_id, est_input, est_output, 0, 0.8).await;
            if let Ok(ref settlement) = compute_service::settle_escrow(
                &db,
                &usage_receipt_secret,
                escrow_id,
                est_input,
                est_output,
                price_input,
                price_output,
            ).await {
                let _ = agent_service::increment_agent_stats(&db, agent_id, session_id, settlement.provider_amount).await;
                let _ = compute_service::update_daily_stats(
                    &db, provider_id, true,
                    est_input + est_output, settlement.provider_amount, 0.0,
                ).await;
            }
            let _ = compute_service::update_reputation(&db, provider_id, true, None).await;
        } else {
            let _ = compute_service::fail_job(&db, job_id, "empty response").await;
            let _ = compute_service::refund_escrow(&db, escrow_id).await;
            let _ = compute_service::update_reputation(&db, provider_id, false, None).await;
        }
    });

    Ok(Sse::new(sse_stream))
}
