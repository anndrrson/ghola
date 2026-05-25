//! Unit tests for `IncrementalMerkleTree`.
//!
//! Strategy: insert N leaves through the incremental code path, then
//! recompute the same N-leaf tree's root naively (layer-by-layer with
//! zero-padding) and assert equality. Also exercise `path()` queries by
//! verifying that following the returned siblings + path_bits from each
//! inserted leaf reproduces the root.

use said_shielded_pool_indexer::tree::{poseidon2_be, IncrementalMerkleTree};
use said_shielded_pool_indexer::zero_hashes::zero_hashes;
use said_shielded_pool_pool_types_alias::{Commitment, FIELD_BYTES, TREE_DEPTH};

mod said_shielded_pool_pool_types_alias {
    // re-export so the test file doesn't need to declare a separate
    // dev-dependency on `said-shielded-pool-types` — it's already a
    // transitive dep via the indexer crate's public API.
    pub use said_shielded_pool_types::{Commitment, FIELD_BYTES, TREE_DEPTH};
}

fn make_commitment(seed: u8) -> Commitment {
    let mut c = [0u8; FIELD_BYTES];
    c[FIELD_BYTES - 1] = seed;
    Commitment(c)
}

/// Naive root computation: build the full layer at the leaf level (with
/// zero-padding to 2^TREE_DEPTH conceptual leaves, but only materialize
/// what's needed) and hash up.
fn naive_root(leaves: &[Commitment]) -> [u8; FIELD_BYTES] {
    let zh = zero_hashes();
    let mut layer: Vec<[u8; FIELD_BYTES]> = leaves.iter().map(|c| c.0).collect();
    for d in 0..TREE_DEPTH {
        let parent_count = (layer.len() + 1) / 2;
        let mut next = Vec::with_capacity(parent_count);
        for i in 0..parent_count {
            let l = layer[2 * i];
            let r = if 2 * i + 1 < layer.len() {
                layer[2 * i + 1]
            } else {
                zh[d]
            };
            next.push(poseidon2_be(&l, &r).unwrap());
        }
        // If we've collapsed entirely (no leaves remaining at this depth),
        // the root is zh[TREE_DEPTH].
        if next.is_empty() {
            return zh[TREE_DEPTH];
        }
        layer = next;
    }
    layer[0]
}

fn verify_path(
    leaf: &Commitment,
    leaf_index: u64,
    siblings: &[[u8; FIELD_BYTES]],
    path_bits: &[bool],
    expected_root: &[u8; FIELD_BYTES],
) -> bool {
    let mut current = leaf.0;
    let mut idx = leaf_index;
    for d in 0..TREE_DEPTH {
        let bit = path_bits[d];
        // Sanity: bit must match low bit of idx.
        assert_eq!(bit, (idx & 1) == 1);
        let (l, r) = if bit {
            (siblings[d], current)
        } else {
            (current, siblings[d])
        };
        current = poseidon2_be(&l, &r).unwrap();
        idx >>= 1;
    }
    &current == expected_root
}

fn open_temp_tree() -> (tempfile::TempDir, IncrementalMerkleTree) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = sled::open(dir.path()).expect("sled open");
    let tree = IncrementalMerkleTree::open(db).expect("tree open");
    (dir, tree)
}

#[test]
fn empty_tree_root_matches_zero_hash() {
    let (_dir, tree) = open_temp_tree();
    let zh = zero_hashes();
    assert_eq!(tree.root().0, zh[TREE_DEPTH]);
    assert_eq!(tree.next_index(), 0);
}

#[test]
fn insert_single_leaf_updates_root_and_index() {
    let (_dir, mut tree) = open_temp_tree();
    let c = make_commitment(1);
    let idx = tree.insert(c).unwrap();
    assert_eq!(idx, 0);
    assert_eq!(tree.next_index(), 1);
    let expected = naive_root(&[c]);
    assert_eq!(tree.root().0, expected);
}

#[test]
fn insert_multiple_leaves_matches_naive_root() {
    let (_dir, mut tree) = open_temp_tree();
    let n = 7u8;
    let mut commitments = Vec::new();
    for i in 0..n {
        let c = make_commitment(i + 1);
        tree.insert(c).unwrap();
        commitments.push(c);
    }
    let expected = naive_root(&commitments);
    assert_eq!(tree.root().0, expected, "root mismatch after {n} inserts");
}

#[test]
fn path_verifies_against_root_for_each_leaf() {
    let (_dir, mut tree) = open_temp_tree();
    let n = 5u8;
    let mut commitments = Vec::new();
    for i in 0..n {
        let c = make_commitment(i + 1);
        tree.insert(c).unwrap();
        commitments.push(c);
    }
    let root = tree.root().0;
    for (i, c) in commitments.iter().enumerate() {
        let path = tree.path(i as u64).expect("path");
        // Convert Vec<[u8;32]> via expected lengths.
        assert_eq!(path.siblings.len(), TREE_DEPTH);
        assert_eq!(path.path_bits.len(), TREE_DEPTH);
        let sib_arr: Vec<[u8; FIELD_BYTES]> = path.siblings.iter().copied().collect();
        assert!(
            verify_path(c, i as u64, &sib_arr, &path.path_bits, &root),
            "path verification failed for leaf {i}"
        );
    }
}

#[test]
fn duplicate_insert_is_idempotent() {
    let (_dir, mut tree) = open_temp_tree();
    let c = make_commitment(42);
    let idx1 = tree.insert(c).unwrap();
    let idx2 = tree.insert(c).unwrap();
    assert_eq!(idx1, idx2);
    assert_eq!(tree.next_index(), 1);
}

#[test]
fn leaf_index_of_returns_correct_index() {
    let (_dir, mut tree) = open_temp_tree();
    let c0 = make_commitment(10);
    let c1 = make_commitment(11);
    let c2 = make_commitment(12);
    tree.insert(c0).unwrap();
    tree.insert(c1).unwrap();
    tree.insert(c2).unwrap();
    assert_eq!(tree.leaf_index_of(&c1).unwrap(), Some(1));
    let missing = make_commitment(99);
    assert_eq!(tree.leaf_index_of(&missing).unwrap(), None);
}

#[test]
fn root_history_accumulates() {
    let (_dir, mut tree) = open_temp_tree();
    for i in 1..=4u8 {
        tree.insert(make_commitment(i)).unwrap();
    }
    let history = tree.root_history().unwrap();
    assert_eq!(history.len(), 4);
    // Last entry in history equals current root.
    assert_eq!(history.last().unwrap(), &tree.root().0);
}
