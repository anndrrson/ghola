//! Pure-Rust witness builder for the transaction circuit.
//!
//! Given a [`TransferWitness`] (the same shape produced by
//! `said-shielded-pool-testvectors`), this module produces the
//! `input.json` shape that snarkjs's `wtns calculate` expects, with all
//! field elements rendered as decimal strings (snarkjs / circom
//! convention).
//!
//! The circuit (see `crates/said-shielded-pool-circuits/circuits/transaction.circom`)
//! is fixed at `nIns = 2`, `nOuts = 2`, `levels = TREE_DEPTH = 26`. When
//! the witness has fewer than 2 real inputs/outputs we pad with dummy
//! zero-amount notes so the input.json always has exactly 2 entries on
//! each side.
//!
//! All Poseidon hashing uses `light-poseidon` (Circom-compatible), so a
//! commitment computed here is bit-for-bit identical to what the circuit
//! computes inside its constraints. We expose those helpers so callers
//! can sanity-check that the public signals they pass on-chain match
//! the values the circuit will produce internally.

use ark_bn254::Fr;
use light_poseidon::{Poseidon, PoseidonBytesHasher};
use num_bigint::BigUint;
use said_shielded_pool_types::{FieldBytes, MerklePath, Note, TransferWitness, TREE_DEPTH};
use serde_json::{json, Value};

const CIRCUIT_N_INS: usize = 2;
const CIRCUIT_N_OUTS: usize = 2;

/// BN254 scalar field modulus `p`. Used to encode signed `public_amount`
/// as a field element via `p - |v|` when `v < 0`.
const BN254_P_DEC: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";

/// Decimal-string representation of a 32-byte field element (treated as
/// an unsigned BE integer). Matches what snarkjs / circom expect.
fn be32_to_decimal(bytes: &FieldBytes) -> String {
    let n = BigUint::from_bytes_be(bytes);
    n.to_str_radix(10)
}

/// Convenience wrapper around `light-poseidon` for circom-compatible
/// Poseidon-BN254 hashing. Inputs are BE-32 field elements.
fn poseidon_n(inputs: &[&FieldBytes]) -> FieldBytes {
    let width = inputs.len();
    let mut p = Poseidon::<Fr>::new_circom(width).expect("poseidon width");
    let slices: Vec<&[u8]> = inputs.iter().map(|x| x.as_slice()).collect();
    p.hash_bytes_be(&slices).expect("poseidon hash")
}

/// `Poseidon1(sk)` — derives the in-circuit public key used as
/// `owner_pubkey` for spendable notes.
pub fn derive_pubkey(sk: &FieldBytes) -> FieldBytes {
    poseidon_n(&[sk])
}

/// `Poseidon4(amount, asset_id, owner, blinding)` — circuit-consistent
/// commitment hash. Mirrors `said-shielded-pool-testvectors::poseidon::commitment`.
pub fn commitment_hash(
    amount: u64,
    asset_id: &FieldBytes,
    owner: &FieldBytes,
    blinding: &FieldBytes,
) -> FieldBytes {
    let amount_field = pack_u64_be(amount);
    poseidon_n(&[&amount_field, asset_id, owner, blinding])
}

/// `Poseidon3(sk, commitment, leaf_index)` — the circuit computes the
/// nullifier this way (note: the circuit uses `inPrivateKey` directly
/// as the nullifying key for the v1 single-key model). Mirrors
/// `said-shielded-pool-testvectors::poseidon::nullifier`.
pub fn nullifier_hash(
    sk: &FieldBytes,
    commitment: &FieldBytes,
    leaf_index: u64,
) -> FieldBytes {
    let idx = pack_u64_be(leaf_index);
    poseidon_n(&[sk, commitment, &idx])
}

/// Pack a `u64` big-endian, right-aligned into a 32-byte field element.
pub fn pack_u64_be(v: u64) -> FieldBytes {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&v.to_be_bytes());
    out
}

/// Encode a signed `i128` public_amount as a BN254 field element.
/// Negative values are represented as `p - |v|`.
pub fn encode_signed_public_amount(v: i128) -> String {
    let p: BigUint = BN254_P_DEC.parse().expect("p");
    if v >= 0 {
        BigUint::from(v as u128).to_str_radix(10)
    } else {
        let abs = BigUint::from((-v) as u128);
        (&p - &abs).to_str_radix(10)
    }
}

fn empty_path() -> MerklePath {
    MerklePath {
        siblings: vec![[0u8; 32]; TREE_DEPTH],
        path_bits: vec![false; TREE_DEPTH],
    }
}

fn dummy_input(slot: usize) -> (FieldBytes, FieldBytes, u64, MerklePath, u64) {
    // (sk, blinding, leaf_index, path, amount=0)
    let mut sk = [0u8; 32];
    sk[31] = (slot as u8) + 1; // "1", "2", … so we get the same dummies the
                                // legacy node script used.
    let mut bl = [0u8; 32];
    // Match build_deposit_input.js: dummyBlinding = [101, 102]
    bl[31] = 100 + slot as u8 + 1;
    (sk, bl, 0, empty_path(), 0)
}

