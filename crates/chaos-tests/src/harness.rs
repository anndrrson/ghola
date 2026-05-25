//! Shared test utilities for the chaos suite.
//!
//! All primitives here are deliberately small: a single
//! `MockProver`/`MockRpc` is one wiremock server with one behavior knob,
//! and a single `TestRelayer`/`TestIndexer` boots the production code
//! inside the test process with an `AppState` we control. Composition
//! happens in `scenarios.rs` and in `tests/*`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use wiremock::matchers::{any, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ---------------------------------------------------------------------
// Mock prover
// ---------------------------------------------------------------------

/// Configurable behavior for [`MockProver`].
#[derive(Clone, Debug)]
pub enum ProverBehavior {
    /// Respond after `Duration::from_secs(60)` no matter what. Used to
    /// exercise the prover-timeout path.
    HangForever,
    /// Return HTTP 5xx for the first `n` requests, then a valid proof.
    Return5xxNTimes(usize),
    /// Always return a structurally valid (but cryptographically dummy)
    /// proof bundle.
    ReturnValidProof,
}

/// Wiremock-backed mock of the said-shielded-pool-prover HTTP API.
///
/// The indexer's forester calls `POST /prove-batch-update`. We surface
/// the same shape so the forester can swallow our mock as a drop-in
/// substitute.
pub struct MockProver {
    pub server: MockServer,
}

impl MockProver {
    pub async fn spawn(behavior: ProverBehavior) -> Self {
        let server = MockServer::start().await;
        match behavior {
            ProverBehavior::HangForever => {
                // wiremock can't "hang forever" in the absolute sense, but
                // a 60s delay is far longer than any sane prover timeout
                // in this stack (Stream 5's PROVER_SUBPROCESS_TIMEOUT_MS
                // default is 30 000ms).
                Mock::given(any())
                    .respond_with(
                        ResponseTemplate::new(200)
                            .set_delay(Duration::from_secs(60))
                            .set_body_json(valid_proof_response()),
                    )
                    .mount(&server)
                    .await;
            }
            ProverBehavior::Return5xxNTimes(n) => {
                if n > 0 {
                    Mock::given(any())
                        .respond_with(ResponseTemplate::new(503))
                        .up_to_n_times(n as u64)
                        .mount(&server)
                        .await;
                }
                Mock::given(any())
                    .respond_with(
                        ResponseTemplate::new(200).set_body_json(valid_proof_response()),
                    )
                    .mount(&server)
                    .await;
            }
            ProverBehavior::ReturnValidProof => {
                Mock::given(any())
                    .respond_with(
                        ResponseTemplate::new(200).set_body_json(valid_proof_response()),
                    )
                    .mount(&server)
                    .await;
            }
        }
        Self { server }
    }

    pub fn url(&self) -> String {
        self.server.uri()
    }
}

fn valid_proof_response() -> Value {
    json!({
        "proof": {
            "a": ["0".repeat(64), "0".repeat(64)],
            "b": [["0".repeat(64), "0".repeat(64)], ["0".repeat(64), "0".repeat(64)]],
            "c": ["0".repeat(64), "0".repeat(64)],
        },
        "public_inputs": [],
        "new_root": "0".repeat(64),
    })
}

// ---------------------------------------------------------------------
// Mock Solana JSON-RPC
// ---------------------------------------------------------------------

/// Configurable behavior for [`MockRpc`].
#[derive(Clone, Debug)]
pub enum RpcBehavior {
    /// Return 503 the first `n` requests, then valid responses.
    Flap5xxNTimes(usize),
    /// Return a stale (fixed) block height; never advances. Returns
    /// empty signature lists.
    StaleStateForever,
    /// Permanently report `getSignatureStatuses` as `Unknown` for any
    /// signature, so the relayer never sees `Confirmed`. Latest blockhash
    /// and getSignaturesForAddress still work normally.
    SignatureUnknownForever,
    /// Healthy mock — every request returns a reasonable default.
    Healthy,
}

/// Wiremock-backed mock of the Solana JSON-RPC API.
///
/// We respond to:
/// - `getLatestBlockhash`
/// - `getSignaturesForAddress`
/// - `getSignatureStatuses`
/// - `getTransaction`
/// - `sendTransaction`
/// - `getBlockHeight`
///
/// All other methods get an empty `result`.
pub struct MockRpc {
    pub server: MockServer,
    /// Request counter for tests that want to assert "we hit the RPC N times".
    pub hits: Arc<AtomicUsize>,
}

