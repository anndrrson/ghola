import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCrossVenueCoordinator,
  resetCrossVenueCoordinatorForTests,
  validateCrossVenueExecutionRequest,
} from "../src/execution/cross-venue.js";

describe("coordinated cross-venue execution", () => {
  it("validates two opposite, matched IOC legs and bounded risk", () => {
    const plan = execution();
    assert.deepEqual(validateCrossVenueExecutionRequest(plan), []);
    assert.ok(validateCrossVenueExecutionRequest({ ...plan, legs: [plan.legs[0], plan.legs[0]] }).includes("leg venues must be distinct"));
    assert.ok(validateCrossVenueExecutionRequest({
      ...plan,
      risk_budget: { ...plan.risk_budget, max_hedge_slippage_bps: 101 },
    }).includes("hedge slippage budget is invalid"));
  });

  it("submits both legs concurrently and repairs residual exposure", async () => {
    resetCrossVenueCoordinatorForTests();
    const attempts = new Map();
    const reports = [];
    const submitted = [];
    const coordinator = createCrossVenueCoordinator({
      state: memoryState(attempts),
      adapter: {
        preflight: async () => ({ ok: true }),
        submit: async ({ leg }) => {
          submitted.push(leg.leg_id);
          return {
            filled_notional_micro_usdc: leg.side === "buy" ? 5_000_000 : 4_000_000,
            venue_order_reference: `${leg.venue_id}:order`,
          };
        },
        hedge: async ({ notional_micro_usdc }) => ({
          filled_notional_micro_usdc: notional_micro_usdc,
          venue_order_reference: "hyperliquid:hedge",
          slippage_bps: 8,
        }),
        unwind: async () => { throw new Error("unwind_should_not_run"); },
        cancel: async () => ({ ok: true }),
      },
      callback: async (payload) => { reports.push(payload.report); },
    });
    const accepted = await coordinator.submit(execution());
    assert.equal(accepted.ok, true);
    await waitFor(() => reports.some((report) => report.phase === "complete"));
    assert.equal(submitted.length, 2);
    assert.deepEqual(reports.map((report) => report.sequence), [2, 3, 4]);
    assert.equal(reports.at(-1).phase, "complete");
    assert.equal(reports.at(-1).legs[0].filled_notional_micro_usdc, 5_000_000);
    assert.equal(reports.at(-1).legs[1].filled_notional_micro_usdc, 4_000_000);
    assert.equal(reports.at(-1).repair_fills[0].side, "sell");
    assert.equal(reports.at(-1).repair_fills[0].filled_notional_micro_usdc, 1_000_000);

    const replay = await coordinator.submit(execution());
    assert.equal(replay.replayed, true);
    assert.equal(submitted.length, 2);
  });

  it("does not pretend execution is available without all five adapter controls", async () => {
    const coordinator = createCrossVenueCoordinator({
      state: memoryState(new Map()),
      adapter: null,
      callback: async () => {},
    });
    const result = await coordinator.submit(execution());
    assert.equal(result.ok, false);
    assert.equal(result.error, "cross_venue_byo_adapter_unavailable");
  });
});

function execution() {
  const executionId = `consumer_cross_venue_execution_${"a".repeat(48)}`;
  return {
    version: 1,
    execution_id: executionId,
    owner_commitment: "owner_cross_venue_test",
    opportunity_commitment: "ghola_opportunity_cross_venue_test",
    market: "SOL-USD",
    matched_notional_micro_usdc: 5_000_000,
    risk_budget: {
      max_unhedged_notional_micro_usdc: 5_000_000,
      max_hedge_slippage_bps: 25,
      max_hedge_duration_ms: 5_000,
      max_unwind_loss_micro_usdc: 250_000,
      max_daily_loss_micro_usdc: 5_000_000,
    },
    legs: [
      {
        leg_id: "consumer_cross_leg_buy_test",
        venue_id: "hyperliquid",
        side: "buy",
        symbol: "SOL",
        limit_price: "150",
        target_notional_micro_usdc: 5_000_000,
        order_type: "ioc_limit",
      },
      {
        leg_id: "consumer_cross_leg_sell_test",
        venue_id: "phoenix",
        side: "sell",
        symbol: "SOL-PERP",
        limit_price: "151",
        target_notional_micro_usdc: 5_000_000,
        order_type: "ioc_limit",
      },
    ],
  };
}

function memoryState(attempts) {
  return {
    async getExecutionAttempt(id) { return attempts.get(id) || null; },
    async putExecutionAttempt(id, attempt) { attempts.set(id, attempt); return attempt; },
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition_not_reached");
}
