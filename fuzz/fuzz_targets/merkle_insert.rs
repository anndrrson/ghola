//! Fuzz target: incremental Poseidon Merkle tree (depth = TREE_DEPTH).
//!
//! Treats the fuzz input as a sequence of 32-byte leaves and inserts
//! them into TWO identically-configured trees. Asserts at the end
//! that both trees agree on the final root and `next_index` — this
//! is the determinism property the on-chain `update_root_via_proof`
//! flow relies on (the forester computes a root off-chain, the chain
//! re-derives it, and they must match bit-for-bit).
//!
//! Bounded at 256 leaves per fuzz input — depth-26 Poseidon insertion
//! is fast (~few µs per leaf in release), so 256 leaves keeps each
//! fuzz iteration well under libFuzzer's per-input budget.
//!
//! Coverage focus:
//!   - Pathological leaf bytes (all-zeros, all-FFs, near-modulus).
//!   - Mixed unique + duplicate leaves (exercises idempotency path).
//!   - Empty input (must produce the depth-TREE_DEPTH zero-hash root).

#![no_main]

use libfuzzer_sys::fuzz_target;
use said_shielded_pool_indexer::tree::IncrementalMerkleTree;
use said_shielded_pool_types::{Commitment, FIELD_BYTES};

const MAX_LEAVES: usize = 256;

fn open_temp_tree() -> IncrementalMerkleTree {
    // We use an in-memory sled DB so the fuzzer doesn't touch the
    // filesystem (libFuzzer runs ~millions of inputs; a tmpdir per
    // input would exhaust inodes fast).
    let cfg = sled::Config::new().temporary(true);
    let db = cfg.open().expect("sled mem open");
    IncrementalMerkleTree::open(db).expect("tree open")
}

fuzz_target!(|data: &[u8]| {
    // Chunk into 32-byte leaves; ignore any partial trailing chunk.
    let chunks: Vec<[u8; FIELD_BYTES]> = data
        .chunks_exact(FIELD_BYTES)
        .take(MAX_LEAVES)
        .map(|c| {
            let mut out = [0u8; FIELD_BYTES];
            out.copy_from_slice(c);
            out
        })
        .collect();

    let mut tree_a = open_temp_tree();
    let mut tree_b = open_temp_tree();

    for raw in &chunks {
        let c = Commitment(*raw);
        // Both trees should accept-or-no-op identically. If one errors
        // (e.g. TreeFull) so should the other.
        let ra = tree_a.insert(c);
        let rb = tree_b.insert(c);
        match (ra, rb) {
            (Ok(ia), Ok(ib)) => assert_eq!(
                ia, ib,
                "insert returned different indices for the same commitment"
            ),
            (Err(_), Err(_)) => return,
            (a, b) => panic!(
                "tree determinism violated: tree_a={:?} tree_b={:?}",
                a.map(|i| i.to_string()).unwrap_or_else(|e| e.to_string()),
                b.map(|i| i.to_string()).unwrap_or_else(|e| e.to_string()),
            ),
        }
    }

    // Final state must agree.
    assert_eq!(
        tree_a.root().0,
        tree_b.root().0,
        "root determinism violated"
    );
    assert_eq!(tree_a.next_index(), tree_b.next_index());
});
