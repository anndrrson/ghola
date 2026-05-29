//! Zero-leakage regression — axum's *built-in* extractor rejections must be
//! mapped to the relayer's opaque `{"error":"bad request"}` body.
//!
//! Two leak vectors are exercised:
//!   1. `POST /relay` with a malformed JSON body — axum's `JsonRejection`
//!      (and the relayer's own manual body-parse) must NOT echo serde detail
//!      (field name, expected type, byte offset) into the 400 body.
//!   2. `GET /status/:id` with a non-UUID path segment — axum's
//!      `PathRejection` must NOT echo the uuid parse error into the 400 body.
//!
//! Drives the axum `Router` in-process via `tower::ServiceExt::oneshot`
//! (no real socket), mirroring `replay_relay_dedupe.rs`.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use said_shielded_pool_relayer::batcher::Batcher;
use said_shielded_pool_relayer::config::Config;
use said_shielded_pool_relayer::dedup::Dedup;
use said_shielded_pool_relayer::metrics::Metrics;
use said_shielded_pool_relayer::queue::WithdrawalQueue;
use said_shielded_pool_relayer::routes::{router, AppState};
use said_shielded_pool_relayer::submit::Submitter;

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

/// Vocabulary that an extractor rejection (serde / uuid) would surface but a
/// properly-opaque body must NOT contain.
fn assert_no_parse_vocabulary(body: &str) {
    let lower = body.to_ascii_lowercase();
    for needle in [
        "uuid",
        "expected",
        "invalid character",
        "missing field",
        "json",
        "deserialize",
        "at line",
        "column",
        "trailing",
        "eof",
        "invalid type",
    ] {
        assert!(
            !lower.contains(needle),
            "opaque body leaked parse vocabulary {needle:?}: {body}"
        );
    }
}

#[tokio::test]
async fn malformed_relay_body_is_opaque() {
    let app = router(test_state());

    let req = Request::builder()
        .method("POST")
        .uri("/relay")
        .header("content-type", "application/json")
        // Garbage that fails JSON parse; serde would normally describe where.
        .body(Body::from("{ this is not valid json :: }"))
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
    let body = String::from_utf8_lossy(&bytes);

    // Opaque marker present; parse detail absent.
    assert!(
        body.contains("bad request"),
        "expected opaque 'bad request', got: {body}"
    );
    assert_no_parse_vocabulary(&body);
}

#[tokio::test]
async fn relay_body_wrong_schema_is_opaque() {
    // Valid JSON but the wrong shape (missing required fields). The serde
    // rejection would name the missing field; the relayer must not.
    let app = router(test_state());

    let req = Request::builder()
        .method("POST")
        .uri("/relay")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"unexpected":"shape"}"#))
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
    let body = String::from_utf8_lossy(&bytes);

    assert!(
        body.contains("bad request"),
        "expected opaque body, got: {body}"
    );
    assert_no_parse_vocabulary(&body);
}

#[tokio::test]
async fn bad_uuid_status_path_is_opaque() {
    let app = router(test_state());

    let req = Request::builder()
        .method("GET")
        .uri("/status/not-a-real-uuid")
        .body(Body::empty())
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
    let body = String::from_utf8_lossy(&bytes);

    assert!(
        body.contains("bad request"),
        "expected opaque 'bad request', got: {body}"
    );
    // Crucially, no "uuid"/parse vocabulary echoed from PathRejection.
    assert_no_parse_vocabulary(&body);
}

#[tokio::test]
async fn unknown_route_is_opaque() {
    // The router fallback must answer unmatched routes with the same opaque
    // body rather than axum's default 404 (which would confirm route shape).
    let app = router(test_state());

    let req = Request::builder()
        .method("GET")
        .uri("/definitely/not/a/route")
        .body(Body::empty())
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
    let body = String::from_utf8_lossy(&bytes);
    assert!(
        body.contains("bad request"),
        "expected opaque body, got: {body}"
    );
    assert_no_parse_vocabulary(&body);
}
