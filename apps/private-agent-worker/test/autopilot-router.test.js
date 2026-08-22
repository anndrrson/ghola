import assert from "node:assert/strict";
import test from "node:test";
import { routeModelProposal } from "../src/execution/autopilot-router.js";

const NOW = new Date("2027-01-15T00:00:00.000Z");

function session(overrides = {}) {
  return {
    daily_notional_used_bucket: "0",
    session_policy: {
      venue_allowlist: ["jupiter", "coinbase_advanced", "hyperliquid"],
      max_notional_bucket: "50",
      max_daily_notional_bucket: "250",
      max_slippage_bps: 50,
      min_net_edge_bps: 5,
      data_max_age_ms: 30_000,
    },
    venue_access: {
      jupiter: { status: "ready" },
      coinbase_advanced: { status: "ready" },
      hyperliquid: { status: "ready" },
    },
    ...overrides,
  };
}

function market(overrides = {}) {
  return {
    product_id: "SOL-USD",
    price: 100,
    spread_bps: 4,
    available_liquidity_usd: 1_000,
    latency_ms: 25,
    fetched_at: NOW.toISOString(),
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    version: 2,
    action: "trade",
    objective: "best_execution",
    market: "SOL-USD",
    side: "buy",
    confidence_bps: 8_000,
    ...overrides,
  };
}

test("model proposal cannot choose venue or size; router selects both from costs and mandate caps", () => {
  const result = routeModelProposal({
    session: session(),
    market: market(),
    decision: decision({ venue_id: "coinbase_advanced", quote_size_usd: 99_999 }),
    signal_bps: 100,
    env: {
      PRIVATE_AGENT_ROUTER_JUPITER_FEE_BPS: "10",
      PRIVATE_AGENT_ROUTER_COINBASE_ADVANCED_FEE_BPS: "60",
    },
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.venue_id, "jupiter");
  assert.equal(result.notional_usd, 50);
  assert.equal(result.routing.selected.expected_net_benefit_bps, 88);
});

test("router fails closed when costs erase deterministic signal benefit", () => {
  const result = routeModelProposal({
    session: session({
      venue_access: {
        jupiter: { status: "ready" },
        coinbase_advanced: { status: "down" },
        hyperliquid: { status: "down" },
      },
    }),
    market: market(),
    decision: decision(),
    signal_bps: 5,
    env: { PRIVATE_AGENT_ROUTER_JUPITER_FEE_BPS: "10" },
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_route_passed");
});

test("single-leg path rejects hedge and carry proposals", () => {
  const result = routeModelProposal({
    session: session(),
    market: market(),
    decision: decision({ objective: "delta_neutral_carry" }),
    signal_bps: 100,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "protected_multi_leg_strategy_required");
});
