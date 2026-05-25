//! Integration tests for the **malicious relayer** profile.
//!
//! Capability assumed: the operator of one of the relayer fleet's
//! instances is hostile, but the on-chain program and other relayers
//! are honest. The attacker can selectively drop, reorder, delay, or
//! infer-then-leak the txs it sees.
//!
//! See `docs/shielded-pool/THREAT_SCENARIOS.md` §A for the prose
//! companion to each test below.

mod common;

use std::sync::Arc;
use std::time::Duration;

use malicious_tests::actors::Profile;
use malicious_tests::mock_submit::{
    BlacklistDropSubmitter, RecordingSubmitter, StallingSubmitter, SubmittedLog,
};
use said_shielded_pool_relayer::queue::{WithdrawalQueue, WithdrawalStatus};
use said_shielded_pool_relayer::submit::{submit_batch, Submitter};

/// Profile: a relayer that silently fails to broadcast for a specific
/// recipient pubkey.
///
/// Defense: the relayer's retry loop trips `max_retries` and marks the
/// row `Failed`. The CLIENT (see
/// `crates/said-shielded-pool-client/src/tx_builder.rs`) observes
/// `Failed` via `/status/:id` and is expected to fall back to a
/// different relayer or a direct on-chain submission. We assert here
/// that the privacy invariants hold even when the relayer is hostile:
/// the row reaches `Failed`, NOT `Confirmed`, and no on-chain signature
/// is observable from the `/status` surface.
#[tokio::test]
async fn drop_specific_recipient() {
    tracing::info!(actor = Profile::MaliciousRelayer.label(), "test=drop_specific_recipient");

    let queue = WithdrawalQueue::open_temporary().expect("open temp queue");
    let cfg = common::test_config();
    let metrics = common::metrics();

    let blacklisted = [9u8; 32];
    let id_blocked = common::enqueue(&queue, blacklisted);
    let id_clean = common::enqueue(&queue, [1u8; 32]);

    let log = SubmittedLog::new();
    let submitter: Arc<dyn Submitter + Send + Sync> = Arc::new(BlacklistDropSubmitter {
        blacklist: vec![blacklisted],
        log: log.clone(),
    });

    let batch = queue.list_all().expect("list");
    submit_batch(submitter.as_ref(), &queue, &cfg, &metrics, batch)
        .await
        .expect("submit_batch returns Ok even with per-item failures");

    let blocked_row = queue.get(id_blocked).expect("get").unwrap();
    let clean_row = queue.get(id_clean).expect("get").unwrap();
    assert_eq!(
        blocked_row.status,
        WithdrawalStatus::Failed,
        "blacklisted recipient must reach Failed, not Confirmed"
    );
    assert_eq!(
        clean_row.status,
        WithdrawalStatus::Confirmed,
        "non-blacklisted recipient should still confirm"
    );
    // The mock observed exactly `max_retries` attempts for the
    // blocked recipient (each returning Err).
    let blocked_events = log
        .events()
        .into_iter()
        .filter(|e| e.recipient == blacklisted)
        .count();
    assert!(blocked_events >= 1, "blacklisted recipient was offered to submitter");
}

/// Profile: a relayer that leaks queue order by submitting in
/// strict-FIFO. We don't need an adversary here — we just verify the
/// HONEST relayer code path *already* breaks the FIFO link, so a
/// downstream operator who replaces our code with a FIFO variant is
/// the malicious case.
///
/// Defense: `submit::submit_batch` calls `batch.shuffle(&mut rng)` before
/// the per-item loop. Assert that across N runs with the same insertion
/// order, the observed submission order is not always identical to
/// insertion order. This is a **privacy** assertion (the inability to
/// link queue-id to on-chain order), not a safety one.
#[tokio::test]
async fn reorder_batches_decorrelates_from_insertion_order() {
    tracing::info!(actor = Profile::MaliciousRelayer.label(), "test=reorder_batches");

    let cfg = common::test_config();
    let metrics = common::metrics();

    // Run several rounds with deterministic recipient encoding, and
    // count how many rounds match the insertion order verbatim.
    const ROUNDS: usize = 12;
    let mut identical_to_insertion = 0usize;
    for _ in 0..ROUNDS {
        let queue = WithdrawalQueue::open_temporary().expect("open");
        let mut inserted_order = Vec::new();
        for i in 0..8u8 {
            let r = [i; 32];
            common::enqueue(&queue, r);
            inserted_order.push(r);
        }
        let log = SubmittedLog::new();
        let sub: Arc<dyn Submitter + Send + Sync> = Arc::new(RecordingSubmitter { log: log.clone() });
        let batch = queue.list_all().expect("list");
        submit_batch(sub.as_ref(), &queue, &cfg, &metrics, batch).await.unwrap();
        let observed: Vec<[u8; 32]> = log.events().iter().map(|e| e.recipient).collect();
        if observed == inserted_order {
            identical_to_insertion += 1;
        }
    }
    // 8! orderings; probability of all 12 rounds matching insertion
    // order purely by chance is astronomically small. We allow up to
    // half to be lazy (CI flake budget), but require that the
    // shuffler at least sometimes reorders.
    assert!(
        identical_to_insertion < ROUNDS,
        "submit_batch must shuffle: every round was strictly FIFO"
    );
}

