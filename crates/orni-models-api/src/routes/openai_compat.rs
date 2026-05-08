use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::stream::Stream;
use futures::StreamExt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;

use axum::response::IntoResponse;
use crate::error::{AppError, AppResult};
use crate::services::inference::InferenceService;
use crate::services::x402_facilitator::X402Client;
use crate::state::AppState;
use orni_models_types::{InferenceChatMessage, Model, ModelStatus, OpenAIChatRequest};

/// POST /v1/chat/completions — OpenAI-compatible chat endpoint
///
/// Auth methods (in priority order):
/// 1. x402 payment proof via `X-Payment` header (agent-to-agent, no account needed)
/// 2. Bearer API key (orn_...) for registered users
///
/// If neither is provided and the model requires payment, returns HTTP 402
/// with x402-compliant `payment-required` header containing USDC payment instructions.
pub async fn chat_completions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Result<Json<OpenAIChatRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    match chat_completions_inner(state, headers, body).await {
        Ok(sse) => sse.into_response(),
        Err(err) => err.into_response(),
    }
}

async fn chat_completions_inner(
    state: Arc<AppState>,
    headers: HeaderMap,
    body: Result<Json<OpenAIChatRequest>, axum::extract::rejection::JsonRejection>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, axum::Error>>>> {
    // If JSON parsing fails (no body, wrong content-type, etc), return x402 payment required
    let Json(req) = match body {
        Ok(json) => json,
        Err(_) => {
            return Err(AppError::X402PaymentRequired {
                pay_to: state.config.escrow_wallet_address.clone(),
                amount_micro_usdc: 50000,
                model_slug: "any".into(),
                model_name: "AI Model".into(),
            });
        }
    };
    // ── Resolve the model first (needed for pricing in 402 response) ──
    let model = sqlx::query_as::<_, Model>(
        "SELECT * FROM models WHERE (slug = $1 OR base_model = $1 OR provider_model_id = $1) AND status = $2",
    )
    .bind(&req.model)
    .bind(ModelStatus::Live)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::X402PaymentRequired {
        pay_to: state.config.escrow_wallet_address.clone(),
        amount_micro_usdc: 50000,
        model_slug: req.model.clone(),
        model_name: req.model.clone(),
    })?;

    // ── x402 payment proof: verify + settle via the configured facilitator ──
    //
    // The X-Payment header carries a base64-encoded JSON payment payload.
    // We never trust it on its own — the facilitator (default x402.org) confirms
    // the on-chain transfer satisfies the requirements before we grant service.
    //
    // x402_enabled defaults to false. Re-enabling requires a reachable
    // facilitator (env: X402_FACILITATOR_URL). Failures here always reject —
    // we don't grant free inference on facilitator outages.
    let mut x402_paid = false;

    if state.config.x402_enabled {
        if let Some(payment_header) = headers.get("x-payment").and_then(|v| v.to_str().ok()) {
            // Build accepts-array entries — one per non-paused stablecoin.
            // Ordered so the platform's primary stablecoin is first; agents
            // SHOULD pick the first they can pay in.
            let accepts: Vec<serde_json::Value> = state
                .config
                .accepted_tokens
                .iter()
                .filter(|t| !t.paused)
                .map(|t| serde_json::json!({
                    "scheme": "exact",
                    "network": state.config.x402_network,
                    "asset": &t.mint_b58,
                    "currency_symbol": &t.symbol,
                    "decimals": t.decimals,
                    "amount": model.price_per_query.to_string(),
                    "payTo": state.config.escrow_wallet_address,
                    "maxTimeoutSeconds": 60,
                    "resource": {
                        "url": "/v1/chat/completions",
                        "description": format!("Inference on {}", model.name),
                        "mimeType": "text/event-stream"
                    },
                    "extra": {
                        "platform": "ghola.xyz",
                        "model": model.slug,
                    }
                }))
                .collect();
            // Backwards-compatible: keep the historical `requirements` shape
            // pointing at the primary token, but expose the full list under
            // `requirements.accepts` for multi-mint-aware clients.
            let primary = accepts
                .first()
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let requirements = serde_json::json!({
                "scheme": "exact",
                "network": state.config.x402_network,
                "asset": &state.config.usdc_mint,
                "currency_symbol": &state.config.primary_token,
                "amount": model.price_per_query.to_string(),
                "payTo": state.config.escrow_wallet_address,
                "maxTimeoutSeconds": 60,
                "accepts": accepts,
                "primary": primary,
                "resource": {
                    "url": "/v1/chat/completions",
                    "description": format!("Inference on {}", model.name),
                    "mimeType": "text/event-stream"
                },
                "extra": {
                    "platform": "ghola.xyz",
                    "model": model.slug,
                }
            });

            let client = X402Client::new(
                state.http_client.clone(),
                state.config.x402_facilitator_url.clone(),
            );

            match client.verify(payment_header, &requirements).await {
                Ok(v) if v.is_valid => match client.settle(payment_header, &requirements).await {
                    Ok(s) if s.success => {
                        tracing::info!(
                            model = %model.slug,
                            payer = ?s.payer,
                            tx = ?s.transaction,
                            "x402 settled"
                        );
                        x402_paid = true;
                    }
                    Ok(s) => {
                        tracing::warn!(
                            model = %model.slug,
                            reason = ?s.error_reason,
                            "x402 settle failed"
                        );
                        return Err(AppError::X402PaymentRequired {
                            pay_to: state.config.escrow_wallet_address.clone(),
                            amount_micro_usdc: model.price_per_query,
                            model_slug: model.slug.clone(),
                            model_name: model.name.clone(),
                        });
                    }
                    Err(e) => {
                        tracing::warn!(model = %model.slug, error = ?e, "x402 settle error");
                        return Err(AppError::X402PaymentRequired {
                            pay_to: state.config.escrow_wallet_address.clone(),
                            amount_micro_usdc: model.price_per_query,
                            model_slug: model.slug.clone(),
                            model_name: model.name.clone(),
                        });
                    }
                },
                Ok(v) => {
                    tracing::warn!(
                        model = %model.slug,
                        reason = ?v.invalid_reason,
                        "x402 payment rejected"
                    );
                    return Err(AppError::X402PaymentRequired {
                        pay_to: state.config.escrow_wallet_address.clone(),
                        amount_micro_usdc: model.price_per_query,
                        model_slug: model.slug.clone(),
                        model_name: model.name.clone(),
                    });
                }
                Err(e) => {
                    tracing::warn!(model = %model.slug, error = ?e, "x402 verify error");
                    return Err(AppError::X402PaymentRequired {
                        pay_to: state.config.escrow_wallet_address.clone(),
                        amount_micro_usdc: model.price_per_query,
                        model_slug: model.slug.clone(),
                        model_name: model.name.clone(),
                    });
                }
            }
        }
    }

    // ── Auth: x402 short-circuits, otherwise standard API-key flow ──
    // Tuple: (user_id, model_id, is_free_query, payment_currency).
    // payment_currency is the symbol the user's balance was debited in
    // (None for x402-paid agents and for free-tier queries).
    let (user_id, _model_id, is_free_query, payment_currency) = if x402_paid {
        // The agent already paid on-chain; no account needed.
        (None, model.id, false, None)
    } else {
        // Require API key
        let auth_header = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                // No auth at all — return x402 payment instructions
                AppError::X402PaymentRequired {
                    pay_to: state.config.escrow_wallet_address.clone(),
                    amount_micro_usdc: model.price_per_query,
                    model_slug: model.slug.clone(),
                    model_name: model.name.clone(),
                }
            })?;

        let api_key = auth_header
            .strip_prefix("Bearer ")
            .ok_or_else(|| AppError::Unauthorized("Invalid Authorization format".into()))?;

        // Hash the key and look it up
        use sha2::{Digest, Sha256};
        let key_hash = hex::encode(Sha256::digest(api_key.as_bytes()));

        let key_record = sqlx::query_as::<_, (Uuid, Uuid, Uuid)>(
            "SELECT id, user_id, model_id FROM api_keys WHERE key_hash = $1 AND is_active = true",
        )
        .bind(&key_hash)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::Unauthorized("Invalid API key".into()))?;

        let (key_id, uid, _key_model_id) = key_record;

        // Update last_used_at
        sqlx::query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1")
            .bind(key_id)
            .execute(&state.db)
            .await?;

        // Check free tier
        let mut is_free = false;
        if model.free_queries_per_day > 0 {
            let usage: Option<i32> = sqlx::query_scalar(
                "SELECT query_count FROM free_query_usage WHERE user_id = $1 AND model_id = $2 AND query_date = CURRENT_DATE",
            )
            .bind(uid)
            .bind(model.id)
            .fetch_optional(&state.db)
            .await?;

            if usage.unwrap_or(0) < model.free_queries_per_day {
                is_free = true;
            }
        }

        // Pre-charge budget check (daily/monthly/total caps) before the
        // debit. If the user would breach a cap, return 402 with structured
        // detail so the client can render "you've hit your daily limit"
        // rather than failing mid-request after a partial charge.
        if !is_free {
            crate::services::budgets::check_or_reject(&state.db, uid, model.price_per_query).await?;
        }

        // Atomic multi-currency debit (prevents double-spending). Tries
        // primary stablecoin first, falls back to other accepted currencies.
        let chosen_currency = if !is_free {
            match crate::services::balances::debit_preferred(
                &state.db,
                &state.config,
                uid,
                model.price_per_query,
                None,
            )
            .await
            {
                Ok((currency, _new_balance)) => Some(currency),
                Err(AppError::InsufficientBalance) => {
                    return Err(AppError::X402PaymentRequired {
                        pay_to: state.config.escrow_wallet_address.clone(),
                        amount_micro_usdc: model.price_per_query,
                        model_slug: model.slug.clone(),
                        model_name: model.name.clone(),
                    });
                }
                Err(other) => return Err(other),
            }
        } else {
            None
        };

        (Some(uid), model.id, is_free, chosen_currency)
    };

    // ── Charge user (skip for x402 — they already paid on-chain) ──
    if let Some(uid) = user_id {
        if is_free_query {
            sqlx::query(
                r#"INSERT INTO free_query_usage (user_id, model_id, query_date, query_count)
                VALUES ($1, $2, CURRENT_DATE, 1)
                ON CONFLICT (user_id, model_id, query_date) DO UPDATE SET query_count = free_query_usage.query_count + 1"#,
            )
            .bind(uid)
            .bind(model.id)
            .execute(&state.db)
            .await?;

            sqlx::query("UPDATE models SET total_queries = total_queries + 1 WHERE id = $1")
                .bind(model.id)
                .execute(&state.db)
                .await?;
        } else {
            // Balance already deducted atomically above
            let currency = payment_currency.as_deref().unwrap_or(&state.config.primary_token);

            let platform_share =
                model.price_per_query * state.config.platform_share_bps as i64 / 10_000;
            let creator_share = model.price_per_query - platform_share;

            sqlx::query(
                "INSERT INTO payments (id, user_id, model_id, amount, creator_share, platform_share, currency) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(Uuid::new_v4())
            .bind(uid)
            .bind(model.id)
            .bind(model.price_per_query)
            .bind(creator_share)
            .bind(platform_share)
            .bind(currency)
            .execute(&state.db)
            .await?;

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
        }
    } else {
        // x402 payment — just count the query
        sqlx::query("UPDATE models SET total_queries = total_queries + 1, total_revenue = total_revenue + $1 WHERE id = $2")
            .bind(model.price_per_query)
            .bind(model.id)
            .execute(&state.db)
            .await?;
    }

    // ── Build messages ──
    let self_hosted_endpoint = model.self_hosted_endpoint.clone();
    let base_model = model.base_model.clone();
    let provider_model_id = match model.provider_model_id.as_ref() {
        Some(id) => id.clone(),
        None if self_hosted_endpoint.is_some() => base_model.clone(),
        None => return Err(AppError::Internal("Model has no provider model ID".into())),
    };

    let mut messages = vec![InferenceChatMessage {
        role: "system".into(),
        content: model.system_prompt.clone(),
    }];
    for msg in &req.messages {
        if msg.role != "system" {
            messages.push(msg.clone());
        }
    }

    // ── Stream inference ──
    let (tx, rx) = mpsc::channel::<String>(32);
    let inference = InferenceService::new(&state.config, &state.http_client);

    let said_cloud_url = state.config.said_cloud_url.clone();
    let http_for_resolve = state.http_client.clone();
    let model_id_str = format!("{}", req.model);

    tokio::spawn(async move {
        let (content_tx, mut content_rx) = mpsc::channel::<String>(32);

        let inference_messages = messages.clone();
        let _inference_handle = tokio::spawn(async move {
            let resolver = crate::services::node_resolver::NodeResolver::new(
                &http_for_resolve,
                &said_cloud_url,
            );
            let nodes = resolver.resolve(&provider_model_id).await;

            for node in &nodes {
                match inference
                    .try_connect_self_hosted(
                        &node.endpoint_url,
                        &provider_model_id,
                        &inference_messages,
                    )
                    .await
                {
                    Ok(response) => {
                        return InferenceService::stream_response(response, content_tx).await;
                    }
                    Err(_) => continue,
                }
            }

            if let Some(ref endpoint) = self_hosted_endpoint {
                match inference
                    .try_connect_self_hosted(endpoint, &provider_model_id, &inference_messages)
                    .await
                {
                    Ok(response) => {
                        return InferenceService::stream_response(response, content_tx).await;
                    }
                    Err(_) => {}
                }
            }

            inference
                .chat_stream(&provider_model_id, inference_messages, content_tx)
                .await
        });

        while let Some(chunk) = content_rx.recv().await {
            let _ = tx.send(chunk).await;
        }
    });

    // ── Stream in OpenAI SSE format with x402 pricing headers ──
    let stream = ReceiverStream::new(rx).map(move |content| {
        Ok(Event::default().data(
            serde_json::to_string(&serde_json::json!({
                "id": format!("chatcmpl-{}", Uuid::new_v4()),
                "object": "chat.completion.chunk",
                "model": model_id_str,
                "choices": [{
                    "index": 0,
                    "delta": { "content": content },
                    "finish_reason": null
                }]
            }))
            .unwrap_or_default(),
        ))
    });

    Ok(Sse::new(stream))
}

