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
    /// device pubkey → (WebSocket sender, optional label)
    devices: DashMap<String, DeviceEntry>,
    /// mcp client pubkey → (WebSocket sender, target device pubkey)
    mcp_clients: DashMap<String, (mpsc::UnboundedSender<Message>, String)>,
    config: RelayConfig,
    nonce_cache: NonceCache,
}

pub struct DeviceEntry {
    pub sender: mpsc::UnboundedSender<Message>,
    pub label: Option<String>,
    pub connected_at: std::time::Instant,
}

impl AppState {
    pub fn new(config: RelayConfig) -> Self {
        let nonce_ttl = config.auth_timeout_secs * 2; // Keep nonces for 2x auth timeout
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

    pub fn add_device(&self, pubkey: &str, sender: mpsc::UnboundedSender<Message>) {
        self.inner.devices.insert(
            pubkey.to_string(),
            DeviceEntry {
                sender,
                label: None,
                connected_at: std::time::Instant::now(),
            },
        );
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

    pub fn connected_device_pubkeys(&self) -> Vec<String> {
        self.inner.devices.iter().map(|e| e.key().clone()).collect()
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
    ) {
        self.inner
            .mcp_clients
            .insert(pubkey.to_string(), (sender, device_pubkey));
    }

    pub fn remove_mcp_client(&self, pubkey: &str) {
        self.inner.mcp_clients.remove(pubkey);
    }

    /// Send data back to the MCP client that is controlling a given device.
    pub fn send_to_mcp_client_for_device(&self, device_pubkey: &str, data: &[u8]) -> bool {
        // Find any MCP client targeting this device
        for entry in self.inner.mcp_clients.iter() {
            let (sender, target) = entry.value();
            if target == device_pubkey {
                if sender
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
}
