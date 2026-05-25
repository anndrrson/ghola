//! Witness builder for the batched-update circuit.
//!
//! The batched-update SNARK proves:
//!
//! ```text
//! new_root = sequential-insert(old_root, [c_0, c_1, …, c_{n-1}])
//! ```
//!
//! i.e. starting from a tree whose root is `old_root` and whose
//! `next_index = start_index`, inserting each commitment `c_i` (in order)
//! at position `start_index + i` yields a tree with root `new_root`.
//!
//! The off-chain witness the prover needs is (in the wire shape defined
//! by [`said_shielded_pool_types::BatchedUpdateWitness`]):
//!
//! - `old_root` (public, hex BE32)
//! - `new_root` (public, hex BE32)
//! - `start_index` (public, u64)
//! - `commitments` (public, hex BE32 each) — length `FORESTER_BATCH_SIZE`
//! - `path_elements[i][d]` (private, hex BE32) — the sibling Merkle node
//!   at depth `d` for the leaf at position `start_index + i`, in the tree
//!   state JUST BEFORE step `i`.
//!
//! For an append-only insertion at leaf index `idx`, the sibling at
//! depth `d` (where `current_idx = idx >> d`) is:
//!   - `zero_hashes[d]`  if `current_idx` is even (right sibling empty)
//!   - `filled[d]`        if `current_idx` is odd  (left sibling is the
//!                        cached filled subtree)
//!
//! We materialize the witness by simulating the inserts against a clone
//! of the on-disk tree without committing — the original tree is unchanged
//! until the on-chain `update_root_via_proof` succeeds and the resulting
//! `RootUpdated` event flows back through the listener.

use said_shielded_pool_types::{
    BatchedUpdateWitness, Commitment, FieldBytes, FIELD_BYTES, FORESTER_BATCH_SIZE, TREE_DEPTH,
};

use crate::tree::poseidon2_be;
use crate::zero_hashes::zero_hashes;
use crate::error::{Error, Result};

/// Simulate inserting `commitments` into a tree starting from
/// (`start_root`, `start_size`, `start_filled_subtrees`) and produce the
/// batched-update witness.
///
/// The starting `filled_subtrees` are the canonical "filled" array from
/// the live [`crate::tree::IncrementalMerkleTree`]. The starting `root`
/// must be derivable from them (and the zero hashes); we do not re-verify
/// that here — the caller has just read both from the same persisted
/// snapshot.
///
/// `commitments.len()` MUST equal [`FORESTER_BATCH_SIZE`]; smaller batches
/// should be padded with zero commitments by the caller (but note that
/// inserting `commitment[i] == 0` makes the inserted leaf indistinguishable
/// from an empty slot — fine here because the circuit's "slot must be
/// empty" check uses the same zero element).
pub fn build_witness(
    start_root: FieldBytes,
    start_size: u64,
    start_filled_subtrees: [FieldBytes; TREE_DEPTH],
    commitments: &[Commitment],
) -> Result<BatchedUpdateWitness> {
    if commitments.len() != FORESTER_BATCH_SIZE {
        return Err(Error::Poseidon(format!(
            "forester batch size mismatch: got {} commitments, expected {FORESTER_BATCH_SIZE}",
            commitments.len()
        )));
    }

    let zh = zero_hashes();
    let mut filled = start_filled_subtrees;
    let mut new_root = start_root;

    let mut path_elements: Vec<Vec<String>> = Vec::with_capacity(commitments.len());

    for (i, c) in commitments.iter().enumerate() {
        let idx = start_size + i as u64;

        // Snapshot the sibling path BEFORE this insertion — this is what
        // the circuit witnesses for step i.
        let mut sibling_row: Vec<String> = Vec::with_capacity(TREE_DEPTH);
        for d in 0..TREE_DEPTH {
            let bit = (idx >> d) & 1;
            let sibling = if bit == 0 { zh[d] } else { filled[d] };
            sibling_row.push(hex_encode_be(&sibling));
        }
        path_elements.push(sibling_row);

        // Apply the insertion to (filled, new_root).
        let mut current = c.0;
        let mut current_idx = idx;
        for d in 0..TREE_DEPTH {
            let (left, right) = if current_idx & 1 == 0 {
                filled[d] = current;
                (current, zh[d])
            } else {
                (filled[d], current)
            };
            current = poseidon2_be(&left, &right)?;
            current_idx >>= 1;
        }
        new_root = current;
    }

    Ok(BatchedUpdateWitness {
        old_root: hex_encode_be(&start_root),
        new_root: hex_encode_be(&new_root),
        start_index: start_size,
        commitments: commitments
            .iter()
            .map(|c| hex_encode_be(&c.0))
            .collect(),
        path_elements,
    })
}

fn hex_encode_be(fb: &FieldBytes) -> String {
    debug_assert_eq!(fb.len(), FIELD_BYTES);
    hex::encode(fb)
}
