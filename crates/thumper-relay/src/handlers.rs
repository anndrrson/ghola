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
    AuthPayload, ConnectedDevice, ConnectedDevicesResult, ConnectionRole, EnclaveKeyId, Envelope,
    InferenceChatMessage, InferenceRequestPayload, MessageType, ProviderAdvertiseAck,
    ProviderAttestAckPayload, ProviderAttestPayload, SealedInferenceRequestPayload, TeeKind,
};

use said_attest::AttestedEnclave;

use crate::auth::verify_auth;
use crate::state::{AppState, RateLimiter};

const OHTTP_X402_FORWARD_HEADERS: &[&str] = &[
    "accept",
    "authorization",
    "content-type",
    "payment-signature",
    "x-payment",
    "x402-payment",
    "x-ghola-payment-rail",
    "x-payment-rail",
];

const OHTTP_X402_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "payment-required",
    "x-payment-required",
    "payment-response",
    "x-payment-response",
];

fn filtered_ohttp_x402_forward_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            let name_lc = name.trim().to_ascii_lowercase();
            if OHTTP_X402_FORWARD_HEADERS.contains(&name_lc.as_str())
                && !value.contains('\r')
                && !value.contains('\n')
            {
                Some((name_lc, value.clone()))
            } else {
                None
            }
        })
        .collect()
}

fn filtered_ohttp_x402_response_headers(
    headers: &reqwest::header::HeaderMap,
) -> Vec<(String, String)> {
    let mut filtered = Vec::new();
    for name in OHTTP_X402_RESPONSE_HEADERS {
        if let Some(value) = headers.get(*name).and_then(|v| v.to_str().ok()) {
            filtered.push((name.to_string(), value.to_string()));
        }
    }
    if !filtered
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
    {
        filtered.push(("content-type".to_string(), "application/json".to_string()));
    }
    filtered
}

/// Health check endpoint.
pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    Json(relay_health_body(&state, true))
}

/// Liveness only. If this handler runs, the process is alive.
pub async fn healthz(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "service": "thumper-relay",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_secs": state.uptime_secs(),
        "timestamp": chrono::Utc::now().to_rfc3339(),
    }))
}

/// General relay readiness probe. This covers process-local dependencies
/// needed to serve production relay traffic; private provider capacity
/// remains visible in `/ready/private` so Open/WS routing does not get
/// confused with zero private enclaves.
pub async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    let readiness = state.private_readiness();
    let status = if readiness.private_ready {
        axum::http::StatusCode::OK
    } else {
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(relay_health_body(&state, readiness.private_ready)),
    )
}

fn relay_health_body(state: &AppState, ready_status: bool) -> serde_json::Value {
    let ready = state.private_readiness();
    let attested_provider_count = state.list_attested_enclaves().len();
    let private_capacity_ready = ready.private_ready && attested_provider_count > 0;
    let x402_upstream_configured = !state.config().thumper_cloud_base_url.trim().is_empty();
    let capacity_reason_codes: Vec<&str> = if private_capacity_ready {
        Vec::new()
    } else if ready.private_ready {
        vec!["no_attested_private_providers"]
    } else {
        vec!["private_stack_not_ready"]
    };
    json!({
        "status": if ready_status { "ok" } else { "degraded" },
        "service": "thumper-relay",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_secs": state.uptime_secs(),
        "devices": state.device_count(),
        "mcp_clients": state.mcp_client_count(),
        "gpu_providers": state.gpu_provider_count(),
        "attested_provider_count": attested_provider_count,
        "ohttp_enabled": ready.ohttp_enabled,
        "ohttp_x402_gateway_enabled": ready.ohttp_enabled && x402_upstream_configured,
        "ohttp_x402_upstream_configured": x402_upstream_configured,
        "did_set_bootstrapped": ready.did_set_bootstrapped,
        "did_set_fresh": ready.did_set_fresh,
        "private_ready": ready.private_ready,
        "private_reason_codes": ready.reason_codes,
        "private_capacity_ready": private_capacity_ready,
        "capacity_reason_codes": capacity_reason_codes,
        "degraded": !ready_status || !private_capacity_ready,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    })
}