fn dummy_output(slot: usize, owner: &FieldBytes, asset_id: &FieldBytes) -> Note {
    let mut bl = [0u8; 32];
    // 88888 for slot=0, 88889 for slot=1, …
    let v: u64 = 88888 + slot as u64;
    bl[24..].copy_from_slice(&v.to_be_bytes());
    Note {
        amount: 0,
        asset_id: said_shielded_pool_types::AssetId(*asset_id),
        owner_pubkey: *owner,
        blinding: bl,
    }
}

/// Sanity-check the public-input layout, expanding inputs/outputs to the
/// circuit-fixed 2-in / 2-out shape, and emit a snarkjs-compatible
/// input.json `Value` ready to be written to disk.
///
/// `sk_per_input` carries the spending key for each *real* input note;
/// dummy inputs always use the canonical (1, 2, …) deterministic dummy
/// keys. If `sk_per_input` is empty all inputs are treated as dummies.
pub fn build_input_json(
    witness: &TransferWitness,
    sk_per_input: &[FieldBytes],
) -> Value {
    let asset_id = witness.asset_id.0;

    // --- INPUTS ---
    let mut in_amounts: Vec<String> = Vec::with_capacity(CIRCUIT_N_INS);
    let mut in_blindings: Vec<String> = Vec::with_capacity(CIRCUIT_N_INS);
    let mut in_priv_keys: Vec<String> = Vec::with_capacity(CIRCUIT_N_INS);
    let mut in_leaf_indices: Vec<String> = Vec::with_capacity(CIRCUIT_N_INS);
    let mut in_path_elements: Vec<Vec<String>> = Vec::with_capacity(CIRCUIT_N_INS);
    let mut in_nullifiers: Vec<String> = Vec::with_capacity(CIRCUIT_N_INS);

    for slot in 0..CIRCUIT_N_INS {
        if slot < witness.input_notes.len() {
            let note = &witness.input_notes[slot];
            let path = witness
                .input_paths
                .get(slot)
                .cloned()
                .unwrap_or_else(empty_path);
            let idx = witness.input_indices.get(slot).copied().unwrap_or(0);
            let sk = sk_per_input.get(slot).copied().unwrap_or(witness.spending_key);

            // Sanity: commitment computed with the in-circuit owner = Poseidon1(sk).
            let owner = derive_pubkey(&sk);
            let c = commitment_hash(note.amount, &asset_id, &owner, &note.blinding);
            let n = nullifier_hash(&sk, &c, idx);

            in_amounts.push(note.amount.to_string());
            in_blindings.push(be32_to_decimal(&note.blinding));
            in_priv_keys.push(be32_to_decimal(&sk));
            in_leaf_indices.push(idx.to_string());
            in_path_elements.push(
                path.siblings
                    .iter()
                    .map(be32_to_decimal)
                    .collect::<Vec<_>>(),
            );
            in_nullifiers.push(be32_to_decimal(&n));
        } else {
            let (sk, bl, idx, path, amount) = dummy_input(slot);
            let owner = derive_pubkey(&sk);
            let c = commitment_hash(amount, &asset_id, &owner, &bl);
            let n = nullifier_hash(&sk, &c, idx);

            in_amounts.push(amount.to_string());
            in_blindings.push(be32_to_decimal(&bl));
            in_priv_keys.push(be32_to_decimal(&sk));
            in_leaf_indices.push(idx.to_string());
            in_path_elements.push(
                path.siblings
                    .iter()
                    .map(be32_to_decimal)
                    .collect::<Vec<_>>(),
            );
            in_nullifiers.push(be32_to_decimal(&n));
        }
    }

    // --- OUTPUTS ---
    // Use the first real input's sk to derive a default dummy-output owner
    // (any value is valid since dummy outputs have amount = 0).
    let default_owner = if !witness.input_notes.is_empty() && !sk_per_input.is_empty() {
        derive_pubkey(&sk_per_input[0])
    } else {
        derive_pubkey(&witness.spending_key)
    };

    let mut out_amounts: Vec<String> = Vec::with_capacity(CIRCUIT_N_OUTS);
    let mut out_blindings: Vec<String> = Vec::with_capacity(CIRCUIT_N_OUTS);
    let mut out_owners: Vec<String> = Vec::with_capacity(CIRCUIT_N_OUTS);
    let mut out_commitments: Vec<String> = Vec::with_capacity(CIRCUIT_N_OUTS);

    for slot in 0..CIRCUIT_N_OUTS {
        let note = if slot < witness.output_notes.len() {
            witness.output_notes[slot].clone()
        } else {
            dummy_output(slot, &default_owner, &asset_id)
        };
        let c = commitment_hash(
            note.amount,
            &asset_id,
            &note.owner_pubkey,
            &note.blinding,
        );
        out_amounts.push(note.amount.to_string());
        out_blindings.push(be32_to_decimal(&note.blinding));
        out_owners.push(be32_to_decimal(&note.owner_pubkey));
        out_commitments.push(be32_to_decimal(&c));
    }

    // --- ROOT ---
    // For a pure deposit, all inputs are dummies (amount == 0) and the
    // circuit's MerkleProof check is skipped via `(1-isZero)*(computed-root)==0`,
    // so root can be anything. We use the witness's computed root when
    // there is at least one real input; otherwise 0.
    let root_str = if witness.input_notes.is_empty() {
        "0".to_string()
    } else {
        // Reconstruct the root from the witness's first real input + its
        // path. The circuit only enforces one path-per-input check, so we
        // emit the root that goes with it.
        let first = &witness.input_notes[0];
        let sk = sk_per_input.get(0).copied().unwrap_or(witness.spending_key);
        let owner = derive_pubkey(&sk);
        let c = commitment_hash(first.amount, &asset_id, &owner, &first.blinding);
        let path = &witness.input_paths[0];
        let idx = witness.input_indices.first().copied().unwrap_or(0);
        let r = merkle_root_from_path(&c, idx, path);
        be32_to_decimal(&r)
    };

    json!({
        "root": root_str,
        "inputNullifier": in_nullifiers,
        "outputCommitment": out_commitments,
        "publicAmount": encode_signed_public_amount(witness.public_amount),
        "assetId": be32_to_decimal(&asset_id),
        "extDataHash": be32_to_decimal(&witness.ext_data_hash),
        "inAmount": in_amounts,
        "inBlinding": in_blindings,
        "inPrivateKey": in_priv_keys,
        "inLeafIndex": in_leaf_indices,
        "inPathElements": in_path_elements,
        "outAmount": out_amounts,
        "outBlinding": out_blindings,
        "outOwnerPubkey": out_owners,
    })
}

