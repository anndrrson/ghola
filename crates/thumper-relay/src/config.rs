use std::env;
use std::net::SocketAddr;

use crate::ohttp::OhttpKeypair;

/// Default OHTTP key id when the operator hasn't pinned one explicitly.
/// RFC 9458 allows 0–255; we reserve 0x01 for the primary in-flight key
/// and bump on rotation.
pub const DEFAULT_OHTTP_KEY_ID: u8 = 0x01;

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
    /// Optional OHTTP gateway secret (32-byte X25519, hex-encoded). When
    /// present, the relay mounts `/ohttp-keys` and `/ohttp-gateway`. Set
    /// via `GHOLA_OHTTP_KEY_SECRET_HEX`, ideally sourced from SSM at boot.
    pub ohttp_key_secret_hex: Option<String>,
    /// Key id advertised in the OHTTP keyconfig + capsule header.
    pub ohttp_key_id: u8,
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
            ohttp_key_secret_hex: env::var("GHOLA_OHTTP_KEY_SECRET_HEX").ok(),
            ohttp_key_id: env::var("GHOLA_OHTTP_KEY_ID")
                .ok()
                .and_then(|s| s.parse::<u8>().ok())
                .unwrap_or(DEFAULT_OHTTP_KEY_ID),
        }
    }

    /// Resolve the OHTTP keypair from the configured hex secret, if any.
    /// Returns `None` when the operator has not opted into OHTTP; the
    /// router skips mounting the OHTTP routes in that case.
    pub fn ohttp_keypair(&self) -> Option<OhttpKeypair> {
        let hex_str = self.ohttp_key_secret_hex.as_ref()?.trim();
        let bytes = hex::decode(hex_str).ok()?;
        let arr: [u8; 32] = bytes.try_into().ok()?;
        Some(OhttpKeypair::from_secret_bytes(self.ohttp_key_id, arr))
    }
}
