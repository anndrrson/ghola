//! Stream 3 — `/relay` idempotent-replay test.
//!
//! Drives the axum `relay` handler in-process (no HTTP) by reusing the
//! `AppState` plumbing the integration suite already builds. We verify
//! the cardinal property of the dedup layer:
//!
//!   Two identical proof bundles, submitted back-to-back, share a
//!   single queue slot and return the SAME `request_id` to the client.
//!
//! And the bonus property:
//!
//!   The dedup key is content-derived from `proof.a/b/c` ONLY. A third
//!   submission with the same proof bytes but a different `recipient`
//!   also dedupes. (The on-chain verifier will reject any such attempt
//!   anyway via `ext_data_hash`, but client-side dedup catches it first
//!   so we don't waste a queue slot.)
//!
//! Lives outside the lib `mod tests` because it pulls in the full
//! axum `Router` wiring — heavier than a unit test wants.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

use said_shielded_pool_relayer::batcher::Batcher;
use said_shielded_pool_relayer::config::Config;
use said_shielded_pool_relayer::dedup::Dedup;
use said_shielded_pool_relayer::metrics::Metrics;
use said_shielded_pool_relayer::queue::WithdrawalQueue;
use said_shielded_pool_relayer::routes::{router, AppState};
use said_shielded_pool_relayer::submit::Submitter;

/// Minimal in-memory submitter that never actually submits — the
/// dedup test cares only about /relay ingest, not chain plumbing.
struct NullSubmitter;

#[async_trait::async_trait]
impl Submitter for NullSubmitter {
    async fn submit_one(
        &self,
        _withdrawal: &said_shielded_pool_relayer::queue::QueuedWithdrawal,
    ) -> said_shielded_pool_relayer::error::Result<()> {
        Ok(())
    }

    async fn submit_decoy(&self) -> said_shielded_pool_relayer::error::Result<()> {
        Ok(())
    }
}

fn test_config() -> Arc<Config> {
    use std::path::PathBuf;
    use std::time::Duration;
    Arc::new(Config {
        port: 0,
        rpc_url: "http://invalid.example".into(),
        keypair_path: PathBuf::from("/dev/null"),
        queue_db_path: PathBuf::from("/dev/null"),
        batch_size: 8,
        min_delay: Duration::from_secs(30),
        max_delay: Duration::from_secs(600),
        anonymity_threshold: 4,
        relay_k_min: 1,
        release_below_kmin: true,
        decoy_rate_per_hour: 0.0,
        jitter_lambda: 0.5,
        max_retries: 3,
        retry_initial_delay_ms: 100,
        retry_max_delay_ms: 1000,
        pool_program_id: "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A".into(),
        max_queue_depth: 10_000,
        relay_rate_limit_per_min: 0,
        dedup_ttl_secs: 86_400,
        trusted_proxies: std::collections::HashSet::new(),
        metrics_token: None,
    })
}

fn test_state() -> AppState {
    let queue = WithdrawalQueue::open_temporary().unwrap();
    let cfg = test_config();
    let metrics = Arc::new(Metrics::new());
    let submitter: Arc<dyn Submitter + Send + Sync> = Arc::new(NullSubmitter);
    let batcher = Batcher::new(queue.clone(), cfg.clone(), submitter, metrics.clone());
    let dedup = Arc::new(Dedup::open_temporary().unwrap());
    AppState::with_dedup(queue, cfg, metrics, &batcher, dedup)
}

fn payload(recipient: &str) -> Value {
    json!({
        "proof_bundle": {
            "proof": {"a": "0xaa", "b": "0xbb", "c": "0xcc"},
            "public_inputs": {
                "root": "0".repeat(64),
                "input_nullifiers": ["0".repeat(64)],
                "output_commitments": ["0".repeat(64)],
                "public_amount": 100,
                "asset_id": "0".repeat(64),
                "ext_data_hash": "0".repeat(64),
            }
        },
        "recipient": recipient,
        "fee": 5000,
        "relayer_fee": 1000
    })
}

