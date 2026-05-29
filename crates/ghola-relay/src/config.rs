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
    /// URL of thumper-cloud's `/v1/did-set` endpoint. Polled periodically
    /// to materialise the membership set used by sealed-inference auth.
    /// If unset, sealed-inference middleware fails closed.
    pub did_set_url: Option<String>,
    /// Static API key the relay sends as `Authorization: Bearer <key>`
    /// when polling `did_set_url`. Must match
    /// `GHOLA_CLOUD_RELAY_API_KEY` on the cloud side.
    pub did_set_api_key: Option<String>,
    /// Maximum age, in seconds, of the cached DID-set before the
    /// sealed-inference middleware fails closed. Defaults to 300 (5 min).
    ///
    /// Without this bound, a thumper-cloud outage would leave the relay
    /// happily serving traffic against an unbounded-stale set, so a DID
    /// removed cloud-side keeps access until the cloud comes back. With
    /// a bound, the relay degrades to "deny all" once the cached set is
    /// older than the configured horizon — which is the correct posture
    /// for a revocation-sensitive control.
    ///
    /// Set via `GHOLA_DID_SET_MAX_STALENESS_SECS`.
    pub did_set_max_staleness_secs: u64,
    /// Per-DID rate limit for the sealed-inference path (HTTP + OHTTP).
    /// The general `rate_limit_per_second` knob applies per WebSocket
    /// connection — useless for stateless HTTP, doubly useless behind
    /// OHTTP which collapses all client IPs onto Cloudflare's egress.
    /// We enforce a per-DID bucket here instead. Defaults to 5/s/DID.
    ///
    /// Set via `GHOLA_SEALED_RATE_LIMIT_PER_DID`.
    pub sealed_rate_limit_per_did: u32,
    /// Maximum accepted HTTP request body size, in bytes, for the
    /// general JSON POST/PUT endpoints (e.g. `POST /inference`,
    /// `POST /providers/attest`). Requests exceeding this are rejected
    /// with `413 Payload Too Large` by axum's body-limit middleware
    /// before the handler ever sees them.
    ///
    /// Defaults to 1 MiB (1_048_576). Set via
    /// `GHOLA_MAX_BODY_SIZE_BYTES`.
    pub max_body_size_bytes: usize,
    /// Maximum accepted HTTP request body size for the sealed-inference
    /// path (`POST /inference/sealed` and the OHTTP gateway). Sealed
    /// envelopes are encrypted blobs that include the full prompt +
    /// chat history, so they routinely run larger than the general
    /// limit. Defaults to 4 MiB; set via
    /// `GHOLA_MAX_SEALED_BODY_SIZE_BYTES`.
    pub max_sealed_body_size_bytes: usize,
    /// CORS allowed origins for browser-facing endpoints. Production
    /// default is `["https://ghola.xyz"]`. In dev mode (`GHOLA_DEV_MODE=1`)
    /// the relay also allows `http://localhost:*` and `http://127.0.0.1:*`
    /// patterns so a developer can hit it from any local dev server
    /// without rebuilding.
    ///
    /// Override with `GHOLA_CORS_ALLOWED_ORIGINS` (comma-separated
    /// list of fully-qualified origins).
    pub cors_allowed_origins: Vec<String>,
    /// Upstream thumper-cloud base URL used for the OHTTP-fronted x402
    /// endpoint. The OHTTP gateway only forwards a narrow `/v1/chat/completions`
    /// allowlist through this origin.
    pub ghola_cloud_base_url: String,
}

