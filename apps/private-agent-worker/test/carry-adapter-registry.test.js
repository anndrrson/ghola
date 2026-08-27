import assert from "node:assert/strict";
import test from "node:test";
import {
  CARRY_EXECUTION_VENUES,
  carryExecutionQualification,
  venueAdapterCapability,
} from "@ghola/execution-core";
import {
  readCarryFundingSettlements,
  registeredCarryAdapterId,
} from "../src/execution/private-execution.js";

test("worker Carry dispatch follows the execution-core capability registry", () => {
  for (const venueId of CARRY_EXECUTION_VENUES) {
    assert.equal(
      registeredCarryAdapterId(venueId, "carry_execution"),
      venueAdapterCapability(venueId, "carry_execution").adapter_id,
    );
    assert.equal(
      registeredCarryAdapterId(venueId, "no_submit_reconciliation"),
      venueAdapterCapability(venueId, "no_submit_reconciliation").adapter_id,
    );
  }
});

test("shadow-only candidates cannot enter worker Carry dispatch", () => {
  for (const venueId of ["edgex", "dydx"]) {
    assert.equal(carryExecutionQualification(venueId).eligible, false);
    assert.ok(carryExecutionQualification(venueId).gaps.includes("adapter_missing:no_submit_reconciliation"));
    assert.equal(registeredCarryAdapterId(venueId, "carry_execution"), null);
    assert.equal(registeredCarryAdapterId(venueId, "no_submit_reconciliation"), null);
  }
});

test("Carry funding history dispatches through the registered Aster adapter", async (t) => {
  const priorDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  const priorFetch = globalThis.fetch;
  process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
  let requestUrl = "";
  globalThis.fetch = async (url) => {
    requestUrl = String(url);
    return {
      ok: true,
      json: async () => [{ time: 1_800_000_000_100, income: "0.01", asset: "USDT", tranId: 42 }],
    };
  };
  t.after(() => {
    globalThis.fetch = priorFetch;
    if (priorDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = priorDryRun;
  });

  const rows = await readCarryFundingSettlements({
    body: {
      venue_id: "aster",
      asset: "BTC",
      start_time_ms: 1_800_000_000_000,
      end_time_ms: 1_800_000_001_000,
    },
    recipient: {},
    state: {},
  });
  assert.match(requestUrl, /\/fapi\/v1\/income/);
  assert.deepEqual(rows, [{
    venue_id: "aster",
    asset: "BTC",
    occurred_at_ms: 1_800_000_000_100,
    amount_quote: "0.01",
    quote_asset: "USDT",
    settlement_id: "42",
  }]);
});
