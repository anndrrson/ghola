use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use futures::stream::StreamExt;
use futures::SinkExt;
use serde_json::json;
use tokio::sync::mpsc;

use thumper_types::{
    AuthPayload, ConnectedDevice, ConnectedDevicesResult, ConnectionRole, Envelope, MessageType,
};

use crate::auth::verify_auth;
use crate::state::{AppState, RateLimiter};

/// Health check endpoint.
pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "devices": state.device_count(),
        "mcp_clients": state.mcp_client_count(),
    }))
}

/// WebSocket upgrade handler.
pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
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

                            let response =
                                envelope.response(MessageType::ConnectedDevicesResult(
                                    ConnectedDevicesResult { devices },
                                ));
                            let _ = tx_clone.send(text_msg(
                                serde_json::to_string(&response).unwrap_or_default(),
                            ));
                            continue;
                        }

                        // MCP client → device: forward command to the target device
                        if let Some(ref target) = device_target {
                            let data = serde_json::to_vec(&envelope).unwrap_or_default();
                            if !state.send_to_device(target, &data) {
                                let err_envelope = envelope.response(MessageType::Error(
                                    thumper_types::ErrorPayload {
                                        code: "device_offline".into(),
                                        message: "target device is not connected".into(),
                                    },
                                ));
                                let _ = tx_clone.send(text_msg(
                                    serde_json::to_string(&err_envelope).unwrap_or_default(),
                                ));
                            }
                        }
                    }
                    ConnectionRole::Device => {
                        // If the device sends a DeviceInfoResult, extract the label
                        if let MessageType::DeviceInfoResult(ref info) = envelope.message {
                            let label =
                                format!("{} {} (Android {})", info.manufacturer, info.model, info.android_version);
                            state.set_device_label(&auth_pubkey_clone, label);
                        }

                        // Device → MCP client: forward response back
                        let data = serde_json::to_vec(&envelope).unwrap_or_default();
                        state.send_to_mcp_client_for_device(&auth_pubkey_clone, &data);
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
    }
}
