//! Chain scanner — given an [`IncomingViewingKey`], walk a slice of
//! on-chain commitment+memo records and surface the ones we own.
//!
//! The intended deployment is:
//!
//! 1. The daemon (`daemon/`) tails the said-shielded-pool indexer
//!    (`crates/said-shielded-pool-indexer`) for new
//!    `(commitment, leaf_index, memo_blob)` rows.
//! 2. It feeds them to [`Scanner::scan`] in batches.
//! 3. The scanner attempts to AEAD-decrypt each `memo_blob` with the
//!    user's IVK; successful decryptions are returned as [`ScannedNote`].
//! 4. The daemon then stores `(note, leaf_index)` so the user can later
//!    spend it (it knows the path because the indexer also serves
//!    Merkle proofs).
//!
use said_shielded_pool_types::{IncomingViewingKey, Note};

use crate::error::Result;

/// A single on-chain insertion record, as served by the indexer.
#[derive(Debug, Clone)]
pub struct ChainCommitment {
    /// Leaf index in the active Merkle tree.
    pub leaf_index: u64,
    /// 32-byte commitment value (Poseidon over note preimage).
    pub commitment: [u8; 32],
    /// Encrypted note memo. May be empty for self-deposits without
    /// memo (in which case the depositor reconstructs the note locally).
    pub memo_blob: Vec<u8>,
}

/// A decrypted, owned note, paired with its on-chain position.
#[derive(Debug, Clone)]
pub struct ScannedNote {
    /// Plaintext note we own.
    pub note: Note,
    /// Position in the Merkle tree (needed later to build a witness).
    pub leaf_index: u64,
    /// Original commitment bytes — useful for re-verifying the
    /// Poseidon(note) == commitment binding.
    pub commitment: [u8; 32],
}

/// Stateless scanner — bind an IVK once, then call [`Self::scan`] on
/// successive batches of [`ChainCommitment`].
#[derive(Debug, Clone)]
pub struct Scanner {
    ivk: IncomingViewingKey,
}

impl Scanner {
    /// Bind a scanner to an incoming viewing key.
    pub fn new(ivk: IncomingViewingKey) -> Self {
        Self { ivk }
    }

    /// Scan a batch and return every commitment whose memo decrypts
    /// under the bound IVK.
    ///
    /// Empty memo blobs are ignored. Malformed blobs are treated as
    /// non-matches so a single bad chain/indexer row cannot stop wallet
    /// recovery. A memo is surfaced only when it decrypts and its note
    /// commitment exactly matches the on-chain commitment.
    pub fn scan(&self, batch: &[ChainCommitment]) -> Result<Vec<ScannedNote>> {
        let mut out = Vec::new();
        for candidate in batch {
            if candidate.memo_blob.is_empty() {
                continue;
            }
            let memo = match crate::encryption::try_decrypt_note(&self.ivk, &candidate.memo_blob) {
                Ok(Some(memo)) => memo,
                Ok(None) => continue,
                Err(_) => continue,
            };
            if crate::note::commitment(&memo.note).0 != candidate.commitment {
                continue;
            }
            // `NoteMemo` zeroizes on drop, so we can't move `note` out of it
            // (partial move from a `Drop` type). Clone instead: the cloned
            // `Note` is owned by `ScannedNote` and itself zeroizes on drop,
            // while `memo` (and its copy of the note) is scrubbed when it
            // drops at the end of this iteration — no plain copy lingers.
            out.push(ScannedNote {
                note: memo.note.clone(),
                leaf_index: candidate.leaf_index,
                commitment: candidate.commitment,
            });
        }
        Ok(out)
    }

    /// Borrow the bound IVK (useful for callers that need to display
    /// or persist it).
    pub fn ivk(&self) -> &IncomingViewingKey {
        &self.ivk
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scanner_construction() {
        let ivk = IncomingViewingKey([1u8; 32]);
        let s = Scanner::new(ivk.clone());
        assert_eq!(s.ivk().0, ivk.0);
    }

    #[test]
    fn scan_ignores_empty_and_malformed_memos() {
        let s = Scanner::new(IncomingViewingKey([0u8; 32]));
        let out = s
            .scan(&[
                ChainCommitment {
                    leaf_index: 0,
                    commitment: [0u8; 32],
                    memo_blob: Vec::new(),
                },
                ChainCommitment {
                    leaf_index: 1,
                    commitment: [0u8; 32],
                    memo_blob: vec![1, 2, 3],
                },
            ])
            .unwrap();
        assert!(out.is_empty());
    }
}
