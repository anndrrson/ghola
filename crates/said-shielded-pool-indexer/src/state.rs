//! Shared app state held by axum handlers, the listener, and the forester.
//!
//! All three components share a single [`IncrementalMerkleTree`] guarded by
//! a `tokio::sync::RwLock`: the listener / forester acquire `.write()`,
//! the HTTP handlers acquire `.read()`. Tree access is bursty and writes
//! are small (one commitment at a time), so contention is negligible.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::RwLock;

use crate::config::Config;
use crate::solana::SolanaRpcClient;
use crate::tree::IncrementalMerkleTree;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub tree: Arc<RwLock<IncrementalMerkleTree>>,
    pub rpc: SolanaRpcClient,
    /// Unix timestamp (seconds since epoch) at which the listener last
    /// observed a fresh root from on-chain. Used by `/witness` and
    /// `/tree-state` to refuse to serve stale state (see Stream 6 of the
    /// production-hardening pass): a witness built against a root the
    /// chain has already rotated past is useless to the client and, if
    /// served silently, lets the client waste a proving attempt.
    ///
    /// Stored as `AtomicI64` so the listener (writer) and the HTTP
    /// handlers (readers) don't need to share a lock. `0` means "no
    /// observation yet" — handlers treat that the same as "stale" so
    /// freshly-started indexers don't claim to serve witnesses before
    /// the listener has confirmed connectivity.
    pub latest_root_observed_unix: Arc<AtomicI64>,
}

impl AppState {
    pub fn new(cfg: Config, tree: IncrementalMerkleTree) -> Self {
        let rpc = SolanaRpcClient::new(cfg.rpc_url.clone());
        // If the tree already has leaves we assume the indexer has caught
        // up at least once historically (via backfill). Initialise the
        // observation clock to "now" so a freshly-restarted node doesn't
        // 503 the first witness query when its sled DB is warm.
        let bootstrap = if tree.next_index() > 0 {
            now_unix()
        } else {
            0
        };
        Self {
            cfg: Arc::new(cfg),
            tree: Arc::new(RwLock::new(tree)),
            rpc,
            latest_root_observed_unix: Arc::new(AtomicI64::new(bootstrap)),
        }
    }

    /// Mark the on-chain root observation timestamp as "now". Called by
    /// the listener every time it successfully decodes a payload from
    /// the chain (even a no-op one — what we're tracking is connectivity
    /// to the chain, not the actual root churn).
    pub fn touch_root_observed(&self) {
        self.latest_root_observed_unix
            .store(now_unix(), Ordering::Relaxed);
    }

    /// Age (in seconds) of the last on-chain observation. Returns
    /// `u64::MAX` when the listener hasn't observed anything yet so
    /// callers can treat "never" the same as "infinitely stale".
    pub fn root_age_secs(&self) -> u64 {
        let last = self.latest_root_observed_unix.load(Ordering::Relaxed);
        if last == 0 {
            return u64::MAX;
        }
        let now = now_unix();
        if now <= last {
            0
        } else {
            (now - last) as u64
        }
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
