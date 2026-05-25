//! Scenario: prover hangs forever -> client times out cleanly.
//!
//! Stream 5 owns the production prover-timeout wiring inside the
//! prover binary's snarkjs path. From the chaos-test side, what we
//! verify here is the *client* contract: a reqwest HTTP call against
//! a hanging prover, wrapped in `tokio::time::timeout`, fails fast
//! and surfaces a typed timeout error. Indexer/forester code uses
//! the same pattern when it calls `/prove-batch-update`.

use std::time::Duration;

use chaos_tests::harness::{MockProver, ProverBehavior};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hanging_prover_trips_client_timeout() {
    let prover = MockProver::spawn(ProverBehavior::HangForever).await;
    let url = format!("{}/prove-batch-update", prover.url());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();

    let started = std::time::Instant::now();
    let res = tokio::time::timeout(
        Duration::from_millis(500),
        client.post(&url).json(&serde_json::json!({})).send(),
    )
    .await;
    let elapsed = started.elapsed();

    assert!(
        res.is_err(),
        "tokio::time::timeout must fire (got Ok response from a hanging prover)"
    );
    // We allow up to 1s of slack to account for runtime scheduling jitter.
    assert!(
        elapsed < Duration::from_secs(1),
        "timeout should fire near deadline; took {elapsed:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prover_recovers_after_transient_failures() {
    let prover = MockProver::spawn(ProverBehavior::Return5xxNTimes(2)).await;
    let url = format!("{}/prove-batch-update", prover.url());
    let client = reqwest::Client::new();

    // First two attempts must see 5xx.
    for i in 0..2 {
        let resp = client
            .post(&url)
            .json(&serde_json::json!({}))
            .send()
            .await
            .expect("send");
        assert!(
            resp.status().is_server_error(),
            "attempt {i} expected 5xx, got {}",
            resp.status()
        );
    }
    // Third attempt must succeed.
    let resp = client
        .post(&url)
        .json(&serde_json::json!({}))
        .send()
        .await
        .expect("send");
    assert!(resp.status().is_success(), "third attempt should succeed");
}
