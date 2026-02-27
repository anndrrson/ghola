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
}

fn default_timeout() -> u64 {
    10
}

impl ThumperConfig {
    /// Load config from ~/.thumper/config.toml, env vars, or defaults.
    pub fn load() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        // Try config file first
        let config_path = config_file_path();
        if config_path.exists() {
            let contents = std::fs::read_to_string(&config_path)?;
            let config: ThumperConfig = toml::from_str(&contents)?;
            return Ok(config);
        }

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
            .unwrap_or(10);

        Ok(Self {
            relay_url,
            mcp_pubkey,
            device_pubkey,
            timeout_secs,
        })
    }
}

fn config_file_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".thumper")
        .join("config.toml")
}
