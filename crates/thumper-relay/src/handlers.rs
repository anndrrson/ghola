use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::sse::{Event, Sse};
use axum::response::IntoResponse;
use axum::Json;
use futures::stream::StreamExt;
use futures::SinkExt;
use serde_json::json;
use tokio::sync::mpsc;

use thumper_types::{
    AuthPayload, ConnectedDevice, ConnectedDevicesResult, ConnectionRole, Envelope,
    InferenceChatMessage, InferenceRequestPayload, MessageType, ProviderAdvertiseAck,
};

use crate::auth::verify_auth;
use crate::state::{AppState, RateLimiter};

/// Health check endpoint.
pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "devices": state.device_count(),
        "mcp_clients": state.mcp_client_count(),
        "gpu_providers": state.gpu_provider_count(),
    }))
}

/// Metrics endpoint — returns a JSON snapshot of relay metrics.
pub async fn metrics_handler(State(state): State<AppState>) -> impl IntoResponse {
    let snapshot = state.metrics().snapshot(
        state.device_count(),
        state.mcp_client_count(),
        state.gpu_provider_count(),
    );
    Json(snapshot)
}

/// Extract a static string name from a MessageType variant for metrics tracking.
fn message_type_name(msg: &MessageType) -> &'static str {
    match msg {
        MessageType::ReadScreen => "ReadScreen",
        MessageType::Tap(_) => "Tap",
        MessageType::TypeText(_) => "TypeText",
        MessageType::LaunchApp(_) => "LaunchApp",
        MessageType::PressBack => "PressBack",
        MessageType::Swipe(_) => "Swipe",
        MessageType::TakeScreenshot(_) => "TakeScreenshot",
        MessageType::LongPress(_) => "LongPress",
        MessageType::Scroll(_) => "Scroll",
        MessageType::GlobalAction(_) => "GlobalAction",
        MessageType::SetClipboard(_) => "SetClipboard",
        MessageType::GetClipboard => "GetClipboard",
        MessageType::GetDeviceInfo => "GetDeviceInfo",
        MessageType::ListInstalledApps => "ListInstalledApps",
        MessageType::WaitFor(_) => "WaitFor",
        MessageType::ExecuteFlow(_) => "ExecuteFlow",
        MessageType::ReadNotifications(_) => "ReadNotifications",
        MessageType::DismissNotification(_) => "DismissNotification",
        MessageType::ListConnectedDevices => "ListConnectedDevices",
        MessageType::ScreenState(_) => "ScreenState",
        MessageType::ActionResult(_) => "ActionResult",
        MessageType::Error(_) => "Error",
        MessageType::ScreenshotResult(_) => "ScreenshotResult",
        MessageType::ClipboardResult(_) => "ClipboardResult",
        MessageType::DeviceInfoResult(_) => "DeviceInfoResult",
        MessageType::InstalledAppsResult(_) => "InstalledAppsResult",
        MessageType::WaitForResult(_) => "WaitForResult",
        MessageType::FlowProgress(_) => "FlowProgress",
        MessageType::FlowResult(_) => "FlowResult",
        MessageType::NotificationsResult(_) => "NotificationsResult",
        MessageType::ConnectedDevicesResult(_) => "ConnectedDevicesResult",
        MessageType::InferenceRequest(_) => "InferenceRequest",
        MessageType::InferenceResponse(_) => "InferenceResponse",
        MessageType::InferenceStreamChunk(_) => "InferenceStreamChunk",
        MessageType::InferenceStreamEnd(_) => "InferenceStreamEnd",
        MessageType::ProviderHeartbeat(_) => "ProviderHeartbeat",
        MessageType::ProviderAdvertise(_) => "ProviderAdvertise",
        MessageType::ProviderAdvertiseAck(_) => "ProviderAdvertiseAck",
        MessageType::Ping => "Ping",
        MessageType::Pong => "Pong",
    }
}

/// WebSocket upgrade handler.
pub async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.max_message_size(state.config().max_message_size_bytes)
        .on_upgrade(move |socket| handle_ws(socket, state))
}

