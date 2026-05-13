//! Merkle helper.
//!
//! Thin wrapper over `rs_merkle` with a SHA-256 hasher. Receipts are
//! already 32-byte digests, so leaves are passed in pre-hashed. A
//! `MerkleProof` here is just the sibling hashes the verifier needs
//! to reconstruct the root from a leaf at a given index.

use rs_merkle::{algorithms::Sha256 as Sha256Algo, MerkleTree};

/// Build a Merkle tree over a slice of pre-hashed leaves.
pub fn build_tree(leaves: &[[u8; 32]]) -> MerkleTree<Sha256Algo> {
    MerkleTree::<Sha256Algo>::from_leaves(leaves)
}

/// Inclusion proof for a single leaf, as the ordered list of sibling
/// hashes required by `rs_merkle::MerkleProof::verify`.
pub fn proof_for_leaf(tree: &MerkleTree<Sha256Algo>, leaf_index: usize) -> Vec<[u8; 32]> {
    tree.proof(&[leaf_index]).proof_hashes().to_vec()
}

/// Recompute the root from a leaf + its proof + the total leaf count.
/// Standalone so callers (and tests) can verify a proof without
/// holding the full tree.
pub fn verify_proof(
    root: [u8; 32],
    leaf: [u8; 32],
    leaf_index: usize,
    proof_hashes: &[[u8; 32]],
    total_leaves: usize,
) -> bool {
    let proof = rs_merkle::MerkleProof::<Sha256Algo>::new(proof_hashes.to_vec());
    proof.verify(root, &[leaf_index], &[leaf], total_leaves)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_leaf_root_equals_leaf() {
        let leaf = [7u8; 32];
        let tree = build_tree(&[leaf]);
        assert_eq!(tree.root().unwrap(), leaf);
    }

    #[test]
    fn round_trip_proof_for_each_leaf() {
        // Eight distinct leaves -> verify every position round-trips.
        let leaves: Vec<[u8; 32]> = (0..8)
            .map(|i| {
                let mut b = [0u8; 32];
                b[0] = i as u8;
                b
            })
            .collect();
        let tree = build_tree(&leaves);
        let root = tree.root().unwrap();
        for (i, leaf) in leaves.iter().enumerate() {
            let proof = proof_for_leaf(&tree, i);
            assert!(
                verify_proof(root, *leaf, i, &proof, leaves.len()),
                "leaf {i} proof did not verify"
            );
        }
    }

    #[test]
    fn proof_rejects_wrong_leaf() {
        let leaves: Vec<[u8; 32]> = (0..4).map(|i| [i as u8; 32]).collect();
        let tree = build_tree(&leaves);
        let root = tree.root().unwrap();
        let proof = proof_for_leaf(&tree, 0);
        // Same proof, different leaf -> must fail.
        assert!(!verify_proof(root, [99u8; 32], 0, &proof, leaves.len()));
    }
}
