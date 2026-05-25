//! Batching policy unit tests.
//!
//! We test the pure `decide_batch` function so we don't need a tokio
//! runtime, and so we can manipulate "now" deterministically.

use std::time::Duration;

use chrono::{TimeZone, Utc};
use said_shielded_pool_relayer::queue::{
    decide_batch, BatchDecision, ProofBlob, QueuedWithdrawal, ReleaseReason, WithdrawalQueue,
    WithdrawalStatus,
};
use uuid::Uuid;

fn dummy_proof() -> ProofBlob {
    ProofBlob(serde_json::json!({
        "proof": {"a": [], "b": [], "c": []},
        "public_inputs": {
            "root": "0".repeat(64),
            "input_nullifiers": ["0".repeat(64)],
            "output_commitments": ["0".repeat(64)],
            "public_amount": 100,
            "asset_id": "0".repeat(64),
            "ext_data_hash": "0".repeat(64),
        }
    }))
}

fn mk(offset_secs: i64) -> QueuedWithdrawal {
    QueuedWithdrawal {
        id: Uuid::new_v4(),
        proof_bundle: dummy_proof(),
        recipient: [9u8; 32],
        fee: 5000,
        relayer_fee: 1000,
        instruction_data: Vec::new(),
        accounts: Vec::new(),
        accepted_at: Utc.timestamp_opt(1_700_000_000 + offset_secs, 0).unwrap(),
        status: WithdrawalStatus::Pending,
        attempts: 0,
    }
}

const MIN_DELAY: Duration = Duration::from_secs(30);
const MAX_DELAY: Duration = Duration::from_secs(600);
const ANONYMITY: usize = 4;
const BATCH_SIZE: usize = 8;

fn now_at(offset_secs: i64) -> chrono::DateTime<Utc> {
    Utc.timestamp_opt(1_700_000_000 + offset_secs, 0).unwrap()
}

#[test]
fn hold_when_empty() {
    let r = decide_batch(now_at(0), &[], ANONYMITY, BATCH_SIZE, MIN_DELAY, MAX_DELAY);
    assert_eq!(r, BatchDecision::Hold);
}

#[test]
fn hold_when_below_threshold_and_fresh() {
    let items: Vec<_> = (0..3).map(|_| mk(0)).collect();
    let r = decide_batch(now_at(5), &items, ANONYMITY, BATCH_SIZE, MIN_DELAY, MAX_DELAY);
    assert_eq!(r, BatchDecision::Hold);
}

#[test]
fn hold_when_above_threshold_but_too_fresh() {
    // 5 items at t=0, now t=10 — meets anonymity but not min_delay (30s).
    let items: Vec<_> = (0..5).map(|_| mk(0)).collect();
    let r = decide_batch(now_at(10), &items, ANONYMITY, BATCH_SIZE, MIN_DELAY, MAX_DELAY);
    assert_eq!(r, BatchDecision::Hold);
}

#[test]
fn release_on_anonymity_threshold_after_min_delay() {
    // 4 items at t=0, now t=60 — meets both anonymity and min_delay.
    let items: Vec<_> = (0..4).map(|_| mk(0)).collect();
    let r = decide_batch(now_at(60), &items, ANONYMITY, BATCH_SIZE, MIN_DELAY, MAX_DELAY);
    assert_eq!(
        r,
        BatchDecision::Release {
            reason: ReleaseReason::AnonymityThresholdMet,
            take: 4,
        }
    );
}

#[test]
fn release_on_max_delay_even_below_threshold() {
    // 1 item at t=0, now t=601 — below threshold but exceeded max_delay (600s).
    let items = vec![mk(0)];
    let r = decide_batch(now_at(601), &items, ANONYMITY, BATCH_SIZE, MIN_DELAY, MAX_DELAY);
    assert_eq!(
        r,
        BatchDecision::Release {
            reason: ReleaseReason::MaxDelayExceeded,
            take: 1,
        }
    );
}

#[test]
fn release_caps_at_batch_size() {
    // 20 items, batch_size 8 — release exactly 8.
    let items: Vec<_> = (0..20).map(|_| mk(0)).collect();
    let r = decide_batch(now_at(60), &items, ANONYMITY, BATCH_SIZE, MIN_DELAY, MAX_DELAY);
    match r {
        BatchDecision::Release { take, .. } => assert_eq!(take, BATCH_SIZE),
        _ => panic!("expected release"),
    }
}

#[test]
fn non_pending_items_are_excluded() {
    let mut items: Vec<_> = (0..6).map(|_| mk(0)).collect();
    items[0].status = WithdrawalStatus::Confirmed;
    items[1].status = WithdrawalStatus::Submitted;
    items[2].status = WithdrawalStatus::Batched;
    // Only 3 pending remain — below threshold of 4.
    let r = decide_batch(now_at(60), &items, ANONYMITY, BATCH_SIZE, MIN_DELAY, MAX_DELAY);
    assert_eq!(r, BatchDecision::Hold);
}

#[test]
fn queue_roundtrip_persistence() {
    let q = WithdrawalQueue::open_temporary().unwrap();
    let w = mk(0);
    q.insert(&w).unwrap();
    let got = q.get(w.id).unwrap().expect("inserted item should be readable");
    assert_eq!(got.id, w.id);
    assert_eq!(got.status, WithdrawalStatus::Pending);

    q.set_status(w.id, WithdrawalStatus::Submitted).unwrap();
    let got = q.get(w.id).unwrap().unwrap();
    assert_eq!(got.status, WithdrawalStatus::Submitted);

    q.delete(w.id).unwrap();
    assert!(q.get(w.id).unwrap().is_none());
}

#[test]
fn queue_lists_only_pending() {
    let q = WithdrawalQueue::open_temporary().unwrap();
    let w1 = mk(0);
    let w2 = mk(1);
    q.insert(&w1).unwrap();
    q.insert(&w2).unwrap();
    q.set_status(w2.id, WithdrawalStatus::Confirmed).unwrap();

    let pending = q.list_pending().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, w1.id);
}
