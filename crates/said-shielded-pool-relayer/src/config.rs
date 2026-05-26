//! Relayer configuration, loaded from environment variables.
//!
//! Every knob has privacy implications — see README.md.

use crate::error::{Error, Result};
use std::path::PathBuf;
use std::time::Duration;

/// Devnet default for the deployed said-shielded-pool program. Phase 41.
pub const DEFAULT_POOL_PROGRAM_ID: &str = "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A";
/// Devnet default RPC.
pub const DEFAULT_RPC_URL: &str = "https://api.devnet.solana.com";

#[derive(Clone, Debug)]
pub struct Config {
    /// HTTP listen port for the axum API.
    pub port: u16,

    /// Solana JSON-RPC URL the relayer submits to.
    pub rpc_url: String,

    /// Path to the relayer's fee-paying keypair JSON.
    pub keypair_path: PathBuf,

    /// Path to the sled queue database (persists across restarts so we
    /// don't drop user withdrawals on relayer crash).
    pub queue_db_path: PathBuf,

    /// Hard cap on items in a single batch. Each item in a batch becomes
    /// a separate on-chain transaction (we cannot pack multiple withdraws
    /// into one tx because each consumes a distinct compute budget and a
    /// linkage between submissions is itself a side-channel). BATCH_SIZE
    /// limits the burst rate.
    pub batch_size: usize,

    /// Minimum time the oldest queue item must wait before release IF
    /// the anonymity threshold is also met. Smaller = lower latency,
    /// weaker timing privacy.
    pub min_delay: Duration,

    /// Maximum time the oldest queue item may wait before forced release.
    /// Acts as a safety valve so withdrawals don't hang forever when the
    /// queue is below the anonymity threshold.
    pub max_delay: Duration,

    /// Minimum queue depth for a normal (non-safety-valve) release. This
    /// is the k-anonymity set size FOR TIMING/ORDERING ONLY: on chain, an
    /// observer sees k withdrawals leave the relayer in a batch, so the link
    /// from a given HTTP request to its on-chain tx has at best 1/k
    /// probability.
    ///
    /// CRITICAL LIMITATION (V1, design-gated): this 1/k property says
    /// NOTHING about VALUE-linkability. Withdrawal `amount` is a clear-text
    /// `u64` on-chain (see `programs/said-shielded-pool/src/instructions/
    /// withdraw.rs` and SPEC §1.4: "we do not hide aggregate per-asset
    /// flow ... `public_amount` ... is public"). An on-chain observer reads
    /// the exact amount credited to the recipient ATA and matches it against
    /// deposit amounts. Because amounts are arbitrary high-entropy u64
    /// values (NOT fixed denominations), a single deposit→withdrawal pair is
    /// typically uniquely linkable BY VALUE ALONE — regardless of how large
    /// `anonymity_threshold` (k) is. Raising k improves only timing privacy;
    /// it does NOT make the rail an untraceable mixer. Closing this requires
    /// fixed-denomination withdrawals at the circuit + program level (a
    /// trusted-setup / ceremony change), out of scope for the relayer.
    pub anonymity_threshold: usize,

    /// Hard floor on the number of items released in ANY batch, including
    /// the `max_delay` safety-valve path. Distinct from
    /// `anonymity_threshold`: the threshold gates the *normal* release path
    /// and is bypassed by the safety valve, whereas `relay_k_min` is an
    /// absolute lower bound the batcher will not cross while
    /// `release_below_kmin` is `false`.
    ///
    /// Default is `1`, which PRESERVES the historical behaviour (a lone
    /// withdrawal may be released by itself once it ages past `max_delay`).
    /// That default is honest, not safe: at `k_min == 1` the effective
    /// anonymity set at low traffic is 1 (perfect HTTP-request→tx linkage).
    /// Set `RELAY_K_MIN` > 1 for any deployment that claims meaningful
    /// timing privacy.
    ///
    /// Tradeoff: until the decoy generator is delivered (V2 — see
    /// `decoy.rs`), there are NO decoys to pad a thin queue, so a
    /// `relay_k_min` > 1 combined with `release_below_kmin == false` means a
    /// thin queue will STALL past `max_delay` rather than release an
    /// under-sized batch. See `release_below_kmin`.
    pub relay_k_min: usize,

