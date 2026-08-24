import assert from "node:assert/strict";
import test from "node:test";
import { routeModelProposal } from "../src/execution/autopilot-router.js";
import { venueStateForRouting } from "../src/execution/venue-readiness.js";

const NOW = 1_800_000_000_000;
const DRIFT_CAPABILITIES = {
  market_data: true,
  funding: true,
  fees: true,
  orders: true,
  positions: true,
  collateral: true,
  reconciliation: true,
  delegated_signing: true,
  cancel: true,
  reduce_only: true,
};

test("keeps Drift quarantined even when configuration claims readiness", () => {
  const state = venueStateForRouting({
    venue_id: "drift",
    access: {
      status: "ready",
      adapter_id: "drift_turnkey_v1",
      execution_mode: "user_stealth",
      no_submit_proof: {
        status: "verified_no_funds",
        transaction_broadcast: false,
        turnkey_policy_checked: true,
        account_state_checked: true,
        order_request_checked: true,
        dependency_audit: "pass",
        verified_at_ms: NOW,
        capabilities: DRIFT_CAPABILITIES,
      },
    },
    market_observed_at_ms: NOW,
    now_ms: NOW,
    env: { PRIVATE_AGENT_DRIFT_ADAPTER_ENABLED: "true" },
  });
  assert.equal(state.status, "quarantined");
  assert.ok(state.quarantine_reasons.includes("drift_runtime_quarantined"));
  assert.equal(state.capabilities.orders, false);
});

test("quarantines pooled custody and preserves negative capability evidence", () => {
  const pooled = venueStateForRouting({
    venue_id: "jupiter",
    access: { status: "ready", execution_mode: "ghola_pooled" },
    market_observed_at_ms: NOW,
    now_ms: NOW,
    env: {},
  });
  assert.equal(pooled.status, "quarantined");
  assert.ok(pooled.quarantine_reasons.includes("pooled_custody_forbidden"));

  const hyperliquid = venueStateForRouting({
    venue_id: "hyperliquid",
    access: { status: "ready", execution_mode: "user_stealth", capabilities: { reconciliation: false } },
    market_observed_at_ms: NOW,
    now_ms: NOW,
  });
  assert.equal(hyperliquid.status, "ready");
  assert.equal(hyperliquid.capabilities.reconciliation, false);
});

test("router cannot select the quarantined Drift placeholder", () => {
  const result = routeModelProposal({
    session: {
      daily_notional_used_bucket: "0",
      session_policy: {
        venue_allowlist: ["drift"],
        max_notional_bucket: "50",
        max_daily_notional_bucket: "250",
        max_slippage_bps: 50,
        min_net_edge_bps: 5,
        data_max_age_ms: 30_000,
      },
      venue_access: { drift: { status: "ready", execution_mode: "user_stealth" } },
    },
    market: { product_id: "SOL-USD", price: 100, spread_bps: 2, fetched_at: new Date(NOW).toISOString() },
    decision: { version: 2, action: "trade", objective: "best_execution", market: "SOL-USD", side: "buy" },
    signal_bps: 100,
    now: new Date(NOW),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_routable_venue");
});

test("new perp venues remain fail-closed until implementation and live qualification both pass", () => {
  for (const venueId of ["lighter", "aster", "edgex", "dydx"]) {
    const state = venueStateForRouting({
      venue_id: venueId,
      access: {
        status: "ready",
        execution_mode: "user_stealth",
        capabilities: DRIFT_CAPABILITIES,
      },
      market_observed_at_ms: NOW,
      now_ms: NOW,
      env: {},
    });
    assert.equal(state.status, "quarantined");
    const expectedStatus = venueId === "lighter" || venueId === "aster"
      ? "implemented_unproven"
      : "unimplemented";
    assert.ok(state.quarantine_reasons.includes(`worker_route_${expectedStatus}`));
  }
});
