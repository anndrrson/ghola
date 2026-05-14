use std::env;
use std::net::SocketAddr;

#[derive(Debug, Clone)]
pub struct RelayConfig {
    pub bind_addr: SocketAddr,
    pub rate_limit_per_second: u32,
    pub max_message_size_bytes: usize,
    pub auth_timeout_secs: u64,
    /// When true, skip Ed25519 signature verification (for local development).
    pub dev_mode: bool,
    /// Path to TLS certificate file (PEM format).
    pub tls_cert_path: Option<String>,
    /// Path to TLS private key file (PEM format).
    pub tls_key_path: Option<String>,
    /// URL of thumper-cloud's `/v1/did-set` endpoint. Polled periodically
    /// to materialise the membership set used by sealed-inference auth.
    /// If unset, sealed-inference middleware fails closed.
    pub did_set_url: Option<String>,
    /// Static API key the relay sends as `Authorization: Bearer <key>`
    /// when polling `did_set_url`. Must match
    /// `THUMPER_CLOUD_RELAY_API_KEY` on the cloud side.
    pub did_set_api_key: Option<String>,
}

impl RelayConfig {
    pub fn from_env() -> Self {
        Self {
            bind_addr: env::var("THUMPER_RELAY_BIND")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(|| "0.0.0.0:8080".parse().unwrap()),
            rate_limit_per_second: env::var("THUMPER_RATE_LIMIT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30),
            max_message_size_bytes: env::var("THUMPER_MAX_MSG_SIZE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(1_048_576), // 1 MiB (screenshots + flow payloads)
            auth_timeout_secs: env::var("THUMPER_AUTH_TIMEOUT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(300), // 5 minutes
            dev_mode: env::var("THUMPER_DEV_MODE")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
            tls_cert_path: env::var("THUMPER_TLS_CERT").ok(),
            tls_key_path: env::var("THUMPER_TLS_KEY").ok(),
            did_set_url: env::var("THUMPER_CLOUD_DID_SET_URL").ok(),
            did_set_api_key: env::var("THUMPER_CLOUD_RELAY_API_KEY").ok(),
        }
    }
}
