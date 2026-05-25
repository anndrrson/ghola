//! Concrete scenarios. Each returns one or more `TestVector`s.
//!
//! All randomness is drawn from a `ChaCha20Rng` seeded with `VECTOR_SEED`
//! threaded through the scenario, so re-running the generator produces the
//! same vectors byte-for-byte.
//!
//! The numbers chosen here are illustrative — auditors are expected to read
//! the witness + expected public inputs and re-derive every commitment and
//! nullifier with their own Poseidon implementation.

use rand::rngs::StdRng;
use rand::{RngCore, SeedableRng};
use said_shielded_pool_types::{
    AssetId, Commitment, FieldBytes, MerkleRoot, Note, PublicInputs, TransferWitness, TREE_DEPTH,
};

use crate::poseidon::{asset_id_from_mint, commitment, nullifier, pack_u64_be, poseidon2};
use crate::tree::IncrementalMerkleTree;
use crate::types::TestVector;

/// Convenience: a fully-zero blinding factor is illegal in practice, so we
/// always draw blindings from the RNG.
fn rand_field(rng: &mut StdRng) -> FieldBytes {
    let mut out = [0u8; 32];
    rng.fill_bytes(&mut out);
    // Zero the top byte to guarantee the value < p (BN254 field has p with
    // top byte < 0x30). This is a deterministic, audit-friendly reduction
    // that doesn't depend on modular arithmetic.
    out[0] = 0;
    out
}

fn make_note(amount: u64, asset: AssetId, owner: FieldBytes, blinding: FieldBytes) -> Note {
    Note {
        amount,
        asset_id: asset,
        owner_pubkey: owner,
        blinding,
    }
}

/// Builds an empty merkle path of length `TREE_DEPTH` (all-zero siblings,
/// all-false path bits). Used for inputs that don't reference any leaf —
/// e.g. pure deposits.
fn empty_path() -> said_shielded_pool_types::MerklePath {
    said_shielded_pool_types::MerklePath {
        siblings: vec![[0u8; 32]; TREE_DEPTH],
        path_bits: vec![false; TREE_DEPTH],
    }
}

/// A scenario builder result. We return a `Vec` because some scenarios
/// (`double_spend`) produce more than one logical step.
pub type ScenarioOutput = Vec<TestVector>;

// ============================================================================
// Helpers shared across scenarios
// ============================================================================

struct Ctx {
    rng: StdRng,
    asset_a: AssetId,
    asset_b: AssetId,
    owner: FieldBytes,
    spending_key: FieldBytes,
    nk: FieldBytes,
}

impl Ctx {
    fn new(seed: u64) -> Self {
        let mut rng = StdRng::seed_from_u64(seed);
        let asset_a = asset_id_from_mint(&{
            let mut m = [0u8; 32];
            m[31] = 0xA1;
            m
        });
        let asset_b = asset_id_from_mint(&{
            let mut m = [0u8; 32];
            m[31] = 0xB2;
            m
        });
        let owner = rand_field(&mut rng);
        let spending_key = rand_field(&mut rng);
        let nk = rand_field(&mut rng);
        Self {
            rng,
            asset_a,
            asset_b,
            owner,
            spending_key,
            nk,
        }
    }
}

/// Compute `ext_data_hash` deterministically — in production this is a
/// Poseidon binding of fee, recipient, encrypted outputs, etc.  For vectors
/// we use `Poseidon2(label_hash, payload_hash)` with `label_hash` drawn
/// from the scenario name.
fn make_ext_data_hash(label: &str) -> FieldBytes {
    let mut buf = [0u8; 32];
    let bytes = label.as_bytes();
    let n = bytes.len().min(32);
    buf[..n].copy_from_slice(&bytes[..n]);
    buf[0] = 0; // ensure < p
    let payload = pack_u64_be(0xC0FFEE_u64);
    poseidon2(&buf, &payload)
}

// ============================================================================
// Scenarios
// ============================================================================

