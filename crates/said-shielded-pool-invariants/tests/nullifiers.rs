//! Family 2 — Nullifier uniqueness, derivation, cross-asset binding.

use std::collections::HashSet;

use said_shielded_pool_invariants::{
    inv_nullifier_derivation, inv_nullifier_pda_existence, inv_nullifier_uniqueness,
    InvariantViolation, Snapshot,
};

fn snapshot_with_nullifiers(set: &[[u8; 32]]) -> Snapshot {
    let mut snap = Snapshot::empty();
    snap.nullifier_set = set.iter().copied().collect::<HashSet<_>>();
    snap
}

#[test]
fn new_spend_passes_uniqueness() {
    let snap = snapshot_with_nullifiers(&[[1u8; 32], [2u8; 32]]);
    let candidate = [3u8; 32];
    inv_nullifier_uniqueness(&snap, candidate).expect("new spend OK");
}

#[test]
fn double_spend_caught() {
    let existing = [7u8; 32];
    let snap = snapshot_with_nullifiers(&[existing]);
    let err = inv_nullifier_uniqueness(&snap, existing).expect_err("dbl-spend");
    assert!(matches!(err, InvariantViolation::Nullifiers(_)));
}

#[test]
fn pda_existence_present() {
    let n = [0xAB; 32];
    let snap = snapshot_with_nullifiers(&[n]);
    inv_nullifier_pda_existence(&snap, n).expect("present");
}

#[test]
fn pda_existence_missing_flagged() {
    let snap = snapshot_with_nullifiers(&[]);
    let n = [0xCD; 32];
    let err = inv_nullifier_pda_existence(&snap, n).expect_err("missing PDA");
    assert!(matches!(err, InvariantViolation::Nullifiers(_)));
}

#[test]
fn derivation_is_deterministic_and_self_consistent() {
    let sk = [0x11; 32];
    let commitment = [0x22; 32];
    let leaf_index = 1234u64;

    // First compute the nullifier from a trusted scratchpad — use the
    // same poseidon3 via inv_nullifier_derivation with a tentative
    // value, expecting the error to surface the computed bytes.
    // Easier: derive twice, assert match.
    let bogus_claim = [0u8; 32];
    let err = inv_nullifier_derivation(&sk, &commitment, leaf_index, &bogus_claim)
        .expect_err("zero claim doesn't match");
    let msg = format!("{err}");
    // The error message embeds the computed bytes; we just confirm
    // determinism by calling the API twice with the same bogus claim.
    let err2 = inv_nullifier_derivation(&sk, &commitment, leaf_index, &bogus_claim)
        .expect_err("zero claim doesn't match");
    let msg2 = format!("{err2}");
    assert_eq!(msg, msg2, "poseidon3 must be deterministic");
}

#[test]
fn derivation_mismatch_caught() {
    let sk = [0x11; 32];
    let commitment = [0x22; 32];
    let leaf_index = 5u64;
    let wrong_claim = [0xFF; 32];
    let err = inv_nullifier_derivation(&sk, &commitment, leaf_index, &wrong_claim)
        .expect_err("must reject mismatch");
    assert!(matches!(err, InvariantViolation::Nullifiers(_)));
}

#[test]
fn different_leaf_index_yields_different_nullifier() {
    let sk = [0x33; 32];
    let commitment = [0x44; 32];
    // Same SK + commitment, different leaf — error messages must differ.
    let bogus = [0u8; 32];
    let e1 = inv_nullifier_derivation(&sk, &commitment, 10, &bogus).expect_err("");
    let e2 = inv_nullifier_derivation(&sk, &commitment, 11, &bogus).expect_err("");
    assert_ne!(format!("{e1}"), format!("{e2}"));
}

#[test]
fn cross_asset_isolation_modeled_via_pda_seeds() {
    // The on-chain PDA seed is `[b"nullifier", mint, &n]`. Two trees
    // (different mints) with accidentally-equal nullifier field-
    // elements yield distinct PDAs — so a clash in the nullifier-byte
    // value alone does not collide on-chain. Off-chain we model this
    // by keeping a single global nullifier set per mint snapshot.
    let shared = [0xEE; 32];
    let snap_mint_a = snapshot_with_nullifiers(&[shared]);
    let snap_mint_b = snapshot_with_nullifiers(&[]); // mint B clean
    // Same byte value, but they live in separate snapshots, so mint-B
    // uniqueness is preserved.
    inv_nullifier_uniqueness(&snap_mint_b, shared)
        .expect("same bytes, different mint, must be unique");
    // And mint-A correctly flags it as already spent.
    assert!(inv_nullifier_uniqueness(&snap_mint_a, shared).is_err());
}
