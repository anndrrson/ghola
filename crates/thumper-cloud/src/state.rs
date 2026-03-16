use sqlx::PgPool;

use crate::config::CloudConfig;
use crate::middleware::RateLimiter;

#[derive(Clone)]
pub struct AppState {
    pub config: CloudConfig,
    pub db: PgPool,
    pub rate_limiter: RateLimiter,
}

impl AppState {
    pub fn new(config: CloudConfig, db: PgPool) -> Self {
        Self {
            config,
            db,
            rate_limiter: RateLimiter::default(),
        }
    }
}
