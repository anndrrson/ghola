use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use futures::stream::StreamExt;
use futures::SinkExt;
use serde_json::json;
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

use thumper_types::{AuthMessage, AuthPayload, ConnectionRole, Envelope};

use crate::config::ThumperConfig;

/// Manages the WebSocket connection to the relay and correlates
/// request/response envelopes via oneshot channels.
pub struct RelayConnection {
    /// Pending requests: correlation_id → oneshot sender
    pending: Arc<DashMap<String, oneshot::Sender<Envelope>>>,
    /// WebSocket write half
    ws_tx: Arc<Mutex<futures::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >>>,
    /// Whether currently connected
    connected: Arc<std::sync::atomic::AtomicBool>,
}

impl RelayConnection {
    /// Connect to the relay, authenticate, and start the receive loop.
    pub async fn connect(config: &ThumperConfig) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let (ws_stream, _) = tokio_tungstenite::connect_async(&config.relay_url).await?;
        let (mut write, mut read) = ws_stream.split();

        // Send auth payload
        let auth = AuthPayload {
            message: AuthMessage {
                pubkey: config.mcp_pubkey.clone(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
                nonce: uuid::Uuid::new_v4().to_string(),
                role: ConnectionRole::McpClient,
            },
            signature: String::new(), // TODO: sign with actual keypair
        };

        write
            .send(Message::Text(serde_json::to_string(&auth)?.into()))
            .await?;

        // Read auth response
        if let Some(Ok(Message::Text(resp))) = read.next().await {
            let v: serde_json::Value = serde_json::from_str(&resp)?;
            if v.get("error").is_some() {
                return Err(format!("auth failed: {}", v["error"]).into());
            }
        }

        // Send device target
        write
            .send(Message::Text(
                json!({"device_pubkey": &config.device_pubkey}).to_string().into(),
            ))
            .await?;

        // Read device status
        if let Some(Ok(Message::Text(resp))) = read.next().await {
            let v: serde_json::Value = serde_json::from_str(&resp)?;
            tracing::info!(
                device_connected = v["device_connected"].as_bool().unwrap_or(false),
                "relay connection established"
            );
        }

        let pending: Arc<DashMap<String, oneshot::Sender<Envelope>>> = Arc::new(DashMap::new());
        let connected = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let ws_tx = Arc::new(Mutex::new(write));

        // Spawn receive loop
        let pending_clone = pending.clone();
        let connected_clone = connected.clone();
        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(envelope) = serde_json::from_str::<Envelope>(&text) {
                            if let Some((_, sender)) = pending_clone.remove(&envelope.id) {
                                let _ = sender.send(envelope);
                            } else {
                                tracing::debug!(id = %envelope.id, "received unsolicited envelope");
                            }
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => {
                        connected_clone.store(false, std::sync::atomic::Ordering::Relaxed);
                        tracing::warn!("relay connection closed");
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(Self {
            pending,
            ws_tx,
            connected,
        })
    }

    /// Send a command envelope to the device and wait for the correlated response.
    pub async fn send_command(
        &self,
        envelope: Envelope,
        timeout: Duration,
    ) -> Result<Envelope, Box<dyn std::error::Error + Send + Sync>> {
        if !self.connected.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("not connected to relay".into());
        }

        let id = envelope.id.clone();
        let (tx, rx) = oneshot::channel();
        self.pending.insert(id.clone(), tx);

        let json = serde_json::to_string(&envelope)?;
        {
            let mut writer = self.ws_tx.lock().await;
            writer.send(Message::Text(json.into())).await?;
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => {
                self.pending.remove(&id);
                Err("response channel closed".into())
            }
            Err(_) => {
                self.pending.remove(&id);
                Err("command timed out".into())
            }
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(std::sync::atomic::Ordering::Relaxed)
    }
}