/// Private-path readiness probe.
///
/// Returns:
/// - `200` when private stack is ready (OHTTP + fresh did_set)
/// - `503` when private stack is not ready, with reason codes.
pub async fn ready_private(State(state): State<AppState>) -> impl IntoResponse {
    let ready = state.private_readiness();
    let attested_provider_count = state.list_attested_enclaves().len();
    let private_capacity_ready = ready.private_ready && attested_provider_count > 0;
    let capacity_reason_codes: Vec<&str> = if private_capacity_ready {
        Vec::new()
    } else if ready.private_ready {
        vec!["no_attested_private_providers"]
    } else {
        vec!["private_stack_not_ready"]
    };
    let status = if ready.private_ready {
        axum::http::StatusCode::OK
    } else {
        tracing::warn!(
            reason_codes = ?ready.reason_codes,
            "relay private readiness failure"
        );
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "private_ready": ready.private_ready,
            "ohttp_enabled": ready.ohttp_enabled,
            "did_set_bootstrapped": ready.did_set_bootstrapped,
            "did_set_fresh": ready.did_set_fresh,
            "reason_codes": ready.reason_codes,
            "attested_provider_count": attested_provider_count,
            "private_capacity_ready": private_capacity_ready,
            "capacity_reason_codes": capacity_reason_codes,
        })),
    )
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
        MessageType::InferenceRequestSealed(_) => "InferenceRequestSealed",
        MessageType::InferenceResponseSealed(_) => "InferenceResponseSealed",
        MessageType::ProviderAttest(_) => "ProviderAttest",
        MessageType::ProviderAttestAck(_) => "ProviderAttestAck",
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
                            MessageType::InferenceResponseSealed(resp) => {
                                let job_id = resp.job_id.clone();
                                state.resolve_pending_inference(&job_id, envelope);
                                state.decrement_gpu_provider_jobs(&auth_pubkey_clone);
                            }
                            MessageType::ProviderAttest(payload) => {
                                let ack = handle_provider_attest(
                                    &state,
                                    &auth_pubkey_clone,
                                    payload.clone(),
                                );
                                let ack_env = Envelope::new(MessageType::ProviderAttestAck(ack));
                                let _ = tx_clone.send(text_msg(
                                    serde_json::to_string(&ack_env).unwrap_or_default(),
                                ));
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

// -- Sealed inference + attestation endpoints (v2) --

/// Parse the env var `GHOLA_ATTEST_SIGNING_PUB` (hex-encoded 32-byte Ed25519
/// public key) into a `VerifyingKey`. Returns `None` if unset or malformed.
fn allowlist_pub_from_env() -> Option<ed25519_dalek::VerifyingKey> {
    let hex_str = std::env::var("GHOLA_ATTEST_SIGNING_PUB").ok()?;
    let bytes = hex::decode(hex_str.trim()).ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    ed25519_dalek::VerifyingKey::from_bytes(&arr).ok()
}

/// Decode a base64 string with `base64::engine::general_purpose::STANDARD`.
fn b64_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s)
}

// Tier 1E: the unattested mock path is compile-time-denied in release
// builds. Production ships `cargo build --release` so `debug_assertions`
// is false and the env var becomes a no-op, closing the "operator
// accidentally sets the flag in prod" failure mode. Debug builds still
// honour `THUMPER_ALLOW_UNATTESTED=1` so local dev + the test suite
// keep working.
//
// Security review item from the a16z peak-security plan: attestation
// cannot be bypassed by configuration.
fn allow_unattested() -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    std::env::var("THUMPER_ALLOW_UNATTESTED").as_deref() == Ok("1")
}

