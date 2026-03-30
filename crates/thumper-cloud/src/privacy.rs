//! Privacy helpers for log sanitization.
//! Prevents PII (UUIDs, wallet addresses) from appearing in INFO-level logs.

use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Return first 8 hex chars of SHA-256(uuid) for privacy-safe logging.
pub fn log_id(id: &Uuid) -> String {
    let hash = Sha256::digest(id.as_bytes());
    hash[..4].iter().map(|b| format!("{b:02x}")).collect()
}

/// Truncate a wallet address for logging: first 4 + last 4 chars.
pub fn log_addr(addr: &str) -> String {
    if addr.len() > 10 {
        format!("{}...{}", &addr[..4], &addr[addr.len() - 4..])
    } else {
        "****".to_string()
    }
}