fn text_msg(s: String) -> Message {
    Message::Text(s.into())
}

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Handle WebSocket connection lifecycle.
async fn handle_ws(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Step 1: Authenticate
    let (auth_pubkey, role) = match ws_receiver.next().await {
        Some(Ok(Message::Text(text))) => match serde_json::from_str::<AuthPayload>(&text) {
            Ok(payload) => {
                let role = payload.message.role;
                match verify_auth(
                    &payload,
                    state.config().auth_timeout_secs,
                    state.config().dev_mode,
                    Some(state.nonce_cache()),
                ) {
                    Ok(pubkey) => (pubkey, role),
                    Err(e) => {
                        tracing::warn!("ws auth failed: {}", e);
                        let _ = ws_sender
                            .send(text_msg(json!({"error": e.to_string()}).to_string()))
                            .await;
                        return;
                    }
                }
            }
            Err(_) => {
                let _ = ws_sender
                    .send(text_msg(
                        json!({"error": "invalid auth payload"}).to_string(),
                    ))
                    .await;
                return;
            }
        },
        _ => return,
    };

    let _ = ws_sender
        .send(text_msg(
            json!({"authenticated": true, "role": role}).to_string(),
        ))
        .await;

    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Step 2: Register by role
    let device_pubkey_for_mcp: Option<String>;
    let last_activity: Arc<AtomicU64>;

    match role {
        ConnectionRole::Device => {
            tracing::info!(pubkey = %auth_pubkey, "device connected");
            last_activity = state.add_device(&auth_pubkey, tx.clone());
            device_pubkey_for_mcp = None;
        }
        ConnectionRole::McpClient => {
            // MCP client must send target device pubkey as second message
            let target = match ws_receiver.next().await {
                Some(Ok(Message::Text(text))) => {
                    #[derive(serde::Deserialize)]
                    struct DeviceTarget {
                        device_pubkey: String,
                    }
                    match serde_json::from_str::<DeviceTarget>(&text) {
                        Ok(t) => t.device_pubkey,
                        Err(_) => {
                            let _ = ws_sender
                                .send(text_msg(
                                    json!({"error": "expected device_pubkey"}).to_string(),
                                ))
                                .await;
                            return;
                        }
                    }
                }
                _ => return,
            };

            let connected = state.device_connected(&target);
            let _ = ws_sender
                .send(text_msg(
                    json!({"device_connected": connected, "device_pubkey": &target}).to_string(),
                ))
                .await;

            tracing::info!(
                mcp_pubkey = %auth_pubkey,
                device_pubkey = %target,
                device_online = connected,
                "mcp client connected"
            );
            last_activity = state.add_mcp_client(&auth_pubkey, tx.clone(), target.clone());
            device_pubkey_for_mcp = Some(target);
        }
        ConnectionRole::GpuProvider => {
            // GPU provider must send ProviderAdvertise as second message
            let advertise = match ws_receiver.next().await {
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<Envelope>(&text) {
                    Ok(env) => match env.message {
                        MessageType::ProviderAdvertise(adv) => adv,
                        _ => {
                            let _ = ws_sender
                                .send(text_msg(
                                    json!({"error": "expected ProviderAdvertise message"})
                                        .to_string(),
                                ))
                                .await;
                            return;
                        }
                    },
                    Err(_) => {
                        let _ = ws_sender
                            .send(text_msg(json!({"error": "invalid envelope"}).to_string()))
                            .await;
                        return;
                    }
                },
                _ => return,
            };

            tracing::info!(
                pubkey = %auth_pubkey,
                name = %advertise.name,
                models = advertise.models.len(),
                max_concurrent = advertise.max_concurrent,
                vram_mb = advertise.vram_mb,
                "gpu provider connected"
            );

            last_activity = state.add_gpu_provider(
                &auth_pubkey,
                tx.clone(),
                advertise.models,
                advertise.max_concurrent,
                advertise.wallet_address,
            );

            // Send ProviderAdvertiseAck
            let ack = Envelope::new(MessageType::ProviderAdvertiseAck(ProviderAdvertiseAck {
                accepted: true,
                message: Some("registered".to_string()),
            }));
            let _ = ws_sender
                .send(text_msg(serde_json::to_string(&ack).unwrap_or_default()))
                .await;

            device_pubkey_for_mcp = None;
        }
    }

    let mut rate_limiter = RateLimiter::new(state.config().rate_limit_per_second);

    // Spawn send task: mpsc → WebSocket
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Receive task: WebSocket → route
    let mut recv_task = tokio::spawn({
        let state = state.clone();
        let auth_pubkey_clone = auth_pubkey.clone();
        let role_clone = role;
        let device_target = device_pubkey_for_mcp.clone();
        let tx_clone = tx.clone();
        let last_activity = last_activity.clone();

        async move {
            while let Some(Ok(msg)) = ws_receiver.next().await {
                // Update activity timestamp on any received message
                last_activity.store(now_epoch_secs(), Ordering::Relaxed);

                let text = match msg {
                    Message::Text(t) => t.to_string(),
                    Message::Close(_) => break,
                    Message::Ping(data) => {
                        let _ = tx_clone.send(Message::Pong(data));
                        continue;
                    }
                    Message::Pong(_) => continue,
                    _ => continue,
                };

                if !rate_limiter.try_consume() {
                    let _ = tx_clone.send(text_msg(
                        json!({"error": "rate limit exceeded"}).to_string(),
                    ));
                    continue;
                }

                // Parse as Envelope
                let envelope: Envelope = match serde_json::from_str(&text) {
                    Ok(e) => e,
                    Err(e) => {
                        let _ = tx_clone.send(text_msg(
                            json!({"error": format!("invalid envelope: {}", e)}).to_string(),
                        ));
                        continue;
                    }
                };

                match role_clone {
                    ConnectionRole::McpClient => {
                        // Check if this is a relay-handled command
                        if let MessageType::ListConnectedDevices = &envelope.message {
                            let devices = state
                                .connected_devices_info()
                                .into_iter()
                                .map(|(pubkey, label)| ConnectedDevice { pubkey, label })
                                .collect();

                            let response = envelope.response(MessageType::ConnectedDevicesResult(
                                ConnectedDevicesResult { devices },
                            ));
                            let _ = tx_clone.send(text_msg(
                                serde_json::to_string(&response).unwrap_or_default(),
                            ));
                            continue;
                        }

                        // Record command in metrics
                        state
                            .metrics()
                            .record_command(message_type_name(&envelope.message));

                        // MCP client → device: forward command to the target device
                        if let Some(ref target) = device_target {
                            // Check per-device rate limit
                            if !state.check_device_rate_limit(target) {
                                let err_envelope = envelope.response(MessageType::Error(
                                    thumper_types::ErrorPayload {
                                        code: "device_rate_limited".into(),
                                        message: "rate limit exceeded for target device".into(),
                                    },
                                ));
                                state.metrics().record_error();
                                let _ = tx_clone.send(text_msg(
                                    serde_json::to_string(&err_envelope).unwrap_or_default(),
                                ));
                                continue;
                            }

                            let data = serde_json::to_vec(&envelope).unwrap_or_default();
                            if !state.send_to_device(target, &data) {
                                let err_envelope = envelope.response(MessageType::Error(
                                    thumper_types::ErrorPayload {
                                        code: "device_offline".into(),
                                        message: "target device is not connected".into(),
                                    },
                                ));
                                state.metrics().record_error();
                                let _ = tx_clone.send(text_msg(
                                    serde_json::to_string(&err_envelope).unwrap_or_default(),
                                ));
                            }
                        }
                    }
                    ConnectionRole::Device => {
                        // If the device sends a DeviceInfoResult, extract the label
                        if let MessageType::DeviceInfoResult(ref info) = envelope.message {
                            let label = format!(
                                "{} {} (Android {})",
                                info.manufacturer, info.model, info.android_version
                            );
                            state.set_device_label(&auth_pubkey_clone, label);
                        }

                        // Record errors from device responses
                        if let MessageType::Error(_) = &envelope.message {
                            state.metrics().record_error();
                        }

                        // Device → MCP client: forward response back
                        let data = serde_json::to_vec(&envelope).unwrap_or_default();
                        state.send_to_mcp_client_for_device(&auth_pubkey_clone, &data);
                    }
                    ConnectionRole::GpuProvider => {
                        match &envelope.message {
                            MessageType::ProviderHeartbeat(hb) => {
                                state.update_gpu_provider_heartbeat(
                                    &auth_pubkey_clone,
                                    hb.active_jobs,
                                    hb.models.clone(),
                                );
                            }
                            MessageType::InferenceResponse(resp) => {
                                let job_id = resp.job_id.clone();
                                state.resolve_pending_inference(&job_id, envelope);
                                state.decrement_gpu_provider_jobs(&auth_pubkey_clone);
                            }
                            MessageType::InferenceStreamChunk(chunk) => {
                                let job_id = chunk.job_id.clone();
                                if !state.send_to_pending_inference_stream(&job_id, envelope) {
                                    tracing::warn!(job_id = %job_id, "no pending stream for chunk");
                                }
                            }
                            MessageType::InferenceStreamEnd(end) => {
                                let job_id = end.job_id.clone();
                                // Send the end marker through the stream, then clean up
                                state.send_to_pending_inference_stream(&job_id, envelope);
                                state.remove_pending_inference_stream(&job_id);
                                state.decrement_gpu_provider_jobs(&auth_pubkey_clone);
                            }
                            _ => {
                                tracing::debug!(
                                    pubkey = %auth_pubkey_clone,
                                    msg_type = message_type_name(&envelope.message),
                                    "unexpected message from gpu provider"
                                );
                            }
                        }
                    }
                }
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    // Cleanup
    match role {
        ConnectionRole::Device => {
            state.remove_device(&auth_pubkey);
            tracing::info!(pubkey = %auth_pubkey, "device disconnected");
        }
        ConnectionRole::McpClient => {
            state.remove_mcp_client(&auth_pubkey);
            tracing::info!(pubkey = %auth_pubkey, "mcp client disconnected");
        }
        ConnectionRole::GpuProvider => {
            state.remove_gpu_provider(&auth_pubkey);
            tracing::info!(pubkey = %auth_pubkey, "gpu provider disconnected");
        }
    }
}

// -- REST inference dispatch endpoints --

/// Request body for inference dispatch endpoints.
#[derive(serde::Deserialize)]
pub struct InferenceDispatchRequest {
    pub provider_pubkey: String,
    pub job_id: String,
    pub model_id: String,
    pub messages: Vec<InferenceChatMessage>,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default = "default_dispatch_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub temperature: Option<f64>,
}

fn default_dispatch_max_tokens() -> u32 {
    2048
}

/// POST /inference — Cloud calls this to dispatch non-streaming inference.
pub async fn dispatch_inference(
    State(state): State<AppState>,
    Json(req): Json<InferenceDispatchRequest>,
) -> impl IntoResponse {
    // Check provider exists
    if state.gpu_provider_count() == 0 {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "no gpu providers connected"})),
        )
            .into_response();
    }

    // Check provider concurrency
    match state.gpu_provider_concurrency(&req.provider_pubkey) {
        None => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(json!({"error": "provider not found"})),
            )
                .into_response();
        }
        Some((active, max)) => {
            if active >= max {
                return (
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({
                        "error": "provider at capacity",
                        "active_jobs": active,
                        "max_concurrent": max,
                    })),
                )
                    .into_response();
            }
        }
    }

    // Create oneshot channel
    let (tx, rx) = tokio::sync::oneshot::channel::<Envelope>();
    state.register_pending_inference(&req.job_id, tx);

    // Increment active jobs
    state.increment_gpu_provider_jobs(&req.provider_pubkey);

    // Build InferenceRequest envelope — strip source so provider doesn't see caller identity
    let envelope = Envelope::new(MessageType::InferenceRequest(InferenceRequestPayload {
        job_id: req.job_id.clone(),
        model_id: req.model_id,
        messages: req.messages,
        system: req.system,
        max_tokens: req.max_tokens,
        stream: false,
        temperature: req.temperature,
    }));

    let data = serde_json::to_vec(&envelope).unwrap_or_default();
    if !state.send_to_gpu_provider(&req.provider_pubkey, &data) {
        // Clean up on send failure
        state.resolve_pending_inference(&req.job_id, Envelope::new(MessageType::Ping)); // drain the channel
        state.decrement_gpu_provider_jobs(&req.provider_pubkey);
        return (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({"error": "failed to send to provider"})),
        )
            .into_response();
    }

    // Await response with 120s timeout
    match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
        Ok(Ok(response_envelope)) => match response_envelope.message {
            MessageType::InferenceResponse(resp) => Json(json!({
                "job_id": resp.job_id,
                "text": resp.text,
                "input_tokens": resp.input_tokens,
                "output_tokens": resp.output_tokens,
                "latency_ms": resp.latency_ms,
            }))
            .into_response(),
            MessageType::Error(err) => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": err.message, "code": err.code})),
            )
                .into_response(),
            _ => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "unexpected response type from provider"})),
            )
                .into_response(),
        },
        Ok(Err(_)) => {
            // Oneshot sender was dropped (provider disconnected)
            state.decrement_gpu_provider_jobs(&req.provider_pubkey);
            (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(json!({"error": "provider disconnected before responding"})),
            )
                .into_response()
        }
        Err(_) => {
            // Timeout — clean up pending entry
            // The oneshot may still be in the map if the provider never responded
            state.decrement_gpu_provider_jobs(&req.provider_pubkey);
            (
                axum::http::StatusCode::GATEWAY_TIMEOUT,
                Json(json!({"error": "inference request timed out (120s)"})),
            )
                .into_response()
        }
    }
}

