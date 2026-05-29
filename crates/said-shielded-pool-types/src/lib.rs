//! said-shielded-pool-types — shared types for the Ghola Solana-native shielded pool.
//!
//! Proof system: Groth16 over BN254 (Solana `alt_bn128` syscalls).
//! Hash: Poseidon-BN254 (Solana `sol_poseidon` syscall, Circom-compatible).
//! Tree: forest of depth-26 incremental Merkle trees with batched insertion queues.
//!
//! See `docs/shielded-pool/SPEC.md` for the canonical specification.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_big_array::BigArray;
use zeroize::Zeroize;

// Re-export Zeroize so downstream code can rely on a single import path.
pub use zeroize;

pub const TREE_DEPTH: usize = 26;
pub const ROOT_HISTORY_SIZE: usize = 256;
pub const NULLIFIER_BYTES: usize = 32;
pub const COMMITMENT_BYTES: usize = 32;
pub const FIELD_BYTES: usize = 32;

/// Raw 32-byte Poseidon/field element. Big-endian on-chain encoding.
pub type FieldBytes = [u8; FIELD_BYTES];

/// Asset identifier — Poseidon(token_mint_pubkey). 32 bytes.
/// `Debug` is hand-written (see bottom of file) to print only a short
/// non-reversible tag — never the full field element — so a stray `{:?}`
/// in a log/panic cannot dump linkable on-chain values verbatim.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AssetId(pub FieldBytes);

/// Commitment = Poseidon(amount, asset_id, owner_pubkey, blinding).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Commitment(pub FieldBytes);

/// Nullifier = Poseidon(spending_key, commitment, leaf_index).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Nullifier(pub FieldBytes);

/// Merkle root of the commitment tree.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MerkleRoot(pub FieldBytes);

/// Shielded note (UTXO). `Debug` is hand-written to fully redact contents
/// (amount/owner/blinding open the UTXO).
#[derive(Clone, Serialize, Deserialize)]
pub struct Note {
    pub amount: u64,
    pub asset_id: AssetId,
    pub owner_pubkey: FieldBytes,
    pub blinding: FieldBytes,
}

impl Note {
    /// Stub — actual commitment derivation lives in the circuit AND in the
    /// host-side poseidon implementation; this trait will be wired up in a
    /// follow-up PR once `light-poseidon` is added to workspace deps.
    pub fn commitment_inputs(&self) -> [FieldBytes; 4] {
        let mut amount = [0u8; FIELD_BYTES];
        amount[FIELD_BYTES - 8..].copy_from_slice(&self.amount.to_be_bytes());
        [amount, self.asset_id.0, self.owner_pubkey, self.blinding]
    }
}

/// Spending key — controls authorization. Held by the agent.
#[derive(Clone, Zeroize, Serialize, Deserialize)]
#[zeroize(drop)]
pub struct SpendingKey(pub FieldBytes);

/// Full Viewing Key — audits-but-not-spends. Held by the principal.
/// `ak` is the public component of the spend authority; `nk` is the
/// nullifier-deriving key. Together they re-derive every nullifier the
/// agent will emit, enabling complete spend-side auditability without
/// authorization power.
#[derive(Clone, Serialize, Deserialize)]
pub struct FullViewingKey {
    pub ak: FieldBytes,
    pub nk: FieldBytes,
}

/// Incoming Viewing Key — decrypt incoming notes only (no nullifier derivation).
#[derive(Clone, Serialize, Deserialize)]
pub struct IncomingViewingKey(pub FieldBytes);

/// Groth16 proof in BN254 affine, big-endian — matches `groth16-solana`
/// (Lightprotocol/groth16-solana) expected encoding.
#[derive(Clone, Serialize, Deserialize)]
pub struct Groth16Proof {
    /// G1 point (compressed = 32 bytes, uncompressed = 64). We carry both
    /// forms; on-chain the program uses compressed via `alt_bn128_g1_decompress`.
    #[serde(with = "BigArray")]
    pub a: [u8; 64],
    /// G2 point.
    #[serde(with = "BigArray")]
    pub b: [u8; 128],
    /// G1 point.
    #[serde(with = "BigArray")]
    pub c: [u8; 64],
}

