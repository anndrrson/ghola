//! Builder for fresh shielded [`Note`]s.
//!
//! A note is a UTXO in the shielded pool:
//!
//! ```text
//! Note { amount, asset_id, owner_pubkey, blinding }
//! commitment = Poseidon(amount, asset_id, owner_pubkey, blinding)
//! ```
//!
//! [`NoteBuilder`] handles two pieces of bookkeeping:
//!
//! 1. Random `blinding` — sampled from `OsRng`, masked into BN254 scalar.
//! 2. `owner_pubkey` — by default derived from a [`ShieldedKeypair`]
//!    (`= ak`) so the recipient can later spend the note.
//!
//! Asset IDs are computed via [`asset_id_from_mint`].
//!
//! Crypto status: commitments and asset-id derivation use Circom-compatible
//! Poseidon-BN254 via [`crate::poseidon`], matching the on-chain
//! `sol_poseidon` syscall, the Circom circuits, and the testvectors crate
//! byte-for-byte.

use rand::RngCore;

use said_shielded_pool_types::{AssetId, Commitment, FieldBytes, Note, FIELD_BYTES};

use crate::error::{Error, Result};
use crate::keypair::ShieldedKeypair;
use crate::poseidon::{pack_u64_be, poseidon1, poseidon4};

/// Builder for [`Note`].
///
/// All setters consume `self` and return `Self`, so the builder chains:
///
/// ```no_run
/// # use said_shielded_pool_client::{NoteBuilder, ShieldedKeypair};
/// let kp = ShieldedKeypair::generate();
/// let note = NoteBuilder::new()
///     .amount(1_000_000)
///     .asset_id_from_mint(&[0u8; 32])
///     .owner_from_keypair(&kp)
///     .build();
/// ```
#[derive(Default, Clone)]
pub struct NoteBuilder {
    amount: Option<u64>,
    asset_id: Option<AssetId>,
    owner_pubkey: Option<FieldBytes>,
    blinding: Option<FieldBytes>,
}

impl NoteBuilder {
    /// Construct an empty builder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the note's amount in atomic mint units (e.g. lamports / 1e6 USDC).
    pub fn amount(mut self, amount: u64) -> Self {
        self.amount = Some(amount);
        self
    }

    /// Set the asset ID directly. Prefer [`Self::asset_id_from_mint`].
    pub fn asset_id(mut self, asset_id: AssetId) -> Self {
        self.asset_id = Some(asset_id);
        self
    }

    /// Compute `asset_id = Poseidon1(mint.to_bytes())` and set it.
    ///
    /// Matches the on-chain program's `AssetId` derivation byte-for-byte
    /// (Circom-compatible Poseidon-BN254 via [`crate::poseidon`]).
    pub fn asset_id_from_mint(mut self, mint: &[u8; 32]) -> Self {
        self.asset_id = Some(asset_id_from_mint(mint));
        self
    }

    /// Set the owner public key directly. Prefer [`Self::owner_from_keypair`].
    pub fn owner_pubkey(mut self, owner_pubkey: FieldBytes) -> Self {
        self.owner_pubkey = Some(owner_pubkey);
        self
    }

    /// Use the recipient's spend authority (`ak`) as the note's owner.
    pub fn owner_from_keypair(mut self, kp: &ShieldedKeypair) -> Self {
        self.owner_pubkey = Some(kp.ak);
        self
    }

    /// Override the blinding (testing / determinism only).
    ///
    /// For production, leave unset — [`Self::build`] samples from `OsRng`.
    pub fn blinding(mut self, blinding: FieldBytes) -> Self {
        self.blinding = Some(blinding);
        self
    }

    /// Finalize the note. Returns `Err` if `amount`, `asset_id`, or
    /// `owner_pubkey` were not set.
    pub fn try_build(self) -> Result<Note> {
        let amount = self.amount.ok_or(Error::Internal("amount unset".into()))?;
        let asset_id = self
            .asset_id
            .ok_or(Error::Internal("asset_id unset".into()))?;
        let owner_pubkey = self
            .owner_pubkey
            .ok_or(Error::Internal("owner_pubkey unset".into()))?;
        let blinding = self.blinding.unwrap_or_else(random_field_element);

        Ok(Note {
            amount,
            asset_id,
            owner_pubkey,
            blinding,
        })
    }

    /// [`Self::try_build`] that panics on missing fields. Convenient for
    /// example code and tests.
    pub fn build(self) -> Note {
        self.try_build().expect("NoteBuilder: missing fields")
    }
}

/// Compute the asset ID from a token mint pubkey.
///
/// `AssetId = Poseidon1(mint.to_bytes())` per spec — Circom-compatible
/// Poseidon-BN254. The mint bytes are reduced mod p by `light-poseidon`.
pub fn asset_id_from_mint(mint: &[u8; 32]) -> AssetId {
    AssetId(poseidon1(mint))
}

/// Compute the commitment for a note:
/// `Poseidon4(amount, asset_id, owner_pubkey, blinding)` with `amount`
/// `u64` packed big-endian right-aligned into 32 bytes.
///
/// Matches the testvectors crate's `commitment()` byte-for-byte and is
/// the same hash the Circom circuit asserts over.
pub fn commitment(note: &Note) -> Commitment {
    let amount = pack_u64_be(note.amount);
    Commitment(poseidon4(
        &amount,
        &note.asset_id.0,
        &note.owner_pubkey,
        &note.blinding,
    ))
}

/// Sample a uniformly-random BN254 scalar (rejection-free; top-three
/// bits cleared so the result is `< 2^253 < p`).
pub fn random_field_element() -> FieldBytes {
    let mut out = [0u8; FIELD_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut out);
    out[0] &= 0b0001_1111;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keypair::ShieldedKeypair;

    #[test]
    fn build_note_happy_path() {
        let kp = ShieldedKeypair::from_seed(&[3u8; 32]);
        let note = NoteBuilder::new()
            .amount(42)
            .asset_id_from_mint(&[1u8; 32])
            .owner_from_keypair(&kp)
            .build();
        assert_eq!(note.amount, 42);
        assert_eq!(note.owner_pubkey, kp.ak);
        // Two builds should yield different blindings.
        let note2 = NoteBuilder::new()
            .amount(42)
            .asset_id_from_mint(&[1u8; 32])
            .owner_from_keypair(&kp)
            .build();
        assert_ne!(note.blinding, note2.blinding);
    }

    #[test]
    fn try_build_rejects_missing_fields() {
        assert!(NoteBuilder::new().try_build().is_err());
        assert!(NoteBuilder::new().amount(1).try_build().is_err());
    }

    #[test]
    fn asset_id_is_deterministic() {
        let a = asset_id_from_mint(&[7u8; 32]);
        let b = asset_id_from_mint(&[7u8; 32]);
        assert_eq!(a, b);
    }
}
