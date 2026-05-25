//! Scenario: queue saturation -> 429 + Retry-After.
//!
//! Fills the relayer's queue past `MAX_QUEUE_DEPTH`, asserts the next
//! POST /relay returns 429 with `Retry-After`, then drains a few items
//! and asserts the relayer accepts again.

use chaos_tests::harness::{RelayerCfgOverrides, TestRelayer};
use chaos_tests::scenarios::{settle, unique_relay_body};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queue_full_yields_429_retry_after() {
    let max_depth = 5usize;
    // Tight knobs so the batcher (if it were running) wouldn't drain
    // mid-test. The harness uses a NoopSubmitter regardless.
    let relayer = TestRelayer::spawn(RelayerCfgOverrides {
        max_queue_depth: max_depth,
        anonymity_threshold: 1_000_000,
        batch_size: 1_000_000,
        min_delay_secs: 60,
        max_delay_secs: 3600,
        ..Default::default()
    })
    .await
    .expect("spawn relayer");

    let client = reqwest::Client::new();
    let url = format!("{}/relay", relayer.url);

    // Use UNIQUE proof bytes per submission — the relayer's dedup layer
    // (`relayer::dedup`) short-circuits identical payloads with 200 OK,
    // so reusing one body would never grow the queue. We want queue-full.
    for i in 0..max_depth {
        let body = unique_relay_body(i as u64);
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .expect("relay POST");
        assert!(
            resp.status().is_success(),
            "fill request {i} should succeed, got {}",
            resp.status()
        );
    }
    settle().await;

    // Next request should bounce.
    let overflow_body = unique_relay_body(max_depth as u64);
    let resp = client
        .post(&url)
        .json(&overflow_body)
        .send()
        .await
        .expect("overflow POST");
    assert_eq!(resp.status().as_u16(), 429, "expected 429 after saturation");
    let retry_after = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .expect("Retry-After header present and numeric");
    assert!(retry_after > 0, "Retry-After must be > 0");

    let body_json: serde_json::Value = resp.json().await.expect("json body");
    assert_eq!(body_json["error"], "queue_full");

    // Drain by marking one item Confirmed (depth() filters by Pending).
    let pending = relayer.queue.list_pending().expect("list_pending");
    assert_eq!(pending.len(), max_depth);
    relayer
        .queue
        .set_status(
            pending[0].id,
            said_shielded_pool_relayer::WithdrawalStatus::Confirmed,
        )
        .expect("set_status");

    settle().await;

    // Now /relay should accept a fresh withdrawal.
    let post_drain_body = unique_relay_body(max_depth as u64 + 1);
    let resp = client
        .post(&url)
        .json(&post_drain_body)
        .send()
        .await
        .expect("post-drain POST");
    assert!(
        resp.status().is_success(),
        "post-drain expected 2xx, got {}",
        resp.status()
    );
}
