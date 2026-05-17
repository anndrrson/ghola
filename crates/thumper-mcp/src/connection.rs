use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use ed25519_dalek::Signer;
use futures::stream::StreamExt;
use futures::SinkExt;
use serde_json::json;
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

use thumper_types::{AuthMessage, AuthPayload, ConnectionRole, Envelope};

use crate::config::ThumperConfig;

type WsSink = futures::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    Message,
>;

/// Manages the WebSocket connection to the relay and correlates
/// request/response envelopes via oneshot channels.
/// Supports automatic reconnection with exponential backoff.
pub struct RelayConnection {
    /// Pending requests: correlation_id -> oneshot sender
    pending: Arc<DashMap<String, oneshot::Sender<Envelope>>>,
    /// WebSocket write half
    ws_tx: Arc<Mutex<WsSink>>,
    /// Whether currently connected
    connected: Arc<AtomicBool>,
    /// Whether a reconnection attempt is in progress
    reconnecting: Arc<AtomicBool>,
    /// Config for reconnection (relay_url, pubkeys, signing key)
    config: Arc<ThumperConfig>,
}

impl RelayConnection {
    /// Connect to the relay, authenticate, and start the receive loop.
    pub async fn connect(
        config: &ThumperConfig,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let config = Arc::new(config.clone());
        let (ws_stream, _) = tokio_tungstenite::connect_async(&config.relay_url).await?;
        let (write, read) = ws_stream.split();

        let pending: Arc<DashMap<String, oneshot::Sender<Envelope>>> = Arc::new(DashMap::new());
        let connected = Arc::new(AtomicBool::new(false));
        let reconnecting = Arc::new(AtomicBool::new(false));
        let ws_tx = Arc::new(Mutex::new(write));

        // Authenticate
        Self::authenticate(&ws_tx, &config, read)
            .await
            .map(|read| {
                connected.store(true, Ordering::Relaxed);

                // Spawn receive loop
                Self::spawn_read_loop(
                    read,
                    pending.clone(),
                    connected.clone(),
                    reconnecting.clone(),
                    ws_tx.clone(),
                    config.clone(),
                );

                Self {
                    pending,
                    ws_tx,
                    connected,
                    reconnecting,
                    config,
                }
            })
    }