/// Shared verification path used by both the WS `ProviderAttest` arm and the
/// `POST /providers/attest` HTTP handler. Returns the ack payload to send
/// back to the provider (or test client).
pub(crate) fn handle_provider_attest(
    state: &AppState,
    provider_id: &str,
    payload: ProviderAttestPayload,
) -> ProviderAttestAckPayload {
    let now = chrono::Utc::now().timestamp();

    let vendor_quote = match b64_decode(&payload.vendor_quote_b64) {
        Ok(b) => b,
        Err(e) => {
            return ProviderAttestAckPayload {
                accepted: false,
                enclave_key_id: None,
                expires_at: None,
                reason: Some(format!("invalid vendor_quote_b64: {e}")),
            };
        }
    };
    let allowlist_sig = match b64_decode(&payload.ghola_allowlist_sig_b64) {
        Ok(b) => b,
        Err(e) => {
            return ProviderAttestAckPayload {
                accepted: false,
                enclave_key_id: None,
                expires_at: None,
                reason: Some(format!("invalid ghola_allowlist_sig_b64: {e}")),
            };
        }
    };

    // Try the real verification path first, regardless of TeeKind, so a
    // legitimate Nitro quote still wins even when dev-mode is enabled.
    if let Some(allowlist_pub) = allowlist_pub_from_env() {
        match said_attest::verify_attestation(
            &vendor_quote,
            &allowlist_sig,
            &allowlist_pub,
            payload.tee_kind,
            now,
        ) {
            Ok(mut enclave) => {
                enclave.provider_id = provider_id.to_string();
                let expires_at = enclave.expires_at_unix;
                let key_id =
                    state.insert_attested_enclave(enclave, payload.vendor_quote_b64.clone());
                return ProviderAttestAckPayload {
                    accepted: true,
                    enclave_key_id: Some(key_id),
                    expires_at: Some(expires_at),
                    reason: None,
                };
            }
            Err(e) => {
                tracing::warn!(
                    provider_id = %provider_id,
                    tee_kind = ?payload.tee_kind,
                    error = %e,
                    "provider attest rejected"
                );
                if !(allow_unattested() && matches!(payload.tee_kind, TeeKind::None)) {
                    return ProviderAttestAckPayload {
                        accepted: false,
                        enclave_key_id: None,
                        expires_at: None,
                        reason: Some(format!("attestation verification failed: {e}")),
                    };
                }
                // fall through to dev-mode mock path
            }
        }
    } else if !(allow_unattested() && matches!(payload.tee_kind, TeeKind::None)) {
        return ProviderAttestAckPayload {
            accepted: false,
            enclave_key_id: None,
            expires_at: None,
            reason: Some("GHOLA_ATTEST_SIGNING_PUB unset; refusing to accept attestation".into()),
        };
    }

    // Dev/staging mock path: THUMPER_ALLOW_UNATTESTED=1 + TeeKind::None.
    // Trust the keys the provider sent, build an AttestedEnclave directly.
    let x25519_pub = match parse_pub32(&payload.enclave_x25519_pub_hex) {
        Some(k) => k,
        None => {
            return ProviderAttestAckPayload {
                accepted: false,
                enclave_key_id: None,
                expires_at: None,
                reason: Some("invalid enclave_x25519_pub_hex".into()),
            };
        }
    };
    let ed25519_pub = match parse_pub32(&payload.enclave_ed25519_pub_hex) {
        Some(k) => k,
        None => {
            return ProviderAttestAckPayload {
                accepted: false,
                enclave_key_id: None,
                expires_at: None,
                reason: Some("invalid enclave_ed25519_pub_hex".into()),
            };
        }
    };

    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(x25519_pub);
    let enclave_key_id = EnclaveKeyId(hex::encode(h.finalize()));
    let expires_at_unix = now + said_attest::ATTESTATION_TTL_SECS;

    let enclave = AttestedEnclave {
        provider_id: provider_id.to_string(),
        enclave_key_id: enclave_key_id.clone(),
        enclave_x25519_pub: x25519_pub,
        enclave_ed25519_pub: ed25519_pub,
        tee_kind: TeeKind::None,
        measurement: Vec::new(),
        attested_at_unix: now,
        expires_at_unix,
    };
    let key_id = state.insert_attested_enclave(enclave, payload.vendor_quote_b64.clone());
    ProviderAttestAckPayload {
        accepted: true,
        enclave_key_id: Some(key_id),
        expires_at: Some(expires_at_unix),
        reason: Some("accepted via THUMPER_ALLOW_UNATTESTED dev path".into()),
    }
}

fn parse_pub32(hex_str: &str) -> Option<[u8; 32]> {
    let bytes = hex::decode(hex_str.trim()).ok()?;
    bytes.try_into().ok()
}

