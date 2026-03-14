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
}

impl CloudConfig {
    pub fn from_env() -> Self {
        let encryption_hex = env::var("THUMPER_ENCRYPTION_KEY").unwrap_or_else(|_| {
            tracing::warn!("THUMPER_ENCRYPTION_KEY not set, using random key (tokens won't survive restarts)");
            let mut key = [0u8; 32];
            use rand::RngCore;
            rand::thread_rng().fill_bytes(&mut key);
            hex_encode(&key)
        });

        let encryption_key = parse_hex_key(&encryption_hex);

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
            claude_api_key: env::var("CLAUDE_API_KEY").ok(),
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
