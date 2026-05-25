//! Precomputed zero-subtree hashes for the depth-[`TREE_DEPTH`] incremental
//! Merkle tree.
//!
//! `Z[0] = 0`
//! `Z[i] = Poseidon(Z[i-1], Z[i-1])` for `1 ≤ i ≤ TREE_DEPTH`.
//!
//! We compute the table once at process start with [`compute_zero_hashes`]
//! and cache it in a `OnceLock`. Hard-coding the constants would be slightly
//! cheaper at boot, but (a) the cost is ~26 Poseidon hashes (~ms), and (b)
//! keeping the derivation in-tree means any future change to the Poseidon
//! parameterization is automatically picked up — fewer places to keep in
//! sync with the on-chain program and the circuit.

use std::sync::OnceLock;

use said_shielded_pool_types::{FieldBytes, TREE_DEPTH, FIELD_BYTES};

use crate::error::{Error, Result};

/// Zero hashes Z[0..=TREE_DEPTH], indexed by subtree depth.
///
/// - `zero_hashes()[0]` is the canonical zero field element (a depth-0 "empty leaf").
/// - `zero_hashes()[TREE_DEPTH]` is the root of an entirely empty depth-26 tree.
pub fn zero_hashes() -> &'static [FieldBytes; TREE_DEPTH + 1] {
    static TABLE: OnceLock<[FieldBytes; TREE_DEPTH + 1]> = OnceLock::new();
    TABLE.get_or_init(|| {
        compute_zero_hashes().expect("zero-hash precomputation must succeed for BN254 Poseidon(2)")
    })
}

/// Compute the zero-hashes table from scratch using the same Poseidon
/// parameterization as the on-chain program and the circuits.
pub fn compute_zero_hashes() -> Result<[FieldBytes; TREE_DEPTH + 1]> {
    let mut table = [[0u8; FIELD_BYTES]; TREE_DEPTH + 1];
    // Z[0] = 0 (the canonical empty-leaf field element).
    table[0] = [0u8; FIELD_BYTES];
    for i in 1..=TREE_DEPTH {
        table[i] = crate::tree::poseidon2_be(&table[i - 1], &table[i - 1])
            .map_err(|e| Error::Poseidon(format!("zero hash at depth {i}: {e}")))?;
    }
    Ok(table)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_hashes_table_is_deterministic_and_sized() {
        let a = compute_zero_hashes().unwrap();
        let b = compute_zero_hashes().unwrap();
        assert_eq!(a, b);
        assert_eq!(a[0], [0u8; FIELD_BYTES]);
        assert_ne!(a[1], a[0]);
        assert_ne!(a[TREE_DEPTH], a[TREE_DEPTH - 1]);
    }
}
