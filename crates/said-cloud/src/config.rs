use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    pub jwt_secret: String,
    pub base_url: String,
    pub frontend_url: String,
    pub stripe_secret_key: Option<String>,
    pub stripe_webhook_secret: Option<String>,
    pub stripe_price_consumer_pro: Option<String>, // price_xxx for $9/mo
    pub stripe_price_business: Option<String>,     // price_xxx for $29/mo
    pub allowed_origins: String,
    pub admin_emails: Vec<String>,
    /// Base58-encoded 64-byte settlement keypair ([secret(32)|pubkey(32)]).
    /// Required for on-chain USDC settlement. If absent, settlement batches
    /// are created in the DB but Solana transfers are skipped.
    pub settlement_keypair_bs58: Option<String>,
    /// Solana RPC endpoint for settlement transactions (default: devnet).
    pub solana_rpc_url: String,
    /// Optional hex-encoded 32-byte ed25519 seed for response signing.
    /// If absent, an ephemeral key is generated at startup.
    pub signing_key_hex: Option<String>,
    /// Google OAuth client ID for verifying Google ID tokens (mobile sign-in).
    /// Same env var as thumper-cloud uses, so Render only needs one value.
    pub google_client_id: Option<String>,
    /// TTL for merchant management capability tokens.
    pub merchant_manage_token_ttl_secs: u64,
    /// When false, merchant origins must be HTTPS.
    pub allow_insecure_merchant_origin_http: bool,
    /// Whether to trust client IP headers such as x-forwarded-for.
    /// Keep false unless running behind a trusted proxy that rewrites them.
    pub trust_proxy_headers: bool,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL").expect("DATABASE_URL required"),
            bind_addr: env::var("BIND_ADDR")
                .or_else(|_| {
                    // Render sets PORT; fall back to it if BIND_ADDR is not set
                    env::var("PORT").map(|p| format!("0.0.0.0:{p}"))
                })
                .unwrap_or_else(|_| "0.0.0.0:8080".into()),
            jwt_secret: env::var("JWT_SECRET").unwrap_or_else(|_| "dev-secret-change-me".into()),
            base_url: env::var("BASE_URL")
                .unwrap_or_else(|_| "https://ghola-api.onrender.com".into()),
            frontend_url: env::var("FRONTEND_URL").unwrap_or_else(|_| "https://ghola.xyz".into()),
            stripe_secret_key: env::var("STRIPE_SECRET_KEY").ok(),
            stripe_webhook_secret: env::var("STRIPE_WEBHOOK_SECRET").ok(),
            stripe_price_consumer_pro: env::var("STRIPE_PRICE_CONSUMER_PRO").ok(),
            stripe_price_business: env::var("STRIPE_PRICE_BUSINESS").ok(),
            allowed_origins: env::var("ALLOWED_ORIGINS")
                .unwrap_or_else(|_| "https://ghola.xyz,http://localhost:3000".into()),
            admin_emails: env::var("ADMIN_EMAILS")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            settlement_keypair_bs58: env::var("SETTLEMENT_KEYPAIR").ok(),
            solana_rpc_url: env::var("SOLANA_RPC_URL")
                .unwrap_or_else(|_| "https://api.devnet.solana.com".into()),
            signing_key_hex: env::var("SIGNING_KEY").ok(),
            google_client_id: env::var("GOOGLE_CLIENT_ID").ok(),
            merchant_manage_token_ttl_secs: env::var("MERCHANT_MANAGE_TOKEN_TTL_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(86_400),
            allow_insecure_merchant_origin_http: env::var("ALLOW_INSECURE_MERCHANT_ORIGIN_HTTP")
                .ok()
                .map(|s| matches!(s.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
                .unwrap_or(false),
            trust_proxy_headers: env::var("TRUST_PROXY_HEADERS")
                .ok()
                .map(|s| matches!(s.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
                .unwrap_or(false),
        }
    }
}
