use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    /// Rake the platform takes from every successful proxied call, in basis
    /// points (100 = 1%). Default matches `service_listings.platform_fee_bps`.
    pub platform_fee_bps: i32,
    /// How long to cache resolved proxy routes in memory before re-reading
    /// from Postgres. Short enough that revocations propagate fast, long
    /// enough that the hot path isn't DB-bound.
    pub route_cache_ttl_secs: u64,
    /// Upstream request timeout. If a merchant's origin hangs past this, the
    /// caller gets a 504 and an x402 refund header. Keep it tight enough that
    /// a hung merchant doesn't tie up gateway workers.
    pub upstream_timeout_secs: u64,
    /// After this many consecutive upstream failures in a 60s window, open
    /// the per-merchant circuit breaker and stop routing calls for
    /// `circuit_open_secs`. Prevents cascading failures.
    pub circuit_failure_threshold: u32,
    pub circuit_open_secs: i64,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL").expect("DATABASE_URL required"),
            bind_addr: env::var("BIND_ADDR")
                .or_else(|_| env::var("PORT").map(|p| format!("0.0.0.0:{p}")))
                .unwrap_or_else(|_| "0.0.0.0:8090".into()),
            platform_fee_bps: env::var("PLATFORM_FEE_BPS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(300),
            route_cache_ttl_secs: env::var("ROUTE_CACHE_TTL_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30),
            upstream_timeout_secs: env::var("UPSTREAM_TIMEOUT_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30),
            circuit_failure_threshold: env::var("CIRCUIT_FAILURE_THRESHOLD")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3),
            circuit_open_secs: env::var("CIRCUIT_OPEN_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(60),
        }
    }
}
