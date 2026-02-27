use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::ws::Message;
use dashmap::DashMap;
use tokio::sync::mpsc;

use crate::auth::NonceCache;
use crate::config::RelayConfig;

/// Token bucket rate limiter per connection.
pub struct RateLimiter {
    tokens: f64,
    max_tokens: f64,
    refill_rate: f64,
    last_refill: std::time::Instant,
}

impl RateLimiter {
    pub fn new(rate_per_second: u32) -> Self {
        let max = rate_per_second as f64;
        Self {
            tokens: max,
            max_tokens: max,
            refill_rate: max,
            last_refill: std::time::Instant::now(),
        }
    }

    pub fn try_consume(&mut self) -> bool {
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_rate).min(self.max_tokens);
        self.last_refill = now;

        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Shared server state. Two separate maps: devices and MCP clients.
/// MCP clients route commands to devices by pubkey.
#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    /// device pubkey → DeviceEntry
    devices: DashMap<String, DeviceEntry>,
    /// mcp client pubkey → McpClientEntry
    mcp_clients: DashMap<String, McpClientEntry>,
    config: RelayConfig,
    nonce_cache: NonceCache,
}

pub struct DeviceEntry {
    pub sender: mpsc::UnboundedSender<Message>,
    pub label: Option<String>,
    pub connected_at: std::time::Instant,
    /// Epoch seconds of last received message (for dead connection detection).
    pub last_activity: Arc<AtomicU64>,
}