impl MockRpc {
    pub async fn spawn(behavior: RpcBehavior) -> Self {
        let server = MockServer::start().await;
        let hits = Arc::new(AtomicUsize::new(0));

        match behavior {
            RpcBehavior::Flap5xxNTimes(n) => {
                if n > 0 {
                    Mock::given(method("POST"))
                        .and(path("/"))
                        .respond_with(ResponseTemplate::new(503))
                        .up_to_n_times(n as u64)
                        .mount(&server)
                        .await;
                }
                Mock::given(method("POST"))
                    .and(path("/"))
                    .respond_with(
                        ResponseTemplate::new(200).set_body_json(healthy_rpc_response()),
                    )
                    .mount(&server)
                    .await;
            }
            RpcBehavior::StaleStateForever => {
                Mock::given(method("POST"))
                    .and(path("/"))
                    .respond_with(
                        ResponseTemplate::new(200).set_body_json(stale_rpc_response()),
                    )
                    .mount(&server)
                    .await;
            }
            RpcBehavior::SignatureUnknownForever => {
                Mock::given(method("POST"))
                    .and(path("/"))
                    .respond_with(
                        ResponseTemplate::new(200).set_body_json(unknown_sig_response()),
                    )
                    .mount(&server)
                    .await;
            }
            RpcBehavior::Healthy => {
                Mock::given(method("POST"))
                    .and(path("/"))
                    .respond_with(
                        ResponseTemplate::new(200).set_body_json(healthy_rpc_response()),
                    )
                    .mount(&server)
                    .await;
            }
        }

        Self { server, hits }
    }

    pub fn url(&self) -> String {
        self.server.uri()
    }
}

fn healthy_rpc_response() -> Value {
    // wiremock returns the same body for every request; for the RPC mock
    // we cheat by emitting a "shape-flexible" JSON that satisfies enough
    // of the methods we hit: `result` is an object with the union of
    // fields we care about.
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "context": { "slot": 1 },
            "value": {
                "blockhash": "11111111111111111111111111111111",
                "lastValidBlockHeight": 1000,
            },
        }
    })
}

fn stale_rpc_response() -> Value {
    // Same shape as healthy, but the "blockHeight" never advances. The
    // staleness test doesn't actually rely on this directly — what it
    // tests is the indexer's `latest_root_observed_unix` clock — but
    // we shape the response so the listener's first poll succeeds and
    // then we let wall-clock time elapse.
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": []
    })
}

fn unknown_sig_response() -> Value {
    // For `getSignatureStatuses` we want every entry to be `null`,
    // which Solana documents as "the transaction is not yet visible".
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "context": { "slot": 1 },
            "value": [null]
        }
    })
}

// ---------------------------------------------------------------------
// In-process relayer
// ---------------------------------------------------------------------

/// Boots the production relayer in-process against a temp sled DB and a
/// random TCP port. Returns the base URL plus a join handle for the axum
/// server (drop the handle to shut it down at end-of-test).
pub struct TestRelayer {
    pub url: String,
    pub addr: SocketAddr,
    pub max_queue_depth: usize,
    pub queue: said_shielded_pool_relayer::WithdrawalQueue,
    _server: JoinHandle<()>,
    _tmpdir: tempfile::TempDir,
}

/// Knobs the test wants to control on the relayer.
#[derive(Clone, Debug)]
pub struct RelayerCfgOverrides {
    pub max_queue_depth: usize,
    pub anonymity_threshold: usize,
    pub batch_size: usize,
    pub min_delay_secs: u64,
    pub max_delay_secs: u64,
    pub max_retries: u32,
    pub retry_initial_delay_ms: u64,
    pub retry_max_delay_ms: u64,
    pub rpc_url: String,
}

impl Default for RelayerCfgOverrides {
    fn default() -> Self {
        Self {
            max_queue_depth: 10_000,
            anonymity_threshold: 4,
            batch_size: 8,
            min_delay_secs: 1,
            max_delay_secs: 2,
            max_retries: 5,
            retry_initial_delay_ms: 500,
            retry_max_delay_ms: 8000,
            rpc_url: "http://127.0.0.1:1".into(),
        }
    }
}

