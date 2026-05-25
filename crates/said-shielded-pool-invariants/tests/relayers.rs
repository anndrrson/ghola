//! Family 6 — relayer dedup + k-anonymity release predicate.

use said_shielded_pool_invariants::{
    inv_k_anonymity_release, inv_relay_dedupe, Batch, InvariantViolation, RelayQueueEntry,
};

fn entry(h: [u8; 32], at: u64) -> RelayQueueEntry {
    RelayQueueEntry {
        proof_hash: h,
        queued_at: at,
    }
}

#[test]
fn empty_queue_dedupe_ok() {
    inv_relay_dedupe(&[], [0xAA; 32]).expect("empty queue");
}

#[test]
fn duplicate_in_queue_caught() {
    let q = vec![entry([0x42; 32], 100), entry([0x99; 32], 110)];
    let err = inv_relay_dedupe(&q, [0x42; 32]).expect_err("dup");
    assert!(matches!(err, InvariantViolation::Relayers(_)));
}

#[test]
fn unique_proof_passes() {
    let q = vec![entry([0x42; 32], 100), entry([0x99; 32], 110)];
    inv_relay_dedupe(&q, [0xAA; 32]).expect("unique");
}

#[test]
fn k_release_size_threshold() {
    // size >= k=8, oldest age >= min=30 — release allowed even without timeout.
    let b = Batch {
        size: 8,
        oldest_age_secs: 30,
    };
    inv_k_anonymity_release(&b, 8, 30, 300).expect("size meets k");
}

#[test]
fn k_release_timeout_path() {
    // size < k, but oldest_age >= max → liveness escape hatch.
    let b = Batch {
        size: 3,
        oldest_age_secs: 350,
    };
    inv_k_anonymity_release(&b, 8, 30, 300).expect("timeout path");
}

#[test]
fn k_release_too_small_too_young_rejected() {
    let b = Batch {
        size: 4,
        oldest_age_secs: 60,
    };
    let err = inv_k_anonymity_release(&b, 8, 30, 300).expect_err("not yet");
    assert!(matches!(err, InvariantViolation::Relayers(_)));
}

#[test]
fn k_release_below_min_delay_rejected() {
    // Even at full size, items must wait min_delay before release.
    let b = Batch {
        size: 8,
        oldest_age_secs: 5,
    };
    let err = inv_k_anonymity_release(&b, 8, 30, 300).expect_err("too fresh");
    assert!(matches!(err, InvariantViolation::Relayers(_)));
}

#[test]
fn k_release_empty_batch_rejected() {
    let b = Batch {
        size: 0,
        oldest_age_secs: 500,
    };
    let err = inv_k_anonymity_release(&b, 8, 30, 300).expect_err("empty");
    assert!(matches!(err, InvariantViolation::Relayers(_)));
}

#[test]
fn k_release_misconfigured_delays_caught() {
    let b = Batch {
        size: 8,
        oldest_age_secs: 100,
    };
    let err = inv_k_anonymity_release(&b, 8, 300, 30).expect_err("min > max");
    assert!(matches!(err, InvariantViolation::Relayers(_)));
}