pub struct McpClientEntry {
    pub sender: mpsc::UnboundedSender<Message>,
    pub target_device: String,
    pub last_activity: Arc<AtomicU64>,
}

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl AppState {
    pub fn new(config: RelayConfig) -> Self {
        let nonce_ttl = config.auth_timeout_secs * 2;
        Self {
            inner: Arc::new(AppStateInner {
                devices: DashMap::new(),
                mcp_clients: DashMap::new(),
                config,
                nonce_cache: NonceCache::new(nonce_ttl),
            }),
        }
    }

    pub fn config(&self) -> &RelayConfig {
        &self.inner.config
    }

    pub fn nonce_cache(&self) -> &NonceCache {
        &self.inner.nonce_cache
    }

    // -- Device connections --

    pub fn add_device(
        &self,
        pubkey: &str,
        sender: mpsc::UnboundedSender<Message>,
    ) -> Arc<AtomicU64> {
        let last_activity = Arc::new(AtomicU64::new(now_epoch_secs()));
        let activity_clone = last_activity.clone();
        self.inner.devices.insert(
            pubkey.to_string(),
            DeviceEntry {
                sender,
                label: None,
                connected_at: std::time::Instant::now(),
                last_activity,
            },
        );
        activity_clone
    }

    pub fn set_device_label(&self, pubkey: &str, label: String) {
        if let Some(mut entry) = self.inner.devices.get_mut(pubkey) {
            entry.label = Some(label);
        }
    }

    pub fn remove_device(&self, pubkey: &str) {
        self.inner.devices.remove(pubkey);
    }

    pub fn send_to_device(&self, pubkey: &str, data: &[u8]) -> bool {
        if let Some(entry) = self.inner.devices.get(pubkey) {
            entry
                .sender
                .send(Message::Text(
                    String::from_utf8_lossy(data).to_string().into(),
                ))
                .is_ok()
        } else {
            false
        }
    }

    pub fn device_connected(&self, pubkey: &str) -> bool {
        self.inner.devices.contains_key(pubkey)
    }

    pub fn device_count(&self) -> usize {
        self.inner.devices.len()
    }

    /// Get device info for multi-device listing.
    pub fn connected_devices_info(&self) -> Vec<(String, Option<String>)> {
        self.inner
            .devices
            .iter()
            .map(|e| (e.key().clone(), e.value().label.clone()))
            .collect()
    }

    // -- MCP client connections --

    pub fn add_mcp_client(
        &self,
        pubkey: &str,
        sender: mpsc::UnboundedSender<Message>,
        device_pubkey: String,
    ) -> Arc<AtomicU64> {
        let last_activity = Arc::new(AtomicU64::new(now_epoch_secs()));
        let activity_clone = last_activity.clone();
        self.inner.mcp_clients.insert(
            pubkey.to_string(),
            McpClientEntry {
                sender,
                target_device: device_pubkey,
                last_activity,
            },
        );
        activity_clone
    }

    pub fn remove_mcp_client(&self, pubkey: &str) {
        self.inner.mcp_clients.remove(pubkey);
    }

    /// Send data back to the MCP client that is controlling a given device.
    pub fn send_to_mcp_client_for_device(&self, device_pubkey: &str, data: &[u8]) -> bool {
        for entry in self.inner.mcp_clients.iter() {
            let client = entry.value();
            if client.target_device == device_pubkey {
                if client
                    .sender
                    .send(Message::Text(
                        String::from_utf8_lossy(data).to_string().into(),
                    ))
                    .is_ok()
                {
                    return true;
                }
            }
        }
        false
    }

    pub fn mcp_client_count(&self) -> usize {
        self.inner.mcp_clients.len()
    }

    /// Prune expired nonces from the cache.
    pub fn prune_nonces(&self) {
        self.inner.nonce_cache.prune();
    }

    /// Send a ping to all connected devices and MCP clients.
    /// Remove entries whose channels are closed (dead connections).
    pub fn ping_all_and_prune_dead(&self) {
        let ping = Message::Ping(vec![].into());

        // Ping devices and collect dead ones
        let dead_devices: Vec<String> = self
            .inner
            .devices
            .iter()
            .filter_map(|entry| {
                if entry.value().sender.send(ping.clone()).is_err() {
                    Some(entry.key().clone())
                } else {
                    None
                }
            })
            .collect();

        for pubkey in &dead_devices {
            self.inner.devices.remove(pubkey);
            tracing::info!(pubkey = %pubkey, "removed dead device connection");
        }

        // Ping MCP clients and collect dead ones
        let dead_clients: Vec<String> = self
            .inner
            .mcp_clients
            .iter()
            .filter_map(|entry| {
                if entry.value().sender.send(ping.clone()).is_err() {
                    Some(entry.key().clone())
                } else {
                    None
                }
            })
            .collect();

        for pubkey in &dead_clients {
            self.inner.mcp_clients.remove(pubkey);
            tracing::info!(pubkey = %pubkey, "removed dead mcp client connection");
        }

        if !dead_devices.is_empty() || !dead_clients.is_empty() {
            tracing::info!(
                dead_devices = dead_devices.len(),
                dead_clients = dead_clients.len(),
                "pruned dead connections"
            );
        }
    }

    /// Remove connections that haven't had any activity within the given timeout.
    pub fn prune_stale_connections(&self, stale_timeout_secs: u64) {
        let now = now_epoch_secs();

        let stale_devices: Vec<String> = self
            .inner
            .devices
            .iter()
            .filter_map(|entry| {
                let last = entry.value().last_activity.load(Ordering::Relaxed);
                if now.saturating_sub(last) > stale_timeout_secs {
                    Some(entry.key().clone())
                } else {
                    None
                }
            })
            .collect();

        for pubkey in &stale_devices {
            self.inner.devices.remove(pubkey);
            tracing::warn!(pubkey = %pubkey, "removed stale device (no activity)");
        }

        let stale_clients: Vec<String> = self
            .inner
            .mcp_clients
            .iter()
            .filter_map(|entry| {
                let last = entry.value().last_activity.load(Ordering::Relaxed);
                if now.saturating_sub(last) > stale_timeout_secs {
                    Some(entry.key().clone())
                } else {
                    None
                }
            })
            .collect();

        for pubkey in &stale_clients {
            self.inner.mcp_clients.remove(pubkey);
            tracing::warn!(pubkey = %pubkey, "removed stale mcp client (no activity)");
        }
    }
}
