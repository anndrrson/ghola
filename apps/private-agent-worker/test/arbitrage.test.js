import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bestArbitrageOpportunity,
  bestCarryOpportunity,
  enforceArbitrageLiveConfig,
  enforceCarryLiveConfig,
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

  it("accepts funding carry only after persistent funding clears round-trip costs", async () => {
    const session = sessionStub();
    session.session_policy.strategy_id = "delta_neutral_carry_v1";
    session.portfolio_mandate = { max_basis_bps: 500 };
    const env = {
      ...process.env,
      PRIVATE_AGENT_CARRY_SIGNAL_MODE: "force",
      PRIVATE_AGENT_CARRY_FORCE_SPOT_PRICE: "100",
      PRIVATE_AGENT_CARRY_FORCE_PERP_PRICE: "100.1",
      PRIVATE_AGENT_CARRY_FORCE_HOURLY_FUNDING_BPS: "5",
      PRIVATE_AGENT_CARRY_FORCE_FUNDING_SAMPLES: "24",
      PRIVATE_AGENT_CARRY_HORIZON_HOURS: "24",
      PRIVATE_AGENT_CARRY_COINBASE_ADVANCED_FEE_BPS: "5",
      PRIVATE_AGENT_CARRY_HYPERLIQUID_FEE_BPS: "5",
      PRIVATE_AGENT_CARRY_MIN_NET_EDGE_BPS: "25",
      PRIVATE_AGENT_CARRY_MAX_LEG_NOTIONAL_USD: "25",
    };
    const found = await bestCarryOpportunity({ session, env, now: new Date("2026-06-03T12:00:00.000Z") });
    assert.equal(found.ok, true);
    assert.equal(found.projected_funding_bps, 120);
    assert.equal(found.buy_venue, "coinbase_advanced");
    assert.equal(found.sell_venue, "hyperliquid");
    assert.ok(found.net_edge_bps >= 25);

    env.PRIVATE_AGENT_CARRY_FORCE_HOURLY_FUNDING_BPS = "0.1";
    const rejected = await bestCarryOpportunity({ session, env, now: new Date("2026-06-03T13:00:00.000Z") });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, "net_edge_below_threshold");
  });

  it("fails closed when carry-specific live caps are absent", () => {
    const checked = enforceCarryLiveConfig({
      session: sessionStub(),
      env: { PRIVATE_AGENT_VENUE_DRY_RUN: "true" },
      requestedNotionalUsd: 10,
    });
    assert.equal(checked.ok, false);
    assert.ok(checked.reason_codes.includes("max_leg_notional_required"));
  });

  it("parses Hyperliquid asset contexts and funding history for live carry screening", async () => {
    const session = sessionStub();
    session.session_policy.strategy_id = "delta_neutral_carry_v1";
    session.portfolio_mandate = { max_basis_bps: 500 };
    const env = {
      ...process.env,
      PRIVATE_AGENT_CARRY_SIGNAL_MODE: "live",
      PRIVATE_AGENT_CARRY_MIN_FUNDING_SAMPLES: "2",
      PRIVATE_AGENT_CARRY_HORIZON_HOURS: "24",
      PRIVATE_AGENT_CARRY_COINBASE_ADVANCED_FEE_BPS: "5",
      PRIVATE_AGENT_CARRY_HYPERLIQUID_FEE_BPS: "5",
      PRIVATE_AGENT_CARRY_MIN_NET_EDGE_BPS: "25",
      PRIVATE_AGENT_CARRY_MAX_LEG_NOTIONAL_USD: "25",
    };
    const found = await bestCarryOpportunity({
      session,
      env,
      now: new Date("2026-06-03T12:00:00.000Z"),
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes("coinbase.com")) return jsonResponse({ price: "100" });
        const body = JSON.parse(init.body || "{}");
        if (body.type === "metaAndAssetCtxs") {
          return jsonResponse([
            { universe: [{ name: "SOL", szDecimals: 2, maxLeverage: 20 }] },
            [{ funding: "0.001", markPx: "100.1", oraclePx: "100" }],
          ]);
        }
        if (body.type === "fundingHistory") {
          return jsonResponse([
            { coin: "SOL", fundingRate: "0.001", time: 1 },
            { coin: "SOL", fundingRate: "0.001", time: 2 },
          ]);
        }
        return jsonResponse({});
      },
    });
    assert.equal(found.ok, true);
    assert.equal(found.current_funding_hourly_bps, 10);
    assert.equal(found.funding_sample_count, 2);
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
    assert.equal(created.strategy.ai_can_execute_directly, false);
    assert.equal(created.strategy.deterministic_router, true);
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
    const saga = await state.getMultiLegSaga(tick.saga_id);
    assert.equal(saga.status, "reconciled");
    assert.equal(saga.terminal, true);
    assert.equal(saga.execution_context.legs.length, 2);
    assert.equal(JSON.stringify(saga.execution_context).includes("private_key"), false);
    assert.equal(
      saga.execution_context.legs[0].instruction.order.base_size,
      saga.execution_context.legs[1].instruction.order.base_size,
    );
    assert.equal(saga.execution_context.legs[0].instruction.order.size_mode, "base");
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

  it("submits a funding-screened carry pair through the protected saga", async () => {
    Object.assign(process.env, {
      PRIVATE_AGENT_CARRY_SIGNAL_MODE: "force",
      PRIVATE_AGENT_CARRY_FORCE_SPOT_PRICE: "100",
      PRIVATE_AGENT_CARRY_FORCE_PERP_PRICE: "100.1",
      PRIVATE_AGENT_CARRY_FORCE_HOURLY_FUNDING_BPS: "5",
      PRIVATE_AGENT_CARRY_FORCE_FUNDING_SAMPLES: "24",
      PRIVATE_AGENT_CARRY_HORIZON_HOURS: "24",
      PRIVATE_AGENT_CARRY_COINBASE_ADVANCED_FEE_BPS: "5",
      PRIVATE_AGENT_CARRY_HYPERLIQUID_FEE_BPS: "5",
      PRIVATE_AGENT_CARRY_LIVE_SUBMIT: "true",
      PRIVATE_AGENT_CARRY_MAX_LEG_NOTIONAL_USD: "25",
      PRIVATE_AGENT_CARRY_DAILY_NOTIONAL_CAP_USD: "100",
      PRIVATE_AGENT_CARRY_MIN_NET_EDGE_BPS: "25",
      PRIVATE_AGENT_CARRY_MAX_EXECUTION_SKEW_MS: "2000",
    });
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-carry-worker" };
    const now = new Date(Date.now() + 60_000);
    const created = await createAutopilotSession({
      body: {
        owner_commitment: "owner_carry_test",
        session_policy: {
          strategy_id: "delta_neutral_carry_v1",
          venue_allowlist: ["coinbase_advanced", "hyperliquid"],
          market_allowlist: ["SOL-USD"],
          max_notional_bucket: "25",
          max_position_notional_bucket: "100",
          max_daily_notional_bucket: "100",
          max_order_count: 2,
          ttl_ms: 30 * 60 * 60_000,
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
    assert.equal(created.strategy.strategy_id, "delta_neutral_carry_v1");
    assert.equal(created.strategy.protected_multi_leg, true);
    const tick = await runAutopilotTick({
      sessionId: created.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });
    assert.equal(tick.ok, true);
    const saga = await state.getMultiLegSaga(tick.saga_id);
    assert.equal(saga.strategy_id, "delta_neutral_carry");
    assert.equal(saga.status, "reconciled");
    const opportunities = await state.listAutopilotOpportunities(created.autopilot_session_id);
    assert.equal(opportunities[0].projected_funding_bps, 120);
    const positions = await state.listAutopilotPositions(created.autopilot_session_id);
    assert.equal(positions.length, 2);
    assert.ok(positions.every((position) => position.strategy_id === "delta_neutral_carry_v1"));
    assert.ok(positions.every((position) => Date.parse(position.exit_due_at) > now.getTime()));
    const opened = await state.getAutopilotSession(created.autopilot_session_id);
    const entryTurnover = opened.daily_notional_used_bucket;

    const holdAt = new Date(now.getTime() + 6 * 60_000);
    const held = await runAutopilotTick({
      sessionId: created.autopilot_session_id,
      state,
      recipient,
      now: holdAt,
      env: process.env,
    });
    assert.equal(held.ok, true);
    assert.equal(held.action, "hold");

    for (const position of positions) {
      await state.putAutopilotPosition(created.autopilot_session_id, {
        ...position,
        exit_due_at: new Date(holdAt.getTime() - 1).toISOString(),
      });
    }
    await state.putAutopilotSession({
      ...(await state.getAutopilotSession(created.autopilot_session_id)),
      last_execution_at: holdAt.toISOString(),
    });
    const closed = await runAutopilotTick({
      sessionId: created.autopilot_session_id,
      state,
      recipient,
      now: new Date(holdAt.getTime() + 30_000),
      env: process.env,
    });
    assert.equal(closed.ok, true, JSON.stringify({
      closed,
      events: await state.listAutopilotEvents(created.autopilot_session_id),
    }));
    assert.equal(closed.opportunity.risk_reducing, true);
    const closedPositions = await state.listAutopilotPositions(created.autopilot_session_id);
    assert.ok(closedPositions.every((position) => position.signed_notional_micro_usdc === 0));
    assert.ok(closedPositions.every((position) => position.signed_base_size === 0));
    assert.ok(closedPositions.every((position) => Boolean(position.closed_at)));
    const afterClose = await state.getAutopilotSession(created.autopilot_session_id);
    assert.equal(afterClose.daily_notional_used_bucket, entryTurnover);
    assert.equal(afterClose.order_count, 4);

    const eventTypes = (await state.listAutopilotEvents(created.autopilot_session_id)).map((event) => event.type);
    assert.ok(eventTypes.includes("carry_scan"));
    assert.ok(eventTypes.includes("carry_hold"));
    assert.ok(eventTypes.includes("carry_exit_ready"));
    assert.ok(eventTypes.includes("carry_exit_reconciled"));
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
