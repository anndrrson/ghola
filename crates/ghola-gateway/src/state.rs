use std::sync::Arc;

use sqlx::PgPool;

use said_turnkey::Vault;

use crate::config::Config;
use crate::ip_rate_limit::IpRateLimiter;
use crate::route_cache::RouteCache;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Config,
    /// Shared reqwest client. Reused across all outbound requests for connection
    /// pooling. `redirect(none)` — we want to see merchant origin redirects at
    /// the gateway layer so we can decide whether to forward them verbatim.
    pub http: reqwest::Client,
    pub vault: Arc<dyn Vault>,
    pub cache: Arc<RouteCache>,
    pub ip_rate_limiter: Arc<IpRateLimiter>,
}
