//! Family 3 — root history window + monotonic forester advancement.

use said_shielded_pool_invariants::{
    inv_next_index_only_advanced_by_forester, inv_root_in_history_window, ForesterEvent,
    ForesterEventKind, InvariantViolation, MerkleTreeSnap, Snapshot, ONCHAIN_ROOT_HISTORY_SIZE,
};

fn snap_with_root(root: [u8; 32], history: Vec<[u8; 32]>) -> Snapshot {
    let mut s = Snapshot::empty();
    s.tree = MerkleTreeSnap {
        pool: [0u8; 32],
        mint: [0u8; 32],
        root,
        next_index: 0,
        queue_tail: 0,
        root_history: history,
        root_history_idx: 0,
        depth: 26,
    };
    s
}

#[test]
fn current_root_accepted() {
    let r = [0x11; 32];
    let snap = snap_with_root(r, vec![[0u8; 32]; ONCHAIN_ROOT_HISTORY_SIZE]);
    inv_root_in_history_window(&snap, r).expect("current root OK");
}

#[test]
fn historical_root_in_window_accepted() {
    let r = [0x11; 32];
    let old = [0x22; 32];
    let mut history = vec![[0u8; 32]; ONCHAIN_ROOT_HISTORY_SIZE];
    history[5] = old;
    let snap = snap_with_root(r, history);
    inv_root_in_history_window(&snap, old).expect("historical OK");
}

#[test]
fn out_of_window_root_rejected() {
    let r = [0x11; 32];
    let snap = snap_with_root(r, vec![[0u8; 32]; ONCHAIN_ROOT_HISTORY_SIZE]);
    let ancient = [0xEE; 32];
    let err = inv_root_in_history_window(&snap, ancient).expect_err("ancient must fail");
    assert!(matches!(err, InvariantViolation::Roots(_)));
}

#[test]
fn forester_advances_by_exact_batch_size() {
    let mut prev = Snapshot::empty();
    let mut next = Snapshot::empty();
    prev.tree.next_index = 100;
    next.tree.next_index = 104; // FORESTER_BATCH_SIZE = 4.
    let ev = ForesterEvent {
        event: ForesterEventKind::ForesterUpdate,
        signer: [0xAA; 32],
    };
    inv_next_index_only_advanced_by_forester(&prev, &next, &ev).expect("OK");
}

#[test]
fn non_forester_advancement_rejected() {
    let mut prev = Snapshot::empty();
    let mut next = Snapshot::empty();
    prev.tree.next_index = 100;
    next.tree.next_index = 104;
    let ev = ForesterEvent {
        event: ForesterEventKind::Other,
        signer: [0xAA; 32],
    };
    let err = inv_next_index_only_advanced_by_forester(&prev, &next, &ev)
        .expect_err("non-forester advance must fail");
    assert!(matches!(err, InvariantViolation::Roots(_)));
}

#[test]
fn wrong_batch_size_rejected() {
    let mut prev = Snapshot::empty();
    let mut next = Snapshot::empty();
    prev.tree.next_index = 100;
    next.tree.next_index = 101; // wrong: advanced by 1, not 4.
    let ev = ForesterEvent {
        event: ForesterEventKind::ForesterUpdate,
        signer: [0xAA; 32],
    };
    let err = inv_next_index_only_advanced_by_forester(&prev, &next, &ev)
        .expect_err("wrong batch must fail");
    assert!(matches!(err, InvariantViolation::Roots(_)));
}

#[test]
fn backward_movement_rejected() {
    let mut prev = Snapshot::empty();
    let mut next = Snapshot::empty();
    prev.tree.next_index = 100;
    next.tree.next_index = 96; // backward!
    let ev = ForesterEvent {
        event: ForesterEventKind::ForesterUpdate,
        signer: [0xAA; 32],
    };
    let err = inv_next_index_only_advanced_by_forester(&prev, &next, &ev)
        .expect_err("backward must fail");
    assert!(matches!(err, InvariantViolation::Roots(_)));
}

#[test]
fn no_op_advance_ok() {
    let prev = Snapshot::empty();
    let next = Snapshot::empty();
    let ev = ForesterEvent {
        event: ForesterEventKind::Other,
        signer: [0u8; 32],
    };
    inv_next_index_only_advanced_by_forester(&prev, &next, &ev).expect("no-op OK");
}