    /// Liveness-vs-anonymity policy for the case where the queue cannot
    /// reach `relay_k_min` by `max_delay` AND no decoys are available to pad
    /// the batch (the current reality, since decoys are not implemented —
    /// V2):
    ///
    /// - `true`  — release the under-sized batch anyway (favour LIVENESS;
    ///   the withdrawal goes through). The batcher emits a prominent `WARN`
    ///   "privacy degraded: released batch below k_min" so the degradation
    ///   is never silent.
    /// - `false` — keep HOLDING the batch until it reaches `k_min` (favour
    ///   ANONYMITY; the withdrawal may be delayed indefinitely if traffic
    ///   stays thin). Operators MUST monitor queue depth, because the
    ///   `max_delay` safety valve no longer guarantees release.
    ///
    /// Default `true`, so out-of-the-box behaviour matches the historical
    /// "release everything at the safety valve" semantics. With the default
    /// `relay_k_min == 1` this flag is a no-op (a batch of 1 already meets
    /// k_min); it only bites once an operator raises `RELAY_K_MIN`.
    pub release_below_kmin: bool,

    /// Decoy transactions per hour. 0 disables decoy traffic.
    ///
    /// STATUS (V2, design-gated): the decoy generator is NOT implemented —
    /// there is no program entrypoint that emits an on-chain-indistinguishable
    /// `withdraw{amount:0}` cover tx, and the in-relayer decoy pool is never
    /// populated. `submit_decoy()` is therefore a hard no-op that returns an
    /// error. Setting `DECOY_RATE` > 0 buys NO cover traffic; to prevent an
    /// operator from believing they have cover when they do not, the relayer
    /// logs a prominent startup `WARN` (see `main.rs`) whenever this is > 0.
    pub decoy_rate_per_hour: f64,

    /// Lambda for the Poisson inter-submission jitter inside a batch.
    /// Larger = tighter clustering (less timing decorrelation).
    pub jitter_lambda: f64,

    /// Maximum retry attempts for a failed on-chain submission. After
    /// this many failures the item is marked Failed and surfaced via
    /// `/status` (client can retry via a fresh /relay POST).
    pub max_retries: u32,

    /// Initial delay before the first submit retry. Doubled each
    /// attempt up to `retry_max_delay_ms`.
    pub retry_initial_delay_ms: u64,

    /// Cap on the exponential-backoff delay.
    pub retry_max_delay_ms: u64,

    /// On-chain program ID (base58) the relayer targets. Required so
    /// we can sanity-check the instruction the client supplies — we
    /// never re-derive PDAs from this in the relayer itself.
    pub pool_program_id: String,

    /// Hard cap on pending queue depth. Once reached, `POST /relay`
    /// short-circuits with HTTP 429 + `Retry-After`. This prevents an
    /// adversary (or a sustained legitimate burst) from exhausting disk
    /// + memory on the relayer host. Tuned so even a multi-day outage
    /// burst stays well under typical sled / RAM ceilings.
    pub max_queue_depth: usize,

    /// Per-IP `POST /relay` rate limit: max requests per fixed 60s window.
    /// Bounds how fast a single source can flood unique proofs (which would
    /// otherwise grow the dedup index and consume queue slots). Privacy note:
    /// many clients legitimately egress through a shared relay/CDN IP, so this
    /// is deliberately generous and is a coarse DoS bound, not a per-user
    /// quota. Set to 0 to disable.
    pub relay_rate_limit_per_min: u32,

    /// Maximum age (seconds) a dedup entry is retained before a periodic sweep
    /// removes it. Must comfortably exceed the queue drain + honest-retry
    /// window so pruning never resurrects an in-flight replay. The on-chain
    /// nullifier check remains the ultimate replay backstop. Set to 0 to
    /// disable pruning (unbounded growth — not recommended).
    pub dedup_ttl_secs: i64,

    /// Set of reverse-proxy / CDN peer IPs whose `X-Forwarded-For` header is
    /// trusted for rate-limit keying. The connecting `SocketAddr` is checked
    /// against this set; only if the immediate peer is a trusted proxy do we
    /// honor XFF (and take its rightmost valid entry). For ANY other peer
    /// (i.e. a direct client connection, or no proxy deployed) we IGNORE XFF
    /// entirely and key on the real peer address — otherwise a client can
    /// forge XFF to rotate its rate-limit identity every request.
    ///
    /// Configured via `RELAY_TRUSTED_PROXIES` (comma-separated IPs). Empty by
    /// default (the safe default: trust no XFF, always use the socket peer).
    pub trusted_proxies: std::collections::HashSet<std::net::IpAddr>,

    /// Optional bearer token guarding `GET /metrics`. When `Some`, the
    /// endpoint requires `Authorization: Bearer <token>` and rejects
    /// everything else with 401.
    ///
    /// Why this matters (V4): `/metrics` exposes the live anonymity-set
    /// gauge and queue depth. Left open, an observer who polls it can read
    /// the exact size of the most recently released batch and correlate
    /// "last batch size == 1" with the single on-chain tx that just landed —
    /// re-opening the very side-channel the M3 log-demotion was meant to
    /// close. Two independent mitigations are applied:
    ///   1. The gauge itself is COARSENED into wide buckets (see
    ///      `metrics.rs`), so even an unauthenticated scrape never reveals
    ///      the exact last-batch size; and the separate decoy counter is
    ///      removed so an observer cannot subtract decoys from totals.
    ///   2. This optional token lets an operator additionally lock the whole
    ///      endpoint down to their monitoring system.
    ///
    /// Configured via `RELAY_METRICS_TOKEN`. Empty/unset = open endpoint
    /// (acceptable ONLY because of mitigation 1). Production deployments that
    /// expose `/metrics` beyond a trusted network SHOULD set it.
    pub metrics_token: Option<String>,
}

