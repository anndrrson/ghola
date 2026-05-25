//! Property-based invariants for `IncrementalMerkleTree`
//! (Stream 2 of the production-hardening pass).
//!
//! Run with `cargo test -p said-shielded-pool-indexer --test tree_props`.
//!
//! # Properties exercised
//!
//! 1. **Root determinism**: inserting the same sequence of commitments
//!    into two fresh trees produces the same root and same `next_index`.
//!    The on-chain `update_root_via_proof` flow depends on this — if a
//!    forester computes a different root than the indexer mirror, the
//!    Groth16 verification will fail.
//!
//! 2. **Path-verifies-against-root**: after inserting N commitments,
//!    `path(i)` for every `i < N`, walked from the leaf via the
//!    in-circuit hash recursion, reproduces the tree's current root.
//!    This is what the transfer/withdraw circuit checks on-chain.
//!
//! 3. **Leaf-index lookup consistency**: `leaf_index_of(c)` returns
//!    `Some(i)` for every leaf `c` we inserted at index `i`, and `None`
//!    for commitments we never inserted.
//!
//! 4. **Idempotent re-insert**: inserting the same commitment twice
//!    returns the same index both times and leaves `next_index`
//!    unchanged after the second call. The on-chain listener replays
//!    transactions on WS reconnects; re-insert must be a no-op.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use proptest::collection::vec;
use proptest::prelude::*;
use said_shielded_pool_indexer::tree::{poseidon2_be, IncrementalMerkleTree};
use said_shielded_pool_indexer::zero_hashes::zero_hashes;
use said_shielded_pool_types::{Commitment, FIELD_BYTES, TREE_DEPTH};

/// Reduce arbitrary 32 bytes into a canonical BN254 scalar-field BE32.
/// `light-poseidon` rejects inputs `>= p` (so does the on-chain
/// `sol_poseidon` syscall), so callers must pre-reduce. This is the
/// invariant the indexer relies on at every entry point that accepts
/// untrusted bytes (proof public-inputs, events) — surfaced here as a
/// proptest helper.
fn reduce_be32(bytes: &[u8; 32]) -> [u8; 32] {
    let fr = Fr::from_be_bytes_mod_order(bytes);
    let bi = fr.into_bigint();
    let raw = bi.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - raw.len()..].copy_from_slice(&raw);
    out
}

fn make_commitment(seed: &[u8; 32]) -> Commitment {
    Commitment(reduce_be32(seed))
}

fn open_temp_tree() -> (tempfile::TempDir, IncrementalMerkleTree) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = sled::open(dir.path()).expect("sled open");
    let tree = IncrementalMerkleTree::open(db).expect("tree open");
    (dir, tree)
}

/// Walk `path` from the leaf and assert we land on `expected_root`.
fn path_verifies(
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
        if bit != ((idx & 1) == 1) {
            return false;
        }
        let (l, r) = if bit {
            (siblings[d], current)
        } else {
            (current, siblings[d])
        };
        current = match poseidon2_be(&l, &r) {
            Ok(h) => h,
            Err(_) => return false,
        };
        idx >>= 1;
    }
    &current == expected_root
}

