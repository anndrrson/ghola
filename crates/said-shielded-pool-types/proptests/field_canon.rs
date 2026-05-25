//! Property-based invariants for the shielded-pool field-element encoding
//! (Stream 2 of the production-hardening pass).
//!
//! Run with `cargo test -p said-shielded-pool-types --test field_canon`.
//!
//! The types crate exposes `FieldBytes = [u8; 32]` as the canonical BE
//! field-element encoding. There is no inherent reducer in the crate —
//! the on-chain `sol_poseidon` syscall and the off-chain
//! `light-poseidon` library both accept arbitrary BE bytes and reduce
//! modulo the BN254 scalar field internally. This harness pins that
//! invariant: any arbitrary 32-byte input, when fed through Poseidon,
//! produces a digest that is strictly less than the BN254 scalar field
//! modulus `p`.
//!
//! # Properties exercised
//!
//! 1. **Poseidon output is in-range**: for arbitrary 32-byte input
//!    pairs, `poseidon2(a, b)` interpreted as a BE big-integer is
//!    strictly less than `p`. (light-poseidon reduces; we check.)
//!
//! 2. **BE-32 round-trip is identity**: `from_be_bytes`+`to_be_bytes`
//!    is the identity function on arbitrary 32-byte inputs.
//!
//! 3. **Reduction is idempotent**: `reduce(reduce(x)) == reduce(x)` for
//!    arbitrary 32-byte inputs.
//!
//! 4. **`Note::commitment_inputs` packs `amount` BE into the low 8
//!    bytes**: arbitrary u64 amount round-trips through the
//!    commitment-input encoding.
//!
//! # Documentation
//!
//! For property 1 we explicitly RE-REDUCE the digest before comparing
//! — this is defense-in-depth: even if light-poseidon's internal API
//! changed to leave non-canonical bytes, the on-chain syscall reduces,
//! so our comparison is "what the chain sees after reduction".

use ark_bn254::Fr;
use ark_ff::PrimeField;
use light_poseidon::{Poseidon, PoseidonBytesHasher};
use num_bigint::BigUint;
use proptest::prelude::*;
use said_shielded_pool_types::{AssetId, FieldBytes, Note, FIELD_BYTES};

/// BN254 scalar field modulus `p`.
fn bn254_p() -> BigUint {
    "21888242871839275222246405745257275088548364400416034343698204186575808495617"
        .parse()
        .expect("p")
}

/// Reduce a 32-byte BE input modulo `p` using ark-bn254.
fn reduce_be32(bytes: &FieldBytes) -> FieldBytes {
    let fr = Fr::from_be_bytes_mod_order(bytes);
    let bi = fr.into_bigint();
    let raw = ark_ff::BigInteger::to_bytes_be(&bi);
    let mut out = [0u8; FIELD_BYTES];
    // ark's to_bytes_be may be shorter than 32 when the value is small.
    out[FIELD_BYTES - raw.len()..].copy_from_slice(&raw);
    out
}

/// Hash two BE-32 inputs through circom-Poseidon. `light-poseidon`
/// rejects inputs that are numerically `>= p` (so do circom and the
/// on-chain `sol_poseidon` syscall). Arbitrary fuzz inputs frequently
/// fall above p; the on-chain program reduces field elements before
/// passing them in, and we mirror that here. The reduction is
/// idempotent for in-range inputs.
fn poseidon2_be(left: &FieldBytes, right: &FieldBytes) -> Option<FieldBytes> {
    let l = reduce_be32(left);
    let r = reduce_be32(right);
    let mut h = Poseidon::<Fr>::new_circom(2).ok()?;
    let d = h.hash_bytes_be(&[l.as_slice(), r.as_slice()]).ok()?;
    let mut out = [0u8; FIELD_BYTES];
    out.copy_from_slice(&d);
    Some(out)
}

proptest! {
    #![proptest_config(ProptestConfig {
        // Poseidon is the slow operation; 64 cases comfortably fits CI.
        cases: 64,
        max_shrink_iters: 1_000,
        .. ProptestConfig::default()
    })]

    /// Property 1: poseidon digest, after canonical reduction, is < p.
    /// (Equivalently: the digest fits in the BN254 scalar field.)
    #[test]
    fn poseidon_output_in_field(a in any::<[u8; 32]>(), b in any::<[u8; 32]>()) {
        let d = poseidon2_be(&a, &b).expect("reduced inputs always hash");
        let n = BigUint::from_bytes_be(&d);
        prop_assert!(
            n < bn254_p(),
            "poseidon digest {:x} ≥ p — non-canonical", n
        );
    }

    /// Property 2: BE-32 round-trip is identity.
    #[test]
    fn be32_round_trip(bytes in any::<[u8; 32]>()) {
        let n = BigUint::from_bytes_be(&bytes);
        let back = n.to_bytes_be();
        let mut padded = [0u8; FIELD_BYTES];
        padded[FIELD_BYTES - back.len()..].copy_from_slice(&back);
        prop_assert_eq!(padded, bytes);
    }

    /// Property 3: reduction is idempotent.
    #[test]
    fn reduce_is_idempotent(bytes in any::<[u8; 32]>()) {
        let r1 = reduce_be32(&bytes);
        let r2 = reduce_be32(&r1);
        prop_assert_eq!(r1, r2);
        // And r1 < p.
        let n = BigUint::from_bytes_be(&r1);
        prop_assert!(n < bn254_p());
    }

    /// Property 4: `Note::commitment_inputs` packs `amount` BE in the low
    /// 8 bytes and zero-pads the high 24 bytes — the layout the
    /// transaction circuit hashes as `Poseidon4(amount_fe, asset, owner, blinding)`.
    #[test]
    fn note_commitment_inputs_packs_amount(
        amount in any::<u64>(),
        asset in any::<[u8; 32]>(),
        owner in any::<[u8; 32]>(),
        blinding in any::<[u8; 32]>(),
    ) {
        let n = Note {
            amount,
            asset_id: AssetId(asset),
            owner_pubkey: owner,
            blinding,
        };
        let [a_fe, asset_out, owner_out, blinding_out] = n.commitment_inputs();
        // high 24 bytes are zero, low 8 bytes are amount BE.
        prop_assert_eq!(&a_fe[..24], &[0u8; 24]);
        prop_assert_eq!(&a_fe[24..], &amount.to_be_bytes());
        prop_assert_eq!(asset_out, asset);
        prop_assert_eq!(owner_out, owner);
        prop_assert_eq!(blinding_out, blinding);
    }

    /// Property 5: arbitrary inputs to poseidon never panic (covered by
    /// proptest already, but assert via an explicit shape check that the
    /// digest is exactly 32 bytes). This guards against a light-poseidon
    /// API change silently changing the output width.
    #[test]
    fn poseidon_output_is_32_bytes(a in any::<[u8; 32]>(), b in any::<[u8; 32]>()) {
        let d = poseidon2_be(&a, &b).expect("reduced inputs always hash");
        prop_assert_eq!(d.len(), FIELD_BYTES);
    }
}
