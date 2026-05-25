//! Family 7 — queue_tail vs next_index + forester batch bounds.

use said_shielded_pool_invariants::{
    inv_forester_proof_bounds, inv_pending_forester_well_formed, inv_queue_tail_geq_next_index,
    InvariantViolation, PendingForesterProof, Snapshot,
};

fn snap_with(next_index: u64, queue_tail: u64) -> Snapshot {
    let mut s = Snapshot::empty();
    s.tree.next_index = next_index;
    s.tree.queue_tail = queue_tail;
    s
}

#[test]
fn queue_tail_equals_next_index_ok() {
    inv_queue_tail_geq_next_index(&snap_with(100, 100)).expect("equal");
}

#[test]
fn queue_tail_greater_ok() {
    inv_queue_tail_geq_next_index(&snap_with(100, 120)).expect("greater");
}

#[test]
fn queue_tail_less_caught() {
    let err = inv_queue_tail_geq_next_index(&snap_with(100, 99))
        .expect_err("queue_tail can't lag next_index");
    assert!(matches!(err, InvariantViolation::Metering(_)));
}

#[test]
fn forester_bounds_aligned_ok() {
    let snap = snap_with(100, 200);
    inv_forester_proof_bounds(&snap, 100).expect("aligned");
}

#[test]
fn forester_start_misaligned_rejected() {
    let snap = snap_with(100, 200);
    let err = inv_forester_proof_bounds(&snap, 101).expect_err("misaligned");
    assert!(matches!(err, InvariantViolation::Metering(_)));
}

#[test]
fn forester_batch_overshoots_queue_tail_rejected() {
    // next_index=100, queue_tail=102 → batch of 4 ends at 104 > 102.
    let snap = snap_with(100, 102);
    let err = inv_forester_proof_bounds(&snap, 100)
        .expect_err("not enough queued commits");
    assert!(matches!(err, InvariantViolation::Metering(_)));
}

#[test]
fn pending_forester_well_formed_ok() {
    let snap = snap_with(100, 200);
    let pending = PendingForesterProof {
        start_index: 100,
        commitments: vec![[1u8; 32]; 4], // FORESTER_BATCH_SIZE = 4
        old_root: [0u8; 32],
        new_root: [1u8; 32],
    };
    inv_pending_forester_well_formed(&snap, &pending).expect("OK");
}

#[test]
fn pending_forester_wrong_batch_size_rejected() {
    let snap = snap_with(100, 200);
    let pending = PendingForesterProof {
        start_index: 100,
        commitments: vec![[1u8; 32]; 3],
        old_root: [0u8; 32],
        new_root: [1u8; 32],
    };
    let err = inv_pending_forester_well_formed(&snap, &pending)
        .expect_err("wrong size");
    assert!(matches!(err, InvariantViolation::Metering(_)));
}
