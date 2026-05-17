//! Phase 4.2 + 4.3: privacy helpers.
//!
//! - `hmac_address` — keyed-MAC a wallet address with a per-user secret. Used
//!   to populate `*_address_hash` columns so a DB breach does not reveal the
//!   on-chain graph linking wallets to users.
//! - `daily_ip_hash` — hash an IP with a daily-rotated salt. Lets fraud /
//!   rate-limit logic group requests by source within a 24h window without
//!   making IP logs reversible after the salt rotates out.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

type HmacSha256 = Hmac<Sha256>;

/// Look up the user's address HMAC key and produce a 64-hex-char keyed-MAC of
/// the address. Different users hashing the same wallet produce different
/// outputs, so the screening backend or any other process cannot correlate
/// users by reading the hash alone.
pub async fn hmac_address(db: &PgPool, user_id: Uuid, address: &str) -> AppResult<String> {
    let key: Vec<u8> = sqlx::query_scalar("SELECT address_hmac_key FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(db)
        .await?;
    let mut mac = HmacSha256::new_from_slice(&key)
        .map_err(|e| AppError::Internal(format!("HMAC key init failed: {e}")))?;
    mac.update(address.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// Hash an IP using a daily salt. The salt is `IP_HASH_SALT` env (rotated
/// daily by ops), prepended with today's date so even within-day cache hits
/// don't leak across days. Truncated to 16 hex chars (8 bytes) — enough to
/// detect a single bad actor within 24h, not enough to identify them long-term.
pub fn daily_ip_hash(ip: &str) -> String {
    use sha2::Digest;
    let salt = std::env::var("IP_HASH_SALT").unwrap_or_else(|_| "dev-salt".into());
    let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b"\0");
    hasher.update(day.as_bytes());
    hasher.update(b"\0");
    hasher.update(ip.as_bytes());
    let h = hasher.finalize();
    hex::encode(&h[..8])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ip_hash_truncated_and_deterministic_within_day() {
        let h1 = daily_ip_hash("203.0.113.42");
        let h2 = daily_ip_hash("203.0.113.42");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 16);
        assert_ne!(h1, daily_ip_hash("198.51.100.1"));
        assert!(!h1.contains("203.0.113.42"));
    }
}
