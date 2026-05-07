use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    pub jwt_secret: String,
    pub together_api_key: String,
    pub together_base_url: String,
    pub default_base_model: String,
    pub solana_rpc_url: String,
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
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL").expect("DATABASE_URL required"),
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            jwt_secret: env::var("JWT_SECRET").unwrap_or_else(|_| "dev-secret-change-me".into()),
            together_api_key: env::var("TOGETHER_API_KEY").unwrap_or_default(),
            together_base_url: env::var("TOGETHER_BASE_URL")
                .unwrap_or_else(|_| "https://api.together.xyz/v1".into()),
            default_base_model: env::var("DEFAULT_BASE_MODEL")
                .unwrap_or_else(|_| "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo".into()),
            solana_rpc_url: env::var("SOLANA_RPC_URL")
                .unwrap_or_else(|_| "https://api.devnet.solana.com".into()),
            usdc_mint: env::var("USDC_MINT")
                .unwrap_or_else(|_| "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU".into()),
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
            frontend_url: env::var("FRONTEND_URL").unwrap_or_else(|_| "http://localhost:3000".into()),
            platform_did: env::var("PLATFORM_DID").unwrap_or_else(|_| "did:key:orni-models-platform".into()),
            x402_enabled: env::var("X402_ENABLED")
                .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes"))
                .unwrap_or(false),
            x402_facilitator_url: env::var("X402_FACILITATOR_URL")
                .unwrap_or_else(|_| "https://x402.org/facilitator".into()),
            x402_network: env::var("X402_NETWORK")
                .unwrap_or_else(|_| "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp".into()),
        }
    }
}
