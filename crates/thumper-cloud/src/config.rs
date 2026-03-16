use std::env;
use std::net::SocketAddr;

#[derive(Debug, Clone)]
pub struct CloudConfig {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub jwt_secret: String,
    pub bland_api_key: Option<String>,
    pub bland_webhook_url: Option<String>,
    pub claude_api_key: Option<String>,
    pub google_client_id: Option<String>,
    pub google_client_secret: Option<String>,
    pub apple_client_id: Option<String>,
    pub gmail_client_id: Option<String>,
    pub gmail_client_secret: Option<String>,
    pub stripe_secret_key: Option<String>,
    pub stripe_webhook_secret: Option<String>,
    pub stripe_price_pro: Option<String>,
    pub stripe_price_unlimited: Option<String>,
    pub base_url: String,
    pub encryption_key: [u8; 32],
    pub telegram_bot_token: Option<String>,
    pub solana_rpc_url: String,
    // Free cascade inference providers
    pub groq_api_key: Option<String>,
    pub cerebras_api_key: Option<String>,
    pub google_gemini_api_key: Option<String>,
    pub openrouter_api_key: Option<String>,
    // GPU Compute Marketplace
    pub relay_url: String,
    pub platform_wallet_address: Option<String>,
    pub min_provider_reputation: f64,
    pub max_escrow_age_secs: u64,
    pub provider_payout_interval_secs: u64,
}

impl CloudConfig {
    pub fn from_env() -> Self {
        let encryption_hex = env::var("THUMPER_ENCRYPTION_KEY").unwrap_or_else(|_| {
            tracing::warn!(
                "THUMPER_ENCRYPTION_KEY not set — using random key. \
                 BYOM API keys and Gmail tokens won't survive restarts. \
                 Set this env var with `openssl rand -hex 32`."
            );
            let mut key = [0u8; 32];
            use rand::RngCore;
            rand::thread_rng().fill_bytes(&mut key);
            hex_encode(&key)
        });

        let encryption_key = parse_hex_key(&encryption_hex);

        let claude_api_key = env::var("CLAUDE_API_KEY").ok();
        if claude_api_key.is_none() {
            tracing::warn!(
                "CLAUDE_API_KEY not set — chat will only work for users who configure their own \
                 API key via Settings > AI Model (BYOM)"
            );
        }

        Self {
            bind_addr: env::var("THUMPER_CLOUD_BIND")
                .or_else(|_| env::var("BIND_ADDR"))
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(|| {
                    // Render sets PORT env var; fall back to it
                    let port = env::var("PORT").unwrap_or_else(|_| "3000".to_string());
                    format!("0.0.0.0:{port}").parse().expect("invalid PORT")
                }),
            database_url: env::var("DATABASE_URL")
                .expect("DATABASE_URL must be set"),
            jwt_secret: env::var("JWT_SECRET")
                .expect("JWT_SECRET must be set"),
            bland_api_key: env::var("BLAND_API_KEY").ok(),
            bland_webhook_url: env::var("BLAND_WEBHOOK_URL").ok(),
            claude_api_key,
            google_client_id: env::var("GOOGLE_CLIENT_ID").ok(),
            google_client_secret: env::var("GOOGLE_CLIENT_SECRET").ok(),
            apple_client_id: env::var("APPLE_CLIENT_ID").ok(),
            gmail_client_id: env::var("GMAIL_CLIENT_ID").ok(),
            gmail_client_secret: env::var("GMAIL_CLIENT_SECRET").ok(),
            stripe_secret_key: env::var("STRIPE_SECRET_KEY").ok(),
            stripe_webhook_secret: env::var("STRIPE_WEBHOOK_SECRET").ok(),
            stripe_price_pro: env::var("STRIPE_PRICE_PRO").ok(),
            stripe_price_unlimited: env::var("STRIPE_PRICE_UNLIMITED").ok(),
            base_url: env::var("BASE_URL")
                .unwrap_or_else(|_| "http://localhost:3000".to_string()),
            encryption_key,
            telegram_bot_token: env::var("TELEGRAM_BOT_TOKEN").ok(),
            solana_rpc_url: env::var("SOLANA_RPC_URL").ok()
                .or_else(|| {
                    env::var("HELIUS_API_KEY").ok().map(|key| {
                        let network = env::var("SOLANA_NETWORK").unwrap_or_else(|_| "mainnet-beta".to_string());
                        let host = if network == "devnet" { "devnet" } else { "mainnet" };
                        format!("https://{host}.helius-rpc.com/?api-key={key}")
                    })
                })
                .unwrap_or_else(|| "https://api.devnet.solana.com".to_string()),
            groq_api_key: env::var("GROQ_API_KEY").ok(),
            cerebras_api_key: env::var("CEREBRAS_API_KEY").ok(),
            google_gemini_api_key: env::var("GOOGLE_GEMINI_API_KEY").ok(),
            openrouter_api_key: env::var("OPENROUTER_API_KEY").ok(),
            relay_url: env::var("RELAY_URL")
                .unwrap_or_else(|_| "http://localhost:8080".to_string()),
            platform_wallet_address: env::var("PLATFORM_WALLET_ADDRESS").ok(),
            min_provider_reputation: env::var("MIN_PROVIDER_REPUTATION")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.3),
            max_escrow_age_secs: env::var("MAX_ESCROW_AGE_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(300),
            provider_payout_interval_secs: env::var("PROVIDER_PAYOUT_INTERVAL_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3600),
        }
    }
}

impl CloudConfig {
    /// Look up a free-cascade provider API key by name.
    pub fn free_provider_key(&self, name: &str) -> Option<String> {
        match name {
            "groq" => self.groq_api_key.clone(),
            "cerebras" => self.cerebras_api_key.clone(),
            "google" => self.google_gemini_api_key.clone(),
            "openrouter" => self.openrouter_api_key.clone(),
            _ => None,
        }
    }
}

fn parse_hex_key(hex_str: &str) -> [u8; 32] {
    let bytes: Vec<u8> = (0..hex_str.len())
        .step_by(2)
        .filter_map(|i| hex_str.get(i..i + 2).and_then(|s| u8::from_str_radix(s, 16).ok()))
        .collect();
    let mut key = [0u8; 32];
    let len = bytes.len().min(32);
    key[..len].copy_from_slice(&bytes[..len]);
    key
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
