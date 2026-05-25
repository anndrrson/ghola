//! Depth-[`TREE_DEPTH`] incremental Merkle tree with Poseidon-BN254 hashing.
//!
//! # Storage layout (sled)
//!
//! All entries live in the `merkle` tree of the sled database:
//!
//! | key                              | value           |
//! |----------------------------------|-----------------|
//! | `b"meta/next_index"`             | u64 BE          |
//! | `b"meta/root"`                   | 32-byte root    |
//! | `leaf/<idx u64 BE>`              | 32-byte leaf    |
//! | `commit/<32-byte commitment>`    | u64 BE leaf idx |
//! | `filled/<depth u8>`              | 32-byte node    |
//! | `node/<depth u8><idx u64 BE>`    | 32-byte node    |
//! | `root_hist/<seq u64 BE>`         | 32-byte root    |
//! | `meta/root_hist_seq`             | u64 BE          |
//!
//! `filled[depth]` is the canonical "filled-subtrees" array used by
//! incremental Merkle tree implementations (e.g. Tornado / Zcash Sapling /
//! Light Protocol). For each depth `d`, it stores the most recent **left**
//! sibling at that depth — the hash that will be paired with the next leaf
//! when the right slot fills.
//!
//! `node/<depth><idx>` is a sparse cache of every internal node hash touched
//! while inserting a leaf (depth 0 = the leaf level; depth `TREE_DEPTH` = the
//! root). It lets [`IncrementalMerkleTree::path`] read each authentication-path
//! sibling in a single point lookup — O(`TREE_DEPTH`) reads — instead of
//! re-hashing the entire tree from all leaves on every witness query (which was
//! O(2^`TREE_DEPTH`) and a trivial unauthenticated DoS). A node absent from the
//! cache is, by construction, an all-zero right subtree and equals `Z[depth]`:
//! every node on the rightmost frontier is (re)written on each insert, and any
//! node fully to the left of the frontier is finalized (a completed left
//! subtree never changes), so the latest persisted value is always current.
//!
//! # Concurrency
//!
//! All mutating operations take `&mut self` and run under a `sled`
//! transactional batch, so the on-disk view is always consistent. The tree
//! is wrapped in a `tokio::sync::RwLock` at the service layer
//! (`AppState`), so writers (the event listener / forester) and readers
//! (the witness HTTP handler) don't race.

use said_shielded_pool_types::{
    Commitment, FieldBytes, MerklePath, MerkleRoot, FIELD_BYTES, ROOT_HISTORY_SIZE, TREE_DEPTH,
};

use light_poseidon::{Poseidon, PoseidonBytesHasher};
use ark_bn254::Fr;

use crate::error::{Error, Result};
use crate::zero_hashes::zero_hashes;

/// Tree depth capacity = `2^TREE_DEPTH` leaves.
pub fn tree_capacity() -> u64 {
    1u64 << TREE_DEPTH
}

/// Poseidon(BN254, x^5, arity 2) over two big-endian 32-byte field elements.
///
/// Returns the digest as big-endian bytes — matching the on-chain
/// `sol_poseidon` syscall's byte order and the Circom circuit's
/// `Poseidon(2)` template.
pub fn poseidon2_be(left: &FieldBytes, right: &FieldBytes) -> Result<FieldBytes> {
    let mut hasher = Poseidon::<Fr>::new_circom(2)
        .map_err(|e| Error::Poseidon(format!("init: {e:?}")))?;
    let bytes = hasher
        .hash_bytes_be(&[left.as_slice(), right.as_slice()])
        .map_err(|e| Error::Poseidon(format!("hash: {e:?}")))?;
    if bytes.len() != FIELD_BYTES {
        return Err(Error::Poseidon(format!(
            "unexpected digest length {} (want {FIELD_BYTES})",
            bytes.len()
        )));
    }
    let mut out = [0u8; FIELD_BYTES];
    out.copy_from_slice(&bytes);
    Ok(out)
}

const MERKLE_TREE_NAME: &str = "merkle";

const KEY_NEXT_INDEX: &[u8] = b"meta/next_index";
const KEY_ROOT: &[u8] = b"meta/root";
const KEY_ROOT_HIST_SEQ: &[u8] = b"meta/root_hist_seq";

