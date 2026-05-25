//! Witness → prove → verify roundtrip.
//!
//! Currently marked `#[ignore]` because:
//!   1. The compiled circuit artifacts (`circuit_final.zkey`,
//!      `transaction.wasm`, `verification_key.json`) are produced by
//!      `crates/said-shielded-pool-circuits` (Circom + Powers-of-Tau)
//!      and not committed.
//!   2. We need `snarkjs` available on `$PATH` (or `rapidsnark` for
//!      the fast path).
//!
//! Run manually once those are in place:
//!
//! ```bash
//! ARTIFACTS_DIR=$PWD/crates/said-shielded-pool-circuits/build \
//!     cargo test -p said-shielded-pool-prover --test proof_roundtrip -- --ignored
//! ```
//!
//! When this passes locally it becomes the gate for Phase 39 (on-chain
//! verifier integration).

use said_shielded_pool_prover::{
    backend,
    config::{BackendKind, Config},
};
use said_shielded_pool_types::{AssetId, MerklePath, Note, TransferWitness};

fn dummy_witness() -> TransferWitness {
    let note = Note {
        amount: 100,
        asset_id: AssetId([1u8; 32]),
        owner_pubkey: [2u8; 32],
        blinding: [3u8; 32],
    };
    let path = MerklePath {
        siblings: vec![[0u8; 32]; 26],
        path_bits: vec![false; 26],
    };
    TransferWitness {
        input_notes: vec![note.clone(), note.clone()],
        input_paths: vec![path.clone(), path],
        input_indices: vec![0, 1],
        output_notes: vec![note.clone(), note],
        spending_key: [9u8; 32],
        public_amount: 0,
        asset_id: AssetId([1u8; 32]),
        ext_data_hash: [0u8; 32],
    }
}

#[tokio::test]
#[ignore = "requires circuit artifacts + snarkjs on $PATH; enable in Phase 39"]
async fn snarkjs_roundtrip() {
    let cfg = Config {
        port: 0,
        artifacts_dir: std::env::var("ARTIFACTS_DIR")
            .map(std::path::PathBuf::from)
            .expect("set ARTIFACTS_DIR"),
        backend: BackendKind::Snarkjs,
        subprocess_timeout_ms: 30_000,
    };
    let b = backend::build(&cfg);
    let witness = dummy_witness();
    let bundle = b.prove(witness).await.expect("prove ok");
    assert_eq!(bundle.public_inputs.input_nullifiers.len(), 2);
    assert_eq!(bundle.public_inputs.output_commitments.len(), 2);
    // proof bytes should be the on-chain layout: A is 64 bytes
    // (negated), B is 128 bytes, C is 64 bytes.
    assert_eq!(bundle.proof.a.len(), 64);
    assert_eq!(bundle.proof.b.len(), 128);
    assert_eq!(bundle.proof.c.len(), 64);
}