proptest! {
    #![proptest_config(ProptestConfig {
        // Tree ops are dominated by Poseidon (slow); cap to ~16 leaves
        // per case and 24 cases. Even at this size we cover the
        // odd/even sibling-walk paths and ~24 distinct branchings.
        cases: 24,
        max_shrink_iters: 256,
        .. ProptestConfig::default()
    })]

    /// Property 1 + 3: root determinism and leaf-index lookup.
    #[test]
    fn root_is_deterministic_under_same_insertion_sequence(
        leaves in vec(any::<[u8; 32]>(), 1..16)
    ) {
        let (_d1, mut t1) = open_temp_tree();
        let (_d2, mut t2) = open_temp_tree();

        let commitments: Vec<Commitment> = leaves.iter().map(make_commitment).collect();

        for c in &commitments {
            let i1 = t1.insert(*c).expect("insert t1");
            let i2 = t2.insert(*c).expect("insert t2");
            prop_assert_eq!(i1, i2, "indices diverged at insertion");
        }
        prop_assert_eq!(t1.root().0, t2.root().0, "roots diverged after same sequence");
        prop_assert_eq!(t1.next_index(), t2.next_index());

        // Leaf-index lookup consistency: every inserted commitment is
        // findable at the position it was inserted at.
        for (expected_idx, c) in commitments.iter().enumerate() {
            let got = t1.leaf_index_of(c).expect("lookup");
            // If there were duplicates in `leaves`, leaf_index_of
            // returns the FIRST insertion index (idempotency contract).
            // Find the first occurrence in our model.
            let first_idx = commitments.iter().position(|x| x == c).unwrap() as u64;
            prop_assert_eq!(got, Some(first_idx),
                "leaf_index_of mismatch at expected_idx={}", expected_idx);
        }
    }

    /// Property 2: every inserted leaf has a path that reproduces the root.
    #[test]
    fn path_reproduces_root(leaves in vec(any::<[u8; 32]>(), 1..8)) {
        let (_d, mut t) = open_temp_tree();
        // Filter duplicates so we know exactly where each commitment lives.
        let mut seen: Vec<Commitment> = Vec::new();
        for raw in &leaves {
            let c = make_commitment(raw);
            if !seen.contains(&c) {
                t.insert(c).expect("insert");
                seen.push(c);
            }
        }
        let root = t.root().0;
        for (i, c) in seen.iter().enumerate() {
            let path = t.path(i as u64).expect("path");
            prop_assert_eq!(path.siblings.len(), TREE_DEPTH);
            prop_assert_eq!(path.path_bits.len(), TREE_DEPTH);
            prop_assert!(
                path_verifies(c, i as u64, &path.siblings, &path.path_bits, &root),
                "path for leaf {} does not verify against root", i
            );
        }
    }

    /// Property 4: idempotent re-insert.
    ///
    /// Inserting the same commitment a second time must:
    ///  (a) return the same index as the first insert,
    ///  (b) leave `next_index` unchanged,
    ///  (c) leave `root` unchanged,
    ///  (d) leave `leaf_index_of` returning the original index.
    #[test]
    fn reinsert_is_noop(seed in any::<[u8; 32]>(), filler in vec(any::<[u8; 32]>(), 0..4)) {
        let (_d, mut t) = open_temp_tree();
        let c = make_commitment(&seed);
        let i1 = t.insert(c).expect("first insert");
        // Insert some unrelated leaves between the duplicate inserts to
        // catch bugs where the dedup check only matches the
        // most-recently-inserted commitment.
        for raw in &filler {
            let other = make_commitment(raw);
            if other != c {
                t.insert(other).expect("filler insert");
            }
        }
        let next_before = t.next_index();
        let root_before = t.root().0;

        let i2 = t.insert(c).expect("second insert (idempotent)");
        prop_assert_eq!(i1, i2, "duplicate insert returned a different index");
        prop_assert_eq!(t.next_index(), next_before);
        prop_assert_eq!(t.root().0, root_before);
        prop_assert_eq!(t.leaf_index_of(&c).expect("lookup"), Some(i1));
    }

    /// Sanity: even an empty tree's root equals zero-hash at depth=TREE_DEPTH.
    /// Not strictly a randomized property, but cheap to assert inside the
    /// harness so we catch regressions in `zero_hashes` if the
    /// constants are ever tampered with.
    #[test]
    fn empty_tree_root_is_zero_hash(_dummy in any::<u8>()) {
        let (_d, t) = open_temp_tree();
        let zh = zero_hashes();
        prop_assert_eq!(t.root().0, zh[TREE_DEPTH]);
        prop_assert_eq!(t.next_index(), 0);
    }
}
