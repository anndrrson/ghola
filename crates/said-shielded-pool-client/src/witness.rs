//! Build a [`TransferWitness`] for the prover.
//!
//! A witness is the off-chain payload the circuit needs to produce a
//! Groth16 proof. It contains:
//!
//! - Input notes (the UTXOs being spent) along with each note's Merkle
//!   path and leaf index inside its tree.
//! - Output notes (the UTXOs being created).
//! - The spending key (so the circuit can re-derive nullifiers).
//! - `public_amount` — net deposit/withdraw with the host chain
//!   (positive = deposit, negative = withdraw, zero = pure shielded transfer).
//! - `asset_id` — single-asset invariant across all input/output notes.
//! - `ext_data_hash` — binds the proof to off-circuit "external data"
//!   (recipient address, fees, memo). See [`crate::tx_builder::compute_ext_data_hash`].
//!
//! Witnesses **MUST NEVER** cross the chain boundary or hit storage;
//! they contain the spending key. [`WitnessBuilder`] does not implement
//! `Debug` or `Serialize` traits that print the full struct unwarded.
//! When sending to the prover service, use a TLS connection and treat
//! the prover as trusted-for-confidentiality (Phase 42 will host it
//! inside a TEE).

use said_shielded_pool_types::{
    AssetId, FieldBytes, MerklePath, MerkleRoot, Note, TransferWitness, TREE_DEPTH,
};

use crate::error::{Error, Result};
use crate::note::commitment;
use crate::poseidon::poseidon2;

/// Builder for [`TransferWitness`].
///
/// Fields are accumulated via setters; [`Self::try_build`] enforces:
///
/// - Inputs and outputs are non-empty (deposit-only uses zero inputs;
///   withdraw-only uses zero outputs; check call site for which is
///   semantically valid).
/// - `input_notes.len() == input_paths.len() == input_indices.len()`.
/// - Every input/output note shares the same `asset_id`.
/// - Every `MerklePath.siblings` has length `TREE_DEPTH`.
/// - Every real (non-dummy) input note's Merkle path recomputes to a root
///   present in [`Self::expected_roots`] — the **H2 anti-tagging guard**
///   (see that method's docs). Builds with real inputs but no expected
///   roots fail with [`Error::MissingExpectedRoots`].
/// - `public_amount` accounts for the value delta:
///   `sum(outputs) − sum(inputs) == −public_amount`
///   (positive `public_amount` → tokens flow OUT of the pool, i.e. withdraw;
///   negative `public_amount` → tokens flow INTO the pool, i.e. deposit).
///   See SPEC.md §3.2.
#[derive(Default, Clone)]
pub struct WitnessBuilder {
    input_notes: Vec<Note>,
    input_paths: Vec<MerklePath>,
    input_indices: Vec<u64>,
    output_notes: Vec<Note>,
    spending_key: Option<FieldBytes>,
    public_amount: Option<i128>,
    asset_id: Option<AssetId>,
    ext_data_hash: Option<FieldBytes>,
    expected_roots: Vec<MerkleRoot>,
}

impl WitnessBuilder {
    /// Construct an empty builder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Push a single input note with its Merkle path + leaf index.
    pub fn add_input(mut self, note: Note, path: MerklePath, index: u64) -> Self {
        self.input_notes.push(note);
        self.input_paths.push(path);
        self.input_indices.push(index);
        self
    }

    /// Push a single output note.
    pub fn add_output(mut self, note: Note) -> Self {
        self.output_notes.push(note);
        self
    }

    /// Set the spending key (32 bytes).
    pub fn spending_key(mut self, sk: FieldBytes) -> Self {
        self.spending_key = Some(sk);
        self
    }

    /// Set the public amount delta.
    ///
    /// Sign convention: positive = withdraw (value leaves the pool),
    /// negative = deposit (value enters the pool). See module docs.
    pub fn public_amount(mut self, amt: i128) -> Self {
        self.public_amount = Some(amt);
        self
    }

    /// Set the asset ID. Must match every input/output note.
    pub fn asset_id(mut self, asset_id: AssetId) -> Self {
        self.asset_id = Some(asset_id);
        self
    }

    /// Set the ext_data_hash binding the proof to the external data
    /// (recipient, fees, memo). Compute with
    /// [`crate::tx_builder::compute_ext_data_hash`].
    pub fn ext_data_hash(mut self, hash: FieldBytes) -> Self {
        self.ext_data_hash = Some(hash);
        self
    }