/// Request body for `POST /inference/sealed`.
#[derive(serde::Deserialize)]
pub struct SealedInferenceDispatchRequest {
    pub enclave_key_id: EnclaveKeyId,
    pub job_id: String,
    pub sealed_request_b64: String,
    #[serde(default)]
    pub mode_hint: Option<String>,
}

/// Core of the sealed-inference dispatch path, factored out so both
/// the direct `POST /inference/sealed` handler and the OHTTP gateway can
/// invoke it without re-implementing the WebSocket plumbing.
///
/// Returns `(status, json_body)` so the caller can render it as either
/// an `axum::Json` response or a BHTTP response inside an OHTTP capsule.
pub async fn handle_sealed_inference(
    state: &AppState,
    req: SealedInferenceDispatchRequest,
) -> (axum::http::StatusCode, serde_json::Value) {
    let enclave = match state.get_attested_enclave(&req.enclave_key_id) {
        Some(e) => e,
        None => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                json!({"error": "enclave_key_id not attested"}),
            );
        }
    };

    let provider_pubkey = enclave.provider_id.clone();
    if provider_pubkey.is_empty() {
        return (
            axum::http::StatusCode::BAD_GATEWAY,
            json!({"error": "attested enclave has no bound provider"}),
        );
    }

    if state.gpu_provider_concurrency(&provider_pubkey).is_none() {
        return (
            axum::http::StatusCode::BAD_GATEWAY,
            json!({"error": "provider disconnected"}),
        );
    }

    let (tx, rx) = tokio::sync::oneshot::channel::<Envelope>();
    state.register_pending_inference(&req.job_id, tx);
    state.increment_gpu_provider_jobs(&provider_pubkey);

    let envelope = Envelope::new(MessageType::InferenceRequestSealed(
        SealedInferenceRequestPayload {
            job_id: req.job_id.clone(),
            enclave_key_id: req.enclave_key_id.clone(),
            ciphertext_b64: req.sealed_request_b64.clone(),
        },
    ));
    let _ = req.mode_hint; // reserved for future stream/private split

    let data = serde_json::to_vec(&envelope).unwrap_or_default();
    if !state.send_to_gpu_provider(&provider_pubkey, &data) {
        state.decrement_gpu_provider_jobs(&provider_pubkey);
        return (
            axum::http::StatusCode::BAD_GATEWAY,
            json!({"error": "failed to send to provider"}),
        );
    }

    match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
        Ok(Ok(response_envelope)) => match response_envelope.message {
            MessageType::InferenceResponseSealed(resp) => (
                axum::http::StatusCode::OK,
                json!({
                    "job_id": resp.job_id,
                    "ciphertext_b64": resp.ciphertext_b64,
                    "is_final": resp.is_final,
                }),
            ),
            MessageType::Error(err) => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error": err.message, "code": err.code}),
            ),
            _ => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error": "unexpected response type from provider"}),
            ),
        },
        Ok(Err(_)) => {
            state.decrement_gpu_provider_jobs(&provider_pubkey);
            (
                axum::http::StatusCode::BAD_GATEWAY,
                json!({"error": "provider disconnected before responding"}),
            )
        }
        Err(_) => {
            state.decrement_gpu_provider_jobs(&provider_pubkey);
            (
                axum::http::StatusCode::GATEWAY_TIMEOUT,
                json!({"error": "sealed inference timed out (120s)"}),
            )
        }
    }
}

/// POST /inference/sealed — forward an opaque sealed envelope to the attested
/// enclave and stream back the opaque sealed response. The relay never
/// decrypts. Streaming sealed responses are out of scope for Track E; if the
/// provider replies with multiple chunks, only the first non-final response
/// is returned (full streaming lands in Wave 3).
pub async fn dispatch_inference_sealed(
    State(state): State<AppState>,
    Json(req): Json<SealedInferenceDispatchRequest>,
) -> impl IntoResponse {
    let (status, body) = handle_sealed_inference(&state, req).await;
    (status, Json(body)).into_response()
}

/// Request body for `POST /providers/attest` (HTTP convenience for tests).
#[derive(serde::Deserialize)]
pub struct ProviderAttestHttpRequest {
    /// Long-lived auth pubkey (bs58) of the provider this attestation binds to.
    pub provider_id: String,
    #[serde(flatten)]
    pub payload: ProviderAttestPayload,
}

