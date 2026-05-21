//! Internal unit tests covering routes + batcher with the in-memory
//! store and the in-memory publisher. Postgres integration tests live
//! in `tests/integration.rs` and require a live database, so they're
//! gated and not in the default `cargo test --lib` run.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use crate::batch::Batcher;
use crate::receipt::ReceiptV1;
use crate::routes::{router, router_with_config, AppState, ReceiptsServiceConfig};
use crate::solana::{InMemoryPublisher, SolanaPublisher};
use crate::storage::{MemoryStore, ReceiptsStore};

fn sample_receipt(job: &str) -> ReceiptV1 {
    ReceiptV1 {
        version: 1,
        job_id: job.to_string(),
        mode: "cloud".to_string(),
        provider_id: "test-provider".to_string(),
        model_id: Some("claude-haiku".to_string()),
        input_token_hash: "a".repeat(64),
        output_token_hash: "b".repeat(64),
        issued_at: 1_700_000_000_000,
        enclave_key_id: None,
        attestation_hash: None,
        measurement: None,
        signer_did: "did:key:zTest".to_string(),
        signature: "AAAA".to_string(),
    }
}

#[tokio::test]
async fn post_then_pending_then_anchored_flow() {
    let store: Arc<dyn ReceiptsStore> = Arc::new(MemoryStore::new());
    let publisher = Arc::new(InMemoryPublisher::new());
    let state = AppState {
        store: store.clone(),
        batcher_interval_secs: 60,
    };
    let app = router(state);

    // POST a receipt and capture the returned hash.
    let body = serde_json::to_vec(&sample_receipt("job-1")).unwrap();
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/receipts")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let hash_hex = parsed["receipt_hash"].as_str().unwrap().to_string();
    assert_eq!(hash_hex.len(), 64);

    // GET proof while still pending -> 202.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/receipts/{hash_hex}/proof"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::ACCEPTED);

    // Run a batcher tick -> assigns the batch + publishes via stub.
    let batcher = Batcher::new(store.clone(), publisher.clone() as Arc<dyn SolanaPublisher>);
    let assigned = batcher.tick().await.unwrap();
    assert!(assigned.is_some());
    assert_eq!(publisher.calls().len(), 1);
    assert_eq!(publisher.calls()[0].count, 1);

    // GET proof now -> 200 with proof + signature.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/receipts/{hash_hex}/proof"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["receipt_hash"].as_str().unwrap(), hash_hex);
    assert!(parsed["batch_root"].as_str().unwrap().len() == 64);
    assert!(parsed["solana_signature"]
        .as_str()
        .unwrap()
        .starts_with("mock-sig"));
    assert_eq!(parsed["leaf_index"].as_i64().unwrap(), 0);
    // Single-leaf tree -> proof is empty (the leaf is the root).
    let proof = parsed["merkle_proof"].as_array().unwrap();
    assert!(proof.is_empty());
}

#[tokio::test]
async fn get_receipt_returns_stored_body_and_status() {
    let store: Arc<dyn ReceiptsStore> = Arc::new(MemoryStore::new());
    let publisher = Arc::new(InMemoryPublisher::new());
    let state = AppState {
        store: store.clone(),
        batcher_interval_secs: 60,
    };
    let app = router(state);

    let receipt = sample_receipt("job-body");
    let body_value = serde_json::to_value(&receipt).unwrap();
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/receipts")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body_value).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let hash_hex = parsed["receipt_hash"].as_str().unwrap().to_string();

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/receipts/{hash_hex}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["receipt_hash"].as_str().unwrap(), hash_hex);
    assert_eq!(parsed["status"].as_str().unwrap(), "pending");
    assert_eq!(parsed["receipt"], body_value);

    // Existing proof behavior is unchanged: pending receipts still
    // return 202 from the proof endpoint.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/receipts/{hash_hex}/proof"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::ACCEPTED);

    let batcher = Batcher::new(store.clone(), publisher.clone() as Arc<dyn SolanaPublisher>);
    batcher.tick().await.unwrap();

    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!("/v1/receipts/{hash_hex}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["status"].as_str().unwrap(), "anchored");
    assert_eq!(parsed["receipt"], body_value);
}

#[tokio::test]
async fn multi_leaf_batch_proof_round_trip() {
    // Five receipts -> verify each one's proof.
    let store: Arc<dyn ReceiptsStore> = Arc::new(MemoryStore::new());
    let publisher = Arc::new(InMemoryPublisher::new());
    let state = AppState {
        store: store.clone(),
        batcher_interval_secs: 60,
    };
    let app = router(state);

    let mut hashes = Vec::new();
    for i in 0..5 {
        let body = serde_json::to_vec(&sample_receipt(&format!("job-{i}"))).unwrap();
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/receipts")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        hashes.push(parsed["receipt_hash"].as_str().unwrap().to_string());
    }

    let batcher = Batcher::new(store.clone(), publisher.clone() as Arc<dyn SolanaPublisher>);
    batcher.tick().await.unwrap();
    assert_eq!(publisher.calls()[0].count, 5);

    // Verify each receipt's proof round-trips against the recorded root.
    let root_bytes = publisher.calls()[0].root;
    for (i, hash_hex) in hashes.iter().enumerate() {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/receipts/{hash_hex}/proof"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let leaf_index = parsed["leaf_index"].as_i64().unwrap() as usize;
        let proof_hashes: Vec<[u8; 32]> = parsed["merkle_proof"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| {
                let bytes = hex::decode(h.as_str().unwrap()).unwrap();
                let mut out = [0u8; 32];
                out.copy_from_slice(&bytes);
                out
            })
            .collect();
        let leaf_bytes = hex::decode(hash_hex).unwrap();
        let mut leaf = [0u8; 32];
        leaf.copy_from_slice(&leaf_bytes);
        assert!(
            crate::merkle::verify_proof(root_bytes, leaf, leaf_index, &proof_hashes, hashes.len()),
            "proof for receipt {i} did not verify against published root"
        );
    }
}