    /// Perform the authentication handshake on a fresh WebSocket connection.
    /// Returns the read half for the caller to spawn a read loop on.
    async fn authenticate(
        ws_tx: &Arc<Mutex<WsSink>>,
        config: &ThumperConfig,
        mut read: futures::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        >,
    ) -> Result<
        futures::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        >,
        Box<dyn std::error::Error + Send + Sync>,
    > {
        let auth_message = AuthMessage {
            pubkey: config.mcp_pubkey.clone(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            nonce: uuid::Uuid::new_v4().to_string(),
            role: ConnectionRole::McpClient,
        };

        // Sign the auth message if we have a signing key, otherwise empty (dev mode)
        let signature = if let Some(ref signing_key) = config.signing_key {
            let canonical = auth_message.canonical_bytes();
            let sig = signing_key.sign(&canonical);
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
        } else {
            String::new()
        };

        let auth = AuthPayload {
            message: auth_message,
            signature,
        };

        {
            let mut writer = ws_tx.lock().await;
            writer
                .send(Message::Text(serde_json::to_string(&auth)?.into()))
                .await?;
        }

        // Read auth response
        if let Some(Ok(Message::Text(resp))) = read.next().await {
            let v: serde_json::Value = serde_json::from_str(&resp)?;
            if v.get("error").is_some() {
                return Err(format!("auth failed: {}", v["error"]).into());
            }
        }

        // Send device target
        {
            let mut writer = ws_tx.lock().await;
            writer
                .send(Message::Text(
                    json!({"device_pubkey": &config.device_pubkey})
                        .to_string()
                        .into(),
                ))
                .await?;
        }

        // Read device status
        if let Some(Ok(Message::Text(resp))) = read.next().await {
            let v: serde_json::Value = serde_json::from_str(&resp)?;
            tracing::info!(
                device_connected = v["device_connected"].as_bool().unwrap_or(false),
                "relay connection established"
            );
        }

        Ok(read)
    }

    /// Spawn the background read loop that dispatches envelope responses
    /// to pending oneshot senders. On disconnect, triggers reconnection.
    fn spawn_read_loop(
        mut read: futures::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        >,
        pending: Arc<DashMap<String, oneshot::Sender<Envelope>>>,
        connected: Arc<AtomicBool>,
        reconnecting: Arc<AtomicBool>,
        ws_tx: Arc<Mutex<WsSink>>,
        config: Arc<ThumperConfig>,
    ) {
        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(envelope) = serde_json::from_str::<Envelope>(&text) {
                            if let Some((_, sender)) = pending.remove(&envelope.id) {
                                let _ = sender.send(envelope);
                            } else {
                                tracing::debug!(id = %envelope.id, "received unsolicited envelope");
                            }
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => {
                        connected.store(false, Ordering::Relaxed);
                        tracing::warn!("relay connection closed");

                        // Drop all stale pending senders so callers get errors immediately
                        pending.clear();

                        // Trigger reconnection
                        Self::spawn_reconnect(
                            pending.clone(),
                            connected.clone(),
                            reconnecting.clone(),
                            ws_tx.clone(),
                            config.clone(),
                        );
                        break;
                    }
                    _ => {}
                }
            }
        });
    }

    /// Spawn a background reconnection task with exponential backoff.
    /// Backoff: 1s -> 2s -> 4s -> ... capped at 30s.
    fn spawn_reconnect(
        pending: Arc<DashMap<String, oneshot::Sender<Envelope>>>,
        connected: Arc<AtomicBool>,
        reconnecting: Arc<AtomicBool>,
        ws_tx: Arc<Mutex<WsSink>>,
        config: Arc<ThumperConfig>,
    ) {
        // Only one reconnect task at a time
        if reconnecting
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
            .is_err()
        {
            return;
        }

        tokio::spawn(async move {
            let mut delay_secs = 1u64;
            let max_delay_secs = 30u64;

            loop {
                tracing::info!(
                    delay_secs = delay_secs,
                    "attempting relay reconnection in {}s",
                    delay_secs
                );
                tokio::time::sleep(Duration::from_secs(delay_secs)).await;

                match tokio_tungstenite::connect_async(&config.relay_url).await {
                    Ok((ws_stream, _)) => {
                        let (new_write, new_read) = ws_stream.split();

                        // Replace the write half
                        {
                            let mut writer = ws_tx.lock().await;
                            *writer = new_write;
                        }

                        // Re-authenticate
                        match Self::authenticate(&ws_tx, &config, new_read).await {
                            Ok(read) => {
                                connected.store(true, Ordering::Relaxed);
                                reconnecting.store(false, Ordering::Relaxed);
                                tracing::info!("relay reconnection successful");

                                // Drop any stale pending senders from before reconnect
                                pending.clear();

                                // Spawn new read loop
                                Self::spawn_read_loop(
                                    read,
                                    pending.clone(),
                                    connected.clone(),
                                    reconnecting.clone(),
                                    ws_tx.clone(),
                                    config.clone(),
                                );
                                return;
                            }
                            Err(e) => {
                                tracing::warn!("reconnect auth failed: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("reconnect failed: {}", e);
                    }
                }

                // Exponential backoff
                delay_secs = (delay_secs * 2).min(max_delay_secs);
            }
        });
    }

    /// Send a command envelope to the device and wait for the correlated response.
    pub async fn send_command(
        &self,
        envelope: Envelope,
        timeout: Duration,
    ) -> Result<Envelope, Box<dyn std::error::Error + Send + Sync>> {
        if !self.connected.load(Ordering::Relaxed) {
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
        self.connected.load(Ordering::Relaxed)
    }

    pub fn is_reconnecting(&self) -> bool {
        self.reconnecting.load(Ordering::Relaxed)
    }
}