fn leaf_key(idx: u64) -> Vec<u8> {
    let mut k = b"leaf/".to_vec();
    k.extend_from_slice(&idx.to_be_bytes());
    k
}

fn commit_key(c: &FieldBytes) -> Vec<u8> {
    let mut k = b"commit/".to_vec();
    k.extend_from_slice(c);
    k
}

fn filled_key(depth: usize) -> Vec<u8> {
    let mut k = b"filled/".to_vec();
    k.push(depth as u8);
    k
}

/// Key for a cached internal node at `(depth, idx)`. `depth == 0` is the leaf
/// level; `idx` is the node's horizontal position within that level.
fn node_key(depth: usize, idx: u64) -> Vec<u8> {
    let mut k = b"node/".to_vec();
    k.push(depth as u8);
    k.extend_from_slice(&idx.to_be_bytes());
    k
}

fn root_hist_key(seq: u64) -> Vec<u8> {
    let mut k = b"root_hist/".to_vec();
    k.extend_from_slice(&seq.to_be_bytes());
    k
}

/// An off-chain incremental Merkle tree mirror, persisted to sled.
pub struct IncrementalMerkleTree {
    db: sled::Db,
    tree: sled::Tree,

    // In-memory cache of the canonical state (matches sled).
    next_index: u64,
    root: FieldBytes,
    /// `filled_subtrees[d]` = the last left-sibling hash seen at depth d.
    filled_subtrees: [FieldBytes; TREE_DEPTH],
    root_hist_seq: u64,
}

impl IncrementalMerkleTree {
    /// Open or create the tree at `db`. If the database has no prior state,
    /// initialize it with `next_index = 0`, `root = Z[TREE_DEPTH]`,
    /// `filled_subtrees[d] = Z[d]`.
    pub fn open(db: sled::Db) -> Result<Self> {
        let tree = db.open_tree(MERKLE_TREE_NAME)?;
        let zh = zero_hashes();

        let next_index = match tree.get(KEY_NEXT_INDEX)? {
            Some(v) => u64::from_be_bytes(v.as_ref().try_into().map_err(|_| {
                Error::Storage(format!("next_index has invalid length: {}", v.len()))
            })?),
            None => 0,
        };

        let root = match tree.get(KEY_ROOT)? {
            Some(v) => fb_from_ivec(&v)?,
            None => zh[TREE_DEPTH],
        };

        let mut filled_subtrees = [[0u8; FIELD_BYTES]; TREE_DEPTH];
        for d in 0..TREE_DEPTH {
            filled_subtrees[d] = match tree.get(filled_key(d))? {
                Some(v) => fb_from_ivec(&v)?,
                None => zh[d],
            };
        }

        let root_hist_seq = match tree.get(KEY_ROOT_HIST_SEQ)? {
            Some(v) => u64::from_be_bytes(v.as_ref().try_into().map_err(|_| {
                Error::Storage(format!("root_hist_seq has invalid length: {}", v.len()))
            })?),
            None => 0,
        };

        let me = Self {
            db,
            tree,
            next_index,
            root,
            filled_subtrees,
            root_hist_seq,
        };

        // Persist initial state if this is a fresh db, so subsequent
        // `open` calls see a populated root entry.
        if me.next_index == 0 && me.tree.get(KEY_ROOT)?.is_none() {
            me.tree.insert(KEY_ROOT, fb_to_ivec(&me.root))?;
            me.tree.insert(KEY_NEXT_INDEX, &0u64.to_be_bytes())?;
            for d in 0..TREE_DEPTH {
                me.tree.insert(filled_key(d), fb_to_ivec(&me.filled_subtrees[d]))?;
            }
            me.tree.flush()?;
        }

        Ok(me)
    }

    /// Number of leaves inserted so far.
    pub fn next_index(&self) -> u64 {
        self.next_index
    }

    /// Current Merkle root.
    pub fn root(&self) -> MerkleRoot {
        MerkleRoot(self.root)
    }