/// POST /providers/attest — HTTP-only path for testing. Production providers
/// send `ProviderAttest` over the WebSocket instead.
pub async fn provider_attest_http(
    State(state): State<AppState>,
    Json(req): Json<ProviderAttestHttpRequest>,
) -> impl IntoResponse {
    let ack = handle_provider_attest(&state, &req.provider_id, req.payload);
    if ack.accepted {
        (axum::http::StatusCode::OK, Json(json!(ack))).into_response()
    } else {
        (axum::http::StatusCode::BAD_REQUEST, Json(json!(ack))).into_response()
    }
}

/// Query string for `GET /providers/attested`.
#[derive(serde::Deserialize)]
pub struct ListAttestedQuery {
    #[serde(default)]
    pub model: Option<String>,
}

fn enclave_to_json(enclave: &AttestedEnclave) -> serde_json::Value {
    json!({
        "enclave_key_id": enclave.enclave_key_id,
        "provider_id": enclave.provider_id,
        "tee_kind": enclave.tee_kind,
        "enclave_x25519_pub_hex": hex::encode(enclave.enclave_x25519_pub),
        "enclave_ed25519_pub_hex": hex::encode(enclave.enclave_ed25519_pub),
        "measurement_hex": hex::encode(&enclave.measurement),
        "attested_at_unix": enclave.attested_at_unix,
        "expires_at_unix": enclave.expires_at_unix,
    })
}

/// GET /providers/attested?model=<model_id> — list attested enclaves the
/// web client can seal to. `model` is currently best-effort: enclaves whose
/// provider advertises that model are kept; if the provider is disconnected
/// the enclave is still listed (it may re-connect before the request lands).
pub async fn list_attested_providers(
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<ListAttestedQuery>,
) -> impl IntoResponse {
    let enclaves = state.list_attested_enclaves();
    let filtered: Vec<serde_json::Value> = if let Some(model_id) = q.model.as_deref() {
        let providers_for_model: std::collections::HashSet<String> = state
            .find_providers_for_model(model_id)
            .into_iter()
            .map(|(pubkey, _)| pubkey)
            .collect();
        enclaves
            .iter()
            .filter(|e| providers_for_model.contains(&e.provider_id))
            .map(enclave_to_json)
            .collect()
    } else {
        enclaves.iter().map(enclave_to_json).collect()
    };
    Json(filtered).into_response()
}

// ── OHTTP gateway (RFC 9458) ───────────────────────────────────────────

/// GET /ohttp-keys — serve the gateway keyconfig so OHTTP clients can
/// encrypt to us. The body is the raw RFC 9458 §3 keyconfig (binary),
/// served with `Content-Type: application/ohttp-keys`.
pub async fn ohttp_keys(State(state): State<AppState>) -> impl IntoResponse {
    let kp = match state.config().ohttp_keypair() {
        Some(kp) => kp,
        None => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(json!({"error": "OHTTP gateway not configured on this relay"})),
            )
                .into_response();
        }
    };
    let body = kp.key_config();
    (
        axum::http::StatusCode::OK,
        [("content-type", "application/ohttp-keys")],
        body,
    )
        .into_response()
}