/// Public inputs to the transfer circuit. Field order MUST match
/// `circuits/transaction.circom`'s public signal declaration. See SPEC.md §4.
#[derive(Clone, Serialize, Deserialize)]
pub struct PublicInputs {
    pub root: MerkleRoot,
    pub input_nullifiers: Vec<Nullifier>,
    pub output_commitments: Vec<Commitment>,
    pub public_amount: i128,
    pub asset_id: AssetId,
    pub ext_data_hash: FieldBytes,
}

/// A complete proof bundle ready for on-chain submission.
#[derive(Clone, Serialize, Deserialize)]
pub struct ProofBundle {
    pub proof: Groth16Proof,
    pub public_inputs: PublicInputs,
}

/// Witness inputs supplied to the prover off-chain. Never crosses chain boundary.
///
/// # Privacy obligation
///
/// `TransferWitness` carries the agent's `spending_key`, each input
/// note's `blinding` factor (which together with the commitment opens
/// the UTXO), and the sibling paths of those input notes. ALL of these
/// are secret. The on-drop zeroize implementation below blanks the
/// secret-bearing fields. The witness JSON written to the prover's
/// temp dir is additionally cleaned up via the `TempArtifacts` RAII
/// guard in `said-shielded-pool-prover::backend::snarkjs`.
#[derive(Clone, Serialize, Deserialize)]
pub struct TransferWitness {
    pub input_notes: Vec<Note>,
    pub input_paths: Vec<MerklePath>,
    pub input_indices: Vec<u64>,
    pub output_notes: Vec<Note>,
    pub spending_key: FieldBytes,
    pub public_amount: i128,
    pub asset_id: AssetId,
    pub ext_data_hash: FieldBytes,
}

impl Zeroize for TransferWitness {
    fn zeroize(&mut self) {
        // spending_key is the headline secret.
        self.spending_key.zeroize();
        // Each Note carries `amount` (u64) and `blinding` (FieldBytes);
        // both leak the underlying UTXO if recovered. owner_pubkey is
        // technically derivable from the spending key but we zero it
        // too for defense in depth.
        for n in self.input_notes.iter_mut() {
            n.zeroize();
        }
        for n in self.output_notes.iter_mut() {
            n.zeroize();
        }
        // Each sibling path is private — it points into the UTXO set.
        for p in self.input_paths.iter_mut() {
            p.zeroize();
        }
        // input_indices reveal which leaf positions were spent.
        for idx in self.input_indices.iter_mut() {
            *idx = 0;
        }
        // public_amount, asset_id, ext_data_hash are public by
        // construction (they appear on-chain). We don't bother zeroing
        // them — they're not secrets — and we keep them readable in
        // case a panic-handler dumps the witness post-drop.
    }
}

impl Drop for TransferWitness {
    fn drop(&mut self) {
        self.zeroize();
    }
}

impl Zeroize for Note {
    fn zeroize(&mut self) {
        self.amount = 0;
        self.asset_id.0.zeroize();
        self.owner_pubkey.zeroize();
        self.blinding.zeroize();
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct MerklePath {
    pub siblings: Vec<FieldBytes>, // length = TREE_DEPTH
    pub path_bits: Vec<bool>,      // length = TREE_DEPTH
}

impl Zeroize for MerklePath {
    fn zeroize(&mut self) {
        for s in self.siblings.iter_mut() {
            s.zeroize();
        }
        // path_bits reveal the leaf index — clear them too.
        for b in self.path_bits.iter_mut() {
            *b = false;
        }
    }
}

/// Fixed batch size of the forester (batched commitment-insertion) circuit.
/// Bumping this requires recompiling `circuits/batchedUpdate.circom` and
/// re-running the trusted-setup ceremony.
pub const FORESTER_BATCH_SIZE: usize = 4;

/// Public inputs to the forester (batched commitment-insertion) circuit.
/// Order must match `circuits/batchedUpdate.circom`:
///   [old_root, new_root, start_index, commitment_0..commitment_3, pad=0]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForesterPublicInputs {
    pub old_root: MerkleRoot,
    pub new_root: MerkleRoot,
    pub start_index: u64,
    pub commitments: Vec<Commitment>,
}

/// Proof bundle ready for on-chain submission to `update_root_via_proof`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForesterProofBundle {
    pub proof: Groth16Proof,
    pub public_inputs: ForesterPublicInputs,
}

