//! Property-based invariants for the persistent withdrawal queue
//! (Stream 2 of the production-hardening pass).
//!
//! These tests live under `proptests/` (referenced by the crate's
//! `Cargo.toml` `[[test]]` entry) so they're opt-in via
//! `cargo test -p said-shielded-pool-relayer --test queue_props` rather
//! than running on every default `cargo test`. Proptest harnesses are
//! slower than unit tests and we want the default suite to stay quick.
//!
//! # Properties exercised
//!
//! 1. **FIFO ordering**: across an arbitrary interleaving of enqueue /
//!    list_pending / take_oldest operations, the order in which items
//!    are surfaced matches insertion order. The queue exposes this
//!    indirectly via `list_pending()` (sorted by `accepted_at` ASC,
//!    see `WithdrawalQueue::list_all`), so we model "release" as
//!    "take the first N from list_pending and mark them Confirmed".
//!
//! 2. **No item lost**: after an arbitrary sequence of enqueue /
//!    delete operations, the set of items remaining in the queue equals
//!    the model's surviving set.
//!
//! 3. **K-anonymity threshold**: `decide_batch` may NOT return `Release`
//!    when `pending.len() < anonymity_threshold` AND the oldest item's
//!    age is below `max_delay`. (Below threshold and below max_delay
//!    is always Hold.)

use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use proptest::collection::vec;
use proptest::prelude::*;
use said_shielded_pool_relayer::queue::{
    decide_batch, BatchDecision, ProofBlob, QueuedWithdrawal, ReleaseReason, WithdrawalQueue,
    WithdrawalStatus,
};
use uuid::Uuid;

// ---------- helpers ----------

fn dummy_proof() -> ProofBlob {
    ProofBlob(serde_json::json!({
        "proof": {"a": [], "b": [], "c": []},
        "public_inputs": {
            "root": "0".repeat(64),
            "input_nullifiers": ["0".repeat(64)],
            "output_commitments": ["0".repeat(64)],
            "public_amount": 0,
            "asset_id": "0".repeat(64),
            "ext_data_hash": "0".repeat(64),
        }
    }))
}

fn mk_at(accepted_at_secs: i64) -> QueuedWithdrawal {
    QueuedWithdrawal {
        id: Uuid::new_v4(),
        proof_bundle: dummy_proof(),
        recipient: [9u8; 32],
        fee: 5_000,
        relayer_fee: 1_000,
        instruction_data: Vec::new(),
        accounts: Vec::new(),
        accepted_at: Utc.timestamp_opt(1_700_000_000 + accepted_at_secs, 0).unwrap(),
        status: WithdrawalStatus::Pending,
        attempts: 0,
    }
}

fn now_at(offset_secs: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(1_700_000_000 + offset_secs, 0).unwrap()
}

const ANONYMITY: usize = 4;
const BATCH_SIZE: usize = 8;
const MIN_DELAY: Duration = Duration::from_secs(30);
const MAX_DELAY: Duration = Duration::from_secs(600);

// ---------- operation enum for the FIFO + no-loss harnesses ----------

#[derive(Debug, Clone)]
#[allow(dead_code)] // `Enqueue(_)` payload is unused — the harness uses a
                    // monotonic counter instead. Kept for shrink-readable Debug.
enum QueueOp {
    /// Enqueue an item; the i64 is its `accepted_at` offset so order is
    /// reproducible.
    Enqueue(i64),
    /// Mark the oldest N pending items as Confirmed (model: drain N).
    ReleaseOldest(u8),
    /// Hard-delete the i'th currently-pending item, if any.
    Delete(u8),
}

fn arb_queueop() -> impl Strategy<Value = QueueOp> {
    prop_oneof![
        // Time monotonically increases per insert — we use a global
        // counter via prop_compose to avoid mixing strategies.
        any::<u16>().prop_map(|n| QueueOp::Enqueue(n as i64)),
        any::<u8>().prop_map(|n| QueueOp::ReleaseOldest(n % (BATCH_SIZE as u8 + 2))),
        any::<u8>().prop_map(QueueOp::Delete),
    ]
}

// ---------- properties ----------

