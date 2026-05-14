//! Shared helpers for the two vsock-proxy binaries.
//!
//! Both `vsock-proxy` (host) and `enclave-vsock-client` (enclave) are
//! the same pattern: accept connections on one side, dial the other
//! side, and shovel bytes both ways using `tokio::io::copy_bidirectional`.
//! The only differences are which kind of socket sits on each side.

use anyhow::Context;
use std::env;

/// Read a required environment variable.
pub fn env_required(key: &str) -> anyhow::Result<String> {
    env::var(key).with_context(|| format!("missing required env var {key}"))
}

/// Parse a port env var with a default fallback.
pub fn env_port(key: &str, default: u16) -> anyhow::Result<u16> {
    match env::var(key) {
        Ok(v) => v
            .parse::<u16>()
            .with_context(|| format!("invalid u16 in env var {key}={v}")),
        Err(_) => Ok(default),
    }
}

/// Initialize the tracing subscriber. Honors `RUST_LOG` and defaults to
/// `info`. Idempotent: subsequent calls are no-ops.
pub fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .try_init();
}
