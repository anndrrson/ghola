import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCarryFlatReconciliation,
  carryReconciliationCommitment,
  hasExactCarryFlatReconciliation,
} from "../src/execution/carry-reconciliation.js";
import {
  carryInventoryExpectation,
  carryInventoryPositionIdentityCommitment,
} from "../src/execution/carry-inventory.js";

const PAIR = ["hyperliquid", "aster"];

test("accepts only exact venue-specific flat reconciliation", () => {
  const evidence = exactEvidence();
  const expected = binding();
  assert.equal(hasExactCarryFlatReconciliation(evidence, PAIR, expected), true);
  assert.deepEqual(assessCarryFlatReconciliation({ evidence, venue_ids: PAIR, ...expected }).venues.map((item) => item.venue_id), PAIR);
});

test("rejects aggregate-only, unsafe, duplicate, and residual venue claims", () => {
  for (const mutate of [
    (value) => { delete value.venues; },
    (value) => { value.transaction_broadcast = true; },
    (value) => { value.venues[1].venue_id = "hyperliquid"; },
    (value) => { value.venues[1].position_count = 1; value.venues[1].flat_zero_orders = false; },
    (value) => { value.venues[1].open_order_count = 1; value.venues[1].flat_zero_orders = false; },
    (value) => { value.owner_commitment = "owner:carry:wrong:0001"; },
    (value) => { value.carry_position_id = "carry:position:wrong:0001"; },
    (value) => { value.venues[1].account_commitment = "account:aster:wrong:0001"; },
    (value) => { value.reconciliation_commitment = "carry:reconciliation:arbitrary:0001"; },
    (value) => { value.venues[1].inventory.target_market = "ETH-PERP"; },
  ]) {
    const evidence = exactEvidence();
    mutate(evidence);
    assert.equal(hasExactCarryFlatReconciliation(evidence, PAIR, binding()), false);
  }
});

test("rejects malformed persisted inventory expectations", () => {
  for (const mutate of [
    (value) => { value.aster.expected_carry_open_order_count = null; },
    (value) => { value.aster.entry_provider_ref_commitment = null; },
    (value) => { value.aster.side = null; },
  ]) {
    const expected = binding();
    expected.inventory_expectations = structuredClone(expected.inventory_expectations);
    mutate(expected.inventory_expectations);
    assert.equal(hasExactCarryFlatReconciliation(exactEvidence(), PAIR, expected), false);
  }
});

function exactEvidence() {
  const evidence = {
    owner_commitment: "owner:carry:reconciliation:0001",
    carry_position_id: "carry:position:reconciliation:0001",
    account_state_checked: true,
    transaction_broadcast: false,
    gross_exposure_micro_usdc: 0,
    open_order_count: 0,
    checked_at_ms: 1_800_000_000_000,
    venues: PAIR.map((venue_id) => ({
      venue_id,
      account_commitment: `account:${venue_id}:reconciliation:0001`,
      authorized: true,
      flat_zero_orders: true,
      position_count: 0,
      open_order_count: 0,
      account_state_checked: true,
      position_identity_commitment: carryInventoryPositionIdentityCommitment({
        venue_id,
        account_commitment: `account:${venue_id}:reconciliation:0001`,
        market: "BTC-PERP",
      }),
      inventory: {
        version: 1,
        target_market: "BTC-PERP",
        position_inventory_verified: true,
        open_order_inventory_verified: true,
        target_positions: [],
        target_open_orders: [],
      },
    })),
  };
  evidence.reconciliation_commitment = carryReconciliationCommitment(evidence);
  return evidence;
}

function binding() {
  return {
    owner_commitment: "owner:carry:reconciliation:0001",
    carry_position_id: "carry:position:reconciliation:0001",
    account_commitments: Object.fromEntries(PAIR.map((venueId) => [venueId, `account:${venueId}:reconciliation:0001`])),
    inventory_expectations: Object.fromEntries(PAIR.map((venueId) => [venueId, carryInventoryExpectation({
      venue_id: venueId,
      account_commitment: `account:${venueId}:reconciliation:0001`,
      market: "BTC-PERP",
      side: venueId === "hyperliquid" ? "buy" : "sell",
      base_size: "0.001",
      entry_work_order_commitment: `work:carry:${venueId}:reconciliation:0001`,
      entry_provider_ref_commitment: `provider:carry:${venueId}:reconciliation:0001`,
    })])),
  };
}