    /// Pin the set of Merkle roots this witness is allowed to prove against
    /// (the **H2 anti-tagging guard**).
    ///
    /// During [`Self::try_build`] the builder recomputes the Merkle root for
    /// every *real* (non-dummy) input note from its leaf commitment and the
    /// `MerklePath` (siblings + path_bits) supplied with it, then checks the
    /// recomputed root against this set. If a recomputed root is not present,
    /// [`Self::try_build`] returns [`Error::RootMismatch`].
    ///
    /// # Why this exists
    ///
    /// Without this check the client proves membership against whatever root
    /// the path implies — and that path is supplied by the indexer. A
    /// malicious indexer can hand each user a *structurally valid but unique*
    /// root; when the resulting withdrawal lands on-chain, the operator links
    /// the spend back to the exact requester (a deanonymizing "tagging"
    /// attack). Recomputing locally and pinning to an independently-sourced
    /// root closes that channel.
    ///
    /// # TRUST REQUIREMENT (read this)
    ///
    /// `roots` **MUST** come from a trust domain *independent of the indexer
    /// that served the Merkle path*. Acceptable sources:
    ///
    /// - an on-chain RPC read of the program's `MerkleTree.root` /
    ///   `MerkleTree.root_history` account, or
    /// - a second, independently-operated indexer's `/root-history`.
    ///
    /// Passing back the same indexer's advertised root here provides **no**
    /// protection — the attacker controls both sides. The whole point is
    /// cross-checking against a source the path-server cannot forge.
    ///
    /// Supply the full recent `root_history` window (not just the head) so
    /// that paths built against a slightly older—but still on-chain-valid—root
    /// are not spuriously rejected during normal tree churn.
    pub fn expected_roots(mut self, roots: Vec<MerkleRoot>) -> Self {
        self.expected_roots = roots;
        self
    }

    /// Validate + assemble.
    pub fn try_build(self) -> Result<TransferWitness> {
        let spending_key = self
            .spending_key
            .ok_or(Error::Internal("spending_key unset".into()))?;
        let public_amount = self
            .public_amount
            .ok_or(Error::Internal("public_amount unset".into()))?;
        let asset_id = self
            .asset_id
            .ok_or(Error::Internal("asset_id unset".into()))?;
        let ext_data_hash = self
            .ext_data_hash
            .ok_or(Error::Internal("ext_data_hash unset".into()))?;

        if self.input_notes.len() != self.input_paths.len()
            || self.input_notes.len() != self.input_indices.len()
        {
            return Err(Error::Internal(
                "input_notes / input_paths / input_indices length mismatch".into(),
            ));
        }

        // Single-asset invariant.
        for n in self.input_notes.iter().chain(self.output_notes.iter()) {
            if n.asset_id != asset_id {
                return Err(Error::AssetMismatch);
            }
        }

        // Merkle path well-formedness.
        for path in &self.input_paths {
            if path.siblings.len() != TREE_DEPTH || path.path_bits.len() != TREE_DEPTH {
                return Err(Error::Internal(format!(
                    "merkle path length != TREE_DEPTH={TREE_DEPTH}"
                )));
            }
        }

        // H2 anti-tagging guard: recompute the Merkle root from each REAL
        // input note's leaf commitment + path and confirm it is one of the
        // caller-pinned `expected_roots` (which must be sourced from a trust
        // domain independent of the indexer that served the path). Pure
        // deposit dummies (all-zero sibling paths) carry no membership claim
        // and are skipped; the circuit does not enforce membership for them.
        let has_real_input = self.input_paths.iter().any(|p| !is_dummy_path(p));
        if has_real_input && self.expected_roots.is_empty() {
            return Err(Error::MissingExpectedRoots);
        }
        for (i, path) in self.input_paths.iter().enumerate() {
            if is_dummy_path(path) {
                continue;
            }
            let leaf = commitment(&self.input_notes[i]);
            let recomputed = recompute_root(leaf.0, path);
            if !self.expected_roots.iter().any(|r| r.0 == recomputed) {
                return Err(Error::RootMismatch { input_index: i });
            }
        }

        // Value-conservation cross-check (debug only — circuit enforces).
        debug_assert_eq!(
            self.output_notes
                .iter()
                .map(|n| n.amount as i128)
                .sum::<i128>()
                - self
                    .input_notes
                    .iter()
                    .map(|n| n.amount as i128)
                    .sum::<i128>(),
            -public_amount,
            "value not conserved: sum(out) - sum(in) != -public_amount"
        );

        Ok(TransferWitness {
            input_notes: self.input_notes,
            input_paths: self.input_paths,
            input_indices: self.input_indices,
            output_notes: self.output_notes,
            spending_key,
            public_amount,
            asset_id,
            ext_data_hash,
        })
    }
}

/// A "dummy" input path is the all-zero-sibling placeholder used for pure
/// deposits (no real UTXO is spent). Such a path asserts no Merkle membership
/// — the circuit skips the membership check — so it is exempt from the H2
/// root-pinning guard. See `tx_builder::dummy_deposit_bundle` and the
/// `dummy_path()` test helper.
fn is_dummy_path(path: &MerklePath) -> bool {
    path.siblings.iter().all(|s| *s == [0u8; 32])
}

