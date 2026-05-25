//! Canonical Poseidon-BN254 hash wrappers used by the shielded pool.
//!
//! These wrappers are intentionally thin around `light-poseidon` so that the
//! same hash function used here is bit-for-bit compatible with:
//!
//!   * the Circom circuits in `crates/said-shielded-pool-circuits/`,
//!   * the on-chain `sol_poseidon` syscall, and
//!   * the host-side prover/client/indexer crates.
//!
//! Canonical encoding rules (see `docs/shielded-pool/SPEC.md`):
//!
//!   * field elements are 32-byte big-endian,
//!   * `commitment(note) = Poseidon4(amount, asset_id, owner_pubkey, blinding)`
//!     where `amount` is `u64` packed big-endian right-aligned into 32 bytes,
//!   * `nullifier(nk, commitment, leaf_index) = Poseidon3(nk, commitment, leaf_index)`
//!     where `leaf_index` is `u64` packed big-endian right-aligned into 32 bytes,
//!   * `asset_id(mint_bytes) = Poseidon1(mint_bytes)` where mint_bytes is the
//!     32-byte SPL mint pubkey, reduced mod p by light-poseidon.

use ark_bn254::Fr;
use light_poseidon::{Poseidon, PoseidonBytesHasher};
use said_shielded_pool_types::{
    AssetId, Commitment, FieldBytes, Note, Nullifier, FIELD_BYTES,
};

/// Pack a `u64` big-endian, right-aligned, into a 32-byte field element.
pub fn pack_u64_be(v: u64) -> FieldBytes {
    let mut out = [0u8; FIELD_BYTES];
    out[FIELD_BYTES - 8..].copy_from_slice(&v.to_be_bytes());
    out
}

/// `Poseidon1(input)` — used to derive `asset_id` from an SPL mint.
pub fn poseidon1(input: &FieldBytes) -> FieldBytes {
    let mut p = Poseidon::<Fr>::new_circom(1).expect("poseidon width 1");
    p.hash_bytes_be(&[input.as_slice()])
        .expect("poseidon1 hash")
}

/// `Poseidon3(a, b, c)` — used for nullifier derivation.
pub fn poseidon3(a: &FieldBytes, b: &FieldBytes, c: &FieldBytes) -> FieldBytes {
    let mut p = Poseidon::<Fr>::new_circom(3).expect("poseidon width 3");
    p.hash_bytes_be(&[a.as_slice(), b.as_slice(), c.as_slice()])
        .expect("poseidon3 hash")
}

/// `Poseidon4(a, b, c, d)` — used for commitment derivation.
pub fn poseidon4(a: &FieldBytes, b: &FieldBytes, c: &FieldBytes, d: &FieldBytes) -> FieldBytes {
    let mut p = Poseidon::<Fr>::new_circom(4).expect("poseidon width 4");
    p.hash_bytes_be(&[a.as_slice(), b.as_slice(), c.as_slice(), d.as_slice()])
        .expect("poseidon4 hash")
}

/// `Poseidon2(a, b)` — used by the Merkle tree.
pub fn poseidon2(a: &FieldBytes, b: &FieldBytes) -> FieldBytes {
    let mut p = Poseidon::<Fr>::new_circom(2).expect("poseidon width 2");
    p.hash_bytes_be(&[a.as_slice(), b.as_slice()])
        .expect("poseidon2 hash")
}

/// Derive the canonical `asset_id` for an SPL mint.
pub fn asset_id_from_mint(mint_bytes: &[u8; 32]) -> AssetId {
    AssetId(poseidon1(mint_bytes))
}

/// Compute the commitment for a note.
pub fn commitment(note: &Note) -> Commitment {
    let amount = pack_u64_be(note.amount);
    Commitment(poseidon4(
        &amount,
        &note.asset_id.0,
        &note.owner_pubkey,
        &note.blinding,
    ))
}

/// Compute the nullifier for a commitment owned by `nk` at `leaf_index`.
pub fn nullifier(nk: &FieldBytes, commitment: &Commitment, leaf_index: u64) -> Nullifier {
    let idx = pack_u64_be(leaf_index);
    Nullifier(poseidon3(nk, &commitment.0, &idx))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_u64_be_right_aligns() {
        let p = pack_u64_be(0x0102_0304_0506_0708);
        assert_eq!(&p[..24], &[0u8; 24]);
        assert_eq!(&p[24..], &[1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn commitment_is_deterministic() {
        let note = Note {
            amount: 1000,
            asset_id: AssetId([7u8; 32]),
            owner_pubkey: [9u8; 32],
            blinding: [11u8; 32],
        };
        let c1 = commitment(&note);
        let c2 = commitment(&note);
        assert_eq!(c1.0, c2.0);
        // Sanity: not all-zero.
        assert_ne!(c1.0, [0u8; 32]);
    }

    #[test]
    fn nullifier_uses_leaf_index() {
        let nk = [3u8; 32];
        let c = Commitment([5u8; 32]);
        let n0 = nullifier(&nk, &c, 0);
        let n1 = nullifier(&nk, &c, 1);
        assert_ne!(n0.0, n1.0);
    }
}