/// GET /v1/chat/completions — x402 discovery endpoint
///
/// Returns HTTP 402 with payment-required header so x402scan and other
/// discovery services can index this endpoint as an x402-compatible resource.
pub async fn x402_discovery(
    State(state): State<Arc<AppState>>,
) -> Response {
    use axum::response::IntoResponse;
    use base64::{engine::general_purpose::STANDARD, Engine};

    let pay_to = &state.config.escrow_wallet_address;

    // One accepts entry per non-paused stablecoin. Primary token is listed first
    // so agents reading `accepts[0]` get the platform default.
    let accepts: Vec<serde_json::Value> = state
        .config
        .accepted_tokens
        .iter()
        .filter(|t| !t.paused)
        .map(|t| serde_json::json!({
            "scheme": "exact",
            "network": state.config.x402_network,
            "amount": "50000",
            "asset": &t.mint_b58,
            "currency_symbol": &t.symbol,
            "decimals": t.decimals,
            "payTo": pay_to,
            "maxTimeoutSeconds": 60,
            "resource": {
                "url": "/v1/chat/completions",
                "description": "AI model inference on ghola.xyz — chat with any open-source model",
                "mimeType": "text/event-stream"
            },
            "extra": {
                "platform": "ghola.xyz",
                "models": ["llama-3-8b", "llama-3-70b", "qwen-32b", "deepseek-r1-120b", "kimi-k2"]
            }
        }))
        .collect();

    let x402_payload = serde_json::json!({
        "x402Version": 2,
        "accepts": accepts,
    });

    let encoded = STANDARD.encode(serde_json::to_vec(&x402_payload).unwrap_or_default());

    let body = axum::Json(x402_payload.clone());
    let primary_symbol = state.config.primary_token.clone();

    (
        StatusCode::PAYMENT_REQUIRED,
        [
            ("payment-required", encoded.as_str()),
            ("x-price-micro-usdc", "50000"),
            ("x-currency", primary_symbol.as_str()),
            ("x-payment-address", pay_to.as_str()),
        ],
        body,
    )
        .into_response()
}

use axum::response::Response;
use axum::http::StatusCode;
