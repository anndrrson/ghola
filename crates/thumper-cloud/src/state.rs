use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::Mutex;
use sqlx::PgPool;
use dashmap::DashMap;

use crate::config::CloudConfig;
use crate::middleware::{IpRateLimiter, RateLimiter};
use crate::services::llm_router::FreeCascade;

/// In-memory record of a SIWS challenge that the server has issued but not
/// yet seen redeemed. We store the *exact* challenge bytes the server minted
/// so that `siws_sign_in` can byte-equal compare them against the challenge
/// the client claims to have signed — closes a MITM substitution flaw where
/// a man-in-the-middle could replace the issued challenge with an
/// attacker-chosen domain-prefixed message (e.g. `ghola/vault-unlock-v1 …`),
/// trick the user into signing it, and then submit the resulting signature
/// with the original nonce.
#[derive(Clone, Debug)]
pub struct SiwsChallengeRecord {
    pub nonce: String,
    pub challenge_text: String,
    pub expires_at: i64,
}

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
pub type SiwsChallengeStore = Arc<Mutex<HashMap<String, SiwsChallengeRecord>>>;

#[derive(Clone)]
pub struct AppState {
    pub config: CloudConfig,
    pub db: PgPool,
    pub rate_limiter: RateLimiter,
    pub ip_rate_limiter: IpRateLimiter,
    pub free_cascade: FreeCascade,
    pub compute_cache: ComputeProviderCache,
    pub swarm_channels: SwarmChannels,
    pub siws_challenges: SiwsChallengeStore,
}

impl AppState {
    pub fn new(config: CloudConfig, db: PgPool) -> Self {
        let free_cascade = FreeCascade::new(&config);
        Self {
            config,
            db,
            rate_limiter: RateLimiter::default(),
            ip_rate_limiter: IpRateLimiter::default(),
            free_cascade,
            compute_cache: Arc::new(Mutex::new(Vec::new())),
            swarm_channels: Arc::new(DashMap::new()),
            siws_challenges: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
