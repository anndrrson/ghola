use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
pub struct ThumperConfig {
    /// WebSocket URL for the relay (e.g., "ws://localhost:8080/ws").
    pub relay_url: String,
    /// This MCP client's base58 pubkey.
    pub mcp_pubkey: String,
    /// Target device's base58 pubkey.
    pub device_pubkey: String,
    /// Command timeout in seconds.
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    /// Ed25519 signing key loaded from ~/.thumper/mcp_key (not deserialized from config).
    #[serde(skip)]
    pub signing_key: Option<ed25519_dalek::SigningKey>,
}

fn default_timeout() -> u64 {
    15
}

impl ThumperConfig {
    /// Load config from ~/.thumper/config.toml, env vars, or defaults.
    /// Also attempts to load the Ed25519 signing key from ~/.thumper/mcp_key.
    pub fn load() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let thumper_dir = thumper_dir();

        // Try config file first
        let config_path = thumper_dir.join("config.toml");
        let mut config = if config_path.exists() {
            let contents = std::fs::read_to_string(&config_path)?;
            toml::from_str::<ThumperConfig>(&contents)?
        } else {
            // Fall back to environment variables
            let relay_url = std::env::var("THUMPER_RELAY_URL")
                .unwrap_or_else(|_| "ws://localhost:8080/ws".to_string());
            let mcp_pubkey = std::env::var("THUMPER_MCP_PUBKEY")
                .unwrap_or_else(|_| "not_configured".to_string());
            let device_pubkey = std::env::var("THUMPER_DEVICE_PUBKEY")
                .unwrap_or_else(|_| "not_configured".to_string());
            let timeout_secs = std::env::var("THUMPER_TIMEOUT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(15);

            Self {
                relay_url,
                mcp_pubkey,
                device_pubkey,
                timeout_secs,
                signing_key: None,
            }
        };

        // Load signing key from ~/.thumper/mcp_key
        config.signing_key = load_signing_key(&thumper_dir);

        Ok(config)
    }
}

/// Load the Ed25519 signing key from ~/.thumper/mcp_key.
/// The file is expected to contain 64 bytes of keypair data, base64-encoded.
/// Returns None if the file doesn't exist or can't be parsed (dev mode).
fn load_signing_key(thumper_dir: &std::path::Path) -> Option<ed25519_dalek::SigningKey> {
    let key_path = thumper_dir.join("mcp_key");
    let contents = match std::fs::read_to_string(&key_path) {
        Ok(c) => c,
        Err(_) => {
            tracing::debug!("no signing key found at {:?} (dev mode)", key_path);
            return None;
        }
    };

    let trimmed = contents.trim();
    let bytes = match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, trimmed) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("failed to base64-decode mcp_key: {}", e);
            return None;
        }
    };

    if bytes.len() < 32 {
        tracing::warn!(
            "mcp_key too short ({} bytes, need at least 32)",
            bytes.len()
        );
        return None;
    }

    // The first 32 bytes are the secret scalar; the rest (if 64 bytes) are the public key.
    let secret_bytes: [u8; 32] = match bytes[..32].try_into() {
        Ok(b) => b,
        Err(_) => {
            tracing::warn!("failed to extract 32-byte secret from mcp_key");
            return None;
        }
    };

    let key = ed25519_dalek::SigningKey::from_bytes(&secret_bytes);
    tracing::info!("loaded signing key from {:?}", key_path);
    Some(key)
}

/// Get the ~/.thumper/ directory path.
fn thumper_dir() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".thumper"))
        .unwrap_or_else(|| {
            // Fallback: try current directory
            tracing::warn!("could not determine home directory, using /tmp/.thumper");
            PathBuf::from("/tmp/.thumper")
        })
}
