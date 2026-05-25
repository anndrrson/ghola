//! Configuration parsed from environment variables.
//!
//! Defaults target the **live devnet deployment** so a freshly-cloned repo
//! can `cargo run -p said-shielded-pool-indexer` with no extra setup.
//!
//! | Var                         | Default                                                | Notes |
//! |-----------------------------|--------------------------------------------------------|-------|
//! | `RPC_URL`                   | `https://api.devnet.solana.com`                        | Solana JSON-RPC endpoint (HTTP). Override for localnet/mainnet. |
//! | `WS_URL`                    | `wss://api.devnet.solana.com`                          | Solana JSON-RPC endpoint (WS). Override alongside `RPC_URL`. |
//! | `INDEXER_DB_PATH`           | `./indexer.db`                                         | sled directory; created if missing. |
//! | `INDEXER_PORT`              | `8788`                                                 | TCP port for the axum witness server. |
//! | `POOL_PROGRAM_ID`           | `5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A` (devnet) | base58 pubkey of the on-chain shielded-pool program. |
//! | `PROVER_URL`                | `http://127.0.0.1:8787`                                | URL of `said-shielded-pool-prover` for batched-update SNARKs. |
//! | `FORESTER_KEYPAIR_PATH`     | unset → forester disabled                              | path to a JSON solana keypair file. Leave unset to run as an indexer-only node. |
//! | `FORESTER_QUEUE_THRESHOLD`  | `16`                                                   | submit a batched-update SNARK when the on-chain queue length ≥ this. |
//! | `FORESTER_POLL_SECS`        | `10`                                                   | how often to poll the on-chain queue account. |
//! | `BACKFILL_LIMIT`            | `1000`                                                 | tx signatures to scan per backfill page. |
//!
//! Validation:
//! - `POOL_PROGRAM_ID` must be a valid base58 pubkey (32 bytes).
//! - `FORESTER_KEYPAIR_PATH` is only required when running as a forester;
//!   pure indexer nodes leave it unset and the [`Forester`] task is not
//!   spawned (see `main.rs`).

use std::path::PathBuf;

use crate::error::{Error, Result};

/// Default port for the indexer's witness HTTP API.
pub const DEFAULT_INDEXER_PORT: u16 = 8788;

/// Default Solana JSON-RPC HTTP endpoint — Solana devnet.
pub const DEFAULT_RPC_URL: &str = "https://api.devnet.solana.com";

/// Default Solana JSON-RPC WebSocket endpoint — Solana devnet.
pub const DEFAULT_WS_URL: &str = "wss://api.devnet.solana.com";

/// Default base58 program ID — the live shielded-pool deployment on devnet.
///
/// Override with `POOL_PROGRAM_ID` env var when targeting localnet or a
/// future mainnet deployment.
pub const DEFAULT_POOL_PROGRAM_ID: &str = "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A";

/// Default queue-fill threshold at which a forester will batch-update the root.
pub const DEFAULT_FORESTER_QUEUE_THRESHOLD: u32 = 16;

/// Default poll interval (seconds) for the forester's on-chain queue watcher.
pub const DEFAULT_FORESTER_POLL_SECS: u64 = 10;

/// Default page size when backfilling historical transactions.
pub const DEFAULT_BACKFILL_LIMIT: u32 = 1000;

/// Default staleness threshold (seconds): if the listener hasn't observed
/// a fresh on-chain payload in this long, witness/tree-state HTTP handlers
/// answer 503 instead of returning a stale witness. Picked to comfortably
/// cover the worst-case `FORESTER_POLL_SECS` plus an extra RPC retry window.
pub const DEFAULT_STALENESS_THRESHOLD_SECS: u64 = 60;

/// Default per-IP `/witness` rate limit (requests per minute). The witness path
/// touches Poseidon hashing, so it's more expensive than a trivial GET; this
/// bounds how fast one source can drive it. `0` disables.
pub const DEFAULT_WITNESS_RATE_LIMIT_PER_MIN: u32 = 120;

/// Default cap on concurrently-served `/witness` requests. Bounds peak CPU so a
/// burst can't pin every core. `0` disables.
pub const DEFAULT_WITNESS_MAX_CONCURRENCY: usize = 16;

/// Default per-request `/witness` timeout (seconds).
pub const DEFAULT_WITNESS_TIMEOUT_SECS: u64 = 10;