proptest! {
    #![proptest_config(ProptestConfig {
        // Keep individual runs cheap — sled-on-temp + 200 ops per case
        // is already ~ms-scale; 64 cases is enough to surface ordering
        // bugs without blowing CI budgets.
        cases: 64,
        max_shrink_iters: 1_000,
        .. ProptestConfig::default()
    })]

    /// FIFO ordering: items released in insertion order.
    #[test]
    fn queue_fifo_invariant(ops in vec(arb_queueop(), 1..200)) {
        let queue = WithdrawalQueue::open_temporary()
            .expect("open temp queue");
        let mut model: Vec<Uuid> = Vec::new();
        // Monotonic time counter — every Enqueue inserts at t = `time`,
        // so the queue's `accepted_at` ordering is deterministic and
        // matches the model's push order.
        let mut time: i64 = 0;

        for op in ops {
            match op {
                QueueOp::Enqueue(_) => {
                    let w = mk_at(time);
                    queue.insert(&w).expect("insert");
                    model.push(w.id);
                    time += 1;
                }
                QueueOp::ReleaseOldest(n) => {
                    let pending = queue.list_pending().expect("list_pending");
                    let n = (n as usize).min(pending.len());
                    // FIFO check: list_pending must be sorted by
                    // accepted_at ASC, so the first N matches model[0..n]
                    // for the items still alive in the model.
                    let model_alive: Vec<Uuid> = model.clone();
                    let model_head: Vec<Uuid> =
                        model_alive.iter().take(n).copied().collect();
                    let q_head: Vec<Uuid> =
                        pending.iter().take(n).map(|w| w.id).collect();
                    prop_assert_eq!(model_head, q_head);

                    // Drain those from both sides — release path marks
                    // them Confirmed AND removes (matches relayer's
                    // gc-after-confirm behavior; we go straight to
                    // delete for simplicity).
                    for w in pending.iter().take(n) {
                        queue.delete(w.id).expect("delete on release");
                    }
                    for _ in 0..n {
                        if !model.is_empty() {
                            model.remove(0);
                        }
                    }
                }
                QueueOp::Delete(i) => {
                    let pending = queue.list_pending().expect("list_pending");
                    if pending.is_empty() { continue; }
                    let i = (i as usize) % pending.len();
                    let target_id = pending[i].id;
                    queue.delete(target_id).expect("delete");
                    model.retain(|id| *id != target_id);
                }
            }
        }

        // No-item-lost: every surviving model id is still in the queue.
        let final_pending = queue.list_pending().expect("list_pending");
        let mut q_ids: Vec<Uuid> = final_pending.iter().map(|w| w.id).collect();
        q_ids.sort();
        let mut m_ids = model.clone();
        m_ids.sort();
        prop_assert_eq!(q_ids, m_ids);
    }

    /// K-anonymity / max-delay policy: `decide_batch` never returns a
    /// Release variant in the "below threshold AND below max_delay" region.
    /// This is the load-bearing privacy invariant — releases below the
    /// anonymity set with insufficient aging would shrink the on-chain
    /// k-anon batch.
    #[test]
    fn decide_batch_respects_anonymity_threshold(
        // Items inserted at t = 0, varying count 1..ANONYMITY (strictly
        // below the threshold).
        count in 1usize..ANONYMITY,
        // "now" offset relative to insertion. Restrict to BELOW max_delay
        // so the max-delay safety-release branch can't fire.
        now_offset in 0i64..(MAX_DELAY.as_secs() as i64 - 1),
    ) {
        let items: Vec<QueuedWithdrawal> = (0..count).map(|_| mk_at(0)).collect();
        let result = decide_batch(
            now_at(now_offset),
            &items,
            ANONYMITY,
            BATCH_SIZE,
            MIN_DELAY,
            MAX_DELAY,
        );
        // We are below threshold AND below max_delay — Release must NOT fire.
        prop_assert!(
            matches!(result, BatchDecision::Hold),
            "expected Hold, got {:?} (count={}, now_offset={})",
            result, count, now_offset
        );
    }

    /// `take` count from a Release decision is bounded by both `batch_size`
    /// and the pending population — invariant that prevents the batcher
    /// from over-committing.
    #[test]
    fn decide_batch_take_is_bounded(
        count in 1usize..32,
        anonymity in 1usize..16,
        batch_size in 1usize..16,
    ) {
        let items: Vec<QueuedWithdrawal> = (0..count).map(|_| mk_at(0)).collect();
        // Force a release: jump far past max_delay.
        let result = decide_batch(
            now_at((MAX_DELAY.as_secs() + 100) as i64),
            &items,
            anonymity,
            batch_size,
            MIN_DELAY,
            MAX_DELAY,
        );
        if let BatchDecision::Release { reason, take } = result {
            prop_assert!(take <= batch_size);
            prop_assert!(take <= count);
            // Must be the max-delay variant because we jumped past it.
            prop_assert_eq!(reason, ReleaseReason::MaxDelayExceeded);
        } else {
            // Non-empty population past max_delay must release.
            prop_assert!(false, "expected Release, got {:?}", result);
        }
    }
}
