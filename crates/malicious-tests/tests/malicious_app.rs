//! Integration tests for the **malicious app** profile.
//!
//! Capability assumed: an attacker who controls a client (browser
//! extension, mobile app, MCP tool) builds malformed or pathological
//! requests to `POST /relay`. They cannot forge proofs (Groth16 is
//! sound) but they can spam the relayer with garbage and they can
//! submit valid-shape-but-stale-root proofs.
//!
//! See `docs/shielded-pool/THREAT_SCENARIOS.md` §E.

mod common;

use chaos_tests::harness::{dummy_relay_request_body, RelayerCfgOverrides, TestRelayer};
use malicious_tests::actors::Profile;
use serde_json::json;

/// Flood the relayer with garbage proofs (shape-broken JSON). Each
/// must be rejected at the `/relay` boundary with HTTP 400 BEFORE
/// the row hits the queue.
///
/// Defense: `routes::validate_proof_shape` (see
/// `crates/said-shielded-pool-relayer/src/routes.rs:236`).
#[tokio::test]
async fn garbage_proof_flood_is_rejected_before_queue() {
    tracing::info!(actor = Profile::MaliciousApp.label(), "test=garbage_proof_flood");

    let relayer = TestRelayer::spawn(RelayerCfgOverrides::default())
        .await
        .expect("spawn relayer");
    let client = reqwest::Client::new();
    let mut accepted = 0usize;
    let mut rejected = 0usize;
    for _ in 0..40 {
        let body = json!({
            "proof_bundle": "not_an_object",
            "recipient": "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
            "fee": 5000,
            "relayer_fee": 1000,
        });
        let resp = client
            .post(format!("{}/relay", relayer.url))
            .json(&body)
            .send()
            .await
            .expect("send");
        if resp.status().is_success() {
            accepted += 1;
        } else {
            rejected += 1;
        }
    }
    assert_eq!(accepted, 0, "garbage proofs must NEVER enqueue");
    assert_eq!(rejected, 40);
    // The queue MUST be empty: shape validation happens before insert.
    let depth = relayer.queue.depth().expect("depth");
    assert_eq!(depth, 0, "garbage flood polluted the queue");
}

/// Valid shape, "stale root" — the public inputs claim a root we know
/// has rotated out. The shape check passes (the relayer never
/// validates the root) so the row reaches the queue. The defense
/// trips on-chain: `RootNotInHistory`. We assert the queue accepted
/// the row (i.e. the shape check is intentionally permissive) so we
/// know the on-chain defense is the gate.
#[tokio::test]
async fn stale_root_proof_passes_shape_check_then_gated_onchain() {
    tracing::info!(
        actor = Profile::MaliciousApp.label(),
        "test=valid_proof_but_invalid_root"
    );

    let relayer = TestRelayer::spawn(RelayerCfgOverrides::default())
        .await
        .expect("spawn relayer");
    let client = reqwest::Client::new();
    let body = dummy_relay_request_body();
    let resp = client
        .post(format!("{}/relay", relayer.url))
        .json(&body)
        .send()
        .await
        .expect("send");
    assert!(
        resp.status().is_success(),
        "shape-valid payload should pass HTTP boundary; on-chain is the gate"
    );
    // On-chain rejection would surface here as the row reaching
    // `Failed` after submission. In this offline test we assert only
    // the shape-check pass; the chained on-chain test lives in
    // `malicious_forester::stale_root_replay_rejected_onchain` (also
    // `#[ignore]` until devnet redeploy).
    assert_eq!(relayer.queue.depth().expect("depth"), 1);
}
