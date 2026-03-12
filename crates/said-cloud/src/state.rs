use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sqlx::PgPool;

use crate::config::Config;

pub struct RateLimiter {
    requests: Mutex<HashMap<String, Vec<Instant>>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
        }
    }

    /// Check if a request is allowed. Returns Ok(()) or Err with retry-after seconds.
    pub fn check(&self, key: &str, max_per_minute: u32) -> Result<(), u64> {
        let mut map = self.requests.lock().unwrap();
        let now = Instant::now();
        let window = Duration::from_secs(60);

        let entries = map.entry(key.to_string()).or_default();
        entries.retain(|t| now.duration_since(*t) < window);

        if entries.len() >= max_per_minute as usize {
            let oldest = entries.first().unwrap();
            let retry_after = window.as_secs() - now.duration_since(*oldest).as_secs();
            return Err(retry_after);
        }

        entries.push(now);
        Ok(())
    }
}

pub struct UsageMeter {
    counts: Mutex<HashMap<String, u64>>,
}

impl UsageMeter {
    pub fn new() -> Self {
        Self {
            counts: Mutex::new(HashMap::new()),
        }
    }

    pub fn increment(&self, user_id: &str) {
        let mut map = self.counts.lock().unwrap();
        *map.entry(user_id.to_string()).or_insert(0) += 1;
    }

    pub fn get_count(&self, user_id: &str) -> u64 {
        let map = self.counts.lock().unwrap();
        map.get(user_id).copied().unwrap_or(0)
    }

    pub async fn flush_to_db(&self, db: &PgPool) -> Result<usize, sqlx::Error> {
        let entries: HashMap<String, u64> = {
            let mut map = self.counts.lock().unwrap();
            std::mem::take(&mut *map)
        };
        let count = entries.len();
        for (user_id, cnt) in &entries {
            if let Ok(uid) = user_id.parse::<uuid::Uuid>() {
                sqlx::query(
                    "INSERT INTO usage_records (user_id, endpoint, count, period_start, period_end) \
                     VALUES ($1, 'api', $2, CURRENT_DATE, CURRENT_DATE)"
                )
                .bind(uid)
                .bind(*cnt as i32)
                .execute(db)
                .await?;
            }
        }
        Ok(count)
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Config,
    pub http_client: reqwest::Client,
    pub rate_limiter: Arc<RateLimiter>,
    pub usage_meter: Arc<UsageMeter>,
}