/// Witness inputs to the batched commitment-insertion circuit
/// (`circuits/batchedUpdate.circom`). Built off-chain by the forester
/// (`crates/said-shielded-pool-indexer/src/forester/witness.rs`),
/// consumed by the prover (`crates/said-shielded-pool-prover`).
///
/// Each `pathElements[i]` is the sibling path at leaf index
/// `start_index + i` in the tree state JUST BEFORE that commitment is
/// inserted (i.e. after commitments 0..i have already been folded in).
///
/// Hex-encoded big-endian 32-byte field elements on the wire to match
/// the existing prover JSON conventions.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BatchedUpdateWitness {
    /// Public — current Merkle root (32-byte BE hex).
    pub old_root: String,
    /// Public — expected root after applying the batch.
    pub new_root: String,
    /// Public — leaf index of the first commitment in this batch.
    pub start_index: u64,
    /// Public — the `FORESTER_BATCH_SIZE` commitments to insert (hex BE32 each).
    pub commitments: Vec<String>,
    /// Private — per-step sibling paths. Outer length = FORESTER_BATCH_SIZE;
    /// inner length = TREE_DEPTH.
    pub path_elements: Vec<Vec<String>>,
}

// ============================================================================
//  Redacting `Debug` impls (zero-leakage hardening)
// ============================================================================
//
// None of the secret- or linkable-bearing types derive `Debug`. Instead we
// hand-write `Debug` so that a stray `{:?}` (in a log line, a `.expect(...)`
// payload, a panic during unwinding, or a `#[derive(Debug)]` on an enclosing
// type) can NEVER print key material or a full on-chain-linkable field element.
//
//   * Secret-bearing types (Note, MerklePath, viewing keys, witnesses, proofs)
//     print only a type tag with NO contents.
//   * Linkable-but-public scalars (AssetId/Commitment/Nullifier/MerkleRoot)
//     print a short, non-reversible 3-byte prefix tag, mirroring
//     `common-secrets::ScrubbedString`, enough to disambiguate in a trace
//     without echoing the whole value.

/// Write a short non-reversible tag (first 3 bytes as hex + ellipsis) for a
/// linkable-but-public field element. Never the full value.
fn write_short_tag(f: &mut std::fmt::Formatter<'_>, bytes: &[u8]) -> std::fmt::Result {
    for b in bytes.iter().take(3) {
        write!(f, "{b:02x}")?;
    }
    f.write_str("…")
}

macro_rules! impl_short_tag_debug {
    ($ty:ident) => {
        impl std::fmt::Debug for $ty {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, concat!(stringify!($ty), "("))?;
                write_short_tag(f, &self.0)?;
                f.write_str(")")
            }
        }
    };
}
impl_short_tag_debug!(AssetId);
impl_short_tag_debug!(Commitment);
impl_short_tag_debug!(Nullifier);
impl_short_tag_debug!(MerkleRoot);

