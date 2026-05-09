//! # said-noncecache
//!
//! Single-purpose, TTL-bounded set of recently-seen nonces for replay
//! detection. Originally lived inside `thumper-relay::auth::NonceCache`;
//! extracted so the SAID MCP HTTP server can reuse the same primitive to
//! enforce the UCAN `nnc` field on every authenticated request.
//!
//! Semantics:
//! - `check_and_insert` returns `true` if the nonce was already present
//!   (i.e. **replay detected**) and `false` otherwise.
//! - `prune` removes entries older than the configured TTL. Caller is
//!   responsible for invoking it on a schedule; the cache does not spawn a
//!   background task on its own.
//!
//! The cache is `Clone` (cheap, internally `Arc<DashMap<...>>`) so it can
//! be passed around `axum` state and middleware without further wrapping.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;

/// TTL-bounded nonce store for replay protection.
#[derive(Clone)]
pub struct NonceCache {
    inner: Arc<DashMap<String, Instant>>,
    ttl: Duration,
}

impl NonceCache {
    /// Create a cache that retains nonces for `ttl_secs` seconds.
    pub fn new(ttl_secs: u64) -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
            ttl: Duration::from_secs(ttl_secs),
        }
    }

    /// Returns `true` if `nonce` was already present (replay), `false`
    /// otherwise. Inserts on miss.
    pub fn check_and_insert(&self, nonce: &str) -> bool {
        if self.inner.contains_key(nonce) {
            return true;
        }
        self.inner.insert(nonce.to_string(), Instant::now());
        false
    }

    /// Drop entries older than the configured TTL.
    pub fn prune(&self) {
        let cutoff = Instant::now() - self.ttl;
        self.inner.retain(|_, v| *v > cutoff);
    }

    /// Number of currently-cached nonces. Useful for tests and metrics.
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_insert_is_not_replay() {
        let c = NonceCache::new(60);
        assert!(!c.check_and_insert("alpha"));
    }

    #[test]
    fn second_insert_is_replay() {
        let c = NonceCache::new(60);
        assert!(!c.check_and_insert("alpha"));
        assert!(c.check_and_insert("alpha"));
    }

    #[test]
    fn prune_drops_expired_entries() {
        let c = NonceCache::new(0); // expire immediately
        c.check_and_insert("alpha");
        // Sleep at least one nanosecond past the cutoff. With a TTL of 0
        // anything strictly older than `Instant::now()` at prune time gets
        // dropped.
        std::thread::sleep(Duration::from_millis(2));
        c.prune();
        assert!(c.is_empty());
        assert!(!c.check_and_insert("alpha"));
    }

    #[test]
    fn distinct_nonces_coexist() {
        let c = NonceCache::new(60);
        for n in ["a", "b", "c"] {
            assert!(!c.check_and_insert(n));
        }
        assert_eq!(c.len(), 3);
    }
}
