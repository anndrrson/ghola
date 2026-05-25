//! Minimal self-contained depth-26 incremental Merkle tree for vector
//! generation. Intentionally not depending on `said-shielded-pool-indexer`
//! so this crate stays portable for external auditors.
//!
//! Hash is Poseidon2 (see `poseidon.rs`); zero-subtree values are precomputed
//! via `zero[0] = [0u8; 32]; zero[i+1] = Poseidon2(zero[i], zero[i])`.

use said_shielded_pool_types::{Commitment, FieldBytes, MerklePath, MerkleRoot, TREE_DEPTH};

use crate::poseidon::poseidon2;

/// In-memory sparse incremental Merkle tree.
pub struct IncrementalMerkleTree {
    /// next free leaf index
    pub next_index: u64,
    /// frontier[i] = current right-most node at level i for the inserted leaves
    frontier: Vec<FieldBytes>,
    /// zero subtree roots at each level (zero[0] = empty leaf = [0; 32])
    zeros: Vec<FieldBytes>,
    /// Full leaf log (only for vector generation — production indexer uses
    /// rolling commitment but vectors record the full state).
    pub leaves: Vec<FieldBytes>,
}

impl Default for IncrementalMerkleTree {
    fn default() -> Self {
        Self::new()
    }
}

impl IncrementalMerkleTree {
    pub fn new() -> Self {
        let mut zeros = Vec::with_capacity(TREE_DEPTH + 1);
        zeros.push([0u8; 32]);
        for i in 0..TREE_DEPTH {
            let z = poseidon2(&zeros[i], &zeros[i]);
            zeros.push(z);
        }
        let frontier = vec![[0u8; 32]; TREE_DEPTH];
        Self {
            next_index: 0,
            frontier,
            zeros,
            leaves: Vec::new(),
        }
    }

    /// Insert a leaf; returns the leaf's index and the root after insertion.
    pub fn insert(&mut self, leaf: FieldBytes) -> (u64, MerkleRoot) {
        let index = self.next_index;
        self.leaves.push(leaf);

        let mut current = leaf;
        let mut idx = index;
        for level in 0..TREE_DEPTH {
            if idx & 1 == 0 {
                // we're the left child; sibling on right is the zero-subtree.
                self.frontier[level] = current;
                current = poseidon2(&current, &self.zeros[level]);
            } else {
                // sibling on left is what's already at frontier[level]
                let left = self.frontier[level];
                current = poseidon2(&left, &current);
            }
            idx >>= 1;
        }

        self.next_index += 1;
        (index, MerkleRoot(current))
    }

    /// Insert a commitment (just unwrapping the newtype).
    pub fn insert_commitment(&mut self, c: &Commitment) -> (u64, MerkleRoot) {
        self.insert(c.0)
    }

    /// Current root. For vector generation we always recompute from the
    /// leaf log for full auditability (no incremental-frontier shortcut).
    pub fn root(&self) -> MerkleRoot {
        MerkleRoot(self.compute_root_from_leaves())
    }

    /// Compute the Merkle root by hashing the full leaf list (slow but
    /// auditable, fine for ≤ few thousand leaves in vector generation).
    pub fn compute_root_from_leaves(&self) -> FieldBytes {
        let mut layer: Vec<FieldBytes> = self.leaves.clone();
        if layer.is_empty() {
            return self.zeros[TREE_DEPTH];
        }
        for level in 0..TREE_DEPTH {
            let mut next_layer = Vec::with_capacity((layer.len() + 1) / 2);
            let mut i = 0;
            while i < layer.len() {
                let left = layer[i];
                let right = if i + 1 < layer.len() {
                    layer[i + 1]
                } else {
                    self.zeros[level]
                };
                next_layer.push(poseidon2(&left, &right));
                i += 2;
            }
            layer = next_layer;
        }
        debug_assert_eq!(layer.len(), 1);
        layer[0]
    }

    /// Build a Merkle authentication path for a leaf at `leaf_index`.
    pub fn path_for(&self, leaf_index: u64) -> MerklePath {
        assert!(
            (leaf_index as usize) < self.leaves.len(),
            "leaf_index out of bounds"
        );
        let mut siblings = Vec::with_capacity(TREE_DEPTH);
        let mut path_bits = Vec::with_capacity(TREE_DEPTH);

        let mut layer: Vec<FieldBytes> = self.leaves.clone();
        let mut idx = leaf_index as usize;
        for level in 0..TREE_DEPTH {
            let sibling = if idx & 1 == 0 {
                // current node is left; sibling is right
                if idx + 1 < layer.len() {
                    layer[idx + 1]
                } else {
                    self.zeros[level]
                }
            } else {
                layer[idx - 1]
            };
            siblings.push(sibling);
            path_bits.push(idx & 1 == 1);

            // build next layer
            let mut next_layer = Vec::with_capacity((layer.len() + 1) / 2);
            let mut i = 0;
            while i < layer.len() {
                let left = layer[i];
                let right = if i + 1 < layer.len() {
                    layer[i + 1]
                } else {
                    self.zeros[level]
                };
                next_layer.push(poseidon2(&left, &right));
                i += 2;
            }
            layer = next_layer;
            idx /= 2;
        }

        MerklePath {
            siblings,
            path_bits,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_tree_root_is_zero_subtree() {
        let t = IncrementalMerkleTree::new();
        let r = t.compute_root_from_leaves();
        assert_eq!(r, t.zeros[TREE_DEPTH]);
    }

    #[test]
    fn insert_advances_index() {
        let mut t = IncrementalMerkleTree::new();
        let (i, _) = t.insert([1u8; 32]);
        assert_eq!(i, 0);
        let (i, _) = t.insert([2u8; 32]);
        assert_eq!(i, 1);
        assert_eq!(t.next_index, 2);
    }

    #[test]
    fn path_reconstruction_matches_root() {
        let mut t = IncrementalMerkleTree::new();
        for k in 0..5u8 {
            let mut l = [0u8; 32];
            l[31] = k + 1;
            t.insert(l);
        }
        let root = t.compute_root_from_leaves();
        let path = t.path_for(2);
        // reconstruct
        let mut current = t.leaves[2];
        for level in 0..TREE_DEPTH {
            current = if path.path_bits[level] {
                poseidon2(&path.siblings[level], &current)
            } else {
                poseidon2(&current, &path.siblings[level])
            };
        }
        assert_eq!(current, root);
    }
}
