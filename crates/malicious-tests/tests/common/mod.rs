//! Helpers shared by the integration-test binaries.
//!
//! Each `tests/malicious_*.rs` file is compiled as a separate
//! integration-test binary, and each binary imports this module via
//! `mod common`. Cargo doesn't track which functions a specific
//! binary uses, so some imports look "dead" in the per-binary
//! perspective even though the suite as a whole consumes them. The
//! file-level `allow` silences those false positives.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use said_shielded_pool_relayer::config::{Config, DEFAULT_POOL_PROGRAM_ID};
use said_shielded_pool_relayer::metrics::Metrics;
use said_shielded_pool_relayer::queue::{
    ProofBlob, QueuedWithdrawal, WithdrawalQueue, WithdrawalStatus,
};

/// Build a deterministic test config with very small delays so a
/// single `submit_batch` invocation completes in well under a second.
pub fn test_config() -> Arc<Config> {
    Arc::new(Config {
        port: 0,
        rpc_url: "http://127.0.0.1:1".into(),
        keypair_path: std::path::PathBuf::from("/dev/null"),
        queue_db_path: std::path::PathBuf::from("/dev/null"),
        batch_size: 8,
        // The Poisson jitter sleep inside submit_batch uses these.
        min_delay: Duration::from_millis(1),
        max_delay: Duration::from_millis(2),
        anonymity_threshold: 1,
        decoy_rate_per_hour: 0.0,
        jitter_lambda: 100.0, // very tight so test is fast
        max_retries: 2,
        retry_initial_delay_ms: 5,
        retry_max_delay_ms: 10,
        pool_program_id: DEFAULT_POOL_PROGRAM_ID.into(),
        max_queue_depth: 10_000,
        relay_rate_limit_per_min: 0,
        dedup_ttl_secs: said_shielded_pool_relayer::config::DEFAULT_DEDUP_TTL_SECS,
    })
}

/// Build a `Metrics` instance for tests.
pub fn metrics() -> Arc<Metrics> {
    Arc::new(Metrics::new())
}

/// Insert a dummy `QueuedWithdrawal` row pointing at `recipient`.
/// Returns the row's id so the test can poll status after submission.
pub fn enqueue(queue: &WithdrawalQueue, recipient: [u8; 32]) -> uuid::Uuid {
    let id = uuid::Uuid::new_v4();
    let w = QueuedWithdrawal {
        id,
        proof_bundle: ProofBlob(serde_json::json!({
            "proof": {"a": [], "b": [], "c": []},
            "public_inputs": {
                "root": "00".repeat(32),
                "input_nullifiers": ["00".repeat(32)],
                "output_commitments": ["00".repeat(32)],
                "public_amount": 0,
                "asset_id": "00".repeat(32),
                "ext_data_hash": "00".repeat(32),
            }
        })),
        recipient,
        fee: 5_000,
        relayer_fee: 1_000,
        // We never actually submit on-chain; an empty ix is fine for the
        // mock submitters and we don't go anywhere near `RpcSubmitter::submit_one`'s
        // `instruction_data.is_empty()` guard because we plug in our own
        // mock `Submitter` impls.
        instruction_data: vec![1, 2, 3, 4],
        accounts: vec![],
        accepted_at: Utc::now(),
        status: WithdrawalStatus::Pending,
        attempts: 0,
    };
    queue.insert(&w).expect("queue insert");
    id
}