impl TestRelayer {
    pub async fn spawn(overrides: RelayerCfgOverrides) -> anyhow::Result<Self> {
        use said_shielded_pool_relayer::config::Config;
        use said_shielded_pool_relayer::metrics::Metrics;
        use said_shielded_pool_relayer::queue::WithdrawalQueue;
        use said_shielded_pool_relayer::routes::{router, AppState};

        let tmpdir = tempfile::tempdir()?;
        let queue_db = tmpdir.path().join("queue.db");
        // A fake keypair file — the routes we hit in chaos tests don't
        // actually need to sign anything (we never trigger the
        // submitter), but Config::from_env wants the path to exist.
        let kp_path = tmpdir.path().join("kp.json");
        std::fs::write(&kp_path, "[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]")?;

        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;

        let cfg = Config {
            port: addr.port(),
            rpc_url: overrides.rpc_url.clone(),
            keypair_path: kp_path,
            queue_db_path: PathBuf::from(&queue_db),
            batch_size: overrides.batch_size,
            min_delay: Duration::from_secs(overrides.min_delay_secs),
            max_delay: Duration::from_secs(overrides.max_delay_secs),
            anonymity_threshold: overrides.anonymity_threshold,
            decoy_rate_per_hour: 0.0,
            jitter_lambda: 0.5,
            max_retries: overrides.max_retries,
            retry_initial_delay_ms: overrides.retry_initial_delay_ms,
            retry_max_delay_ms: overrides.retry_max_delay_ms,
            pool_program_id: said_shielded_pool_relayer::config::DEFAULT_POOL_PROGRAM_ID
                .to_string(),
            max_queue_depth: overrides.max_queue_depth,
            relay_rate_limit_per_min: 0,
            dedup_ttl_secs: said_shielded_pool_relayer::config::DEFAULT_DEDUP_TTL_SECS,
            trusted_proxies: std::collections::HashSet::new(),
        };
        let cfg = Arc::new(cfg);

        let queue = WithdrawalQueue::open(&queue_db)?;
        let metrics = Arc::new(Metrics::new());

        // We don't spawn a Batcher in the chaos tests — the tests we run
        // here are about HTTP-layer behavior (backpressure, status
        // collapse) and don't need on-chain submission. AppState wants
        // a Batcher to clone its Notify; we synthesise one here without
        // wiring its run loop into the runtime.
        let submitter: Arc<dyn said_shielded_pool_relayer::submit::Submitter + Send + Sync> =
            Arc::new(NoopSubmitter::default());
        let batcher = said_shielded_pool_relayer::batcher::Batcher::new(
            queue.clone(),
            cfg.clone(),
            submitter,
            metrics.clone(),
        );
        let state = AppState::new(queue.clone(), cfg.clone(), metrics.clone(), &batcher);
        let app = router(state);

        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let url = format!("http://{}", addr);
        Ok(Self {
            url,
            addr,
            max_queue_depth: overrides.max_queue_depth,
            queue,
            _server: server,
            _tmpdir: tmpdir,
        })
    }
}

/// A submitter that does nothing — used in chaos tests that exercise
/// only the HTTP front-end of the relayer and never trigger the
/// batcher's submit loop.
#[derive(Default)]
struct NoopSubmitter;