    /// Tree depth (constant).
    pub fn depth(&self) -> usize {
        TREE_DEPTH
    }

    /// Insert a commitment leaf at the next available index.
    ///
    /// Returns the index at which the leaf was inserted.
    pub fn insert(&mut self, commitment: Commitment) -> Result<u64> {
        if self.next_index >= tree_capacity() {
            return Err(Error::TreeFull(self.next_index));
        }
        // Idempotency: if we've already inserted this exact commitment, the
        // event listener is replaying a tx we already processed (very common
        // on WS reconnects). Treat it as a no-op and return the existing idx.
        if let Some(v) = self.tree.get(commit_key(&commitment.0))? {
            let idx = u64::from_be_bytes(
                v.as_ref()
                    .try_into()
                    .map_err(|_| Error::Storage("commit→idx length".into()))?,
            );
            return Ok(idx);
        }

        let idx = self.next_index;
        let mut current = commitment.0;
        let mut current_idx = idx;
        let zh = zero_hashes();

        // Persist the node hash at every level on this leaf's path-to-root so
        // `path()` can read siblings directly (O(TREE_DEPTH)) instead of
        // rebuilding the whole tree from all leaves on every query. The leaf
        // itself is node (depth 0, idx); each parent is node (d+1, idx>>(d+1)).
        let mut batch = sled::Batch::default();
        batch.insert(node_key(0, idx), fb_to_ivec(&current));

        // Walk up the tree computing the new path. At each depth d, the
        // current node is either a left sibling (current_idx even) or a
        // right sibling (odd).
        for d in 0..TREE_DEPTH {
            let (left, right) = if current_idx & 1 == 0 {
                // This is a new left node — remember it as filled[d].
                self.filled_subtrees[d] = current;
                (current, zh[d])
            } else {
                // Right child of an existing left sibling.
                (self.filled_subtrees[d], current)
            };
            current = poseidon2_be(&left, &right)?;
            current_idx >>= 1;
            // `current` is now the node at (depth d+1, position current_idx).
            // Cache it. Re-writing a node already on the frontier is correct:
            // its value is the latest, and a finalized left subtree's node is
            // never revisited (so it keeps its finalized value).
            batch.insert(node_key(d + 1, current_idx), fb_to_ivec(&current));
        }

        self.root = current;
        self.next_index = idx + 1;
        self.push_root_history(current)?;

        // Persist atomically (leaf + commit index + frontier + meta, plus the
        // node-path entries already staged above).
        batch.insert(leaf_key(idx), fb_to_ivec(&commitment.0));
        batch.insert(commit_key(&commitment.0), &idx.to_be_bytes());
        for d in 0..TREE_DEPTH {
            batch.insert(filled_key(d), fb_to_ivec(&self.filled_subtrees[d]));
        }
        batch.insert(KEY_NEXT_INDEX, &self.next_index.to_be_bytes());
        batch.insert(KEY_ROOT, fb_to_ivec(&self.root));
        self.tree.apply_batch(batch)?;
        // We rely on sled's default fsync-on-flush cadence for durability;
        // explicit flush is left to the caller after a batch of inserts to
        // avoid syncing on every leaf during backfill.

        Ok(idx)
    }

    /// Read the cached node hash at `(depth, idx)`, or the zero-subtree hash
    /// `Z[depth]` if no node has been persisted there (an all-zero, never-filled
    /// right subtree). This is the O(1) primitive behind the O(TREE_DEPTH)
    /// [`Self::path`] derivation.
    fn node_or_zero(&self, depth: usize, idx: u64) -> Result<FieldBytes> {
        match self.tree.get(node_key(depth, idx))? {
            Some(v) => fb_from_ivec(&v),
            None => Ok(zero_hashes()[depth]),
        }
    }

