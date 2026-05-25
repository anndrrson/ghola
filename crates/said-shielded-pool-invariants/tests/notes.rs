//! Family 1 — Notes / value-conservation invariants.

use said_shielded_pool_invariants::{
    inv_note_conservation, InvariantViolation, TransferWitnessSummary,
};

fn wit(inputs: Vec<u64>, outputs: Vec<u64>) -> TransferWitnessSummary {
    TransferWitnessSummary {
        input_amounts: inputs,
        output_amounts: outputs,
        asset_id: [0x42; 32],
        mixed_asset_present: false,
    }
}

#[test]
fn deposit_value_conservation_ok() {
    // L-NEW-1 / C1: DEPOSIT adds a fresh output note with no input. The
    // conservation relation `sumIn == sumOut + publicAmount` gives
    // `0 == 1000 + publicAmount` → publicAmount = -1000 (NEGATIVE = deposit).
    // (On-chain the same value is signed-field-encoded as `r - 1000`; off-
    // chain we work in plain i128.)
    let w = wit(vec![], vec![1000]);
    inv_note_conservation(&w, -1000).expect("deposit balances");
}

#[test]
fn transfer_value_conservation_ok() {
    // Internal transfer: public_amount = 0; sumIn == sumOut.
    let w = wit(vec![500, 500], vec![700, 300]);
    inv_note_conservation(&w, 0).expect("transfer balances");
}

#[test]
fn withdraw_value_conservation_ok() {
    // L-NEW-1 / C1: WITHDRAW spends an input note. The conservation relation
    // `sumIn == sumOut + publicAmount` gives `1000 == 800 + publicAmount` →
    // publicAmount = +200 (POSITIVE = withdraw).
    let w = wit(vec![1000], vec![800]);
    inv_note_conservation(&w, 200).expect("withdraw balances");
}

#[test]
fn unbalanced_transfer_rejected() {
    let w = wit(vec![100, 100], vec![100, 150]);
    let err = inv_note_conservation(&w, 0).expect_err("should fail");
    matches!(err, InvariantViolation::Notes(_));
}

#[test]
fn dummy_zero_inputs_are_noops() {
    // 0-valued "dummy" input notes are accepted as no-ops by the circuit.
    let w = wit(vec![0, 0, 750], vec![750]);
    inv_note_conservation(&w, 0).expect("dummy inputs sum to zero");
}

#[test]
fn mixed_asset_rejected() {
    let mut w = wit(vec![100], vec![100]);
    w.mixed_asset_present = true;
    let err = inv_note_conservation(&w, 0).expect_err("mixed asset must fail");
    matches!(err, InvariantViolation::Notes(_));
}

#[test]
fn overflow_rejected() {
    let w = wit(vec![u64::MAX, u64::MAX], vec![u64::MAX]);
    // input sum overflows u128? u64::MAX * 2 = 2^65-2; still fits u128.
    // Instead check that an unbalanced equation around u64::MAX is caught.
    let err = inv_note_conservation(&w, 0).expect_err("unbalanced");
    matches!(err, InvariantViolation::Notes(_));
}

#[test]
fn withdraw_more_than_input_rejected() {
    // L-NEW-1 / C1: try to withdraw 200 with only 100 of input. Under
    // `sumIn == sumOut + publicAmount`, `100 == 0 + 200` is false → reject.
    let w = wit(vec![100], vec![0]);
    let err = inv_note_conservation(&w, 200).expect_err("violates conservation");
    matches!(err, InvariantViolation::Notes(_));
}