/// Default cap on pending queue depth. See [`Config::max_queue_depth`].
pub const DEFAULT_MAX_QUEUE_DEPTH: usize = 10_000;

/// Default per-IP `/relay` rate limit (requests per minute).
pub const DEFAULT_RELAY_RATE_LIMIT_PER_MIN: u32 = 60;

/// Default dedup retention (24h) — well beyond any realistic queue-drain +
/// client-retry window.
pub const DEFAULT_DEDUP_TTL_SECS: i64 = 86_400;

impl Config {
    /// Load from environment. Missing values fall back to safe defaults
    /// where reasonable; required values (RPC_URL, RELAYER_KEYPAIR_PATH)
    /// hard-error.
    pub fn from_env() -> Result<Self> {
        let port = env_parse::<u16>("RELAYER_PORT").unwrap_or(Ok(8088))
            .map_err(|e| Error::Config(format!("RELAYER_PORT: {e}")))?;

        let rpc_url =
            std::env::var("RPC_URL").unwrap_or_else(|_| DEFAULT_RPC_URL.to_string());

        let keypair_path: PathBuf = match std::env::var("RELAYER_KEYPAIR_PATH") {
            Ok(p) => p.into(),
            Err(_) => {
                // PoC default: the local solana-cli keypair. Production
                // must set RELAYER_KEYPAIR_PATH explicitly.
                let home = std::env::var("HOME")
                    .map_err(|_| Error::Config("HOME unset and RELAYER_KEYPAIR_PATH not provided".into()))?;
                PathBuf::from(home).join(".config/solana/id.json")
            }
        };

        let queue_db_path: PathBuf = std::env::var("RELAYER_QUEUE_DB")
            .unwrap_or_else(|_| "./relayer-queue.db".into())
            .into();

        let batch_size = env_parse::<usize>("BATCH_SIZE").unwrap_or(Ok(8))
            .map_err(|e| Error::Config(format!("BATCH_SIZE: {e}")))?;

        let min_delay = Duration::from_secs(
            env_parse::<u64>("MIN_DELAY_SECS").unwrap_or(Ok(30))
                .map_err(|e| Error::Config(format!("MIN_DELAY_SECS: {e}")))?,
        );

        let max_delay = Duration::from_secs(
            env_parse::<u64>("MAX_DELAY_SECS").unwrap_or(Ok(600))
                .map_err(|e| Error::Config(format!("MAX_DELAY_SECS: {e}")))?,
        );

        let anonymity_threshold = env_parse::<usize>("ANONYMITY_THRESHOLD")
            .unwrap_or(Ok(4))
            .map_err(|e| Error::Config(format!("ANONYMITY_THRESHOLD: {e}")))?;

        // V3: hard floor on released batch size. Default 1 preserves the
        // historical behaviour (singleton release allowed) — honestly, not
        // safely. See the field doc on `Config::relay_k_min`.
        let relay_k_min = env_parse::<usize>("RELAY_K_MIN")
            .unwrap_or(Ok(1))
            .map_err(|e| Error::Config(format!("RELAY_K_MIN: {e}")))?;

        // V3: liveness-vs-anonymity policy when a thin queue can't reach
        // k_min by max_delay. Default true = release the under-sized batch
        // (with a WARN), matching the historical safety-valve semantics.
        let release_below_kmin = env_bool("RELAY_RELEASE_BELOW_KMIN", true)?;

        let decoy_rate_per_hour = env_parse::<f64>("DECOY_RATE")
            .unwrap_or(Ok(0.0))
            .map_err(|e| Error::Config(format!("DECOY_RATE: {e}")))?;

        let jitter_lambda = env_parse::<f64>("JITTER_LAMBDA")
            .unwrap_or(Ok(0.5))
            .map_err(|e| Error::Config(format!("JITTER_LAMBDA: {e}")))?;

        let max_retries = env_parse::<u32>("MAX_RETRIES").unwrap_or(Ok(5))
            .map_err(|e| Error::Config(format!("MAX_RETRIES: {e}")))?;

        let retry_initial_delay_ms = env_parse::<u64>("INITIAL_DELAY_MS")
            .unwrap_or(Ok(500))
            .map_err(|e| Error::Config(format!("INITIAL_DELAY_MS: {e}")))?;

        let retry_max_delay_ms = env_parse::<u64>("MAX_DELAY_MS")
            .unwrap_or(Ok(8000))
            .map_err(|e| Error::Config(format!("MAX_DELAY_MS: {e}")))?;

        let pool_program_id = std::env::var("POOL_PROGRAM_ID")
            .unwrap_or_else(|_| DEFAULT_POOL_PROGRAM_ID.to_string());

        let max_queue_depth = env_parse::<usize>("MAX_QUEUE_DEPTH")
            .unwrap_or(Ok(DEFAULT_MAX_QUEUE_DEPTH))
            .map_err(|e| Error::Config(format!("MAX_QUEUE_DEPTH: {e}")))?;

        let relay_rate_limit_per_min = env_parse::<u32>("RELAY_RATE_LIMIT_PER_MIN")
            .unwrap_or(Ok(DEFAULT_RELAY_RATE_LIMIT_PER_MIN))
            .map_err(|e| Error::Config(format!("RELAY_RATE_LIMIT_PER_MIN: {e}")))?;

        let dedup_ttl_secs = env_parse::<i64>("DEDUP_TTL_SECS")
            .unwrap_or(Ok(DEFAULT_DEDUP_TTL_SECS))
            .map_err(|e| Error::Config(format!("DEDUP_TTL_SECS: {e}")))?;

        // Comma-separated list of trusted reverse-proxy peer IPs. Any entry
        // that fails to parse as an IpAddr is a config error (fail loud rather
        // than silently trusting/ignoring a malformed proxy address).
        let trusted_proxies = match std::env::var("RELAY_TRUSTED_PROXIES") {
            Ok(raw) => {
                let mut set = std::collections::HashSet::new();
                for part in raw.split(',') {
                    let part = part.trim();
                    if part.is_empty() {
                        continue;
                    }
                    let ip = part.parse::<std::net::IpAddr>().map_err(|e| {
                        Error::Config(format!("RELAY_TRUSTED_PROXIES entry '{part}': {e}"))
                    })?;
                    set.insert(ip);
                }
                set
            }
            Err(_) => std::collections::HashSet::new(),
        };

        // V4: optional bearer token for `/metrics`. Empty/whitespace = unset.
        let metrics_token = match std::env::var("RELAY_METRICS_TOKEN") {
            Ok(t) if !t.trim().is_empty() => Some(t),
            _ => None,
        };

        if min_delay >= max_delay {
            return Err(Error::Config(
                "MIN_DELAY_SECS must be < MAX_DELAY_SECS".into(),
            ));
        }
        if batch_size == 0 || anonymity_threshold == 0 {
            return Err(Error::Config(
                "BATCH_SIZE and ANONYMITY_THRESHOLD must be > 0".into(),
            ));
        }
        if relay_k_min == 0 {
            return Err(Error::Config("RELAY_K_MIN must be > 0".into()));
        }
        if relay_k_min > batch_size {
            // A k_min above the batch cap can never be satisfied — a single
            // batch can hold at most `batch_size` items, so the queue would
            // stall forever (with release_below_kmin=false) or warn on every
            // release (true). Fail loud at boot rather than ship a misconfig.
            return Err(Error::Config(format!(
                "RELAY_K_MIN ({relay_k_min}) must be <= BATCH_SIZE ({batch_size})"
            )));
        }
        if max_queue_depth == 0 {
            return Err(Error::Config(
                "MAX_QUEUE_DEPTH must be > 0".into(),
            ));
        }

        Ok(Self {
            port,
            rpc_url,
            keypair_path,
            queue_db_path,
            batch_size,
            min_delay,
            max_delay,
            anonymity_threshold,
            relay_k_min,
            release_below_kmin,
            decoy_rate_per_hour,
            jitter_lambda,
            max_retries,
            retry_initial_delay_ms,
            retry_max_delay_ms,
            pool_program_id,
            max_queue_depth,
            relay_rate_limit_per_min,
            dedup_ttl_secs,
            trusted_proxies,
            metrics_token,
        })
    }
}

fn env_parse<T: std::str::FromStr>(key: &str) -> Option<std::result::Result<T, T::Err>> {
    std::env::var(key).ok().map(|v| v.parse::<T>())
}

/// Parse a boolean-ish env var. Accepts `1/0`, `true/false`, `yes/no`,
/// `on/off` (case-insensitive). Unset → `default`. A malformed value is a
/// hard config error (fail loud rather than silently pick a default).
fn env_bool(key: &str, default: bool) -> Result<bool> {
    match std::env::var(key) {
        Err(_) => Ok(default),
        Ok(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            other => Err(Error::Config(format!(
                "{key}: expected a boolean (true/false), got '{other}'"
            ))),
        },
    }
}