/// POST /ohttp-gateway — decapsulate an OHTTP request capsule, dispatch
/// the inner BHTTP request to the relay's existing handlers, then
/// encapsulate the response. Only `/inference/sealed` is currently
/// dispatched; everything else returns 404 inside the BHTTP envelope.
pub async fn ohttp_gateway(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    use crate::ohttp;

    // Content-Type sanity-check (RFC 9458 §4).
    if let Some(ct) = headers.get(axum::http::header::CONTENT_TYPE) {
        if ct.as_bytes() != b"message/ohttp-req" {
            return (
                axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
                Json(json!({"error": "expected Content-Type: message/ohttp-req"})),
            )
                .into_response();
        }
    }

    let kp = match state.config().ohttp_keypair() {
        Some(kp) => kp,
        None => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(json!({"error": "OHTTP gateway not configured on this relay"})),
            )
                .into_response();
        }
    };

    let (bhttp_bytes, resp_ctx) = match ohttp::decapsulate_request(&kp, &body) {
        Ok(out) => out,
        Err(e) => {
            tracing::warn!(err = %e, "ohttp capsule decap failed");
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("ohttp decap: {e}")})),
            )
                .into_response();
        }
    };

    let bhttp_req = match ohttp::BhttpRequest::decode(&bhttp_bytes) {
        Some(r) => r,
        None => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({"error": "malformed inner BHTTP request"})),
            )
                .into_response();
        }
    };

    // Dispatch on the inner request's method + path. We support sealed
    // inference locally and a narrow x402 inference proxy to thumper-cloud.
    //
    // SECURITY: the direct `POST /inference/sealed` route is wrapped by
    // `auth::require_sealed_envelope_auth`, but axum middleware doesn't
    // cross transport boundaries — an OHTTP-wrapped sealed-inference
    // request reaches `ohttp_gateway` and would otherwise bypass that
    // middleware entirely. We therefore call the shared
    // `validate_sealed_envelope_bytes` here so both transports get
    // identical auth semantics (did-set bootstrap + freshness + sig +
    // DID membership + nonce replay + per-DID rate limit). The status
    // code from the validator is forwarded inside the BHTTP response so
    // the client surfaces the real failure through the encrypted tunnel.
    let bhttp_resp = if bhttp_req.method.eq_ignore_ascii_case("POST")
        && bhttp_req.path == "/inference/sealed"
    {
        let (resp_status, resp_json) =
            match serde_json::from_slice::<SealedInferenceDispatchRequest>(&bhttp_req.body) {
                Ok(parsed) => match base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    &parsed.sealed_request_b64,
                ) {
                    Ok(sealed_bytes) => {
                        match crate::auth::validate_sealed_envelope_bytes(&state, &sealed_bytes) {
                            Ok(_header) => handle_sealed_inference(&state, parsed).await,
                            Err(status) => (
                                status,
                                json!({
                                    "error": "sealed inference rejected by gateway auth",
                                    "status": status.as_u16(),
                                }),
                            ),
                        }
                    }
                    Err(e) => (
                        axum::http::StatusCode::BAD_REQUEST,
                        json!({"error": format!("bad sealed_request_b64: {e}")}),
                    ),
                },
                Err(e) => (
                    axum::http::StatusCode::BAD_REQUEST,
                    json!({"error": format!("invalid sealed inference body: {e}")}),
                ),
            };
        let body_bytes = serde_json::to_vec(&resp_json).unwrap_or_default();
        ohttp::BhttpResponse {
            status: resp_status.as_u16(),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: body_bytes,
        }
    } else if bhttp_req.method.eq_ignore_ascii_case("POST")
        && bhttp_req.path == "/v1/chat/completions"
    {
        ohttp_x402_chat_completions(&state, &bhttp_req).await
    } else {
        ohttp::BhttpResponse {
            status: axum::http::StatusCode::NOT_FOUND.as_u16(),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: serde_json::to_vec(&json!({
                "error": "OHTTP gateway: unsupported inner path",
                "path": bhttp_req.path
            }))
            .unwrap_or_default(),
        }
    }
    .encode();

    let capsule = match ohttp::encapsulate_response(&resp_ctx, &bhttp_resp) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(err = %e, "ohttp response encap failed");
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("ohttp encap: {e}")})),
            )
                .into_response();
        }
    };

    (
        axum::http::StatusCode::OK,
        [("content-type", "message/ohttp-res")],
        capsule,
    )
        .into_response()
}

