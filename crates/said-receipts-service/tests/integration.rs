//! Cross-module integration tests that mirror the live wiring without
//! requiring Postgres. The "real" Postgres integration test lives
//! out-of-band — see the workspace README for how to run it once the
//! migrations are applied to a scratch database.

use said_receipts_service::merkle::{build_tree, proof_for_leaf, verify_proof};

#[test]
fn merkle_round_trip_external_api() {
    let leaves: Vec<[u8; 32]> = (0..16)
        .map(|i| {
            let mut h = [0u8; 32];
            h[0] = i as u8;
            h
        })
        .collect();
    let tree = build_tree(&leaves);
    let root = tree.root().unwrap();
    for (i, leaf) in leaves.iter().enumerate() {
        let proof = proof_for_leaf(&tree, i);
        assert!(verify_proof(root, *leaf, i, &proof, leaves.len()));
    }
}
