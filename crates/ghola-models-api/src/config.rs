use std::env;

const DEV_JWT_SECRET: &str = "dev-secret-change-me";

/// Per-stablecoin configuration. Loaded from env at startup, then frozen.
#[derive(Debug, Clone)]
pub struct TokenConfig {
    pub symbol: String,
    /// Base58 mint address active on the configured Solana network. Set per
    /// `solana_rpc_url`: mainnet RPC → mainnet mint, devnet RPC → devnet mint.
    pub mint_b58: String,
    pub decimals: u8,
    /// When true, deposits and payouts in this currency are rejected. Used as
    /// the runtime depeg / freeze response lever.
    pub paused: bool,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    pub jwt_secret: String,
    pub together_api_key: String,
    pub together_base_url: String,
    pub default_base_model: String,
    pub solana_rpc_url: String,
    /// Stablecoins accepted for deposits and payouts. The first non-paused
    /// entry is the platform default (presented first in pickers, used as the
    /// fallback when a request omits `currency`).
    pub accepted_tokens: Vec<TokenConfig>,
    /// Symbol of the primary stablecoin (e.g., "USDT"). Drives UI defaults and
    /// x402 challenge ordering. Must appear in `accepted_tokens`.
    pub primary_token: String,
    /// Legacy single-currency mint string. Retained for backwards compatibility
    /// with callers that haven't migrated to `accepted_tokens` yet; it always
    /// equals the primary token's mint.
    pub usdc_mint: String,
    pub escrow_wallet_address: String,
    pub escrow_keypair_path: Option<String>,
    pub r2_endpoint: Option<String>,
    pub r2_access_key: Option<String>,
    pub r2_secret_key: Option<String>,
    pub r2_bucket: String,
    pub platform_share_bps: u32, // basis points (1500 = 15%)
    pub anthropic_api_key: String,
    pub said_cloud_url: String,
    pub stripe_secret_key: Option<String>,
    pub stripe_webhook_secret: Option<String>,
    pub frontend_url: String,
    pub platform_did: String,
    /// x402 acceptance for unauthenticated agentic payment.
    /// Off by default — re-enabling requires a verified facilitator URL.
    pub x402_enabled: bool,
    /// x402 facilitator that verifies + settles X-Payment payloads. We don't
    /// trust the X-Payment header on its own; the facilitator confirms the
    /// on-chain transfer landed.
    pub x402_facilitator_url: String,
    /// Network identifier echoed in the 402 paymentRequirements. CAIP-2 style
    /// for Solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" (mainnet genesis).
    pub x402_network: String,
    /// Phase 3.5: per-user-per-day withdrawal cap, in micro-units (USD-equivalent).
    /// Cap applies across all currencies combined.
    pub daily_withdrawal_limit_micro: i64,
    /// Withdrawals at or above this threshold (micro-units, USD-equivalent)
    /// require a second admin to approve before settlement picks them up.
    pub large_withdrawal_threshold_micro: i64,
}

