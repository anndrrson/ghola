import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bestArbitrageOpportunity,
  enforceArbitrageLiveConfig,
} from "../src/execution/arbitrage.js";
import {
  createAutopilotSession,
  runAutopilotTick,
} from "../src/execution/autopilot.js";
import { createWorkerState } from "../src/state/private-state.js";

const OLD_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...OLD_ENV };
}

describe("guarded arbitrage autopilot", () => {
  let dir;

  beforeEach(() => {
    resetEnv();
    dir = mkdtempSync(join(tmpdir(), "ghola-arb-"));
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
    process.env.PRIVATE_AGENT_ARB_SIGNAL_MODE = "force";
    process.env.PRIVATE_AGENT_ARB_FORCE_BUY_PRICE = "100";
    process.env.PRIVATE_AGENT_ARB_FORCE_SELL_PRICE = "103";
    process.env.PRIVATE_AGENT_ARB_LIVE_SUBMIT = "true";
    process.env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD = "25";
    process.env.PRIVATE_AGENT_ARB_DAILY_NOTIONAL_CAP_USD = "100";
    process.env.PRIVATE_AGENT_ARB_MIN_NET_EDGE_BPS = "25";
    process.env.PRIVATE_AGENT_ARB_MAX_EXECUTION_SKEW_MS = "2000";
  });

  afterEach(() => {
    resetEnv();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("finds a hedged spread only when net edge clears costs", async () => {
    const session = sessionStub();
    const found = await bestArbitrageOpportunity({
      session,
      env: process.env,
      now: new Date("2026-06-03T12:00:00.000Z"),
    });

    assert.equal(found.ok, true);
    assert.equal(found.buy_venue, "coinbase_advanced");
    assert.equal(found.sell_venue, "hyperliquid");
    assert.equal(found.market, "SOL-USD");
    assert.ok(found.net_edge_bps >= 25);

    process.env.PRIVATE_AGENT_ARB_FORCE_SELL_PRICE = "100.01";
    const rejected = await bestArbitrageOpportunity({
      session,
      env: process.env,
      now: new Date("2026-06-03T12:01:00.000Z"),
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, "net_edge_below_threshold");
  });

  it("fails closed when config-only live caps are absent", () => {
    const session = sessionStub();
    delete process.env.PRIVATE_AGENT_ARB_MAX_LEG_NOTIONAL_USD;

    const checked = enforceArbitrageLiveConfig({
      session,
      env: process.env,
      requestedNotionalUsd: 10,
    });

    assert.equal(checked.ok, false);
    assert.equal(checked.reason_codes.includes("max_leg_notional_required"), true);
  });

  it("fetches live venue snapshots concurrently", async () => {
    delete process.env.PRIVATE_AGENT_ARB_SIGNAL_MODE;
    let active = 0;
    let maxActive = 0;
    const found = await bestArbitrageOpportunity({
      session: sessionStub(),
      env: process.env,
      now: new Date("2026-06-03T12:02:00.000Z"),
      fetchImpl: async (url) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(15);
        active -= 1;
        if (String(url).includes("coinbase.com")) {
          return jsonResponse({ price: "100" });
        }
        return jsonResponse({ SOL: "103" });
      },
    });

    assert.equal(found.ok, true);
    assert.ok(maxActive > 1);
  });

  it("rejects opportunities when live quote skew exceeds the execution budget", async () => {
    delete process.env.PRIVATE_AGENT_ARB_SIGNAL_MODE;
    process.env.PRIVATE_AGENT_ARB_MAX_MARKET_DATA_SKEW_MS = "1";

    const rejected = await bestArbitrageOpportunity({
      session: sessionStub(),
      env: process.env,
      now: new Date("2026-06-03T12:03:00.000Z"),
      fetchImpl: async (url) => {
        if (String(url).includes("hyperliquid")) await delay(20);
        return String(url).includes("coinbase.com")
          ? jsonResponse({ price: "100" })
          : jsonResponse({ SOL: "103" });
      },
    });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, "market_data_skew_exceeded");
  });

  it("submits and records a bounded dry-run arbitrage pair", async () => {
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-arb-worker" };
    const now = new Date(Date.now() + 60_000);
    const created = await createAutopilotSession({
      body: {
        owner_commitment: "owner_arb_test",
        session_policy: {
          strategy_id: "hedged_spread_arbitrage_v1",
          venue_allowlist: ["coinbase_advanced", "hyperliquid"],
          market_allowlist: ["SOL-USD"],
          max_notional_bucket: "25",
          max_daily_notional_bucket: "100",
          max_order_count: 10,
          ttl_ms: 2 * 60 * 60_000,
          max_slippage_bps: 5,
          min_net_edge_bps: 25,
        },
        venue_access: {
          coinbase_advanced: { status: "ready", execution_mode: "byo_api_key" },
          hyperliquid: { status: "ready", execution_mode: "byo_api_key" },
        },
      },
      recipient,
      state,
      provider: "test",
      startLoop: false,
      now,
    });

    assert.equal(created.strategy.strategy_id, "hedged_spread_arbitrage_v1");
    assert.equal(created.status, "running");

    const tick = await runAutopilotTick({
      sessionId: created.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });

    assert.equal(tick.ok, true);
    assert.equal(tick.receipts.length, 2);
    const updated = await state.getAutopilotSession(created.autopilot_session_id);
    assert.equal(updated.order_count, 2);
    assert.equal((await state.listAutopilotOpportunities(created.autopilot_session_id)).length, 1);

    const eventTypes = (await state
      .listAutopilotEvents(created.autopilot_session_id))
      .map((event) => event.type);
    assert.equal(eventTypes.includes("arb_scan"), true);
    assert.equal(eventTypes.includes("arb_opportunity"), true);
    assert.equal(eventTypes.includes("arb_pair_preflight"), true);
    assert.equal(eventTypes.includes("arb_pair_reconciled"), true);
  });
});

function sessionStub() {
  return {
    autopilot_session_id: "autopilot_arb_stub",
    status: "running",
    execution_enabled: true,
    session_policy: {
      strategy_id: "hedged_spread_arbitrage_v1",
      policy_commitment: "arb_policy_stub",
      venue_allowlist: ["coinbase_advanced", "hyperliquid"],
      market_allowlist: ["SOL-USD"],
      max_notional_bucket: "25",
      max_daily_notional_bucket: "100",
      max_slippage_bps: 5,
      min_net_edge_bps: 25,
      ttl_ms: 60_000,
    },
    venue_access: {
      coinbase_advanced: { status: "ready", execution_mode: "byo_api_key" },
      hyperliquid: { status: "ready", execution_mode: "byo_api_key" },
    },
    daily_notional_used_bucket: "0",
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(body) {
  return {
    ok: true,
    async json() {
      return body;
    },
  };
}
