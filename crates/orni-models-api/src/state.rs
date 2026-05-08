use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use sqlx::PgPool;
use tokio::sync::Mutex;

use crate::auth::NonceStore;
use crate::config::Config;
use crate::services::screening::Screener;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Config,
    pub http_client: reqwest::Client,
    pub nonce_store: Arc<NonceStore>,
    pub guest_rate_limits: Arc<Mutex<HashMap<IpAddr, Vec<Instant>>>>,
    pub auth_rate_limiter: Arc<AuthRateLimiter>,
    /// Escrow wallet keypair for on-chain stablecoin settlements.
    /// None if no keypair is configured (Stripe-only mode).
    pub escrow_keypair: Option<[u8; 64]>,
    /// Sanctions / risk-screening backend for incoming deposits. Default is
    /// the no-op screener; production should swap in a real backend.
    pub screener: Arc<dyn Screener>,
}

/// Simple rate limiter for auth endpoints (login/register).
/// Tracks attempts per key (email) with a sliding window.
pub struct AuthRateLimiter {
    attempts: StdMutex<HashMap<String, Vec<Instant>>>,
}

impl AuthRateLimiter {
    pub fn new() -> Self {
        Self {
            attempts: StdMutex::new(HashMap::new()),
        }
    }

    /// Check if an action is allowed. Returns Err with seconds to wait if rate limited.
    /// max_attempts per window_secs.
    pub fn check(&self, key: &str, max_attempts: u32, window_secs: u64) -> Result<(), u64> {
        let mut map = match self.attempts.lock() {
            Ok(m) => m,
            Err(p) => p.into_inner(),
        };
        let now = Instant::now();
        let window = Duration::from_secs(window_secs);

        let entries = map.entry(key.to_string()).or_default();
        entries.retain(|t| now.duration_since(*t) < window);

        if entries.len() >= max_attempts as usize {
            let retry_after = window
                .as_secs()
                .saturating_sub(entries.first().map(|t| now.duration_since(*t).as_secs()).unwrap_or(0));
            return Err(retry_after.max(1));
        }

        entries.push(now);

        // Periodic cleanup of stale keys
        if map.len() > 10_000 {
            map.retain(|_, entries| {
                entries.retain(|t| now.duration_since(*t) < window);
                !entries.is_empty()
            });
        }

        Ok(())
    }
}