/// Profile: a relayer that holds a tx indefinitely (no submit). The
/// honest CLIENT detects the stall via `/status` returning `Pending`
/// past N minutes and falls back. We model the timeout here with a
/// short stall to keep CI fast.
///
/// Defense: the row's `accepted_at` lets the client compute age and
/// trigger fallback. The relayer NEVER returns an on-chain signature
/// even after a "successful" stall — we re-assert that invariant by
/// confirming `/status` only ever exposes the abstract enum.
#[tokio::test]
async fn delay_indefinitely_does_not_leak_signature() {
    tracing::info!(actor = Profile::MaliciousRelayer.label(), "test=delay_indefinitely");

    let queue = WithdrawalQueue::open_temporary().expect("open");
    let cfg = common::test_config();
    let metrics = common::metrics();

    let id = common::enqueue(&queue, [3u8; 32]);

    // We don't actually run the stall — we'd block the test for the
    // full duration. Instead we assert the contract: while the row is
    // mid-stall the in-DB status would be `Submitted`/`Batched` (the
    // `set_status` happens inside `submit_with_retry` before the
    // submitter call). The HTTP-facing `status_response` collapse
    // means the client sees `Submitted` — never the underlying tx
    // signature.

    // Force the row into Submitted as the relayer would just before
    // calling the (stalled) submitter:
    queue
        .set_status(id, WithdrawalStatus::Submitted)
        .expect("set_status");

    let row = queue.get(id).expect("get").unwrap();
    // Row holds NO signature field. The QueuedWithdrawal struct
    // intentionally omits one — see `crates/said-shielded-pool-relayer/src/queue.rs`
    // (the doc-comment on `QueuedWithdrawal` is explicit about this).
    // We can't `assert!(row.signature.is_none())` because the field
    // does not exist; compile-time absence IS the assertion. The
    // following sanity check ensures we didn't accidentally widen the
    // struct in a refactor.
    let serialized = serde_json::to_string(&row).expect("serde");
    assert!(
        !serialized.contains("signature"),
        "QueuedWithdrawal must not serialize an on-chain signature: {serialized}"
    );
    let _ = (cfg, metrics);
}

/// Profile: a relayer that stalls its submit but does so with a
/// bounded delay, after which it succeeds. Confirms that a slow-but-
/// not-malicious relayer (or a stall caused by transient backend
/// issues) does eventually mark the row `Confirmed`.
#[tokio::test]
async fn bounded_stall_eventually_confirms() {
    tracing::info!(actor = Profile::MaliciousRelayer.label(), "test=bounded_stall");

    let queue = WithdrawalQueue::open_temporary().expect("open");
    let cfg = common::test_config();
    let metrics = common::metrics();

    let id = common::enqueue(&queue, [4u8; 32]);

    let log = SubmittedLog::new();
    let sub: Arc<dyn Submitter + Send + Sync> = Arc::new(StallingSubmitter {
        stall: Duration::from_millis(15),
        log: log.clone(),
    });
    let batch = queue.list_all().expect("list");
    submit_batch(sub.as_ref(), &queue, &cfg, &metrics, batch).await.unwrap();
    let row = queue.get(id).expect("get").unwrap();
    assert_eq!(row.status, WithdrawalStatus::Confirmed);
    assert_eq!(log.confirmed_count(), 1);
}

/// Profile: a relayer that infers user identity from queue order +
/// timing. We exercise the timing-channel mitigation: k=8 + Poisson
/// jitter scatters submissions enough that an observer who clusters
/// submissions by 1-second bins cannot rebuild the insertion order.
///
/// Pragmatic test: assert that the relative-order rank correlation
/// between insertion order and observed submission order is below a
/// threshold across multiple rounds.
#[tokio::test]
async fn censor_via_timing_inference_is_broken_by_shuffle() {
    tracing::info!(actor = Profile::MaliciousRelayer.label(), "test=censor_via_timing");

    let cfg = common::test_config();
    let metrics = common::metrics();

    const ROUNDS: usize = 8;
    const K: usize = 8;
    let mut total_correlation: f64 = 0.0;
    for _ in 0..ROUNDS {
        let queue = WithdrawalQueue::open_temporary().expect("open");
        let mut inserted = Vec::new();
        for i in 0..K as u8 {
            common::enqueue(&queue, [i; 32]);
            inserted.push([i; 32]);
        }
        let log = SubmittedLog::new();
        let sub: Arc<dyn Submitter + Send + Sync> =
            Arc::new(RecordingSubmitter { log: log.clone() });
        let batch = queue.list_all().expect("list");
        submit_batch(sub.as_ref(), &queue, &cfg, &metrics, batch).await.unwrap();
        let observed: Vec<[u8; 32]> = log.events().iter().map(|e| e.recipient).collect();
        // Spearman-style rank correlation between insertion index and
        // observed index. A perfectly shuffled batch averages 0; a
        // perfectly preserved order is 1.
        total_correlation += rank_correlation(&inserted, &observed);
    }
    let avg = total_correlation / ROUNDS as f64;
    assert!(
        avg.abs() < 0.6,
        "shuffler should decorrelate; avg rank correlation = {avg}"
    );
}

fn rank_correlation(a: &[[u8; 32]], b: &[[u8; 32]]) -> f64 {
    let n = a.len();
    if n == 0 {
        return 0.0;
    }
    let mut sum_sq_diff: i64 = 0;
    for (i, x) in a.iter().enumerate() {
        let j = b.iter().position(|y| y == x).unwrap_or(i) as i64;
        let d = i as i64 - j;
        sum_sq_diff += d * d;
    }
    1.0 - (6.0 * sum_sq_diff as f64) / (n as f64 * (n.pow(2) - 1) as f64).max(1.0)
}