/// Reconstruct the Merkle root from a leaf + path. Mirrors the circuit's
/// `MerkleProof` template (mux on `path_bits[i]` selecting left vs right).
fn merkle_root_from_path(leaf: &FieldBytes, leaf_index: u64, path: &MerklePath) -> FieldBytes {
    let mut current = *leaf;
    for level in 0..TREE_DEPTH {
        let sibling = path.siblings.get(level).copied().unwrap_or([0u8; 32]);
        // path_bits drives mux: bit=0 → current on left, sibling on right.
        let bit = path
            .path_bits
            .get(level)
            .copied()
            .unwrap_or(((leaf_index >> level) & 1) == 1);
        current = if bit {
            poseidon_n(&[&sibling, &current])
        } else {
            poseidon_n(&[&current, &sibling])
        };
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;
    use said_shielded_pool_types::AssetId;

    #[test]
    fn pack_u64_be_round_trip() {
        let f = pack_u64_be(1000);
        assert_eq!(&f[..24], &[0u8; 24]);
        assert_eq!(&f[24..], &1000u64.to_be_bytes());
    }

    #[test]
    fn encode_signed_public_amount_negative() {
        // -1000 ≡ p - 1000
        let s = encode_signed_public_amount(-1000);
        let p: BigUint = BN254_P_DEC.parse().unwrap();
        let expected = (&p - BigUint::from(1000u64)).to_str_radix(10);
        assert_eq!(s, expected);
    }

    #[test]
    fn deposit_input_json_has_expected_shape() {
        // A minimal deposit witness: no real inputs, one real output.
        let mut owner_sk = [0u8; 32];
        owner_sk[24..].copy_from_slice(&12345u64.to_be_bytes());
        let mut blinding = [0u8; 32];
        blinding[24..].copy_from_slice(&99999u64.to_be_bytes());
        let mut asset = [0u8; 32];
        asset[31] = 0xAA;

        let owner = derive_pubkey(&owner_sk);
        let note = Note {
            amount: 1000,
            asset_id: AssetId(asset),
            owner_pubkey: owner,
            blinding,
        };
        let w = TransferWitness {
            input_notes: vec![],
            input_paths: vec![],
            input_indices: vec![],
            output_notes: vec![note],
            spending_key: owner_sk,
            public_amount: -1000,
            asset_id: AssetId(asset),
            ext_data_hash: [0u8; 32],
        };

        let v = build_input_json(&w, &[owner_sk]);
        let in_nf = v["inputNullifier"].as_array().unwrap();
        assert_eq!(in_nf.len(), 2);
        let out_cm = v["outputCommitment"].as_array().unwrap();
        assert_eq!(out_cm.len(), 2);
        assert_eq!(v["inAmount"].as_array().unwrap().len(), 2);
        assert_eq!(v["outAmount"].as_array().unwrap()[0], "1000");
        assert_eq!(v["outAmount"].as_array().unwrap()[1], "0");
        // path elements: 2 paths of length 26
        let paths = v["inPathElements"].as_array().unwrap();
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0].as_array().unwrap().len(), TREE_DEPTH);
    }
}