    /// Compute a Merkle path (siblings + path bits) for the leaf at `index`.
    ///
    /// The siblings list goes from leaf-level (depth 0) up to the root,
    /// matching the `MerklePath` shape expected by the circuit. `path_bits[d]`
    /// is `true` iff the leaf-side of the pair at depth d is the *right*
    /// child (i.e. bit d of `index` is set).
    ///
    /// Cost: O(`TREE_DEPTH`) point lookups against the `node/<d><idx>` cache —
    /// it does NOT read all leaves or re-hash the tree. (The previous
    /// implementation rebuilt every layer from `leaves_snapshot()` on each
    /// call, which was O(2^`TREE_DEPTH`) work and an unauthenticated DoS.)
    pub fn path(&self, index: u64) -> Result<MerklePath> {
        if index >= self.next_index {
            return Err(Error::LeafIndexOutOfRange(index, self.next_index));
        }
        let mut siblings = Vec::with_capacity(TREE_DEPTH);
        let mut path_bits = Vec::with_capacity(TREE_DEPTH);

        let mut current_idx = index;
        for d in 0..TREE_DEPTH {
            // Sibling of the node at (depth d, current_idx).
            let sibling_idx = current_idx ^ 1;
            siblings.push(self.node_or_zero(d, sibling_idx)?);
            path_bits.push(current_idx & 1 == 1);
            current_idx >>= 1;
        }

        Ok(MerklePath { siblings, path_bits })
    }

    /// Return the leaf index for a commitment, or None.
    pub fn leaf_index_of(&self, commitment: &Commitment) -> Result<Option<u64>> {
        match self.tree.get(commit_key(&commitment.0))? {
            Some(v) => Ok(Some(u64::from_be_bytes(
                v.as_ref()
                    .try_into()
                    .map_err(|_| Error::Storage("commit→idx length".into()))?,
            ))),
            None => Ok(None),
        }
    }

    /// Return all leaves currently in the tree (length = `next_index`).
    pub fn leaves_snapshot(&self) -> Result<Vec<FieldBytes>> {
        let mut out = Vec::with_capacity(self.next_index as usize);
        for i in 0..self.next_index {
            let v = self
                .tree
                .get(leaf_key(i))?
                .ok_or_else(|| Error::Storage(format!("leaf {i} missing")))?;
            out.push(fb_from_ivec(&v)?);
        }
        Ok(out)
    }

    /// Return the last [`ROOT_HISTORY_SIZE`] roots in insertion order
    /// (oldest first, newest last).
    pub fn root_history(&self) -> Result<Vec<FieldBytes>> {
        let start = self.root_hist_seq.saturating_sub(ROOT_HISTORY_SIZE as u64);
        let mut out = Vec::with_capacity(ROOT_HISTORY_SIZE);
        for seq in start..self.root_hist_seq {
            if let Some(v) = self.tree.get(root_hist_key(seq))? {
                out.push(fb_from_ivec(&v)?);
            }
        }
        Ok(out)
    }

    /// Flush all pending writes to disk. Call after a batch of inserts.
    pub fn flush(&self) -> Result<()> {
        self.tree.flush()?;
        Ok(())
    }

    /// Drop the database file — used by recovery procedures and tests.
    /// After calling this the [`IncrementalMerkleTree`] is in an
    /// indeterminate state and should be dropped.
    pub fn wipe(&self) -> Result<()> {
        self.db.drop_tree(MERKLE_TREE_NAME)?;
        Ok(())
    }

    fn push_root_history(&mut self, root: FieldBytes) -> Result<()> {
        let seq = self.root_hist_seq;
        self.tree.insert(root_hist_key(seq), fb_to_ivec(&root))?;
        self.root_hist_seq = seq + 1;
        self.tree
            .insert(KEY_ROOT_HIST_SEQ, &self.root_hist_seq.to_be_bytes())?;
        // GC: prune entries older than ROOT_HISTORY_SIZE behind the head.
        if self.root_hist_seq > ROOT_HISTORY_SIZE as u64 {
            let prune_seq = self.root_hist_seq - ROOT_HISTORY_SIZE as u64 - 1;
            let _ = self.tree.remove(root_hist_key(prune_seq))?;
        }
        Ok(())
    }
}

fn fb_to_ivec(fb: &FieldBytes) -> sled::IVec {
    sled::IVec::from(fb.to_vec())
}