#[async_trait::async_trait]
impl said_shielded_pool_relayer::submit::Submitter for NoopSubmitter {
    async fn submit_one(
        &self,
        _w: &said_shielded_pool_relayer::QueuedWithdrawal,
    ) -> said_shielded_pool_relayer::Result<()> {
        Ok(())
    }
    async fn submit_decoy(&self) -> said_shielded_pool_relayer::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------
// In-process indexer
// ---------------------------------------------------------------------

/// Boots the indexer's HTTP server in-process. The listener task is
/// NOT spawned — we drive `state.touch_root_observed()` from the test
/// to simulate stale / fresh chain observations deterministically.
pub struct TestIndexer {
    pub url: String,
    pub addr: SocketAddr,
    pub state: said_shielded_pool_indexer::AppState,
    _server: JoinHandle<()>,
    _tmpdir: tempfile::TempDir,
}

#[derive(Clone, Debug)]
pub struct IndexerCfgOverrides {
    pub staleness_threshold_secs: u64,
    pub rpc_url: String,
}

impl Default for IndexerCfgOverrides {
    fn default() -> Self {
        Self {
            staleness_threshold_secs: 60,
            rpc_url: "http://127.0.0.1:1".into(),
        }
    }
}

impl TestIndexer {
    pub async fn spawn(overrides: IndexerCfgOverrides) -> anyhow::Result<Self> {
        use said_shielded_pool_indexer::config::Config;
        use said_shielded_pool_indexer::routes::router;
        use said_shielded_pool_indexer::state::AppState;
        use said_shielded_pool_indexer::tree::IncrementalMerkleTree;

        let tmpdir = tempfile::tempdir()?;
        let db_path = tmpdir.path().join("indexer.db");
        let db = sled_open(&db_path)?;
        let tree = IncrementalMerkleTree::open(db)
            .map_err(|e| anyhow::anyhow!("tree open: {e:?}"))?;

        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;

        let cfg = Config {
            rpc_url: overrides.rpc_url.clone(),
            ws_url: overrides.rpc_url.clone(),
            db_path,
            port: addr.port(),
            pool_program_id: "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A".into(),
            pool_mint: "11111111111111111111111111111111".into(),
            prover_url: "http://127.0.0.1:1".into(),
            forester_keypair_path: None,
            forester_queue_threshold: 16,
            forester_poll_secs: 10,
            backfill_limit: 100,
            staleness_threshold_secs: overrides.staleness_threshold_secs,
            // Witness DoS bounds — defaults are fine for chaos tests (which use
            // a bare `axum::serve` with no ConnectInfo, so the per-IP limiter is
            // skipped). Concurrency/timeout layers are inert at this scale.
            witness_rate_limit_per_min:
                said_shielded_pool_indexer::config::DEFAULT_WITNESS_RATE_LIMIT_PER_MIN,
            witness_max_concurrency:
                said_shielded_pool_indexer::config::DEFAULT_WITNESS_MAX_CONCURRENCY,
            witness_timeout_secs:
                said_shielded_pool_indexer::config::DEFAULT_WITNESS_TIMEOUT_SECS,
            trusted_proxies: std::collections::HashSet::new(),
        };

        let state = AppState::new(cfg, tree);
        let state_clone = state.clone();
        let app = router(state_clone);

        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let url = format!("http://{}", addr);
        Ok(Self {
            url,
            addr,
            state,
            _server: server,
            _tmpdir: tmpdir,
        })
    }
}

fn sled_open(path: &std::path::Path) -> anyhow::Result<sled::Db> {
    sled::open(path).map_err(|e| anyhow::anyhow!("sled open: {e}"))
}

// `sled` is re-exported by the indexer crate, but the harness needs it
// for tree-DB construction. Bring it in via the indexer's public deps —
// said-shielded-pool-indexer exports `IncrementalMerkleTree::open(db: sled::Db)`,
// so we need a matching `sled::open`. Pull it via the workspace.
use sled;

// ---------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------

/// A structurally-valid `RelayRequest` body. Contains zero field elements
/// — the relayer only checks shape, never crypto.
pub fn dummy_relay_request_body() -> Value {
    dummy_relay_request_body_with_seed(0)
}

/// Variant that produces UNIQUE proof bytes per `seed`. Required by tests
/// that submit many bodies to the same relayer — the dedup layer
/// (`relayer::dedup`) content-addresses by `blake3(proof.a||b||c)` so
/// reusing the same body would dedupe instead of testing queue depth /
/// concurrency.
pub fn dummy_relay_request_body_with_seed(seed: u64) -> Value {
    let mut a = vec![0u8; 64];
    a[..8].copy_from_slice(&seed.to_le_bytes());
    let a_hex = a.iter().map(|b| format!("{b:02x}")).collect::<String>();
    json!({
        "proof_bundle": {
            "proof": {"a": a_hex, "b": "0".repeat(256), "c": "0".repeat(128)},
            "public_inputs": {
                "root": "0".repeat(64),
                "input_nullifiers": ["0".repeat(64)],
                "output_commitments": ["0".repeat(64)],
                "public_amount": 0,
                "asset_id": "0".repeat(64),
                "ext_data_hash": "0".repeat(64),
            }
        },
        // 32-byte all-ones recipient, base58 of [1; 32]
        "recipient": "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
        "fee": 5000,
        "relayer_fee": 1000
    })
}