#[tokio::test]
async fn solana_failure_retries_next_tick() {
    let store: Arc<dyn ReceiptsStore> = Arc::new(MemoryStore::new());
    let publisher = Arc::new(InMemoryPublisher::new());

    // Insert a receipt directly.
    let r = sample_receipt("job-retry");
    store
        .insert_receipt(r.hash(), &serde_json::to_value(&r).unwrap())
        .await
        .unwrap();

    publisher.fail_next();

    let batcher = Batcher::new(store.clone(), publisher.clone() as Arc<dyn SolanaPublisher>);

    // First tick: batch row created, publish fails, signature stays None.
    batcher.tick().await.unwrap();
    assert_eq!(publisher.calls().len(), 0); // failure recorded as no call
    let unpub = store.list_unpublished_batches().await.unwrap();
    assert_eq!(unpub.len(), 1);

    // Second tick: no new pending receipts, but the unpublished batch
    // is retried and succeeds.
    batcher.tick().await.unwrap();
    assert_eq!(publisher.calls().len(), 1);
    let unpub = store.list_unpublished_batches().await.unwrap();
    assert_eq!(unpub.len(), 0);
}

// -- AFK hardening sprint: body-size + malformed-JSON tests -----------

/// POSTing a body larger than `max_body_size_bytes` is rejected with
/// `413 Payload Too Large` by axum's body-limit layer before the
/// handler runs.
#[tokio::test]
async fn rejects_oversized_receipt_body() {
    let store: Arc<dyn ReceiptsStore> = Arc::new(MemoryStore::new());
    let state = AppState {
        store,
        batcher_interval_secs: 60,
    };
    let cfg = ReceiptsServiceConfig {
        max_body_size_bytes: 256,
        cors_allowed_origins: vec!["https://ghola.xyz".to_string()],
        dev_mode: false,
    };
    let app = router_with_config(state, cfg);

    // 4 KiB of valid-shape JSON, well above 256-byte ceiling.
    let pad = "a".repeat(4096);
    let body = format!(r#"{{"version":1,"job_id":"j","mode":"cloud","pad":"{pad}"}}"#);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/receipts")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        resp.status(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "expected 413 for body over max_body_size_bytes"
    );
}

/// Malformed JSON to `POST /v1/receipts` is rejected with 400 by
/// axum's `Json` extractor before any storage call runs.
#[tokio::test]
async fn rejects_malformed_receipt_json() {
    let store: Arc<dyn ReceiptsStore> = Arc::new(MemoryStore::new());
    let state = AppState {
        store,
        batcher_interval_secs: 60,
    };
    let app = router(state);

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/receipts")
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        resp.status(),
        StatusCode::BAD_REQUEST,
        "expected 400 for malformed JSON"
    );
}

/// Every response carries the Cross-Origin-Resource-Policy header. The
/// public proof path (`/v1/receipts/{hash}/proof`) is overridden to
/// `cross-origin` so the `/r/<hash>` verifier page can fetch it; every
/// other route defaults to `same-origin`.
#[tokio::test]
async fn cross_origin_resource_policy_header_present() {
    let store: Arc<dyn ReceiptsStore> = Arc::new(MemoryStore::new());
    let state = AppState {
        store,
        batcher_interval_secs: 60,
    };
    let app = router(state);

    // Default route: same-origin.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/healthz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let corp = resp
        .headers()
        .get("cross-origin-resource-policy")
        .and_then(|v| v.to_str().ok());
    assert_eq!(corp, Some("same-origin"));

    // Public proof path: cross-origin. The hash doesn't exist so we get
    // 404 — the CORP header is set regardless of status.
    let bogus_hash = "0".repeat(64);
    let resp = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/v1/receipts/{bogus_hash}/proof"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let corp = resp
        .headers()
        .get("cross-origin-resource-policy")
        .and_then(|v| v.to_str().ok());
    assert_eq!(corp, Some("cross-origin"));
}

#[tokio::test]
async fn health_alias_matches_healthz() {
    let store: Arc<dyn ReceiptsStore> = Arc::new(MemoryStore::new());
    let state = AppState {
        store,
        batcher_interval_secs: 60,
    };
    let app = router(state);

    for uri in ["/health", "/healthz"] {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "{uri} should return 200");
        let body = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], "ok", "{uri} should return JSON health");
        assert_eq!(
            json["service"], "said-receipts-service",
            "{uri} should identify service"
        );
    }
}