fn flat_payload(recipient: &str) -> Value {
    json!({
        "proof_bundle": {
            "a": "11".repeat(64),
            "b": "22".repeat(128),
            "c": "33".repeat(64),
            "root": "44".repeat(32),
            "input_nullifiers": ["55".repeat(32)],
            "output_commitments": ["66".repeat(32)],
            "public_amount": 100,
            "asset_id": "77".repeat(32),
            "ext_data_hash": "88".repeat(32)
        },
        "recipient": recipient,
        "fee": 5000,
        "relayer_fee": 1000
    })
}

async fn post_relay(app: &axum::Router, body: Value) -> (StatusCode, Value) {
    let req = Request::builder()
        .method("POST")
        .uri("/relay")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    (status, v)
}

#[tokio::test]
async fn identical_relay_posts_share_a_single_queue_slot() {
    let state = test_state();
    let queue = state.queue.clone();
    let app = router(state);

    // Fresh address (32 bytes -> base58). Use `1`-only string which
    // decodes to all-zero; valid recipient shape, irrelevant content.
    let body = payload("11111111111111111111111111111111");

    let (status1, resp1) = post_relay(&app, body.clone()).await;
    assert_eq!(status1, StatusCode::OK, "first POST should succeed");
    let id1 = resp1["id"].as_str().expect("first response has id");
    assert!(
        resp1.get("status").and_then(|v| v.as_str()).is_none(),
        "first response must NOT carry status: \"duplicate\""
    );

    let (status2, resp2) = post_relay(&app, body.clone()).await;
    assert_eq!(status2, StatusCode::OK, "duplicate POST returns 200, not 4xx");
    let id2 = resp2["id"].as_str().expect("second response has id");
    assert_eq!(id1, id2, "duplicate must return the FIRST id");
    assert_eq!(
        resp2["status"].as_str(),
        Some("duplicate"),
        "duplicate POST must carry status: \"duplicate\""
    );

    // The queue has exactly one entry.
    let depth = queue.depth().unwrap();
    assert_eq!(depth, 1, "duplicate must not allocate a second queue row");
}

#[tokio::test]
async fn flattened_android_cloud_payload_is_accepted() {
    let state = test_state();
    let app = router(state);

    let (status, resp) = post_relay(
        &app,
        flat_payload("11111111111111111111111111111111"),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(resp.get("id").and_then(|v| v.as_str()).is_some());
}

#[tokio::test]
async fn dedupe_ignores_recipient_change() {
    // Bonus assertion: dedup key is `H(proof.a||proof.b||proof.c)`,
    // NOT the full payload. Re-submitting the same proof with a
    // different recipient still dedupes — defense in depth, since
    // such a tx would fail on-chain anyway via ext_data_hash.
    let state = test_state();
    let queue = state.queue.clone();
    let app = router(state);

    let body1 = payload("11111111111111111111111111111111");
    let body2 = payload("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi");

    let (s1, r1) = post_relay(&app, body1).await;
    let (s2, r2) = post_relay(&app, body2).await;

    assert_eq!(s1, StatusCode::OK);
    assert_eq!(s2, StatusCode::OK);
    assert_eq!(
        r1["id"], r2["id"],
        "same proof bytes, different recipient -> same id (dedup wins client-side)"
    );
    assert_eq!(r2["status"].as_str(), Some("duplicate"));
    assert_eq!(queue.depth().unwrap(), 1);
}

#[tokio::test]
async fn distinct_proofs_get_distinct_ids() {
    // Negative: changing proof.a alone produces a new key and a new
    // queue slot, even if everything else is identical.
    let state = test_state();
    let queue = state.queue.clone();
    let app = router(state);

    let mut body1 = payload("11111111111111111111111111111111");
    let mut body2 = body1.clone();
    body1["proof_bundle"]["proof"]["a"] = json!("0xa1");
    body2["proof_bundle"]["proof"]["a"] = json!("0xa2");

    let (s1, r1) = post_relay(&app, body1).await;
    let (s2, r2) = post_relay(&app, body2).await;

    assert_eq!(s1, StatusCode::OK);
    assert_eq!(s2, StatusCode::OK);
    assert_ne!(r1["id"], r2["id"]);
    assert!(r2.get("status").and_then(|v| v.as_str()).is_none());
    assert_eq!(queue.depth().unwrap(), 2);
}
