//! Declarative compositions of harness primitives.
//!
//! Each scenario is a thin sequence of harness calls that the integration
//! tests under `tests/` can invoke without repeating boilerplate. We keep
//! them in a separate module so contributors adding new chaos tests can
//! see at a glance what existing primitives compose into a runnable
//! failure-injection setup.

use std::time::Duration;

use crate::harness::{
    dummy_relay_request_body, dummy_relay_request_body_with_seed, IndexerCfgOverrides, MockProver, MockRpc, ProverBehavior,
    RelayerCfgOverrides, RpcBehavior, TestIndexer, TestRelayer,
};

/// Scenario: prover hangs forever, every other dependency healthy.
pub async fn prover_outage() -> anyhow::Result<(MockProver, MockRpc, TestIndexer)> {
    let prover = MockProver::spawn(ProverBehavior::HangForever).await;
    let rpc = MockRpc::spawn(RpcBehavior::Healthy).await;
    let indexer = TestIndexer::spawn(IndexerCfgOverrides {
        staleness_threshold_secs: 60,
        rpc_url: rpc.url(),
    })
    .await?;
    Ok((prover, rpc, indexer))
}

/// Scenario: RPC flaps 503 the first 3 calls then recovers. Used to
/// exercise exponential-backoff retry semantics.
pub async fn rpc_flap() -> anyhow::Result<(MockRpc, TestRelayer)> {
    let rpc = MockRpc::spawn(RpcBehavior::Flap5xxNTimes(3)).await;
    let relayer = TestRelayer::spawn(RelayerCfgOverrides {
        max_retries: 5,
        retry_initial_delay_ms: 100,
        retry_max_delay_ms: 1000,
        rpc_url: rpc.url(),
        ..Default::default()
    })
    .await?;
    Ok((rpc, relayer))
}

/// Scenario: relayer with a tiny `MAX_QUEUE_DEPTH` so we can saturate it.
pub async fn queue_backlog(max_queue_depth: usize) -> anyhow::Result<TestRelayer> {
    TestRelayer::spawn(RelayerCfgOverrides {
        max_queue_depth,
        // Generous timing knobs so the test never accidentally trips the
        // anonymity-batch release path.
        min_delay_secs: 60,
        max_delay_secs: 3600,
        anonymity_threshold: 1_000_000,
        batch_size: 1_000_000,
        ..Default::default()
    })
    .await
}

/// Scenario: indexer with stale on-chain state. The harness exposes
/// `state.touch_root_observed()` so the caller can simulate a fresh
/// observation and then let time advance past the threshold.
pub async fn stale_indexer(threshold_secs: u64) -> anyhow::Result<TestIndexer> {
    TestIndexer::spawn(IndexerCfgOverrides {
        staleness_threshold_secs: threshold_secs,
        ..Default::default()
    })
    .await
}

/// Scenario: relayer pointed at an RPC that always reports tx status as
/// `Unknown`. Combined with `Healthy` ingestion this lets us check the
/// "submitted but never confirmed" path: the relayer must mark the row
/// `submitted` and NOT silently retry.
pub async fn partial_settlement() -> anyhow::Result<(MockRpc, TestRelayer)> {
    let rpc = MockRpc::spawn(RpcBehavior::SignatureUnknownForever).await;
    let relayer = TestRelayer::spawn(RelayerCfgOverrides {
        max_retries: 1,
        retry_initial_delay_ms: 10,
        retry_max_delay_ms: 20,
        rpc_url: rpc.url(),
        ..Default::default()
    })
    .await?;
    Ok((rpc, relayer))
}

/// Helper: a body the relayer's `/relay` endpoint accepts.
pub fn good_relay_body() -> serde_json::Value {
    dummy_relay_request_body()
}

/// Helper: a body with UNIQUE proof bytes per `seed`. Required when
/// submitting many bodies to the same relayer — the dedup layer
/// short-circuits identical payloads, so use this when testing queue
/// depth / concurrency / batching behaviour.
pub fn unique_relay_body(seed: u64) -> serde_json::Value {
    dummy_relay_request_body_with_seed(seed)
}

/// Helper: yield to the runtime a few times so spawned tasks make
/// progress. Used between flooding the queue and asserting depth.
pub async fn settle() {
    for _ in 0..5 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
