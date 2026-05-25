//! Scenario: concurrent /relay storm must not block /healthz.
//!
//! Sled is sync-only; if the relayer accidentally does sled writes on
//! the tokio runtime threads instead of inside `spawn_blocking`, a burst
//! of POSTs can stall unrelated requests. We measure: hammer N parallel
//! /relay POSTs and assert that an interleaved /healthz call still
//! returns in <500ms.

use std::time::{Duration, Instant};

use chaos_tests::harness::{RelayerCfgOverrides, TestRelayer};
use chaos_tests::scenarios::good_relay_body;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn healthz_responsive_under_relay_storm() {
    let relayer = TestRelayer::spawn(RelayerCfgOverrides {
        max_queue_depth: 100_000,
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
    let healthz_url = format!("{}/healthz", relayer.url);
    let body = good_relay_body();

    // Fire 32 concurrent /relay requests.
    let mut handles = Vec::new();
    for _ in 0..32 {
        let c = client.clone();
        let u = url.clone();
        let b = body.clone();
        handles.push(tokio::spawn(async move {
            let _ = c.post(&u).json(&b).send().await;
        }));
    }

    // Mid-storm: hit /healthz a few times and record latencies.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let mut latencies = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        let resp = client
            .get(&healthz_url)
            .send()
            .await
            .expect("healthz GET");
        assert!(resp.status().is_success());
        latencies.push(start.elapsed());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    for h in handles {
        let _ = h.await;
    }

    // Worst-case latency must stay under 500ms. The relayer's writes
    // are small (one row each) and sled is buffered, so even on a slow
    // CI runner this has a wide margin.
    let worst = latencies.iter().copied().max().unwrap_or_default();
    assert!(
        worst < Duration::from_millis(500),
        "/healthz latency degraded under load: worst = {worst:?}, all = {latencies:?}"
    );
}
