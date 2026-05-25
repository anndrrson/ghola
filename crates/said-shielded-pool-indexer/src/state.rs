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
use crate::routes::IpRateLimiter;
use crate::solana::SolanaRpcClient;
use crate::tree::IncrementalMerkleTree;

/// The base58 system-program / default pubkey. Used as the `POOL_MINT`
/// sentinel for indexer-only nodes that don't configure a mint; when the mint
/// equals this, we can't derive a concrete tree PDA and fall back to
/// program-scope-only event attribution.
const DEFAULT_MINT_B58: &str = "11111111111111111111111111111111";

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub tree: Arc<RwLock<IncrementalMerkleTree>>,
    pub rpc: SolanaRpcClient,
    /// `pool_program_id` decoded to raw 32 bytes once at startup, so the event
    /// listener can attribute `Program data:` log lines to the emitting program
    /// without re-decoding base58 per log line.
    pub pool_program_id_bytes: [u8; 32],
    /// The expected MerkleTree PDA this indexer mirrors, derived from
    /// `(pool_program_id, pool_config, pool_mint)`. `None` for indexer-only
    /// nodes with no configured mint (the default), in which case event
    /// attribution relies on program-scope alone. When `Some`, tree-mutating
    /// events whose `tree` field differs are rejected.
    pub expected_tree_pda: Option<[u8; 32]>,
    /// Per-IP fixed-window limiter for the (Poseidon-touching) `/witness`
    /// endpoint. Keyed on the resolved client identity (see
    /// [`crate::routes::client_ip`]).
    pub witness_rate_limiter: IpRateLimiter,
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

        // Decode the pool program id once. `Config::from_env` already validated
        // it is a 32-byte base58 pubkey, so this is infallible in practice; on
        // the off chance it isn't we fall back to all-zeros (which simply means
        // NO log line will ever attribute to "the pool program", i.e. the
        // listener ingests nothing — fail-closed).
        let pool_program_id_bytes = decode_pubkey(&cfg.pool_program_id).unwrap_or([0u8; 32]);

        // Derive the concrete MerkleTree PDA when a real mint is configured.
        // Indexer-only nodes leave POOL_MINT unset (defaulting to the system
        // pubkey), in which case we can't pin a tree PDA and use scope-only
        // attribution.
        let expected_tree_pda = (cfg.pool_mint != DEFAULT_MINT_B58)
            .then(|| decode_pubkey(&cfg.pool_mint))
            .flatten()
            .map(|mint| {
                let pool_config =
                    crate::forester::derive_pool_config_pda(&pool_program_id_bytes);
                crate::forester::derive_merkle_tree_pda(
                    &pool_program_id_bytes,
                    &pool_config,
                    &mint,
                )
            });

        Self {
            cfg: Arc::new(cfg),
            tree: Arc::new(RwLock::new(tree)),
            rpc,
            pool_program_id_bytes,
            expected_tree_pda,
            witness_rate_limiter: IpRateLimiter::default(),
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

/// Decode a base58 pubkey string to raw 32 bytes, or `None` if it isn't a
/// 32-byte base58 value.
fn decode_pubkey(s: &str) -> Option<[u8; 32]> {
    bs58::decode(s).into_vec().ok()?.try_into().ok()
}
