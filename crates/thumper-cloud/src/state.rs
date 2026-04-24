use dashmap::DashMap;
use said_turnkey::Vault;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::config::CloudConfig;
use crate::middleware::{IpRateLimiter, RateLimiter};
use crate::services::llm_router::FreeCascade;

/// Cached info about an online community GPU provider.
#[derive(Clone)]
pub struct CommunityProviderInfo {
    pub provider_id: uuid::Uuid,
    pub relay_pubkey: String,
    pub display_name: String,
    pub models: serde_json::Value,
    pub reputation_score: f64,
    pub current_load: i32,
    pub max_concurrent: i32,
}

pub type ComputeProviderCache = Arc<Mutex<Vec<CommunityProviderInfo>>>;

/// Broadcast channels for real-time swarm progress events (JSON strings).
pub type SwarmChannels = Arc<DashMap<uuid::Uuid, tokio::sync::broadcast::Sender<String>>>;

#[derive(Clone)]
pub struct AppState {
    pub config: CloudConfig,
    pub db: PgPool,
    pub vault: Arc<dyn Vault>,
    pub rate_limiter: RateLimiter,
    pub ip_rate_limiter: IpRateLimiter,
    pub free_cascade: FreeCascade,
    pub compute_cache: ComputeProviderCache,
    pub swarm_channels: SwarmChannels,
}

impl AppState {
    pub fn new(config: CloudConfig, db: PgPool, vault: Arc<dyn Vault>) -> Self {
        let free_cascade = FreeCascade::new(&config);
        Self {
            config,
            db,
            vault,
            rate_limiter: RateLimiter::default(),
            ip_rate_limiter: IpRateLimiter::default(),
            free_cascade,
            compute_cache: Arc::new(Mutex::new(Vec::new())),
            swarm_channels: Arc::new(DashMap::new()),
        }
    }
}
