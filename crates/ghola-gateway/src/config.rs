use std::env;

/// Per-stablecoin entry in the gateway's accepted-mints list.
#[derive(Debug, Clone)]
pub struct AcceptedMint {
    pub symbol: String,
    pub mint_b58: String,
    pub decimals: u8,
    pub paused: bool,
}

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
    /// Temporary safety valve. When false (default), inbound x402 headers are
    /// trusted only after on-chain verification. When true, legacy behavior
    /// accepts syntactically-valid x402 headers without on-chain checks.
    pub allow_unverified_xpayment: bool,
    /// Solana RPC URL used for x402 payment verification.
    pub solana_rpc_url: String,
    /// Platform escrow wallet that should receive inbound x402 USDC transfers.
    pub escrow_wallet_address: Option<String>,
    /// Maximum accepted x402 transaction age in seconds.
    pub x402_max_tx_age_secs: i64,
    /// Timeout for Solana RPC verification calls.
    pub x402_verify_timeout_secs: u64,
    /// Flat per-IP request cap on the public gateway ingress.
    pub rate_limit_per_minute: u32,
    /// Upper bound for in-memory distinct IP buckets kept by the edge limiter.
    pub rate_limit_max_keys: usize,
    /// Hard cap on inbound request body size at the gateway edge.
    pub max_request_body_bytes: usize,
    /// Browser origins allowed to call the gateway directly.
    pub allowed_origins: String,
    /// Whether to trust client IP/scheme headers from a known proxy.
    pub trust_proxy_headers: bool,
    /// Stablecoins this gateway accepts in 402 challenges. Ordered, primary
    /// first. The verify path accepts payment in any non-paused mint here.
    pub accepted_mints: Vec<AcceptedMint>,
    /// Symbol of the primary stablecoin (e.g. "USDT"). Drives challenge
    /// ordering and the legacy single-mint fallback path.
    pub primary_mint_symbol: String,
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
            allow_unverified_xpayment: env::var("ALLOW_UNVERIFIED_XPAYMENT")
                .ok()
                .map(|s| parse_bool(&s))
                .unwrap_or(false),
            solana_rpc_url: env::var("SOLANA_RPC_URL")
                .unwrap_or_else(|_| "https://api.devnet.solana.com".into()),
            escrow_wallet_address: env::var("ESCROW_WALLET_ADDRESS")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty()),
            x402_max_tx_age_secs: env::var("X402_MAX_TX_AGE_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(600),
            x402_verify_timeout_secs: env::var("X402_VERIFY_TIMEOUT_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(8),
            rate_limit_per_minute: env::var("GATEWAY_RATE_LIMIT_PER_MINUTE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(120),
            rate_limit_max_keys: env::var("GATEWAY_RATE_LIMIT_MAX_KEYS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(50_000),
            max_request_body_bytes: env::var("GATEWAY_MAX_REQUEST_BODY_BYTES")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(10 * 1024 * 1024),
            allowed_origins: env::var("ALLOWED_ORIGINS")
                .unwrap_or_else(|_| "https://ghola.xyz,https://www.ghola.xyz,http://localhost:3000".into()),
            trust_proxy_headers: env::var("TRUST_PROXY_HEADERS")
                .ok()
                .map(|s| parse_bool(&s))
                .unwrap_or(false),
            accepted_mints: load_accepted_mints(
                &env::var("SOLANA_RPC_URL")
                    .unwrap_or_else(|_| "https://api.devnet.solana.com".into()),
            ),
            primary_mint_symbol: env::var("PRIMARY_STABLECOIN")
                .unwrap_or_else(|_| "USDT".into())
                .to_uppercase(),
        }
    }

    /// Look up an accepted-and-not-paused mint by base58.
    pub fn find_mint(&self, mint_b58: &str) -> Option<&AcceptedMint> {
        self.accepted_mints
            .iter()
            .find(|m| m.mint_b58 == mint_b58 && !m.paused)
    }

    /// Look up by symbol (case-insensitive).
    pub fn find_symbol(&self, symbol: &str) -> Option<&AcceptedMint> {
        self.accepted_mints
            .iter()
            .find(|m| m.symbol.eq_ignore_ascii_case(symbol) && !m.paused)
    }
}

fn load_accepted_mints(solana_rpc_url: &str) -> Vec<AcceptedMint> {
    let is_devnet = solana_rpc_url.contains("devnet") || solana_rpc_url.contains("localhost");
    let accepted_csv = env::var("ACCEPTED_STABLECOINS").unwrap_or_else(|_| "USDT,USDC".into());
    let mut out = Vec::new();
    for raw in accepted_csv.split(',') {
        let symbol = raw.trim().to_uppercase();
        if symbol.is_empty() {
            continue;
        }
        let registry = match said_solana::spl::token_for_symbol(&symbol) {
            Some(t) => t,
            None => {
                tracing::warn!("ACCEPTED_STABLECOINS has unknown symbol: {}", symbol);
                continue;
            }
        };
        let env_mint_var = format!("{}_MINT", symbol);
        let mint_b58 = env::var(&env_mint_var).unwrap_or_else(|_| {
            let default = registry.mint_b58(is_devnet);
            if default.is_empty() {
                panic!(
                    "{} has no canonical mint on this network — set {} env var",
                    symbol, env_mint_var
                );
            }
            default.to_string()
        });
        let pause_var = format!("STABLECOIN_{}_PAUSED", symbol);
        let paused = env::var(&pause_var)
            .map(|s| parse_bool(&s))
            .unwrap_or(false);
        out.push(AcceptedMint {
            symbol: registry.symbol.to_string(),
            mint_b58,
            decimals: registry.decimals,
            paused,
        });
    }
    out
}

fn parse_bool(v: &str) -> bool {
    matches!(v, "1" | "true" | "TRUE" | "yes" | "YES")
}