macro_rules! impl_redacted_debug {
    ($ty:ident) => {
        impl std::fmt::Debug for $ty {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(concat!(stringify!($ty), "(<redacted>)"))
            }
        }
    };
}
// Secret-bearing: print nothing but the type name.
impl_redacted_debug!(Note);
impl_redacted_debug!(MerklePath);
impl_redacted_debug!(FullViewingKey);
impl_redacted_debug!(IncomingViewingKey);
impl_redacted_debug!(Groth16Proof);
impl_redacted_debug!(TransferWitness);
// PublicInputs carries the clear-text `public_amount` (the dispositive
// amount-linkage of Part 2) alongside already-tagged commitments/nullifiers;
// redact the whole struct so logs never echo the amount.
impl_redacted_debug!(PublicInputs);
impl_redacted_debug!(ProofBundle);

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("invalid encoding: {0}")]
    Encoding(String),
    #[error("value out of range")]
    ValueOutOfRange,
    #[error("mismatched asset ids in transfer")]
    AssetMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_witness_zeroize_clears_secrets() {
        let mut w = TransferWitness {
            input_notes: vec![Note {
                amount: 999,
                asset_id: AssetId([0xAA; 32]),
                owner_pubkey: [0xBB; 32],
                blinding: [0xCC; 32],
            }],
            input_paths: vec![MerklePath {
                siblings: vec![[0xDD; 32]; TREE_DEPTH],
                path_bits: vec![true; TREE_DEPTH],
            }],
            input_indices: vec![42],
            output_notes: vec![Note {
                amount: 500,
                asset_id: AssetId([0xAA; 32]),
                owner_pubkey: [0x11; 32],
                blinding: [0x22; 32],
            }],
            spending_key: [0x77; 32],
            public_amount: -123,
            asset_id: AssetId([0xAA; 32]),
            ext_data_hash: [0xEE; 32],
        };
        w.zeroize();
        assert_eq!(w.spending_key, [0u8; 32]);
        assert_eq!(w.input_notes[0].amount, 0);
        assert_eq!(w.input_notes[0].blinding, [0u8; 32]);
        assert_eq!(w.output_notes[0].blinding, [0u8; 32]);
        assert_eq!(w.input_paths[0].siblings[0], [0u8; 32]);
        assert!(!w.input_paths[0].path_bits[0]);
        assert_eq!(w.input_indices[0], 0);
        // Public fields preserved.
        assert_eq!(w.asset_id.0, [0xAA; 32]);
        assert_eq!(w.ext_data_hash, [0xEE; 32]);
    }

    #[test]
    fn debug_impls_redact_secrets_and_tag_linkables() {
        let note = Note {
            amount: 0xDEAD_BEEF,
            asset_id: AssetId([0xAA; 32]),
            owner_pubkey: [0xBB; 32],
            blinding: [0xCC; 32],
        };
        // Secret-bearing types: full redaction, NO contents.
        let d = format!("{note:?}");
        assert_eq!(d, "Note(<redacted>)");
        assert!(!d.contains("bb") && !d.contains("cc") && !d.contains("3735928559"));

        let w = TransferWitness {
            input_notes: vec![note.clone()],
            input_paths: vec![MerklePath {
                siblings: vec![[0xDD; 32]; TREE_DEPTH],
                path_bits: vec![true; TREE_DEPTH],
            }],
            input_indices: vec![7],
            output_notes: vec![],
            spending_key: [0x77; 32],
            public_amount: -123_456,
            asset_id: AssetId([0xAA; 32]),
            ext_data_hash: [0xEE; 32],
        };
        let dw = format!("{w:?}");
        assert_eq!(dw, "TransferWitness(<redacted>)");
        assert!(!dw.contains("77") && !dw.contains("123456") && !dw.contains("dd"));

        // Viewing keys fully redacted.
        assert_eq!(
            format!("{:?}", IncomingViewingKey([0x99; 32])),
            "IncomingViewingKey(<redacted>)"
        );
        assert_eq!(
            format!(
                "{:?}",
                FullViewingKey {
                    ak: [1; 32],
                    nk: [2; 32]
                }
            ),
            "FullViewingKey(<redacted>)"
        );

        // Linkable-but-public scalars: short non-reversible tag only (3 bytes),
        // never the full 32-byte value.
        let c = format!("{:?}", Commitment([0xAB; 32]));
        assert_eq!(c, "Commitment(ababab…)");
        assert!(!c.contains(&"ab".repeat(32)));
        assert!(format!("{:?}", MerkleRoot([0x01; 32])).starts_with("MerkleRoot(010101…"));
    }

    #[test]
    fn note_commitment_inputs_packs_amount_be() {
        let note = Note {
            amount: 0x1234_5678,
            asset_id: AssetId([0xAA; 32]),
            owner_pubkey: [0xBB; 32],
            blinding: [0xCC; 32],
        };
        let [amount, asset, owner, blinding] = note.commitment_inputs();
        assert_eq!(&amount[24..32], &0x1234_5678u64.to_be_bytes());
        assert_eq!(asset, [0xAA; 32]);
        assert_eq!(owner, [0xBB; 32]);
        assert_eq!(blinding, [0xCC; 32]);
    }
}
