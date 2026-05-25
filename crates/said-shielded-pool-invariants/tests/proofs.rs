//! Family 5 — proof binding: vk hash commitment + public-input layout.

use said_shielded_pool_invariants::{
    inv_public_input_layout, inv_vk_hash_commitment, InvariantViolation, Snapshot,
};
use sha2::{Digest, Sha256};

fn snap_with_vk_hash(hash: [u8; 32]) -> Snapshot {
    let mut s = Snapshot::empty();
    s.pool_config.verifier_key_hash = hash;
    s
}

#[test]
fn vk_hash_matches() {
    let vk = b"fake-vk-bytes-blob-do-not-trust";
    let mut h = Sha256::new();
    h.update(vk);
    let hash: [u8; 32] = h.finalize().into();
    let snap = snap_with_vk_hash(hash);
    inv_vk_hash_commitment(&snap, vk).expect("matches");
}

#[test]
fn vk_hash_mismatch_caught() {
    let snap = snap_with_vk_hash([0xAA; 32]);
    let err = inv_vk_hash_commitment(&snap, b"different-vk")
        .expect_err("must fail");
    assert!(matches!(err, InvariantViolation::Proofs(_)));
}

#[test]
fn public_inputs_correct_length() {
    let inputs = [[0u8; 32]; 8];
    inv_public_input_layout(&inputs).expect("8 inputs");
}

#[test]
fn public_inputs_short_rejected() {
    let inputs = [[0u8; 32]; 7];
    let err = inv_public_input_layout(&inputs).expect_err("short");
    assert!(matches!(err, InvariantViolation::Proofs(_)));
}

#[test]
fn public_inputs_long_rejected() {
    let inputs = vec![[0u8; 32]; 9];
    let err = inv_public_input_layout(&inputs).expect_err("long");
    assert!(matches!(err, InvariantViolation::Proofs(_)));
}

#[test]
fn empty_vk_bytes_hash_consistent() {
    // sha256 of empty input is well-known; we just need round-trip.
    let mut h = Sha256::new();
    h.update(b"");
    let hash: [u8; 32] = h.finalize().into();
    let snap = snap_with_vk_hash(hash);
    inv_vk_hash_commitment(&snap, b"").expect("empty round trip");
}

#[test]
fn changing_one_byte_breaks_vk_match() {
    let vk = vec![0u8; 100];
    let mut h = Sha256::new();
    h.update(&vk);
    let hash: [u8; 32] = h.finalize().into();
    let snap = snap_with_vk_hash(hash);

    let mut vk_modified = vk.clone();
    vk_modified[50] = 1;
    let err = inv_vk_hash_commitment(&snap, &vk_modified).expect_err("byte flip");
    assert!(matches!(err, InvariantViolation::Proofs(_)));
}

#[test]
fn empty_public_inputs_rejected() {
    let inputs: [[u8; 32]; 0] = [];
    let err = inv_public_input_layout(&inputs).expect_err("empty");
    assert!(matches!(err, InvariantViolation::Proofs(_)));
}
