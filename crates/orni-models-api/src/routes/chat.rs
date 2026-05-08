use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::stream::Stream;
use futures::StreamExt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::{AppError, AppResult};
use crate::services::inference::InferenceService;
use crate::state::AppState;
use orni_models_types::{
    ChatMessage, ChatRequest, ChatRole, ChatSession, InferenceChatMessage, Model, ModelStatus,
    SessionSummary, UsageResponse,
};

pub async fn send_message(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Path(slug): Path<String>,
    Json(req): Json<ChatRequest>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, axum::Error>>>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Get model
    let model = sqlx::query_as::<_, Model>("SELECT * FROM models WHERE slug = $1 AND status = $2")
        .bind(&slug)
        .bind(ModelStatus::Live)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Model not found or not live".into()))?;

    let self_hosted_endpoint = model.self_hosted_endpoint.clone();
    let base_model = model.base_model.clone();

    let provider_model_id = match model.provider_model_id.as_ref() {
        Some(id) => id.clone(),
        None if self_hosted_endpoint.is_some() => base_model.clone(),
        None => return Err(AppError::Internal("Model has no provider model ID".into())),
    };

    // Check free tier
    let mut is_free_query = false;
    if model.free_queries_per_day > 0 {
        let usage: Option<i32> = sqlx::query_scalar(
            "SELECT query_count FROM free_query_usage WHERE user_id = $1 AND model_id = $2 AND query_date = CURRENT_DATE",
        )
        .bind(user_id)
        .bind(model.id)
        .fetch_optional(&state.db)
        .await?;

        let used = usage.unwrap_or(0);
        if used < model.free_queries_per_day {
            is_free_query = true;
        }
    }

    // Atomic multi-currency debit. Tries the platform's primary stablecoin
    // first, falls back to other accepted (non-paused) currencies. The chosen
    // currency tags the payment row and the creator's settlement queue entry,
    // so creators are paid in whatever currency the user spent.
    let payment_currency = if !is_free_query {
        let (currency, _new_balance) = crate::services::balances::debit_preferred(
            &state.db,
            &state.config,
            user_id,
            model.price_per_query,
            None,
        )
        .await?;
        Some(currency)
    } else {
        None
    };

    // Get or create session — if no session_id provided, create a new one
    let session_id = if let Some(sid) = req.session_id {
        // Verify session belongs to user
        let session = sqlx::query_as::<_, ChatSession>(
            "SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2",
        )
        .bind(sid)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Session not found".into()))?;
        session.id
    } else {
        let session = sqlx::query_as::<_, ChatSession>(
            "INSERT INTO chat_sessions (id, user_id, model_id) VALUES ($1, $2, $3) RETURNING *",
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(model.id)
        .fetch_one(&state.db)
        .await?;
        session.id
    };

    // Sanitize user input (prompt injection defense)
    let (sanitized_message, _injection_detected) = crate::security::sanitize_chat_input(&req.message);

    // Save user message
    sqlx::query(
        "INSERT INTO chat_messages (id, session_id, role, content) VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(session_id)
    .bind(ChatRole::User)
    .bind(&sanitized_message)
    .execute(&state.db)
    .await?;

    if is_free_query {
        // Increment free usage counter
        sqlx::query(
            r#"INSERT INTO free_query_usage (user_id, model_id, query_date, query_count)
            VALUES ($1, $2, CURRENT_DATE, 1)
            ON CONFLICT (user_id, model_id, query_date) DO UPDATE SET query_count = free_query_usage.query_count + 1"#,
        )
        .bind(user_id)
        .bind(model.id)
        .execute(&state.db)
        .await?;

        // Update model query count (no revenue for free queries)
        sqlx::query("UPDATE models SET total_queries = total_queries + 1 WHERE id = $1")
            .bind(model.id)
            .execute(&state.db)
            .await?;
    } else {
        // Balance already deducted atomically above — just record the payment.
        let currency = payment_currency.as_deref().unwrap_or(&state.config.primary_token);

        let platform_share =
            model.price_per_query * state.config.platform_share_bps as i64 / 10_000;
        let creator_share = model.price_per_query - platform_share;

        sqlx::query(
            "INSERT INTO payments (id, user_id, model_id, amount, creator_share, platform_share, currency) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(model.id)
        .bind(model.price_per_query)
        .bind(creator_share)
        .bind(platform_share)
        .bind(currency)
        .execute(&state.db)
        .await?;

        // Credit creator in the same currency the user paid with.
        crate::services::balances::credit(
            &state.db,
            model.creator_id,
            currency,
            creator_share,
        )
        .await?;

        sqlx::query(
            "UPDATE models SET total_queries = total_queries + 1, total_revenue = total_revenue + $1 WHERE id = $2",
        )
        .bind(model.price_per_query)
        .bind(model.id)
        .execute(&state.db)
        .await?;

        let creator_wallet: Option<String> = sqlx::query_scalar(
            "SELECT wallet_address FROM users WHERE id = $1",
        )
        .bind(model.creator_id)
        .fetch_optional(&state.db)
        .await?
        .flatten();

        if let Some(ref wallet) = creator_wallet {
            sqlx::query(
                "INSERT INTO settlement_queue (id, creator_id, creator_wallet, amount_micro_usdc, currency) VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(Uuid::new_v4())
            .bind(model.creator_id)
            .bind(wallet)
            .bind(creator_share)
            .bind(currency)
            .execute(&state.db)
            .await
            .ok();
        }

        // If model uses self-hosted node, record payment with SAID cloud
        if let Some(node_id) = model.self_hosted_node_id {
            let said_url = state.config.said_cloud_url.clone();
            let http = state.http_client.clone();
            let price = model.price_per_query;
            let node_share = price * 80 / 100;
            let creator_share_amount = price * 5 / 100;
            let platform_share_amount = price * 15 / 100;

            tokio::spawn(async move {
                let _ = http
                    .post(format!("{}/v1/nodes/{}/payment", said_url, node_id))
                    .json(&serde_json::json!({
                        "amount_micro_usdc": price,
                        "node_share_micro_usdc": node_share,
                        "creator_share_micro_usdc": creator_share_amount,
                        "platform_share_micro_usdc": platform_share_amount,
                    }))
                    .send()
                    .await;
            });
        }
    }

    // Build message history
    let history = sqlx::query_as::<_, ChatMessage>(
        "SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT 50",
    )
    .bind(session_id)
    .fetch_all(&state.db)
    .await?;

    let mut messages = vec![InferenceChatMessage {
        role: "system".into(),
        content: model.system_prompt.clone(),
    }];

    for msg in &history {
        messages.push(InferenceChatMessage {
            role: match msg.role {
                ChatRole::System => "system".into(),
                ChatRole::User => "user".into(),
                ChatRole::Assistant => "assistant".into(),
            },
            content: msg.content.clone(),
        });
    }

    // Stream inference response
    let (tx, rx) = mpsc::channel::<String>(32);
    let inference = InferenceService::new(&state.config, &state.http_client);
    let db = state.db.clone();

    // Spawn inference task with failover
    let said_cloud_url = state.config.said_cloud_url.clone();
    let http_for_resolve = state.http_client.clone();

    tokio::spawn(async move {
        let mut full_response = String::new();
        let (content_tx, mut content_rx) = mpsc::channel::<String>(32);

        let inference_messages = messages.clone();
        let inference_handle = tokio::spawn(async move {
            // Try node pool failover
            let resolver = crate::services::node_resolver::NodeResolver::new(
                &http_for_resolve,
                &said_cloud_url,
            );

            // Resolve model identifier for node lookup
            let model_identifier = provider_model_id.clone();
            let nodes = resolver.resolve(&model_identifier).await;

            // Try each resolved node
            for node in &nodes {
                match inference
                    .try_connect_self_hosted(&node.endpoint_url, &model_identifier, &inference_messages)
                    .await
                {
                    Ok(response) => {
                        tracing::info!(node_id = %node.id, endpoint = %node.endpoint_url, "Connected to pool node");
                        return InferenceService::stream_response(response, content_tx).await;
                    }
                    Err(e) => {
                        tracing::warn!(node_id = %node.id, endpoint = %node.endpoint_url, error = %e, "Pool node failed, trying next");
                    }
                }
            }

            // Try the model's own self-hosted endpoint (if set and not already tried via pool)
            if let Some(ref endpoint) = self_hosted_endpoint {
                match inference
                    .try_connect_self_hosted(endpoint, &provider_model_id, &inference_messages)
                    .await
                {
                    Ok(response) => {
                        tracing::info!(endpoint = %endpoint, "Connected to model's self-hosted endpoint");
                        return InferenceService::stream_response(response, content_tx).await;
                    }
                    Err(e) => {
                        tracing::warn!(endpoint = %endpoint, error = %e, "Model's self-hosted endpoint failed");
                    }
                }
            }

            // Fall back to Together.ai
            tracing::info!("All self-hosted nodes failed, falling back to Together.ai");
            inference
                .chat_stream(&provider_model_id, inference_messages, content_tx)
                .await
        });

        while let Some(chunk) = content_rx.recv().await {
            full_response.push_str(&chunk);
            let _ = tx.send(chunk).await;
        }

        let _ = inference_handle.await;

        // Save assistant response
        if !full_response.is_empty() {
            let _ = sqlx::query(
                "INSERT INTO chat_messages (id, session_id, role, content) VALUES ($1, $2, $3, $4)",
            )
            .bind(Uuid::new_v4())
            .bind(session_id)
            .bind(ChatRole::Assistant)
            .bind(&full_response)
            .execute(&db)
            .await;
        }
    });

    // Convert to SSE stream — send session_id in first event
    let sid = session_id;
    let mut first = true;
    let stream = ReceiverStream::new(rx).map(move |content| {
        let mut data = serde_json::json!({ "content": content });
        if first {
            data["session_id"] = serde_json::json!(sid);
            first = false;
        }
        Ok(Event::default()
            .event("message")
            .json_data(data)
            .unwrap())
    });

    Ok(Sse::new(stream))
}

/// GET /api/chat/sessions — List user's chat sessions
pub async fn list_sessions(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
) -> AppResult<Json<Vec<SessionSummary>>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let sessions = sqlx::query_as::<_, SessionSummary>(
        r#"
        SELECT
            cs.id, cs.model_id,
            m.name as model_name, m.slug as model_slug,
            (SELECT content FROM chat_messages WHERE session_id = cs.id ORDER BY created_at DESC LIMIT 1) as last_message,
            (SELECT COUNT(*) FROM chat_messages WHERE session_id = cs.id) as message_count,
            cs.created_at, cs.updated_at
        FROM chat_sessions cs
        JOIN models m ON m.id = cs.model_id
        WHERE cs.user_id = $1
        ORDER BY cs.updated_at DESC
        LIMIT 50
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(sessions))
}

/// GET /api/chat/sessions/{id}/messages — Load full chat history
pub async fn get_session_messages(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Vec<ChatMessage>>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    // Verify session belongs to user
    let _session = sqlx::query_as::<_, ChatSession>(
        "SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Session not found".into()))?;

    let messages = sqlx::query_as::<_, ChatMessage>(
        "SELECT * FROM chat_messages WHERE session_id = $1 AND role != 'system' ORDER BY created_at ASC",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(messages))
}

/// GET /api/chat/{slug}/usage — Get free tier usage for a model
pub async fn get_usage(
    State(state): State<Arc<AppState>>,
    claims: axum::Extension<Claims>,
    Path(slug): Path<String>,
) -> AppResult<Json<UsageResponse>> {
    let user_id: Uuid = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("Invalid token".into()))?;

    let model = sqlx::query_as::<_, Model>("SELECT * FROM models WHERE slug = $1")
        .bind(&slug)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Model not found".into()))?;

    if model.free_queries_per_day == 0 {
        return Ok(Json(UsageResponse {
            used: 0,
            limit: 0,
            is_free: false,
        }));
    }

    let usage: Option<i32> = sqlx::query_scalar(
        "SELECT query_count FROM free_query_usage WHERE user_id = $1 AND model_id = $2 AND query_date = CURRENT_DATE",
    )
    .bind(user_id)
    .bind(model.id)
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(UsageResponse {
        used: usage.unwrap_or(0),
        limit: model.free_queries_per_day,
        is_free: true,
    }))
}