fn fb_from_ivec(v: &sled::IVec) -> Result<FieldBytes> {
    if v.len() != FIELD_BYTES {
        return Err(Error::Storage(format!(
            "field elt has wrong length: {} (want {FIELD_BYTES})",
            v.len()
        )));
    }
    let mut out = [0u8; FIELD_BYTES];
    out.copy_from_slice(v);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use said_shielded_pool_types::Commitment;

    fn open_temp() -> (tempfile::TempDir, IncrementalMerkleTree) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = sled::open(dir.path()).expect("sled open");
        let tree = IncrementalMerkleTree::open(db).expect("tree open");
        (dir, tree)
    }

    fn commitment(seed: u8) -> Commitment {
        let mut c = [0u8; FIELD_BYTES];
        c[FIELD_BYTES - 1] = seed;
        Commitment(c)
    }

    /// Recompute the root from a leaf + its returned authentication path and
    /// assert it matches the tree's current root.
    fn root_from_path(leaf: &Commitment, index: u64, path: &MerklePath) -> FieldBytes {
        let mut current = leaf.0;
        let mut idx = index;
        for d in 0..TREE_DEPTH {
            let (l, r) = if idx & 1 == 1 {
                (path.siblings[d], current)
            } else {
                (current, path.siblings[d])
            };
            current = poseidon2_be(&l, &r).unwrap();
            idx >>= 1;
        }
        current
    }

    /// Correctness: each leaf's `path()` reproduces the live root.
    #[test]
    fn path_reproduces_root() {
        let (_dir, mut tree) = open_temp();
        let mut leaves = Vec::new();
        for i in 1..=9u8 {
            let c = commitment(i);
            tree.insert(c).unwrap();
            leaves.push(c);
        }
        let root = tree.root().0;
        for (i, c) in leaves.iter().enumerate() {
            let path = tree.path(i as u64).unwrap();
            assert_eq!(path.siblings.len(), TREE_DEPTH);
            assert_eq!(
                root_from_path(c, i as u64, &path),
                root,
                "leaf {i} path did not reproduce the root"
            );
        }
    }

    /// DoS regression: `path()` must derive siblings from the `node/` cache
    /// (O(TREE_DEPTH) point lookups), NOT by re-reading every leaf. We prove
    /// this by deleting ALL `leaf/<idx>` entries from the backing store after
    /// insertion: the old implementation called `leaves_snapshot()` and would
    /// error ("leaf N missing") or return a wrong path; the cache-based
    /// implementation is unaffected and still reproduces the root.
    #[test]
    fn path_does_not_read_leaves() {
        let (_dir, mut tree) = open_temp();
        let mut leaves = Vec::new();
        for i in 1..=9u8 {
            let c = commitment(i);
            tree.insert(c).unwrap();
            leaves.push(c);
        }
        let root = tree.root().0;

        // Nuke every leaf entry from the backing sled tree. `path()` must not
        // touch these — only `node/<d><idx>` entries.
        for i in 0..leaves.len() as u64 {
            tree.tree.remove(leaf_key(i)).unwrap();
        }
        // Sanity: leaves really are gone (the old leaves_snapshot path would
        // now fail).
        assert!(tree.leaves_snapshot().is_err(), "leaves should be deleted");

        for (i, c) in leaves.iter().enumerate() {
            let path = tree
                .path(i as u64)
                .expect("path must succeed without leaf entries");
            assert_eq!(
                root_from_path(c, i as u64, &path),
                root,
                "leaf {i} path (cache-only) did not reproduce the root"
            );
        }
    }

    /// A never-filled sibling resolves to the zero-subtree hash, not a stale or
    /// missing value — exercised by inserting a single leaf (its entire right
    /// side is zero subtrees).
    #[test]
    fn single_leaf_path_uses_zero_hashes() {
        let (_dir, mut tree) = open_temp();
        let c = commitment(7);
        tree.insert(c).unwrap();
        let path = tree.path(0).unwrap();
        let zh = zero_hashes();
        for d in 0..TREE_DEPTH {
            assert_eq!(path.siblings[d], zh[d], "sibling at depth {d} must be Z[d]");
            assert!(!path.path_bits[d], "leaf 0 is always a left child");
        }
        assert_eq!(root_from_path(&c, 0, &path), tree.root().0);
    }
}