pub fn scenario_deposit_only() -> ScenarioOutput {
    let mut ctx = Ctx::new(crate::VECTOR_SEED);
    let blinding = rand_field(&mut ctx.rng);
    let out_note = make_note(1000, ctx.asset_a, ctx.owner, blinding);
    let out_c = commitment(&out_note);

    let tree = IncrementalMerkleTree::new();
    let root = MerkleRoot(tree.compute_root_from_leaves());
    let ext = make_ext_data_hash("deposit_only");

    let witness = TransferWitness {
        input_notes: vec![],
        input_paths: vec![],
        input_indices: vec![],
        output_notes: vec![out_note],
        spending_key: ctx.spending_key,
        public_amount: 1000,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };

    let public_inputs = PublicInputs {
        root,
        input_nullifiers: vec![],
        output_commitments: vec![out_c],
        public_amount: 1000,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };

    vec![TestVector {
        name: "deposit_only".into(),
        description: "Single deposit of 1000 units of asset A. No inputs, one output commitment.".into(),
        witness,
        expected_public_inputs: public_inputs,
        expected_commitment_chain: vec![out_c],
        expected_nullifiers: vec![],
        should_prove: true,
        should_verify: true,
        notes: Some("public_amount > 0 indicates a public-side deposit into the pool.".into()),
    }]
}

/// Build a tree pre-populated with `notes` and return (tree, commitments,
/// indices) so a downstream transfer scenario can build proper Merkle paths.
fn populate_tree(notes: &[Note]) -> (IncrementalMerkleTree, Vec<Commitment>, Vec<u64>) {
    let mut tree = IncrementalMerkleTree::new();
    let mut cs = Vec::new();
    let mut idxs = Vec::new();
    for n in notes {
        let c = commitment(n);
        let (idx, _root) = tree.insert(c.0);
        cs.push(c);
        idxs.push(idx);
    }
    (tree, cs, idxs)
}