impl RelayConfig {
    pub fn from_env() -> Self {
        Self {
            bind_addr: ghola_assistant_types::env_compat("GHOLA_RELAY_BIND", "THUMPER_RELAY_BIND")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(|| "0.0.0.0:8080".parse().unwrap()),
            rate_limit_per_second: ghola_assistant_types::env_compat("GHOLA_RATE_LIMIT", "THUMPER_RATE_LIMIT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30),
            max_message_size_bytes: ghola_assistant_types::env_compat("GHOLA_MAX_MSG_SIZE", "THUMPER_MAX_MSG_SIZE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(1_048_576), // 1 MiB (screenshots + flow payloads)
            auth_timeout_secs: ghola_assistant_types::env_compat("GHOLA_AUTH_TIMEOUT", "THUMPER_AUTH_TIMEOUT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(300), // 5 minutes
            dev_mode: ghola_assistant_types::env_compat("GHOLA_DEV_MODE", "THUMPER_DEV_MODE")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
            tls_cert_path: ghola_assistant_types::env_compat("GHOLA_TLS_CERT", "THUMPER_TLS_CERT").ok(),
            tls_key_path: ghola_assistant_types::env_compat("GHOLA_TLS_KEY", "THUMPER_TLS_KEY").ok(),
            ohttp_key_secret_hex: env::var("GHOLA_OHTTP_KEY_SECRET_HEX").ok(),
            ohttp_key_id: env::var("GHOLA_OHTTP_KEY_ID")
                .ok()
                .and_then(|s| s.parse::<u8>().ok())
                .unwrap_or(DEFAULT_OHTTP_KEY_ID),
            did_set_url: ghola_assistant_types::env_compat("GHOLA_CLOUD_DID_SET_URL", "THUMPER_CLOUD_DID_SET_URL").ok(),
            did_set_api_key: ghola_assistant_types::env_compat("GHOLA_CLOUD_RELAY_API_KEY", "THUMPER_CLOUD_RELAY_API_KEY").ok(),
            did_set_max_staleness_secs: ghola_assistant_types::env_compat("GHOLA_DID_SET_MAX_STALENESS_SECS", "THUMPER_DID_SET_MAX_STALENESS_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(300),
            sealed_rate_limit_per_did: ghola_assistant_types::env_compat("GHOLA_SEALED_RATE_LIMIT_PER_DID", "THUMPER_SEALED_RATE_LIMIT_PER_DID")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(5),
            max_body_size_bytes: ghola_assistant_types::env_compat("GHOLA_MAX_BODY_SIZE_BYTES", "THUMPER_MAX_BODY_SIZE_BYTES")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(1_048_576), // 1 MiB
            max_sealed_body_size_bytes: ghola_assistant_types::env_compat("GHOLA_MAX_SEALED_BODY_SIZE_BYTES", "THUMPER_MAX_SEALED_BODY_SIZE_BYTES")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(4 * 1_048_576), // 4 MiB
            cors_allowed_origins: ghola_assistant_types::env_compat("GHOLA_CORS_ALLOWED_ORIGINS", "THUMPER_CORS_ALLOWED_ORIGINS")
                .ok()
                .map(|s| {
                    s.split(',')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_else(|| vec!["https://ghola.xyz".to_string()]),
            ghola_cloud_base_url: ghola_assistant_types::env_compat("GHOLA_CLOUD_BASE_URL", "THUMPER_CLOUD_BASE_URL")
                .unwrap_or_else(|_| "https://thumper-cloud.onrender.com".to_string()),
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

    /// Return machine-readable reason codes for production preflight failures.
    ///
    /// In production (`dev_mode = false`) sealed private mode requires:
    /// - a valid OHTTP gateway secret
    /// - did-set URL configured
    /// - relay API key configured
    pub fn private_preflight_failures(&self) -> Vec<String> {
        let mut reasons = Vec::new();
        if self.dev_mode {
            return reasons;
        }

        match self.ohttp_key_secret_hex.as_ref().map(|s| s.trim()) {
            None | Some("") => reasons.push("ohttp_key_missing".to_string()),
            Some(_) if self.ohttp_keypair().is_none() => {
                reasons.push("ohttp_key_invalid".to_string())
            }
            _ => {}
        }

        if self
            .did_set_url
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        {
            reasons.push("did_set_url_missing".to_string());
        }
        if self
            .did_set_api_key
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        {
            reasons.push("did_set_api_key_missing".to_string());
        }
        reasons
    }
}
