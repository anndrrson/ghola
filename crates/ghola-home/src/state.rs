use dashmap::DashMap;
use sqlx::SqlitePool;
use std::sync::Arc;

use crate::config::HomeConfig;

#[derive(Clone)]
pub struct PairedDevice {
    pub device_name: String,
    pub paired_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone)]
pub struct HomeState {
    pub config: HomeConfig,
    pub db: SqlitePool,
    pub paired_devices: Arc<DashMap<String, PairedDevice>>,
}

impl HomeState {
    pub fn new(config: HomeConfig, db: SqlitePool) -> Self {
        Self {
            config,
            db,
            paired_devices: Arc::new(DashMap::new()),
        }
    }
}
