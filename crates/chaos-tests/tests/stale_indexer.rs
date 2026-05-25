//! Scenario: indexer loses chain connectivity -> /witness returns 503.
//!
//! We point the indexer at an unreachable RPC, set a tight staleness
//! threshold, simulate one fresh observation, then let wall-clock time
//! advance past the threshold and assert the witness handler refuses
//! to serve.

use std::time::Duration;

use chaos_tests::scenarios::stale_indexer;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn witness_returns_503_when_state_is_stale() {
    let indexer = stale_indexer(/* threshold */ 1)
        .await
        .expect("spawn indexer");

    let client = reqwest::Client::new();
    let witness_url = format!(
        "{}/witness?commitment={}",
        indexer.url,
        "0".repeat(64)
    );

    // Before any observation: u64::MAX age, must be 503.
    let resp = client.get(&witness_url).send().await.expect("witness GET");
    assert_eq!(
        resp.status().as_u16(),
        503,
        "fresh indexer must 503 before listener observes anything"
    );
    let body: serde_json::Value = resp.json().await.expect("json");
    assert_eq!(body["error"], "stale_state");
    assert_eq!(body["threshold"], 1);

    // After a fresh observation: still no commitment in the tree, but at
    // least the staleness gate is satisfied — we expect 404 (not found),
    // not 503.
    indexer.state.touch_root_observed();
    let resp = client.get(&witness_url).send().await.expect("witness GET");
    assert_eq!(
        resp.status().as_u16(),
        404,
        "fresh observation should pass staleness gate; got {}",
        resp.status()
    );

    // Wait past the threshold without further observations.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let resp = client.get(&witness_url).send().await.expect("witness GET");
    assert_eq!(
        resp.status().as_u16(),
        503,
        "expected 503 after staleness threshold elapsed"
    );
    let body: serde_json::Value = resp.json().await.expect("json");
    assert_eq!(body["error"], "stale_state");
    let age_secs = body["age_secs"].as_u64().expect("age_secs is u64");
    assert!(
        age_secs >= 2,
        "age_secs should reflect elapsed time, got {age_secs}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tree_state_also_503s_when_stale() {
    let indexer = stale_indexer(1).await.expect("spawn indexer");
    let url = format!("{}/tree-state", indexer.url);

    let resp = reqwest::Client::new().get(&url).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 503);

    indexer.state.touch_root_observed();
    let resp = reqwest::Client::new().get(&url).send().await.unwrap();
    assert!(resp.status().is_success(), "fresh state should serve");
}
