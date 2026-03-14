use sqlx::PgPool;

use crate::config::CloudConfig;

#[derive(Clone)]
pub struct AppState {
    pub config: CloudConfig,
    pub db: PgPool,
}

impl AppState {
    pub fn new(config: CloudConfig, db: PgPool) -> Self {
        Self { config, db }
    }
}