/// POST /inference-stream — Returns SSE stream for streaming inference.
pub async fn dispatch_inference_stream(
    State(state): State<AppState>,
    Json(req): Json<InferenceDispatchRequest>,
) -> impl IntoResponse {
    // Check provider exists
    if state.gpu_provider_count() == 0 {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "no gpu providers connected"})),
        )
            .into_response();
    }

    // Check provider concurrency
    match state.gpu_provider_concurrency(&req.provider_pubkey) {
        None => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(json!({"error": "provider not found"})),
            )
                .into_response();
        }
        Some((active, max)) => {
            if active >= max {
                return (
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({
                        "error": "provider at capacity",
                        "active_jobs": active,
                        "max_concurrent": max,
                    })),
                )
                    .into_response();
            }
        }
    }

    // Create mpsc channel for streaming
    let (stream_tx, mut stream_rx) = mpsc::unbounded_channel::<Envelope>();
    state.register_pending_inference_stream(&req.job_id, stream_tx);

    // Increment active jobs
    state.increment_gpu_provider_jobs(&req.provider_pubkey);

    // Build InferenceRequest envelope with stream=true
    let envelope = Envelope::new(MessageType::InferenceRequest(InferenceRequestPayload {
        job_id: req.job_id.clone(),
        model_id: req.model_id,
        messages: req.messages,
        system: req.system,
        max_tokens: req.max_tokens,
        stream: true,
        temperature: req.temperature,
    }));

    let data = serde_json::to_vec(&envelope).unwrap_or_default();
    if !state.send_to_gpu_provider(&req.provider_pubkey, &data) {
        state.remove_pending_inference_stream(&req.job_id);
        state.decrement_gpu_provider_jobs(&req.provider_pubkey);
        return (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({"error": "failed to send to provider"})),
        )
            .into_response();
    }

    let job_id = req.job_id.clone();
    let provider_pubkey = req.provider_pubkey.clone();
    let state_clone = state.clone();

    let stream = async_stream::stream! {
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(120), stream_rx.recv()).await {
                Ok(Some(env)) => {
                    match &env.message {
                        MessageType::InferenceStreamChunk(chunk) => {
                            let data = serde_json::to_string(&json!({
                                "job_id": chunk.job_id,
                                "text": chunk.text,
                                "tokens_so_far": chunk.tokens_so_far,
                            }))
                            .unwrap_or_default();
                            yield Ok::<_, Infallible>(Event::default().event("chunk").data(data));
                        }
                        MessageType::InferenceStreamEnd(end) => {
                            let data = serde_json::to_string(&json!({
                                "job_id": end.job_id,
                                "input_tokens": end.input_tokens,
                                "output_tokens": end.output_tokens,
                                "latency_ms": end.latency_ms,
                            }))
                            .unwrap_or_default();
                            yield Ok::<_, Infallible>(Event::default().event("done").data(data));
                            break;
                        }
                        MessageType::Error(err) => {
                            let data = serde_json::to_string(&json!({
                                "error": err.message,
                                "code": err.code,
                            }))
                            .unwrap_or_default();
                            yield Ok::<_, Infallible>(Event::default().event("error").data(data));
                            break;
                        }
                        _ => continue,
                    }
                }
                Ok(None) => {
                    // Channel closed — provider disconnected
                    let data = json!({"error": "provider disconnected"}).to_string();
                    yield Ok::<_, Infallible>(Event::default().event("error").data(data));
                    state_clone.decrement_gpu_provider_jobs(&provider_pubkey);
                    break;
                }
                Err(_) => {
                    // Timeout
                    let data = json!({"error": "stream timed out (120s)"}).to_string();
                    yield Ok::<_, Infallible>(Event::default().event("error").data(data));
                    state_clone.remove_pending_inference_stream(&job_id);
                    state_clone.decrement_gpu_provider_jobs(&provider_pubkey);
                    break;
                }
            }
        }
    };

    Sse::new(stream).into_response()
}
