import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCarryFlatReconciliation,
  hasExactCarryFlatReconciliation,
} from "../src/execution/carry-reconciliation.js";

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
  ]) {
    const evidence = exactEvidence();
    mutate(evidence);
    assert.equal(hasExactCarryFlatReconciliation(evidence, PAIR, binding()), false);
  }
});

function exactEvidence() {
  return {
    owner_commitment: "owner:carry:reconciliation:0001",
    carry_position_id: "carry:position:reconciliation:0001",
    account_state_checked: true,
    transaction_broadcast: false,
    gross_exposure_micro_usdc: 0,
    open_order_count: 0,
    checked_at_ms: 1_800_000_000_000,
    reconciliation_commitment: "carry:reconciliation:exact:0001",
    venues: PAIR.map((venue_id) => ({
      venue_id,
      account_commitment: `account:${venue_id}:reconciliation:0001`,
      authorized: true,
      flat_zero_orders: true,
      position_count: 0,
      open_order_count: 0,
      account_state_checked: true,
    })),
  };
}

function binding() {
  return {
    owner_commitment: "owner:carry:reconciliation:0001",
    carry_position_id: "carry:position:reconciliation:0001",
    account_commitments: Object.fromEntries(PAIR.map((venueId) => [venueId, `account:${venueId}:reconciliation:0001`])),
  };
}