impl Config {
    pub fn from_env() -> Self {
        let runtime_env = env::var("APP_ENV")
            .or_else(|_| env::var("ENVIRONMENT"))
            .or_else(|_| env::var("RUST_ENV"))
            .unwrap_or_else(|_| "development".into());
        let is_local = matches!(
            runtime_env.as_str(),
            "development" | "dev" | "local" | "test" | "testing"
        );
        let jwt_secret = env::var("JWT_SECRET").unwrap_or_else(|_| {
            if is_local {
                DEV_JWT_SECRET.into()
            } else {
                panic!("JWT_SECRET required outside local/test environments")
            }
        });
        if !is_local && jwt_secret == DEV_JWT_SECRET {
            panic!(
                "JWT_SECRET must not use the development sentinel outside local/test environments"
            );
        }

        let solana_rpc_url =
            env::var("SOLANA_RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".into());
        let is_devnet = solana_rpc_url.contains("devnet") || solana_rpc_url.contains("localhost");

        let (accepted_tokens, primary_token) = load_accepted_tokens(is_devnet);
        // Legacy `usdc_mint` field equals the primary token's active mint so
        // any caller that still reads it gets the right address.
        let primary = accepted_tokens
            .iter()
            .find(|t| t.symbol.eq_ignore_ascii_case(&primary_token))
            .expect("primary token must be in accepted_tokens");
        let primary_mint = primary.mint_b58.clone();

        Self {
            database_url: env::var("DATABASE_URL").expect("DATABASE_URL required"),
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            jwt_secret,
            together_api_key: env::var("TOGETHER_API_KEY").unwrap_or_default(),
            together_base_url: env::var("TOGETHER_BASE_URL")
                .unwrap_or_else(|_| "https://api.together.xyz/v1".into()),
            default_base_model: env::var("DEFAULT_BASE_MODEL")
                .unwrap_or_else(|_| "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo".into()),
            solana_rpc_url,
            accepted_tokens,
            primary_token,
            usdc_mint: primary_mint,
            escrow_wallet_address: env::var("ESCROW_WALLET_ADDRESS").unwrap_or_default(),
            escrow_keypair_path: env::var("ESCROW_KEYPAIR_PATH").ok(),
            r2_endpoint: env::var("R2_ENDPOINT").ok(),
            r2_access_key: env::var("R2_ACCESS_KEY").ok(),
            r2_secret_key: env::var("R2_SECRET_KEY").ok(),
            r2_bucket: env::var("R2_BUCKET").unwrap_or_else(|_| "orni-models".into()),
            platform_share_bps: env::var("PLATFORM_SHARE_BPS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1500),
            anthropic_api_key: env::var("ANTHROPIC_API_KEY").unwrap_or_default(),
            said_cloud_url: env::var("SAID_CLOUD_URL")
                .unwrap_or_else(|_| "http://localhost:8080".into()),
            stripe_secret_key: env::var("STRIPE_SECRET_KEY").ok(),
            stripe_webhook_secret: env::var("STRIPE_WEBHOOK_SECRET").ok(),
            frontend_url: env::var("FRONTEND_URL")
                .unwrap_or_else(|_| "http://localhost:3000".into()),
            platform_did: env::var("PLATFORM_DID")
                .unwrap_or_else(|_| "did:key:orni-models-platform".into()),
            x402_enabled: env::var("X402_ENABLED")
                .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes"))
                .unwrap_or(false),
            x402_facilitator_url: env::var("X402_FACILITATOR_URL")
                .unwrap_or_else(|_| "https://x402.org/facilitator".into()),
            x402_network: env::var("X402_NETWORK")
                .unwrap_or_else(|_| "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp".into()),
            daily_withdrawal_limit_micro: env::var("DAILY_WITHDRAWAL_LIMIT_USD")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(2_000)
                * 1_000_000,
            large_withdrawal_threshold_micro: env::var("LARGE_WITHDRAWAL_THRESHOLD_USD")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(10_000)
                * 1_000_000,
        }
    }

    /// Look up an accepted token by symbol, returning None for unknown or
    /// paused tokens. Use `find_token_unchecked` to inspect paused state.
    pub fn find_token(&self, symbol: &str) -> Option<&TokenConfig> {
        self.accepted_tokens
            .iter()
            .find(|t| t.symbol.eq_ignore_ascii_case(symbol) && !t.paused)
    }

    /// Look up an accepted token by symbol regardless of pause state.
    pub fn find_token_unchecked(&self, symbol: &str) -> Option<&TokenConfig> {
        self.accepted_tokens
            .iter()
            .find(|t| t.symbol.eq_ignore_ascii_case(symbol))
    }

    /// Look up an accepted token by its on-chain base58 mint address.
    pub fn find_token_by_mint(&self, mint_b58: &str) -> Option<&TokenConfig> {
        self.accepted_tokens.iter().find(|t| t.mint_b58 == mint_b58)
    }

    /// True if the configured RPC URL points at a devnet/local cluster.
    pub fn is_devnet(&self) -> bool {
        self.solana_rpc_url.contains("devnet") || self.solana_rpc_url.contains("localhost")
    }
}

/// Load the accepted-tokens list from env. Defaults: USDT primary, USDC
/// secondary, both with canonical Solana mints (or env-overridden for devnet
/// where USDT has no canonical mint and operators must deploy a test SPL).
fn load_accepted_tokens(is_devnet: bool) -> (Vec<TokenConfig>, String) {
    let primary_token = env::var("PRIMARY_STABLECOIN")
        .unwrap_or_else(|_| "USDT".into())
        .to_uppercase();

    let accepted_csv = env::var("ACCEPTED_STABLECOINS").unwrap_or_else(|_| "USDT,USDC".into());
    let symbols: Vec<String> = accepted_csv
        .split(',')
        .map(|s| s.trim().to_uppercase())
        .filter(|s| !s.is_empty())
        .collect();

    let mut tokens = Vec::new();
    for symbol in &symbols {
        let Some(registry_token) = said_solana::spl::token_for_symbol(symbol) else {
            tracing::warn!(
                symbol = %symbol,
                "ACCEPTED_STABLECOINS lists unknown symbol — skipping"
            );
            continue;
        };

        let env_mint_var = format!("{}_MINT", symbol);
        let mint_b58 = match env::var(&env_mint_var) {
            Ok(v) if !v.is_empty() => v,
            _ => {
                let default = registry_token.mint_b58(is_devnet);
                if default.is_empty() {
                    // No canonical mint on the active network and no env
                    // override — drop the token with a warning instead of
                    // panicking so the service can still serve other
                    // stablecoins. Operators who need this token must set
                    // <SYMBOL>_MINT to a network-specific mint.
                    tracing::warn!(
                        symbol = %symbol,
                        env_var = %env_mint_var,
                        is_devnet,
                        "no canonical mint for stablecoin on this network — token disabled"
                    );
                    continue;
                }
                default.to_string()
            }
        };

        let pause_var = format!("STABLECOIN_{}_PAUSED", symbol);
        let paused = env::var(&pause_var)
            .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes"))
            .unwrap_or(false);

        tokens.push(TokenConfig {
            symbol: registry_token.symbol.to_string(),
            mint_b58,
            decimals: registry_token.decimals,
            paused,
        });
    }

    if tokens.is_empty() {
        panic!(
            "no stablecoins available — ACCEPTED_STABLECOINS={:?} produced zero usable tokens. Set <SYMBOL>_MINT for at least one.",
            symbols
        );
    }

    // If primary isn't available (e.g., USDT on devnet without override),
    // fall back to the first available token rather than panicking.
    let active_primary = if tokens.iter().any(|t| t.symbol == primary_token) {
        primary_token
    } else {
        let fallback = tokens[0].symbol.clone();
        tracing::warn!(
            requested_primary = %primary_token,
            fallback_to = %fallback,
            "PRIMARY_STABLECOIN unavailable on this network — falling back"
        );
        fallback
    };

    (tokens, active_primary)
}
