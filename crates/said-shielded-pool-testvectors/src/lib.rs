//! said-shielded-pool-testvectors — deterministic test vectors for the
//! Ghola shielded pool.
//!
//! See `README.md` for the full schema description and consumption examples.

#![forbid(unsafe_code)]

pub mod poseidon;
pub mod scenarios;
pub mod tree;
pub mod types;

pub use types::TestVector;

use said_shielded_pool_types::{MerklePath, Note, PublicInputs, TransferWitness};
use serde_json::{json, Value};

/// Deterministic seed for the test-vector RNG. Documented in `README.md`.
pub const VECTOR_SEED: u64 = 0xDEAD_BEEF;

/// Encode a `FieldBytes` (or any byte slice) as lowercase hex, no prefix.
pub fn hex_bytes(b: &[u8]) -> String {
    hex::encode(b)
}

/// Convert a `TestVector` into the canonical JSON representation used in
/// the on-disk vector files. Hex-encodes every `FieldBytes`-shaped value.
pub fn vector_to_json(v: &TestVector) -> Value {
    json!({
        "name": v.name,
        "description": v.description,
        "should_prove": v.should_prove,
        "should_verify": v.should_verify,
        "notes": v.notes,
        "witness": witness_to_json(&v.witness),
        "expected_public_inputs": public_inputs_to_json(&v.expected_public_inputs),
        "expected_commitment_chain": v.expected_commitment_chain.iter()
            .map(|c| hex_bytes(&c.0))
            .collect::<Vec<_>>(),
        "expected_nullifiers": v.expected_nullifiers.iter()
            .map(|n| hex_bytes(&n.0))
            .collect::<Vec<_>>(),
        // The Groth16 proof is filled in later by the prover service. The
        // vector specifies the *expected* witness + public inputs; the
        // proof bytes are not yet available because no prover is wired up
        // in this crate (see SPEC §6).
        "proof": Value::Null,
    })
}

fn note_to_json(n: &Note) -> Value {
    json!({
        "amount": n.amount,
        "asset_id": hex_bytes(&n.asset_id.0),
        "owner_pubkey": hex_bytes(&n.owner_pubkey),
        "blinding": hex_bytes(&n.blinding),
    })
}

fn path_to_json(p: &MerklePath) -> Value {
    json!({
        "siblings": p.siblings.iter().map(|s| hex_bytes(s)).collect::<Vec<_>>(),
        "path_bits": p.path_bits,
    })
}

fn witness_to_json(w: &TransferWitness) -> Value {
    json!({
        "input_notes": w.input_notes.iter().map(note_to_json).collect::<Vec<_>>(),
        "input_paths": w.input_paths.iter().map(path_to_json).collect::<Vec<_>>(),
        "input_indices": w.input_indices,
        "output_notes": w.output_notes.iter().map(note_to_json).collect::<Vec<_>>(),
        "spending_key": hex_bytes(&w.spending_key),
        "public_amount": w.public_amount.to_string(),
        "asset_id": hex_bytes(&w.asset_id.0),
        "ext_data_hash": hex_bytes(&w.ext_data_hash),
    })
}

fn public_inputs_to_json(p: &PublicInputs) -> Value {
    json!({
        "root": hex_bytes(&p.root.0),
        "input_nullifiers": p.input_nullifiers.iter()
            .map(|n| hex_bytes(&n.0))
            .collect::<Vec<_>>(),
        "output_commitments": p.output_commitments.iter()
            .map(|c| hex_bytes(&c.0))
            .collect::<Vec<_>>(),
        "public_amount": p.public_amount.to_string(),
        "asset_id": hex_bytes(&p.asset_id.0),
        "ext_data_hash": hex_bytes(&p.ext_data_hash),
    })
}