pub fn scenario_transfer_2in_2out_same_asset() -> ScenarioOutput {
    let mut ctx = Ctx::new(crate::VECTOR_SEED.wrapping_add(1));
    // Two pre-existing input notes (500 + 700 = 1200), two outputs (800 + 400 = 1200).
    let bl0 = rand_field(&mut ctx.rng);
    let bl1 = rand_field(&mut ctx.rng);
    let in0 = make_note(500, ctx.asset_a, ctx.owner, bl0);
    let in1 = make_note(700, ctx.asset_a, ctx.owner, bl1);
    let (tree, in_cs, in_idxs) = populate_tree(&[in0.clone(), in1.clone()]);

    let bl_out0 = rand_field(&mut ctx.rng);
    let bl_out1 = rand_field(&mut ctx.rng);
    let out0 = make_note(800, ctx.asset_a, ctx.owner, bl_out0);
    let out1 = make_note(400, ctx.asset_a, ctx.owner, bl_out1);
    let out_c0 = commitment(&out0);
    let out_c1 = commitment(&out1);

    let n0 = nullifier(&ctx.nk, &in_cs[0], in_idxs[0]);
    let n1 = nullifier(&ctx.nk, &in_cs[1], in_idxs[1]);

    let root = MerkleRoot(tree.compute_root_from_leaves());
    let ext = make_ext_data_hash("transfer_2in_2out_same_asset");

    let witness = TransferWitness {
        input_notes: vec![in0, in1],
        input_paths: vec![tree.path_for(in_idxs[0]), tree.path_for(in_idxs[1])],
        input_indices: in_idxs.clone(),
        output_notes: vec![out0, out1],
        spending_key: ctx.spending_key,
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    let public_inputs = PublicInputs {
        root,
        input_nullifiers: vec![n0, n1],
        output_commitments: vec![out_c0, out_c1],
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    vec![TestVector {
        name: "transfer_2in_2out_same_asset".into(),
        description: "Spend two notes of asset A (500 + 700 = 1200), produce two new notes (800 + 400). public_amount = 0.".into(),
        witness,
        expected_public_inputs: public_inputs,
        expected_commitment_chain: vec![out_c0, out_c1],
        expected_nullifiers: vec![n0, n1],
        should_prove: true,
        should_verify: true,
        notes: None,
    }]
}

pub fn scenario_transfer_1in_2out_split() -> ScenarioOutput {
    let mut ctx = Ctx::new(crate::VECTOR_SEED.wrapping_add(2));
    let bl0 = rand_field(&mut ctx.rng);
    let in0 = make_note(1000, ctx.asset_a, ctx.owner, bl0);
    let (tree, in_cs, in_idxs) = populate_tree(&[in0.clone()]);

    let bl_out0 = rand_field(&mut ctx.rng);
    let bl_out1 = rand_field(&mut ctx.rng);
    let out0 = make_note(300, ctx.asset_a, ctx.owner, bl_out0);
    let out1 = make_note(700, ctx.asset_a, ctx.owner, bl_out1);
    let out_c0 = commitment(&out0);
    let out_c1 = commitment(&out1);
    let n0 = nullifier(&ctx.nk, &in_cs[0], in_idxs[0]);

    let root = MerkleRoot(tree.compute_root_from_leaves());
    let ext = make_ext_data_hash("transfer_1in_2out_split");

    let witness = TransferWitness {
        input_notes: vec![in0],
        input_paths: vec![tree.path_for(in_idxs[0])],
        input_indices: in_idxs,
        output_notes: vec![out0, out1],
        spending_key: ctx.spending_key,
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    let public_inputs = PublicInputs {
        root,
        input_nullifiers: vec![n0],
        output_commitments: vec![out_c0, out_c1],
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    vec![TestVector {
        name: "transfer_1in_2out_split".into(),
        description: "Split one 1000-unit note into 300 + 700.".into(),
        witness,
        expected_public_inputs: public_inputs,
        expected_commitment_chain: vec![out_c0, out_c1],
        expected_nullifiers: vec![n0],
        should_prove: true,
        should_verify: true,
        notes: None,
    }]
}

pub fn scenario_transfer_2in_1out_merge() -> ScenarioOutput {
    let mut ctx = Ctx::new(crate::VECTOR_SEED.wrapping_add(3));
    let bl0 = rand_field(&mut ctx.rng);
    let bl1 = rand_field(&mut ctx.rng);
    let in0 = make_note(250, ctx.asset_a, ctx.owner, bl0);
    let in1 = make_note(750, ctx.asset_a, ctx.owner, bl1);
    let (tree, in_cs, in_idxs) = populate_tree(&[in0.clone(), in1.clone()]);

    let bl_out = rand_field(&mut ctx.rng);
    let out0 = make_note(1000, ctx.asset_a, ctx.owner, bl_out);
    let out_c0 = commitment(&out0);
    let n0 = nullifier(&ctx.nk, &in_cs[0], in_idxs[0]);
    let n1 = nullifier(&ctx.nk, &in_cs[1], in_idxs[1]);

    let root = MerkleRoot(tree.compute_root_from_leaves());
    let ext = make_ext_data_hash("transfer_2in_1out_merge");

    let witness = TransferWitness {
        input_notes: vec![in0, in1],
        input_paths: vec![tree.path_for(in_idxs[0]), tree.path_for(in_idxs[1])],
        input_indices: in_idxs,
        output_notes: vec![out0],
        spending_key: ctx.spending_key,
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    let public_inputs = PublicInputs {
        root,
        input_nullifiers: vec![n0, n1],
        output_commitments: vec![out_c0],
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    vec![TestVector {
        name: "transfer_2in_1out_merge".into(),
        description: "Merge two notes (250 + 750) into one 1000-unit note.".into(),
        witness,
        expected_public_inputs: public_inputs,
        expected_commitment_chain: vec![out_c0],
        expected_nullifiers: vec![n0, n1],
        should_prove: true,
        should_verify: true,
        notes: None,
    }]
}

pub fn scenario_withdraw_full() -> ScenarioOutput {
    let mut ctx = Ctx::new(crate::VECTOR_SEED.wrapping_add(4));
    let bl = rand_field(&mut ctx.rng);
    let in0 = make_note(2500, ctx.asset_a, ctx.owner, bl);
    let (tree, in_cs, in_idxs) = populate_tree(&[in0.clone()]);
    let n0 = nullifier(&ctx.nk, &in_cs[0], in_idxs[0]);

    let root = MerkleRoot(tree.compute_root_from_leaves());
    let ext = make_ext_data_hash("withdraw_full");

    let witness = TransferWitness {
        input_notes: vec![in0],
        input_paths: vec![tree.path_for(in_idxs[0])],
        input_indices: in_idxs,
        output_notes: vec![],
        spending_key: ctx.spending_key,
        public_amount: -2500,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    let public_inputs = PublicInputs {
        root,
        input_nullifiers: vec![n0],
        output_commitments: vec![],
        public_amount: -2500,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    vec![TestVector {
        name: "withdraw_full".into(),
        description: "Withdraw the entire balance of a 2500-unit note. No change note.".into(),
        witness,
        expected_public_inputs: public_inputs,
        expected_commitment_chain: vec![],
        expected_nullifiers: vec![n0],
        should_prove: true,
        should_verify: true,
        notes: Some("Negative public_amount signals withdrawal to the pool program.".into()),
    }]
}

pub fn scenario_partial_withdraw_with_change_note() -> ScenarioOutput {
    let mut ctx = Ctx::new(crate::VECTOR_SEED.wrapping_add(5));
    let bl = rand_field(&mut ctx.rng);
    let in0 = make_note(2000, ctx.asset_a, ctx.owner, bl);
    let (tree, in_cs, in_idxs) = populate_tree(&[in0.clone()]);

    let bl_change = rand_field(&mut ctx.rng);
    let change = make_note(1500, ctx.asset_a, ctx.owner, bl_change);
    let change_c = commitment(&change);
    let n0 = nullifier(&ctx.nk, &in_cs[0], in_idxs[0]);

    let root = MerkleRoot(tree.compute_root_from_leaves());
    let ext = make_ext_data_hash("partial_withdraw_with_change_note");

    let witness = TransferWitness {
        input_notes: vec![in0],
        input_paths: vec![tree.path_for(in_idxs[0])],
        input_indices: in_idxs,
        output_notes: vec![change],
        spending_key: ctx.spending_key,
        public_amount: -500,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    let public_inputs = PublicInputs {
        root,
        input_nullifiers: vec![n0],
        output_commitments: vec![change_c],
        public_amount: -500,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    vec![TestVector {
        name: "partial_withdraw_with_change_note".into(),
        description: "Withdraw 500 of a 2000-unit note; keep a 1500-unit change note shielded.".into(),
        witness,
        expected_public_inputs: public_inputs,
        expected_commitment_chain: vec![change_c],
        expected_nullifiers: vec![n0],
        should_prove: true,
        should_verify: true,
        notes: None,
    }]
}

// ============================================================================
// Negative cases — should_prove = false
// ============================================================================

pub fn scenario_invalid_value_conservation() -> ScenarioOutput {
    let mut ctx = Ctx::new(crate::VECTOR_SEED.wrapping_add(6));
    let bl0 = rand_field(&mut ctx.rng);
    let in0 = make_note(100, ctx.asset_a, ctx.owner, bl0);
    let (tree, in_cs, in_idxs) = populate_tree(&[in0.clone()]);

    // Output is 500 — strictly larger than input, with public_amount = 0.
    // Value conservation fails: sum(in) + public_amount != sum(out).
    let bl_out = rand_field(&mut ctx.rng);
    let out = make_note(500, ctx.asset_a, ctx.owner, bl_out);
    let out_c = commitment(&out);
    let n0 = nullifier(&ctx.nk, &in_cs[0], in_idxs[0]);

    let root = MerkleRoot(tree.compute_root_from_leaves());
    let ext = make_ext_data_hash("invalid_value_conservation");

    let witness = TransferWitness {
        input_notes: vec![in0],
        input_paths: vec![tree.path_for(in_idxs[0])],
        input_indices: in_idxs,
        output_notes: vec![out],
        spending_key: ctx.spending_key,
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    let public_inputs = PublicInputs {
        root,
        input_nullifiers: vec![n0],
        output_commitments: vec![out_c],
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    vec![TestVector {
        name: "invalid_value_conservation".into(),
        description: "Sum of inputs (100) + public_amount (0) ≠ sum of outputs (500). Circuit MUST reject.".into(),
        witness,
        expected_public_inputs: public_inputs,
        expected_commitment_chain: vec![out_c],
        expected_nullifiers: vec![n0],
        should_prove: false,
        should_verify: false,
        notes: Some("Negative test: a correct prover should refuse to produce a proof.".into()),
    }]
}

pub fn scenario_invalid_asset_mismatch() -> ScenarioOutput {
    let mut ctx = Ctx::new(crate::VECTOR_SEED.wrapping_add(7));
    let bl0 = rand_field(&mut ctx.rng);
    let in0 = make_note(1000, ctx.asset_a, ctx.owner, bl0);
    let (tree, in_cs, in_idxs) = populate_tree(&[in0.clone()]);

    // Output is asset B — but the circuit only handles a single asset per tx.
    let bl_out = rand_field(&mut ctx.rng);
    let out = make_note(1000, ctx.asset_b, ctx.owner, bl_out);
    let out_c = commitment(&out);
    let n0 = nullifier(&ctx.nk, &in_cs[0], in_idxs[0]);

    let root = MerkleRoot(tree.compute_root_from_leaves());
    let ext = make_ext_data_hash("invalid_asset_mismatch");

    let witness = TransferWitness {
        input_notes: vec![in0],
        input_paths: vec![tree.path_for(in_idxs[0])],
        input_indices: in_idxs,
        output_notes: vec![out],
        spending_key: ctx.spending_key,
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    let public_inputs = PublicInputs {
        root,
        input_nullifiers: vec![n0],
        output_commitments: vec![out_c],
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    vec![TestVector {
        name: "invalid_asset_mismatch".into(),
        description: "Input note is asset A but output note is asset B. Circuit MUST reject.".into(),
        witness,
        expected_public_inputs: public_inputs,
        expected_commitment_chain: vec![out_c],
        expected_nullifiers: vec![n0],
        should_prove: false,
        should_verify: false,
        notes: Some("Negative test: cross-asset transfer is disallowed per the single-asset circuit.".into()),
    }]
}

pub fn scenario_double_spend_same_nullifier() -> ScenarioOutput {
    let mut ctx = Ctx::new(crate::VECTOR_SEED.wrapping_add(8));
    let bl0 = rand_field(&mut ctx.rng);
    let in0 = make_note(400, ctx.asset_a, ctx.owner, bl0);
    let (tree, in_cs, in_idxs) = populate_tree(&[in0.clone()]);

    let bl_out = rand_field(&mut ctx.rng);
    let out_a = make_note(400, ctx.asset_a, ctx.owner, bl_out);
    let out_a_c = commitment(&out_a);
    let n0 = nullifier(&ctx.nk, &in_cs[0], in_idxs[0]);

    let root = MerkleRoot(tree.compute_root_from_leaves());
    let ext_first = make_ext_data_hash("double_spend_first");
    let ext_replay = make_ext_data_hash("double_spend_replay");

    let witness_first = TransferWitness {
        input_notes: vec![in0.clone()],
        input_paths: vec![tree.path_for(in_idxs[0])],
        input_indices: in_idxs.clone(),
        output_notes: vec![out_a.clone()],
        spending_key: ctx.spending_key,
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext_first,
    };
    let public_inputs_first = PublicInputs {
        root,
        input_nullifiers: vec![n0],
        output_commitments: vec![out_a_c],
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext_first,
    };

    // Replay: re-use the same nullifier with a different output.
    let bl_replay = rand_field(&mut ctx.rng);
    let out_replay = make_note(400, ctx.asset_a, ctx.owner, bl_replay);
    let out_replay_c = commitment(&out_replay);

    let witness_replay = TransferWitness {
        input_notes: vec![in0],
        input_paths: vec![tree.path_for(in_idxs[0])],
        input_indices: in_idxs,
        output_notes: vec![out_replay],
        spending_key: ctx.spending_key,
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext_replay,
    };
    let public_inputs_replay = PublicInputs {
        root,
        input_nullifiers: vec![n0],
        output_commitments: vec![out_replay_c],
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext_replay,
    };

    vec![
        TestVector {
            name: "double_spend_same_nullifier__first".into(),
            description: "Initial spend of a 400-unit note. Both the proof and the on-chain submission MUST succeed.".into(),
            witness: witness_first,
            expected_public_inputs: public_inputs_first,
            expected_commitment_chain: vec![out_a_c],
            expected_nullifiers: vec![n0],
            should_prove: true,
            should_verify: true,
            notes: Some("Step 1 of 2 — submit this first.".into()),
        },
        TestVector {
            name: "double_spend_same_nullifier__replay".into(),
            description: "Same input note re-spent. The proof itself is still cryptographically valid, but the on-chain program MUST reject because the nullifier already exists.".into(),
            witness: witness_replay,
            expected_public_inputs: public_inputs_replay,
            expected_commitment_chain: vec![out_replay_c],
            expected_nullifiers: vec![n0],
            should_prove: true,
            should_verify: false,
            notes: Some("Step 2 of 2 — must be rejected on-chain.".into()),
        },
    ]
}

pub fn scenario_root_not_in_history() -> ScenarioOutput {
    let mut ctx = Ctx::new(crate::VECTOR_SEED.wrapping_add(9));
    let bl0 = rand_field(&mut ctx.rng);
    let in0 = make_note(600, ctx.asset_a, ctx.owner, bl0);
    let (tree, in_cs, in_idxs) = populate_tree(&[in0.clone()]);

    let bl_out = rand_field(&mut ctx.rng);
    let out = make_note(600, ctx.asset_a, ctx.owner, bl_out);
    let out_c = commitment(&out);
    let n0 = nullifier(&ctx.nk, &in_cs[0], in_idxs[0]);

    // Fabricated root that doesn't match any tree state and is not in the
    // on-chain history window.
    let mut bogus = [0u8; 32];
    bogus[31] = 0xEE;
    bogus[0] = 0;
    let root = MerkleRoot(bogus);
    let ext = make_ext_data_hash("root_not_in_history");

    let witness = TransferWitness {
        input_notes: vec![in0],
        input_paths: vec![tree.path_for(in_idxs[0])],
        input_indices: in_idxs,
        output_notes: vec![out],
        spending_key: ctx.spending_key,
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    let public_inputs = PublicInputs {
        root,
        input_nullifiers: vec![n0],
        output_commitments: vec![out_c],
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    vec![TestVector {
        name: "root_not_in_history".into(),
        description: "Witness references a Merkle root that is not in the on-chain ROOT_HISTORY_SIZE = 256 window. The on-chain program MUST reject.".into(),
        witness,
        expected_public_inputs: public_inputs,
        expected_commitment_chain: vec![out_c],
        expected_nullifiers: vec![n0],
        should_prove: true,
        should_verify: false,
        notes: Some("Witness internally inconsistent: a real prover would fail the Merkle inclusion check. We mark should_prove = true because the failure mode under test here is the on-chain root-history check; testers should construct a separate proof bundle whose public `root` is the bogus one above without altering the rest of the bundle.".into()),
    }]
}

pub fn scenario_amount_overflow() -> ScenarioOutput {
    let mut ctx = Ctx::new(crate::VECTOR_SEED.wrapping_add(10));
    // The circuit range-checks each amount to 64 bits and the sum to 64 bits
    // as well. We construct an out-of-range note by setting amount to u64::MAX
    // and a second output that would cause a sum > 2^64-1.
    let bl0 = rand_field(&mut ctx.rng);
    let in0 = make_note(u64::MAX, ctx.asset_a, ctx.owner, bl0);
    let (tree, in_cs, in_idxs) = populate_tree(&[in0.clone()]);

    let bl_out0 = rand_field(&mut ctx.rng);
    let bl_out1 = rand_field(&mut ctx.rng);
    // u64::MAX - 1 + 2 = u64::MAX + 1 → overflow.
    let out0 = make_note(u64::MAX - 1, ctx.asset_a, ctx.owner, bl_out0);
    let out1 = make_note(2, ctx.asset_a, ctx.owner, bl_out1);
    let out_c0 = commitment(&out0);
    let out_c1 = commitment(&out1);
    let n0 = nullifier(&ctx.nk, &in_cs[0], in_idxs[0]);

    let root = MerkleRoot(tree.compute_root_from_leaves());
    let ext = make_ext_data_hash("amount_overflow");

    let witness = TransferWitness {
        input_notes: vec![in0],
        input_paths: vec![tree.path_for(in_idxs[0])],
        input_indices: in_idxs,
        output_notes: vec![out0, out1],
        spending_key: ctx.spending_key,
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    let public_inputs = PublicInputs {
        root,
        input_nullifiers: vec![n0],
        output_commitments: vec![out_c0, out_c1],
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext,
    };
    vec![TestVector {
        name: "amount_overflow".into(),
        description: "Output amounts sum exceeds 2^64 - 1. The 64-bit range check inside the circuit MUST reject this witness.".into(),
        witness,
        expected_public_inputs: public_inputs,
        expected_commitment_chain: vec![out_c0, out_c1],
        expected_nullifiers: vec![n0],
        should_prove: false,
        should_verify: false,
        notes: Some("Negative test: range-check failure.".into()),
    }]
}

pub fn scenario_ext_data_binding_mismatch() -> ScenarioOutput {
    let mut ctx = Ctx::new(crate::VECTOR_SEED.wrapping_add(11));
    let bl0 = rand_field(&mut ctx.rng);
    let in0 = make_note(800, ctx.asset_a, ctx.owner, bl0);
    let (tree, in_cs, in_idxs) = populate_tree(&[in0.clone()]);

    let bl_out = rand_field(&mut ctx.rng);
    let out = make_note(800, ctx.asset_a, ctx.owner, bl_out);
    let out_c = commitment(&out);
    let n0 = nullifier(&ctx.nk, &in_cs[0], in_idxs[0]);

    let root = MerkleRoot(tree.compute_root_from_leaves());
    let ext_in_proof = make_ext_data_hash("ext_data_binding_in_proof");
    let ext_in_tx = make_ext_data_hash("ext_data_binding_in_tx");

    // Witness binds proof to `ext_in_proof`, but the on-chain transaction
    // will carry `ext_in_tx` — the program recomputes the ext-data hash
    // from the tx payload and compares to the public input, so this MUST
    // be rejected on-chain even though the proof verifies.
    let witness = TransferWitness {
        input_notes: vec![in0],
        input_paths: vec![tree.path_for(in_idxs[0])],
        input_indices: in_idxs,
        output_notes: vec![out],
        spending_key: ctx.spending_key,
        public_amount: 0,
        asset_id: ctx.asset_a,
        ext_data_hash: ext_in_proof,
    };
    let public_inputs = PublicInputs {
        root,
        input_nullifiers: vec![n0],
        output_commitments: vec![out_c],
        public_amount: 0,
        asset_id: ctx.asset_a,
        // Vector reports the *on-chain* ext_data_hash that the program will
        // compute — different from the one bound into the proof.
        ext_data_hash: ext_in_tx,
    };
    vec![TestVector {
        name: "ext_data_binding_mismatch".into(),
        description: "Proof is cryptographically valid and binds to ext_data_hash = ext_in_proof, but the on-chain transaction's recomputed ext_data_hash differs. Program MUST reject.".into(),
        witness,
        expected_public_inputs: public_inputs,
        expected_commitment_chain: vec![out_c],
        expected_nullifiers: vec![n0],
        should_prove: true,
        should_verify: false,
        notes: Some("Negative test: ext_data binding enforced by program, not by circuit.".into()),
    }]
}

// ============================================================================
// Entry point
// ============================================================================

/// Run every scenario, in a fixed order, and return the flat list of vectors.
pub fn all_scenarios() -> Vec<TestVector> {
    let mut out = Vec::new();
    out.extend(scenario_deposit_only());
    out.extend(scenario_transfer_2in_2out_same_asset());
    out.extend(scenario_transfer_1in_2out_split());
    out.extend(scenario_transfer_2in_1out_merge());
    out.extend(scenario_withdraw_full());
    out.extend(scenario_partial_withdraw_with_change_note());
    out.extend(scenario_invalid_value_conservation());
    out.extend(scenario_invalid_asset_mismatch());
    out.extend(scenario_double_spend_same_nullifier());
    out.extend(scenario_root_not_in_history());
    out.extend(scenario_amount_overflow());
    out.extend(scenario_ext_data_binding_mismatch());
    out
}

// `empty_path` is reserved for future scenarios that build out manually-
// authored witnesses. Kept here so it stays in tree.
#[allow(dead_code)]
fn _retain_helpers() {
    let _ = empty_path;
}
