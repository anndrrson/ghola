//! Integration tests for the **griefing** profile.
//!
//! Capability assumed: a user (or coalition) sends valid requests at
//! a rate or shape that strains the relayer/program without violating
//! safety. The mitigations are economic + structural:
//!
//! 1. `Config::max_queue_depth` caps pending rows; excess get HTTP 429
//!    with `Retry-After`. Each accepted request still costs the payer
//!    a fee — so spam has a per-message cost.
//! 2. The on-chain deposit instruction (Stream 4) advances
//!    `queue_tail` per call; dust deposits do not corrupt the tree
//!    (each deposit is a real commitment) but they do force the
//!    forester to drain in batches.
//!
//! See `docs/shielded-pool/THREAT_SCENARIOS.md` §G.

mod common;

use chaos_tests::harness::{dummy_relay_request_body, RelayerCfgOverrides, TestRelayer};
use malicious_tests::actors::Profile;
use serde_json::Value;

/// Mutate `dummy_relay_request_body` so each call produces a body
/// with a unique `output_commitments[0]` value. Stream 3's dedup hashes
/// `proof.a || proof.b || proof.c` — but `dummy_relay_request_body`
/// returns the SAME proof bytes every call, so naive replays land in
/// `DedupOutcome::Duplicate` (HTTP 200, `status: "duplicate"`) and never
/// pressure the queue cap. We make each body unique by stuffing a
/// counter into one of the proof field-element strings.
fn unique_body(counter: u32) -> Value {
    let mut body = dummy_relay_request_body();
    // Inject the counter into proof.a so the dedup key changes per
    // call. We touch proof.a (NOT public_inputs) because Stream 3's
    // `derive_key` hashes `proof_a || proof_b || proof_c`.
    let bytes_hex = format!("{:064x}", counter);
    body["proof_bundle"]["proof"]["a"] = serde_json::json!([bytes_hex.clone(), bytes_hex]);
    body
}

/// Submit MAX_QUEUE_DEPTH + 1 valid requests; assert the last one
/// gets HTTP 429 with `Retry-After`.
#[tokio::test]
async fn queue_flood_returns_429() {
    tracing::info!(actor = Profile::Griefing.label(), "test=queue_flood");

    let mut overrides = RelayerCfgOverrides::default();
    overrides.max_queue_depth = 5;
    let relayer = TestRelayer::spawn(overrides)
        .await
        .expect("spawn relayer");
    let client = reqwest::Client::new();

    // We need to push the queue PAST the depth cap. Submit more than
    // max_queue_depth and look for the *first* 429 — relying on the
    // last response alone is fragile because depth() can race with
    // the relayer's internal batcher notify path.
    let mut last_status = reqwest::StatusCode::OK;
    let mut last_retry_after: Option<String> = None;
    let mut saw_429 = false;
    // Submit 4x the cap to make doubly sure we cross the threshold
    // even if a few requests slip in between depth() reads.
    let target = (relayer.max_queue_depth * 4).max(relayer.max_queue_depth + 5);
    for i in 0..target {
        let body = unique_body(i as u32);
        let resp = client
            .post(format!("{}/relay", relayer.url))
            .json(&body)
            .send()
            .await
            .expect("send");
        let status = resp.status();
        let retry_after = resp
            .headers()
            .get("Retry-After")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            saw_429 = true;
            last_status = status;
            last_retry_after = retry_after;
            break;
        }
        last_status = status;
        last_retry_after = retry_after;
    }
    let depth_now = relayer.queue.depth().unwrap_or(0);
    assert!(
        saw_429,
        "expected at least one 429 across {target} requests; last_status={last_status}, depth_now={depth_now}, max_queue_depth={}",
        relayer.max_queue_depth
    );
    assert_eq!(
        last_status,
        reqwest::StatusCode::TOO_MANY_REQUESTS,
        "queue cap should yield HTTP 429"
    );
    assert!(
        last_retry_after.is_some(),
        "429 response must include Retry-After"
    );
}

/// Dust deposits: documented as **costly for the attacker** because
/// each deposit pays a Solana network fee and an SPL transfer fee.
/// We assert here only that the abstract queue accepts many small
/// requests (no per-request rate-limit), so the cost is real and not
/// circumventable by quietly dropping the spammer.
#[tokio::test]
async fn dust_deposits_are_accepted_but_costly() {
    tracing::info!(actor = Profile::Griefing.label(), "test=dust_deposits");

    let mut overrides = RelayerCfgOverrides::default();
    overrides.max_queue_depth = 1_000;
    let relayer = TestRelayer::spawn(overrides)
        .await
        .expect("spawn relayer");
    let client = reqwest::Client::new();

    const ATTEMPTS: usize = 50;
    let mut accepted = 0usize;
    for i in 0..ATTEMPTS {
        // Unique body per call so dedup doesn't collapse them.
        let body = unique_body(0x10_000 + i as u32);
        let resp = client
            .post(format!("{}/relay", relayer.url))
            .json(&body)
            .send()
            .await
            .expect("send");
        if resp.status().is_success() {
            accepted += 1;
        }
    }
    assert_eq!(
        accepted, ATTEMPTS,
        "below max_queue_depth, all valid requests should enqueue"
    );
    assert_eq!(
        relayer.queue.depth().expect("depth"),
        ATTEMPTS,
        "each accepted deposit must be a distinct queue row (dedup must not collapse unique proofs)"
    );
}