/// Recompute the Merkle root from a leaf and its authentication path.
///
/// Walks leaf → root reusing the crate's canonical Circom-compatible
/// width-2 Poseidon ([`crate::poseidon::poseidon2`]) — the SAME hash the
/// indexer/circuit use. `path_bits[d] == true` means the leaf-side node is
/// the RIGHT child at depth `d` (so the sibling is the left input),
/// matching `IncrementalMerkleTree::path` in the indexer.
fn recompute_root(leaf: FieldBytes, path: &MerklePath) -> FieldBytes {
    let mut current = leaf;
    for d in 0..TREE_DEPTH {
        let sibling = path.siblings[d];
        let (left, right) = if path.path_bits[d] {
            (sibling, current)
        } else {
            (current, sibling)
        };
        current = poseidon2(&left, &right);
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::note::asset_id_from_mint;

    fn dummy_note(amount: u64, asset: AssetId) -> Note {
        Note {
            amount,
            asset_id: asset,
            owner_pubkey: [1u8; 32],
            blinding: [2u8; 32],
        }
    }

    fn dummy_path() -> MerklePath {
        MerklePath {
            siblings: vec![[0u8; 32]; TREE_DEPTH],
            path_bits: vec![false; TREE_DEPTH],
        }
    }

    #[test]
    fn deposit_only_witness_builds() {
        let asset = asset_id_from_mint(&[9u8; 32]);
        // Deposit 100 → one output, no inputs, public_amount = -100.
        let w = WitnessBuilder::new()
            .spending_key([7u8; 32])
            .public_amount(-100)
            .asset_id(asset)
            .ext_data_hash([0u8; 32])
            .add_output(dummy_note(100, asset))
            .try_build();
        assert!(w.is_ok(), "{w:?}");
    }

    /// A non-dummy path: at least one non-zero sibling so `is_dummy_path`
    /// is false and the H2 guard engages. path_bits all-false (leaf is the
    /// leftmost position).
    fn real_path() -> MerklePath {
        let mut siblings = vec![[0u8; 32]; TREE_DEPTH];
        siblings[0] = [3u8; 32]; // first sibling non-zero → real membership claim
        MerklePath {
            siblings,
            path_bits: vec![false; TREE_DEPTH],
        }
    }

    #[test]
    fn root_pinning_rejects_unexpected_root_and_accepts_expected() {
        let asset = asset_id_from_mint(&[5u8; 32]);
        let note = dummy_note(50, asset);
        let path = real_path();

        // The honest, recomputed root for this leaf+path.
        let leaf = commitment(&note);
        let good_root = MerkleRoot(recompute_root(leaf.0, &path));
        // A different (attacker-substituted / unrecognized) root.
        let bad_root = MerkleRoot([0xAB; 32]);

        // (a) Recomputed root NOT in expected set → RootMismatch.
        let rejected = WitnessBuilder::new()
            .spending_key([7u8; 32])
            .public_amount(50) // withdraw all 50, no outputs
            .asset_id(asset)
            .ext_data_hash([0u8; 32])
            .add_input(note.clone(), path.clone(), 0)
            .expected_roots(vec![bad_root])
            .try_build();
        assert!(
            matches!(rejected, Err(Error::RootMismatch { input_index: 0 })),
            "expected RootMismatch, got {rejected:?}"
        );

        // (b) Recomputed root IS in expected set → builds.
        let accepted = WitnessBuilder::new()
            .spending_key([7u8; 32])
            .public_amount(50)
            .asset_id(asset)
            .ext_data_hash([0u8; 32])
            .add_input(note, path, 0)
            .expected_roots(vec![bad_root, good_root])
            .try_build();
        assert!(accepted.is_ok(), "expected Ok, got {accepted:?}");
    }

    #[test]
    fn real_input_without_expected_roots_fails_closed() {
        let asset = asset_id_from_mint(&[5u8; 32]);
        let res = WitnessBuilder::new()
            .spending_key([7u8; 32])
            .public_amount(50)
            .asset_id(asset)
            .ext_data_hash([0u8; 32])
            .add_input(dummy_note(50, asset), real_path(), 0)
            .try_build();
        assert!(
            matches!(res, Err(Error::MissingExpectedRoots)),
            "real input with no expected_roots must fail closed, got {res:?}"
        );
    }

    #[test]
    fn dummy_deposit_skips_root_check() {
        // Pure deposit: one dummy input (all-zero path), one output, no
        // expected_roots — must still build (dummies carry no membership).
        let asset = asset_id_from_mint(&[9u8; 32]);
        let w = WitnessBuilder::new()
            .spending_key([7u8; 32])
            .public_amount(0)
            .asset_id(asset)
            .ext_data_hash([0u8; 32])
            .add_input(dummy_note(100, asset), dummy_path(), 0)
            .add_output(dummy_note(100, asset))
            .try_build();
        assert!(w.is_ok(), "dummy input must skip H2 guard, got {w:?}");
    }

    #[test]
    fn asset_mismatch_rejected() {
        let a = asset_id_from_mint(&[1u8; 32]);
        let b = asset_id_from_mint(&[2u8; 32]);
        let res = WitnessBuilder::new()
            .spending_key([0u8; 32])
            .public_amount(0)
            .asset_id(a)
            .ext_data_hash([0u8; 32])
            .add_input(dummy_note(10, a), dummy_path(), 0)
            .add_output(dummy_note(10, b))
            .try_build();
        assert!(matches!(res, Err(Error::AssetMismatch)));
    }
}
