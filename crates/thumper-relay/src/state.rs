use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::ws::Message;
use dashmap::DashMap;
use sha2::{Digest, Sha256};
use std::sync::RwLock;
use tokio::sync::mpsc;

use said_attest::AttestedEnclave;
use thumper_types::{EnclaveKeyId, Envelope, ProviderModelInfo};

use crate::auth::NonceCache;
use crate::config::RelayConfig;
use crate::did_set::DidSet;
use crate::metrics::RelayMetrics;

/// Token bucket rate limiter per connection.
pub struct RateLimiter {
    tokens: f64,
    max_tokens: f64,
    refill_rate: f64,
    pub(crate) last_refill: std::time::Instant,
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
    /// gpu provider pubkey → GpuProviderEntry
    gpu_providers: DashMap<String, GpuProviderEntry>,
    /// job_id → oneshot sender for non-streaming inference responses
    pending_inference: DashMap<String, tokio::sync::oneshot::Sender<Envelope>>,
    /// job_id → mpsc sender for streaming inference chunks
    pending_inference_streams: DashMap<String, mpsc::UnboundedSender<Envelope>>,
    /// Per-device rate limiters (keyed by device pubkey).
    device_rate_limiters: DashMap<String, std::sync::Mutex<RateLimiter>>,
    /// Per-DID rate limiters for sealed inference (keyed by `did:key:z…`
    /// sender DID extracted from the sealed envelope header). The general
    /// HTTP rate limit on the WebSocket path is per-connection, which is
    /// useless for sealed inference: every OHTTP-fronted request arrives
    /// from the same Cloudflare egress IP, so a per-IP limit would gate
    /// the whole user base together. Per-DID is the right granularity —
    /// the DID is the authenticated principal for sealed inference, and
    /// it costs the relay HPKE-decap + envelope verify + did-set check
    /// per request, which is expensive enough to want bounded.
    sealed_did_rate_limiters: DashMap<String, std::sync::Mutex<RateLimiter>>,
    /// Attested enclaves keyed by EnclaveKeyId (sha256-hex of x25519 pub).
    attested_enclaves: DashMap<EnclaveKeyId, Arc<RwLock<AttestedEnclave>>>,
    /// Hash-of-vendor-quote (sha256 hex) -> EnclaveKeyId, for /attestations/:hash lookup.
    attestation_hash_index: DashMap<String, EnclaveKeyId>,
    /// EnclaveKeyId -> vendor_quote_b64 (cached so /attestations/:hash can serve it).
    attestation_quotes: DashMap<EnclaveKeyId, String>,
    config: RelayConfig,
    nonce_cache: NonceCache,
    metrics: RelayMetrics,
    /// In-memory set of registered Ghola DIDs, refreshed from
    /// thumper-cloud. Used by the sealed-inference auth middleware to
    /// reject requests whose `sender_did` is not a registered user
    /// — without ever persisting the user→DID mapping at the relay.
    did_set: DidSet,
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

pub struct GpuProviderEntry {
    pub sender: mpsc::UnboundedSender<Message>,
    pub models: Vec<ProviderModelInfo>,
    pub max_concurrent: u32,
    pub active_jobs: AtomicU32,
    pub wallet_address: String,
    pub last_activity: Arc<AtomicU64>,
}

#[derive(Debug, Clone)]
pub struct PrivateReadiness {
    pub ohttp_enabled: bool,
    pub did_set_bootstrapped: bool,
    pub did_set_fresh: bool,
    pub private_ready: bool,
    pub reason_codes: Vec<String>,
}

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl AppState {
    pub fn new(config: RelayConfig) -> Self {
        Self::new_with_did_set(config, DidSet::new())
    }

    /// Construct with a caller-supplied `DidSet`. Used by tests that need
    /// to pre-populate the membership set without spinning up a refresh
    /// task against a real thumper-cloud.
    pub fn new_with_did_set(config: RelayConfig, did_set: DidSet) -> Self {
        // Nonce TTL must be >= the DID-set max-staleness window. Otherwise:
        // a DID is revoked cloud-side at T, the relay refresh happens at
        // T+staleness, but a replay of a request the now-revoked DID
        // signed pre-revocation would slip through if the nonce had
        // already aged out of the replay cache. By making the nonce TTL
        // strictly >= the staleness window we guarantee any replay is
        // caught either by the membership check (after refresh) or by
        // the nonce cache (before refresh).
        //
        // `auth_timeout_secs * 2` is the historical setting (the auth
        // message lives for `auth_timeout_secs`, the nonce must outlive
        // it by enough to catch in-flight replays). We take the max of
        // that and the configured DID-set staleness to enforce the
        // invariant even if an operator dials the staleness window up.
        let nonce_ttl = (config.auth_timeout_secs * 2).max(config.did_set_max_staleness_secs);
        Self {
            inner: Arc::new(AppStateInner {
                devices: DashMap::new(),
                mcp_clients: DashMap::new(),
                gpu_providers: DashMap::new(),
                pending_inference: DashMap::new(),
                pending_inference_streams: DashMap::new(),
                device_rate_limiters: DashMap::new(),
                sealed_did_rate_limiters: DashMap::new(),
                attested_enclaves: DashMap::new(),
                attestation_hash_index: DashMap::new(),
                attestation_quotes: DashMap::new(),
                config,
                nonce_cache: NonceCache::new(nonce_ttl),
                metrics: RelayMetrics::new(),
                did_set,
            }),
        }
    }

    /// Cloneable handle to the in-memory DID set holder.
    pub fn did_set(&self) -> &DidSet {
        &self.inner.did_set
    }

    pub fn config(&self) -> &RelayConfig {
        &self.inner.config
    }

    pub fn nonce_cache(&self) -> &NonceCache {
        &self.inner.nonce_cache
    }

    pub fn metrics(&self) -> &RelayMetrics {
        &self.inner.metrics
    }

    /// Compute readiness of the sealed private path.
    pub fn private_readiness(&self) -> PrivateReadiness {
        let ohttp_enabled = self.config().ohttp_keypair().is_some();
        let did_set_bootstrapped = self.did_set().is_bootstrapped();
        let now_unix = chrono::Utc::now().timestamp();
        let did_set_fresh = self
            .did_set()
            .is_fresh(now_unix, self.config().did_set_max_staleness_secs);
        let private_ready = ohttp_enabled && did_set_bootstrapped && did_set_fresh;

        let mut reason_codes = Vec::new();
        if !ohttp_enabled {
            reason_codes.push("ohttp_not_ready".to_string());
        }
        if !did_set_bootstrapped {
            reason_codes.push("did_set_not_bootstrapped".to_string());
        } else if !did_set_fresh {
            reason_codes.push("did_set_stale".to_string());
        }

        PrivateReadiness {
            ohttp_enabled,
            did_set_bootstrapped,
            did_set_fresh,
            private_ready,
            reason_codes,
        }
    }

    /// Check rate limit for a specific device. Returns true if allowed.
    pub fn check_device_rate_limit(&self, device_pubkey: &str) -> bool {
        let entry = self
            .inner
            .device_rate_limiters
            .entry(device_pubkey.to_string())
            .or_insert_with(|| std::sync::Mutex::new(RateLimiter::new(10))); // 10 cmd/sec per device
        let result = entry
            .value()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_consume();
        result
    }

    /// Check the per-DID rate limit for the sealed-inference path.
    /// Returns true if allowed. Initialises a token bucket on first use
    /// at `rate_per_second` tokens/sec, max burst = `rate_per_second`.
    ///
    /// Per-DID (rather than per-IP or per-connection) because the OHTTP
    /// front-end collapses all client IPs onto Cloudflare's egress range,
    /// and sealed-inference is stateless HTTP so there is no long-lived
    /// connection to attach a per-connection limiter to.
    pub fn check_sealed_did_rate_limit(&self, sender_did: &str, rate_per_second: u32) -> bool {
        let entry = self
            .inner
            .sealed_did_rate_limiters
            .entry(sender_did.to_string())
            .or_insert_with(|| std::sync::Mutex::new(RateLimiter::new(rate_per_second)));
        let result = entry
            .value()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_consume();
        result
    }

    /// Drop per-DID rate-limiter buckets that haven't been touched in a
    /// while. Bounded growth: without this, an adversary could open many
    /// short-lived DIDs and grow the map indefinitely. Called from the
    /// heartbeat loop.
    pub fn prune_sealed_did_rate_limiters(&self, max_idle_secs: u64) {
        let now = std::time::Instant::now();
        let max_idle = std::time::Duration::from_secs(max_idle_secs);
        self.inner.sealed_did_rate_limiters.retain(|_, m| {
            let g = m.lock().unwrap_or_else(|e| e.into_inner());
            now.duration_since(g.last_refill) < max_idle
        });
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

    // -- GPU provider connections --

    pub fn add_gpu_provider(
        &self,
        pubkey: &str,
        sender: mpsc::UnboundedSender<Message>,
        models: Vec<ProviderModelInfo>,
        max_concurrent: u32,
        wallet_address: String,
    ) -> Arc<AtomicU64> {
        let last_activity = Arc::new(AtomicU64::new(now_epoch_secs()));
        let activity_clone = last_activity.clone();
        self.inner.gpu_providers.insert(
            pubkey.to_string(),
            GpuProviderEntry {
                sender,
                models,
                max_concurrent,
                active_jobs: AtomicU32::new(0),
                wallet_address,
                last_activity,
            },
        );
        activity_clone
    }

    pub fn remove_gpu_provider(&self, pubkey: &str) {
        self.inner.gpu_providers.remove(pubkey);
    }

    pub fn send_to_gpu_provider(&self, pubkey: &str, data: &[u8]) -> bool {
        if let Some(entry) = self.inner.gpu_providers.get(pubkey) {
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

    pub fn gpu_provider_count(&self) -> usize {
        self.inner.gpu_providers.len()
    }

    /// Returns (provider_pubkey, ProviderModelInfo) for all providers serving the given model.
    pub fn find_providers_for_model(&self, model_id: &str) -> Vec<(String, ProviderModelInfo)> {
        let mut results = Vec::new();
        for entry in self.inner.gpu_providers.iter() {
            for model in &entry.value().models {
                if model.model_id == model_id {
                    results.push((entry.key().clone(), model.clone()));
                }
            }
        }
        results
    }

    /// Update heartbeat data for a GPU provider.
    pub fn update_gpu_provider_heartbeat(
        &self,
        pubkey: &str,
        active_jobs: u32,
        models: Vec<String>,
    ) {
        if let Some(entry) = self.inner.gpu_providers.get(pubkey) {
            entry.last_activity.store(now_epoch_secs(), Ordering::Relaxed);
            entry.active_jobs.store(active_jobs, Ordering::Relaxed);
            // `models` from heartbeat is a Vec<String> of model IDs — used for logging/monitoring.
            // The full ProviderModelInfo list stays as advertised.
            let _ = models; // acknowledged but model pricing doesn't change on heartbeat
        }
    }

    /// Get provider's active_jobs and max_concurrent for concurrency checks.
    pub fn gpu_provider_concurrency(&self, pubkey: &str) -> Option<(u32, u32)> {
        self.inner.gpu_providers.get(pubkey).map(|entry| {
            (
                entry.active_jobs.load(Ordering::Relaxed),
                entry.max_concurrent,
            )
        })
    }

    /// Increment active_jobs for a provider. Returns the new count.
    pub fn increment_gpu_provider_jobs(&self, pubkey: &str) -> Option<u32> {
        self.inner.gpu_providers.get(pubkey).map(|entry| {
            entry.active_jobs.fetch_add(1, Ordering::Relaxed) + 1
        })
    }

    /// Decrement active_jobs for a provider.
    pub fn decrement_gpu_provider_jobs(&self, pubkey: &str) {
        if let Some(entry) = self.inner.gpu_providers.get(pubkey) {
            let prev = entry.active_jobs.load(Ordering::Relaxed);
            if prev > 0 {
                entry.active_jobs.fetch_sub(1, Ordering::Relaxed);
            }
        }
    }

    // -- Pending inference maps --

    pub fn register_pending_inference(
        &self,
        job_id: &str,
        sender: tokio::sync::oneshot::Sender<Envelope>,
    ) {
        self.inner
            .pending_inference
            .insert(job_id.to_string(), sender);
    }

    pub fn resolve_pending_inference(&self, job_id: &str, envelope: Envelope) {
        if let Some((_, sender)) = self.inner.pending_inference.remove(job_id) {
            let _ = sender.send(envelope);
        }
    }

    pub fn register_pending_inference_stream(
        &self,
        job_id: &str,
        sender: mpsc::UnboundedSender<Envelope>,
    ) {
        self.inner
            .pending_inference_streams
            .insert(job_id.to_string(), sender);
    }

    pub fn send_to_pending_inference_stream(&self, job_id: &str, envelope: Envelope) -> bool {
        if let Some(entry) = self.inner.pending_inference_streams.get(job_id) {
            entry.value().send(envelope).is_ok()
        } else {
            false
        }
    }

    pub fn remove_pending_inference_stream(&self, job_id: &str) {
        self.inner.pending_inference_streams.remove(job_id);
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

        // Ping GPU providers and collect dead ones
        let dead_gpu_providers: Vec<String> = self
            .inner
            .gpu_providers
            .iter()
            .filter_map(|entry| {
                if entry.value().sender.send(ping.clone()).is_err() {
                    Some(entry.key().clone())
                } else {
                    None
                }
            })
            .collect();

        for pubkey in &dead_gpu_providers {
            self.inner.gpu_providers.remove(pubkey);
            tracing::info!(pubkey = %pubkey, "removed dead gpu provider connection");
        }

        if !dead_devices.is_empty() || !dead_clients.is_empty() || !dead_gpu_providers.is_empty() {
            tracing::info!(
                dead_devices = dead_devices.len(),
                dead_clients = dead_clients.len(),
                dead_gpu_providers = dead_gpu_providers.len(),
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

        let stale_gpu_providers: Vec<String> = self
            .inner
            .gpu_providers
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

        for pubkey in &stale_gpu_providers {
            self.inner.gpu_providers.remove(pubkey);
            tracing::warn!(pubkey = %pubkey, "removed stale gpu provider (no activity)");
        }

        // Clean up rate limiters for devices that are no longer connected
        self.inner.device_rate_limiters.retain(|key, _| {
            self.inner.devices.contains_key(key)
        });
    }

    // -- Attested enclaves --

    /// Compute sha256(decoded vendor_quote_b64) -> hex. Used as the
    /// /attestations/:hash lookup key.
    pub fn compute_attestation_hash(vendor_quote_b64: &str) -> String {
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(vendor_quote_b64)
            .unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(&decoded);
        hex::encode(hasher.finalize())
    }

    /// Insert an attested enclave. Also caches the vendor_quote_b64 so
    /// `find_attestation_by_hash` can return it later.
    pub fn insert_attested_enclave(
        &self,
        enclave: AttestedEnclave,
        vendor_quote_b64: String,
    ) -> EnclaveKeyId {
        let key_id = enclave.enclave_key_id.clone();
        let attestation_hash = Self::compute_attestation_hash(&vendor_quote_b64);
        self.inner
            .attested_enclaves
            .insert(key_id.clone(), Arc::new(RwLock::new(enclave)));
        self.inner
            .attestation_hash_index
            .insert(attestation_hash, key_id.clone());
        self.inner
            .attestation_quotes
            .insert(key_id.clone(), vendor_quote_b64);
        key_id
    }

    /// Get a clone of the attested enclave with the given key id.
    pub fn get_attested_enclave(&self, key_id: &EnclaveKeyId) -> Option<AttestedEnclave> {
        self.inner
            .attested_enclaves
            .get(key_id)
            .map(|entry| entry.value().read().unwrap_or_else(|e| e.into_inner()).clone())
    }

    /// List all currently attested enclaves (clones).
    pub fn list_attested_enclaves(&self) -> Vec<AttestedEnclave> {
        self.inner
            .attested_enclaves
            .iter()
            .map(|entry| entry.value().read().unwrap_or_else(|e| e.into_inner()).clone())
            .collect()
    }

    /// Remove all entries whose `expires_at_unix < now_unix`. Returns count removed.
    pub fn prune_expired_enclaves(&self, now_unix: i64) -> usize {
        let expired: Vec<EnclaveKeyId> = self
            .inner
            .attested_enclaves
            .iter()
            .filter_map(|entry| {
                let enclave = entry.value().read().unwrap_or_else(|e| e.into_inner());
                if enclave.expires_at_unix < now_unix {
                    Some(entry.key().clone())
                } else {
                    None
                }
            })
            .collect();

        let count = expired.len();
        for key_id in &expired {
            self.inner.attested_enclaves.remove(key_id);
            self.inner.attestation_quotes.remove(key_id);
        }
        // Drop any hash-index entries that now point nowhere.
        self.inner
            .attestation_hash_index
            .retain(|_, v| self.inner.attested_enclaves.contains_key(v));
        count
    }

    /// Look up an attested enclave by sha256-hex of the decoded vendor quote.
    /// Returns the enclave plus the cached `vendor_quote_b64`.
    pub fn find_attestation_by_hash(
        &self,
        attestation_hash_hex: &str,
    ) -> Option<(AttestedEnclave, String)> {
        let key_id = self
            .inner
            .attestation_hash_index
            .get(attestation_hash_hex)
            .map(|e| e.value().clone())?;
        let enclave = self.get_attested_enclave(&key_id)?;
        let quote = self
            .inner
            .attestation_quotes
            .get(&key_id)
            .map(|e| e.value().clone())?;
        Some((enclave, quote))
    }

    /// Look up the provider WebSocket session id (long-lived auth pubkey)
    /// bound to an enclave_key_id. Returns `None` if the enclave is unknown.
    pub fn provider_for_enclave(&self, key_id: &EnclaveKeyId) -> Option<String> {
        self.inner
            .attested_enclaves
            .get(key_id)
            .map(|entry| entry.value().read().unwrap_or_else(|e| e.into_inner()).provider_id.clone())
    }
}
