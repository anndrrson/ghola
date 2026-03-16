use std::sync::Arc;
use tokio::sync::Mutex;
use sqlx::PgPool;

use crate::config::CloudConfig;
use crate::middleware::RateLimiter;
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

#[derive(Clone)]
pub struct AppState {
    pub config: CloudConfig,
    pub db: PgPool,
    pub rate_limiter: RateLimiter,
    pub free_cascade: FreeCascade,
    pub compute_cache: ComputeProviderCache,
}

impl AppState {
    pub fn new(config: CloudConfig, db: PgPool) -> Self {
        let free_cascade = FreeCascade::new(&config);
        Self {
            config,
            db,
            rate_limiter: RateLimiter::default(),
            free_cascade,
            compute_cache: Arc::new(Mutex::new(Vec::new())),
        }
    }
}
