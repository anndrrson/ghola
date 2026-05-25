//! `TestVector` — the on-disk JSON shape consumed by auditors, the circuit
//! test harness, the on-chain program test harness, and the client SDK.
//!
//! The vector encodes:
//!
//!   * `witness`       — full prover input (private),
//!   * `expected_public_inputs` — what the circuit MUST expose,
//!   * `expected_commitment_chain` — the ordered list of commitments that
//!     will be inserted into the tree by this transaction,
//!   * `expected_nullifiers` — the ordered list of nullifiers consumed,
//!   * `should_prove`  — whether a correct prover should succeed on this
//!     witness (false ⇒ witness violates a circuit constraint),
//!   * `should_verify` — whether the on-chain program should accept the
//!     resulting proof bundle (false ⇒ on-chain check fails even if proof
//!     verifies cryptographically — e.g. nullifier already used, root not in
//!     history window, ext_data binding mismatch).
//!
//! All `FieldBytes` (and types wrapping them) are encoded as lowercase-hex
//! strings (no `0x` prefix) when serialized to JSON via `serde_json`.

use said_shielded_pool_types::{Commitment, Nullifier, PublicInputs, TransferWitness};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TestVector {
    /// Short identifier (also the filename stem).
    pub name: String,
    /// Free-form human-readable description.
    pub description: String,
    /// Full prover witness (private inputs).
    pub witness: TransferWitness,
    /// Public inputs the circuit must expose for this witness.
    pub expected_public_inputs: PublicInputs,
    /// Commitments expected to be inserted (in order) on-chain.
    pub expected_commitment_chain: Vec<Commitment>,
    /// Nullifiers expected to be spent (in order) on-chain.
    pub expected_nullifiers: Vec<Nullifier>,
    /// A correct prover should produce a valid proof for this witness.
    pub should_prove: bool,
    /// The on-chain program should accept the resulting proof bundle.
    pub should_verify: bool,
    /// Optional free-form notes (failure mode being exercised, etc.).
    pub notes: Option<String>,
}
