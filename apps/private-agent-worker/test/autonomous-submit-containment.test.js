import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autonomousLiveSubmitEnabled } from "../src/execution/autonomous-submit-containment.js";

const exactPolicy = {
  strategy_id: "level_trigger_v1",
  venue_allowlist: ["hyperliquid"],
  market_allowlist: ["HYPE-USD"],
  execution_network: "testnet",
  exact_notional_usd: "26",
  max_notional_bucket: "50",
};

describe("autonomous submit containment", () => {
  it("admits only the exact Hyperliquid plan on shared Postgres", () => {
    assert.equal(autonomousLiveSubmitEnabled({
      strategyId: "level_trigger_v1", venue: "hyperliquid", policy: exactPolicy, state: { path: "postgres" },
    }), true);
    assert.equal(autonomousLiveSubmitEnabled({
      strategyId: "level_trigger_v1", venue: "hyperliquid", policy: exactPolicy, state: { path: "json" },
    }), false);
    assert.equal(autonomousLiveSubmitEnabled({
      strategyId: "level_trigger_v1", venue: "hyperliquid", policy: { ...exactPolicy, exact_notional_usd: "" }, state: { path: "postgres" },
    }), false);
    assert.equal(autonomousLiveSubmitEnabled({
      strategyId: "momentum_micro_trader", venue: "hyperliquid", policy: exactPolicy, state: { path: "postgres" },
    }), false);
  });

  it("admits SQLite only while the worker is explicitly dry-run", () => {
    const before = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
    assert.equal(autonomousLiveSubmitEnabled({
      strategyId: "level_trigger_v1", venue: "hyperliquid", policy: exactPolicy, state: { path: "/tmp/e2e.sqlite" },
    }), true);
    if (before === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = before;
  });
});