#[derive(Clone, Debug)]
pub struct Config {
    pub rpc_url: String,
    pub ws_url: String,
    pub db_path: PathBuf,
    pub port: u16,
    pub pool_program_id: String,
    /// The SPL mint of the tree the forester operates against. Required when
    /// the forester role is enabled because `update_root_via_proof` takes
    /// `mint` as an account (the program derives the per-mint MerkleTree PDA
    /// from it). Optional otherwise; the indexer's witness API doesn't need it.
    pub pool_mint: String,
    pub prover_url: String,
    /// `Some(path)` enables the forester role; `None` runs as indexer-only.
    pub forester_keypair_path: Option<PathBuf>,
    pub forester_queue_threshold: u32,
    pub forester_poll_secs: u64,
    pub backfill_limit: u32,
    /// Witness API refuses to answer if the listener hasn't observed the
    /// chain in this long (seconds). See [`DEFAULT_STALENESS_THRESHOLD_SECS`].
    pub staleness_threshold_secs: u64,
    /// Per-IP request cap (per minute) on `/witness`. `0` disables limiting.
    pub witness_rate_limit_per_min: u32,
    /// Max number of `/witness` requests served concurrently (bounds peak CPU).
    /// `0` disables the cap.
    pub witness_max_concurrency: usize,
    /// Hard timeout (seconds) for a single `/witness` request.
    pub witness_timeout_secs: u64,
    /// Reverse-proxy / CDN peer IPs whose `X-Forwarded-For` is trusted for
    /// rate-limit keying. Empty by default (trust no XFF; key on socket peer).
    /// Same semantics as the relayer's `RELAY_TRUSTED_PROXIES`.
    pub trusted_proxies: std::collections::HashSet<std::net::IpAddr>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let rpc_url =
            std::env::var("RPC_URL").unwrap_or_else(|_| DEFAULT_RPC_URL.to_string());
        let ws_url = std::env::var("WS_URL").unwrap_or_else(|_| DEFAULT_WS_URL.to_string());
        let db_path = std::env::var("INDEXER_DB_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./indexer.db"));
        let port = parse_env_u16("INDEXER_PORT", DEFAULT_INDEXER_PORT)?;

        let pool_program_id = std::env::var("POOL_PROGRAM_ID")
            .unwrap_or_else(|_| DEFAULT_POOL_PROGRAM_ID.to_string());
        // Basic base58 sanity — full pubkey decoding lives in `solana.rs`.
        if bs58::decode(&pool_program_id).into_vec().ok().map(|v| v.len()) != Some(32) {
            return Err(Error::ConfigInvalid(format!(
                "POOL_PROGRAM_ID is not a valid base58-encoded 32-byte pubkey: {pool_program_id}"
            )));
        }

        // `POOL_MINT` is only required when the forester role is enabled
        // (it's only used to derive the on-chain MerkleTree PDA passed into
        // `update_root_via_proof`). Default to a 32-byte zero pubkey when
        // unset so indexer-only deployments keep working.
        let pool_mint = std::env::var("POOL_MINT")
            .unwrap_or_else(|_| "11111111111111111111111111111111".to_string());

        let prover_url = std::env::var("PROVER_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8787".to_string());

        let forester_keypair_path = std::env::var("FORESTER_KEYPAIR_PATH")
            .ok()
            .map(PathBuf::from);

        let forester_queue_threshold = parse_env_u32(
            "FORESTER_QUEUE_THRESHOLD",
            DEFAULT_FORESTER_QUEUE_THRESHOLD,
        )?;
        let forester_poll_secs = parse_env_u64(
            "FORESTER_POLL_SECS",
            DEFAULT_FORESTER_POLL_SECS,
        )?;
        let backfill_limit = parse_env_u32(
            "BACKFILL_LIMIT",
            DEFAULT_BACKFILL_LIMIT,
        )?;

        let staleness_threshold_secs = parse_env_u64(
            "STALENESS_THRESHOLD_SECS",
            DEFAULT_STALENESS_THRESHOLD_SECS,
        )?;

        let witness_rate_limit_per_min = parse_env_u32(
            "WITNESS_RATE_LIMIT_PER_MIN",
            DEFAULT_WITNESS_RATE_LIMIT_PER_MIN,
        )?;
        let witness_max_concurrency = parse_env_usize(
            "WITNESS_MAX_CONCURRENCY",
            DEFAULT_WITNESS_MAX_CONCURRENCY,
        )?;
        let witness_timeout_secs = parse_env_u64(
            "WITNESS_TIMEOUT_SECS",
            DEFAULT_WITNESS_TIMEOUT_SECS,
        )?;

        // Comma-separated trusted reverse-proxy peer IPs. A malformed entry is
        // a hard config error (fail loud rather than silently mis-trust).
        let trusted_proxies = match std::env::var("INDEXER_TRUSTED_PROXIES") {
            Ok(raw) => {
                let mut set = std::collections::HashSet::new();
                for part in raw.split(',') {
                    let part = part.trim();
                    if part.is_empty() {
                        continue;
                    }
                    let ip = part.parse::<std::net::IpAddr>().map_err(|e| {
                        Error::ConfigInvalid(format!("INDEXER_TRUSTED_PROXIES entry '{part}': {e}"))
                    })?;
                    set.insert(ip);
                }
                set
            }
            Err(_) => std::collections::HashSet::new(),
        };

        Ok(Self {
            rpc_url,
            ws_url,
            db_path,
            port,
            pool_program_id,
            pool_mint,
            prover_url,
            forester_keypair_path,
            forester_queue_threshold,
            forester_poll_secs,
            backfill_limit,
            staleness_threshold_secs,
            witness_rate_limit_per_min,
            witness_max_concurrency,
            witness_timeout_secs,
            trusted_proxies,
        })
    }

    /// Whether this node will spawn the forester task in addition to the indexer.
    pub fn forester_enabled(&self) -> bool {
        self.forester_keypair_path.is_some()
    }
}

fn parse_env_u16(name: &str, default: u16) -> Result<u16> {
    match std::env::var(name) {
        Ok(s) => s
            .parse::<u16>()
            .map_err(|e| Error::ConfigInvalid(format!("{name}: {e}"))),
        Err(_) => Ok(default),
    }
}

fn parse_env_u32(name: &str, default: u32) -> Result<u32> {
    match std::env::var(name) {
        Ok(s) => s
            .parse::<u32>()
            .map_err(|e| Error::ConfigInvalid(format!("{name}: {e}"))),
        Err(_) => Ok(default),
    }
}

fn parse_env_u64(name: &str, default: u64) -> Result<u64> {
    match std::env::var(name) {
        Ok(s) => s
            .parse::<u64>()
            .map_err(|e| Error::ConfigInvalid(format!("{name}: {e}"))),
        Err(_) => Ok(default),
    }
}

fn parse_env_usize(name: &str, default: usize) -> Result<usize> {
    match std::env::var(name) {
        Ok(s) => s
            .parse::<usize>()
            .map_err(|e| Error::ConfigInvalid(format!("{name}: {e}"))),
        Err(_) => Ok(default),
    }
}
