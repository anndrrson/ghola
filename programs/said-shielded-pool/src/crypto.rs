//! On-chain crypto helpers shared by the spend instructions.
//!
//! These functions implement the byte-exact conventions used by the
//! off-chain SDK (`crates/said-shielded-pool-client/src/tx_builder.rs`) so
//! the program can RE-DERIVE and bind the values that were previously
//! trusted from the caller:
//!
//!   * `encode_public_amount` — signed amount → BN254 field element (BE),
//!     matching `tx_builder::encode_public_amount`.
//!   * `compute_ext_data_hash` — `keccak256(borsh(ExtData))` with the top
//!     three bits cleared, matching `tx_builder::compute_ext_data_hash`.
//!   * `is_canonical_field_element` — rejects 32-byte values `>= r` so a
//!     non-canonical encoding can't be used to evade nullifier-PDA
//!     uniqueness or smuggle an out-of-range `public_amount`.
//!
//! Wire-format invariant: if either the SDK or this module changes its
//! encoding, the other MUST change in lockstep or every spend will fail
//! the binding `require!`s below.

use anchor_lang::prelude::*;

/// BN254 scalar field order `r` (big-endian). Same constant as
/// `said-shielded-pool-client::tx_builder::BN254_SCALAR_FIELD_BE`.
///
/// `r = 21888242871839275222246405745257275088548364400416034343698204186575808495617`
pub const BN254_SCALAR_FIELD_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// `true` iff `x` (big-endian) is a canonical BN254 scalar element, i.e.
/// strictly less than the field order `r`.
///
/// `groth16-solana 0.2.0` does NOT enforce that public inputs are reduced
/// mod `r`. Two byte-distinct values `x` and `x + r` would be treated as
/// equal by the pairing check but produce DIFFERENT nullifier-PDA seeds,
/// which would let an attacker spend the same note twice. We therefore
/// gate every spend-relevant public input through this check on-chain.
pub fn is_canonical_field_element(x: &[u8; 32]) -> bool {
    // Big-endian lexicographic comparison == numeric comparison.
    for i in 0..32 {
        if x[i] < BN254_SCALAR_FIELD_BE[i] {
            return true;
        }
        if x[i] > BN254_SCALAR_FIELD_BE[i] {
            return false;
        }
    }
    // Exactly equal to r → NOT canonical (canonical range is [0, r)).
    false
}

/// Big-endian 32-byte subtraction `a - b`. Mirrors
/// `tx_builder::sub_be`. Caller guarantees `a >= b` (used only for
/// `r - amount` where `amount < r`).
fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow: i16 = 0;
    for i in (0..32).rev() {
        let v = a[i] as i16 - b[i] as i16 - borrow;
        if v < 0 {
            out[i] = (v + 256) as u8;
            borrow = 1;
        } else {
            out[i] = v as u8;
            borrow = 0;
        }
    }
    out
}

/// Encode a signed `i128` `value` as a BN254 field element (big-endian),
/// byte-identical to `tx_builder::encode_public_amount`:
///   * `value >= 0` → `value` as 32-byte BE unsigned.
///   * `value <  0` → `(r - |value|) mod r`.
///
/// The shielded pool only ever encodes `|value| <= u64::MAX` (a token
/// amount), so `|value|` always fits in 16 bytes and is `< r`.
pub fn encode_public_amount(value: i128) -> [u8; 32] {
    if value >= 0 {
        let mut out = [0u8; 32];
        out[16..].copy_from_slice(&(value as u128).to_be_bytes());
        out
    } else {
        let abs = value.unsigned_abs();
        let mut abs32 = [0u8; 32];
        abs32[16..].copy_from_slice(&abs.to_be_bytes());
        sub_be(&BN254_SCALAR_FIELD_BE, &abs32)
    }
}

/// External data binding the proof to a specific on-chain context.
///
/// Borsh layout MUST stay byte-identical to
/// `said-shielded-pool-client::tx_builder::ExtData` so that the
/// `keccak256(borsh(ExtData))` computed here equals the value the prover
/// committed to as the `ext_data_hash` public input.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ExtData {
    /// Recipient SPL token account (32 bytes). Zero for pure transfers.
    pub recipient: [u8; 32],
    /// Token-mint pubkey.
    pub mint: [u8; 32],
    /// Protocol fee (charged out of the value being moved).
    pub fee: u64,
    /// Relayer fee (paid to whichever relayer broadcasts the tx).
    pub relayer_fee: u64,
    /// Commitment to encrypted note memos for each output, in order.
    pub memo_commitments: Vec<[u8; 32]>,
}

/// Compute `ext_data_hash = keccak256(borsh(ExtData))` with the top three
/// bits cleared, byte-identical to `tx_builder::compute_ext_data_hash`.
///
/// We use `solana_program::keccak` (the same Keccak-256 the off-chain SDK
/// uses via `tiny_keccak`) rather than Poseidon: `ext_data_hash` is a
/// binding-only public signal, not recomputed inside the circuit.
pub fn compute_ext_data_hash(ext: &ExtData) -> [u8; 32] {
    let bytes = ext.try_to_vec().expect("borsh ExtData serialize");
    let mut out = anchor_lang::solana_program::keccak::hash(&bytes).to_bytes();
    // Reduce into the BN254 scalar field — clear the top three bits so the
    // result is < 2^253 < r. Matches the SDK's `out[0] &= 0b0001_1111`.
    out[0] &= 0b0001_1111;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_is_canonical() {
        assert!(is_canonical_field_element(&[0u8; 32]));
    }

    #[test]
    fn r_itself_is_not_canonical() {
        assert!(!is_canonical_field_element(&BN254_SCALAR_FIELD_BE));
    }

    #[test]
    fn r_minus_one_is_canonical() {
        let mut x = BN254_SCALAR_FIELD_BE;
        x[31] -= 1;
        assert!(is_canonical_field_element(&x));
    }

    #[test]
    fn all_ff_is_not_canonical() {
        assert!(!is_canonical_field_element(&[0xffu8; 32]));
    }

    #[test]
    fn encode_positive_amount_right_aligned() {
        let v = encode_public_amount(123);
        assert_eq!(v[31], 123);
        assert!(v[..31].iter().all(|b| *b == 0));
    }

    #[test]
    fn encode_negative_one_is_r_minus_one() {
        let v = encode_public_amount(-1);
        let mut expected = BN254_SCALAR_FIELD_BE;
        expected[31] -= 1;
        assert_eq!(v, expected);
    }
}