async fn ohttp_x402_chat_completions(
    state: &AppState,
    bhttp_req: &crate::ohttp::BhttpRequest,
) -> crate::ohttp::BhttpResponse {
    let base = state.config().thumper_cloud_base_url.trim_end_matches('/');
    let url = format!("{base}/v1/chat/completions");
    let client = reqwest::Client::new();
    let mut req = client.post(url).body(bhttp_req.body.clone());

    for (name, value) in filtered_ohttp_x402_forward_headers(&bhttp_req.headers) {
        req = req.header(name, value);
    }

    let upstream = match req.send().await {
        Ok(response) => response,
        Err(e) => {
            tracing::warn!(err = %e, "OHTTP x402 upstream request failed");
            return crate::ohttp::BhttpResponse {
                status: axum::http::StatusCode::BAD_GATEWAY.as_u16(),
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: serde_json::to_vec(&json!({"error": "x402 upstream unavailable"}))
                    .unwrap_or_default(),
            };
        }
    };

    let status = upstream.status().as_u16();
    let headers = filtered_ohttp_x402_response_headers(upstream.headers());

    let body = match upstream.bytes().await {
        Ok(bytes) => bytes.to_vec(),
        Err(e) => {
            tracing::warn!(err = %e, "OHTTP x402 upstream body read failed");
            serde_json::to_vec(&json!({"error": "x402 upstream body unavailable"}))
                .unwrap_or_default()
        }
    };

    crate::ohttp::BhttpResponse {
        status,
        headers,
        body,
    }
}

#[cfg(test)]
mod ohttp_x402_tests {
    use super::*;

    #[test]
    fn ohttp_x402_forward_filter_only_keeps_payment_headers() {
        let headers = vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            ("X402-Payment".to_string(), "opaque-payment".to_string()),
            (
                "Payment-Signature".to_string(),
                "bad\r\nx-leak: yes".to_string(),
            ),
            ("Cookie".to_string(), "sid=session".to_string()),
            ("Referer".to_string(), "https://ghola.xyz/chat".to_string()),
            ("X-Forwarded-For".to_string(), "203.0.113.7".to_string()),
            ("X-Request-Id".to_string(), "req-123".to_string()),
            ("X-User-Id".to_string(), "user-123".to_string()),
            ("X-Wallet-Address".to_string(), "0xabc".to_string()),
            ("X-Viewing-Key".to_string(), "view-secret".to_string()),
        ];

        let filtered = filtered_ohttp_x402_forward_headers(&headers);

        assert_eq!(
            filtered,
            vec![
                ("content-type".to_string(), "application/json".to_string()),
                ("x402-payment".to_string(), "opaque-payment".to_string()),
            ]
        );
    }

    #[test]
    fn ohttp_x402_response_filter_only_keeps_payment_headers() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        headers.insert(
            reqwest::header::HeaderName::from_static("payment-response"),
            reqwest::header::HeaderValue::from_static("paid"),
        );
        headers.insert(
            reqwest::header::SET_COOKIE,
            reqwest::header::HeaderValue::from_static("sid=upstream"),
        );
        headers.insert(
            reqwest::header::HeaderName::from_static("x-request-id"),
            reqwest::header::HeaderValue::from_static("req-123"),
        );
        headers.insert(
            reqwest::header::HeaderName::from_static("server"),
            reqwest::header::HeaderValue::from_static("upstream"),
        );

        let filtered = filtered_ohttp_x402_response_headers(&headers);

        assert_eq!(
            filtered,
            vec![
                ("content-type".to_string(), "application/json".to_string()),
                ("payment-response".to_string(), "paid".to_string()),
            ]
        );
    }

    #[test]
    fn ohttp_x402_response_filter_defaults_json_content_type() {
        let headers = reqwest::header::HeaderMap::new();

        assert_eq!(
            filtered_ohttp_x402_response_headers(&headers),
            vec![("content-type".to_string(), "application/json".to_string())]
        );
    }
}

/// GET /attestations/:hash_hex — serve the cached vendor_quote_b64 plus the
/// AttestedEnclave so a client can re-verify the quote offline.
pub async fn get_attestation(
    State(state): State<AppState>,
    axum::extract::Path(hash_hex): axum::extract::Path<String>,
) -> impl IntoResponse {
    match state.find_attestation_by_hash(&hash_hex) {
        Some((enclave, vendor_quote_b64)) => {
            let mut body = enclave_to_json(&enclave);
            if let Some(obj) = body.as_object_mut() {
                obj.insert(
                    "vendor_quote_b64".into(),
                    serde_json::Value::String(vendor_quote_b64),
                );
                obj.insert(
                    "attestation_hash".into(),
                    serde_json::Value::String(hash_hex),
                );
            }
            (axum::http::StatusCode::OK, Json(body)).into_response()
        }
        None => (
            axum::http::StatusCode::NOT_FOUND,
            Json(json!({"error": "attestation not found"})),
        )
            .into_response(),
    }
}
