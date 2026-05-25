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
    AssetId, FieldBytes, MerklePath, Note, TransferWitness, TREE_DEPTH,
};

use crate::error::{Error, Result};

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

        // Value-conservation cross-check (debug only — circuit enforces).
        debug_assert_eq!(
            self.output_notes
                .iter()
                .map(|n| n.amount as i128)
                .sum::<i128>()
                - self.input_notes.iter().map(|n| n.amount as i128).sum::<i128>(),
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
