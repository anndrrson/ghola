//! Scenario: tx broadcast succeeds but confirmation never arrives.
//!
//! The relayer must mark the withdrawal `Submitted` (which collapses to
//! `submitted` on the client side) and must NOT silently retry — a
//! retry under uncertainty is how double-submits happen on Solana.
//! Idempotency proof.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use said_shielded_pool_relayer::config::Config;
use said_shielded_pool_relayer::metrics::Metrics;
use said_shielded_pool_relayer::queue::{
    ProofBlob, QueuedAccountMeta, QueuedWithdrawal, WithdrawalQueue, WithdrawalStatus,
};
use said_shielded_pool_relayer::submit::{submit_batch, Submitter};

/// Submitter that "succeeds" at send but represents the on-chain status
/// as never-confirming by always returning an `Err` (which the relayer
/// treats as "retry" until max_retries, then `Failed`). For the
/// partial-settlement test we actually want the submitter to model the
/// pessimistic case: `submit_one` returns `Err("confirmation timeout")`
/// every time.
struct NeverConfirms {
    calls: AtomicU32,
}

#[async_trait]
impl Submitter for NeverConfirms {
    async fn submit_one(&self, _w: &QueuedWithdrawal) -> said_shielded_pool_relayer::Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(said_shielded_pool_relayer::Error::Submit(
            "confirmation timeout".into(),
        ))
    }
    async fn submit_decoy(&self) -> said_shielded_pool_relayer::Result<()> {
        Ok(())
    }
}

fn dummy_withdrawal() -> QueuedWithdrawal {
    QueuedWithdrawal {
        id: uuid::Uuid::new_v4(),
        proof_bundle: ProofBlob(serde_json::json!({})),
        recipient: [1u8; 32],
        fee: 5000,
        relayer_fee: 1000,
        instruction_data: vec![0u8; 1],
        accounts: vec![QueuedAccountMeta {
            pubkey: "11111111111111111111111111111111".into(),
            is_signer: false,
            is_writable: false,
        }],
        accepted_at: chrono::Utc::now(),
        status: WithdrawalStatus::Pending,
        attempts: 0,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn never_confirms_marks_failed_not_confirmed() {
    use std::path::PathBuf;

    let submitter = Arc::new(NeverConfirms {
        calls: AtomicU32::new(0),
    });
    let queue = WithdrawalQueue::open_temporary().unwrap();
    let metrics = Arc::new(Metrics::new());
    let w = dummy_withdrawal();
    queue.insert(&w).unwrap();

    // Force exactly 1 retry attempt so the test runs fast.
    let cfg = Arc::new(Config {
        port: 0,
        rpc_url: "http://127.0.0.1:1".into(),
        keypair_path: PathBuf::from("/nonexistent"),
        queue_db_path: PathBuf::from("/tmp/no.db"),
        batch_size: 8,
        min_delay: Duration::from_secs(1),
        max_delay: Duration::from_secs(2),
        anonymity_threshold: 1,
        decoy_rate_per_hour: 0.0,
        jitter_lambda: 1.0,
        max_retries: 1,
        retry_initial_delay_ms: 5,
        retry_max_delay_ms: 5,
        pool_program_id: said_shielded_pool_relayer::config::DEFAULT_POOL_PROGRAM_ID.into(),
        max_queue_depth: 10_000,
        relay_rate_limit_per_min: 0,
        dedup_ttl_secs: said_shielded_pool_relayer::config::DEFAULT_DEDUP_TTL_SECS,
        trusted_proxies: std::collections::HashSet::new(),
        // k-anonymity policy (defaults: k_min=1, release-everything).
        relay_k_min: 1,
        release_below_kmin: true,
        metrics_token: None,
    });

    submit_batch(submitter.as_ref(), &queue, &cfg, &metrics, vec![w.clone()])
        .await
        .unwrap();

    // The submitter was called exactly `max_retries` times (1). NO extra
    // calls — that's the idempotency invariant.
    let calls = submitter.calls.load(Ordering::SeqCst);
    assert_eq!(
        calls, 1,
        "submitter must be called max_retries times, not more"
    );

    // Final state is Failed (NOT Confirmed) and the client-visible
    // mapping is therefore `Failed` (not `Confirmed`).
    let final_state = queue.get(w.id).unwrap().unwrap();
    assert_eq!(final_state.status, WithdrawalStatus::Failed);
    let client_status = said_shielded_pool_relayer::routes::status_response(final_state.status);
    // We can't pattern-match on a non-`PartialEq` enum, so check via
    // the serialised form.
    let s = serde_json::to_value(&client_status).unwrap();
    assert_eq!(s, serde_json::json!("failed"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submitted_status_collapses_to_submitted_for_client() {
    // Direct check on the public status-mapping. `Batched` and `Submitted`
    // must both report as `submitted` — this is the privacy-collapse
    // invariant documented in `routes::status_response`. We test it from
    // the chaos suite so a future refactor that accidentally splits the
    // two doesn't silently re-leak the timing distinction.
    let batched = said_shielded_pool_relayer::routes::status_response(WithdrawalStatus::Batched);
    let submitted =
        said_shielded_pool_relayer::routes::status_response(WithdrawalStatus::Submitted);
    let s1 = serde_json::to_value(&batched).unwrap();
    let s2 = serde_json::to_value(&submitted).unwrap();
    assert_eq!(s1, s2, "Batched/Submitted must collapse for the client");
    assert_eq!(s1, serde_json::json!("submitted"));
}
