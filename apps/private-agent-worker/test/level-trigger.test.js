import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutopilotSession, runAutopilotTick } from "../src/execution/autopilot.js";
import { evaluateEntryTrigger, evaluateExit, instructionForVenue } from "../src/execution/level-trigger.js";
import { createWorkerState } from "../src/state/private-state.js";

const OLD_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...OLD_ENV };
}

function levelMandate(overrides = {}) {
  return {
    strategy_profile: "breakout_retest",
    entry_trigger: "break_level",
    exit_rule: "exit_on_invalidation",
    time_horizon: "scalp",
    trigger_level: "100",
    invalidation_level: "95",
    ...overrides,
  };
}

async function armLevelSession(state, recipient, now, { mandate = levelMandate(), side = "buy" } = {}) {
  return createAutopilotSession({
    body: {
      owner_commitment: "owner_level_trigger_test",
      session_policy: {
        strategy_id: "level_trigger_v1",
        agent_side: side,
        agent_mandate: mandate,
        venue_allowlist: ["jupiter"],
        market_allowlist: ["SOL-USD"],
        max_notional_bucket: "50",
        max_daily_notional_bucket: "250",
        max_order_count: 10,
        ttl_ms: 2 * 60 * 60_000,
        max_slippage_bps: 50,
      },
    },
    recipient,
    state,
    provider: "test",
    startLoop: false,
    now,
  });
}

function tickAt(state, recipient, session, now, price) {
  process.env.PRIVATE_AGENT_AUTOPILOT_FORCE_PRICE = String(price);
  return runAutopilotTick({
    sessionId: session.autopilot_session_id,
    state,
    recipient,
    now,
    env: process.env,
  });
}

describe("level_trigger_v1 directional strategy", () => {
  let dir;
  const recipient = { recipient_id: "did:key:test-level-trigger" };

  beforeEach(() => {
    resetEnv();
    dir = mkdtempSync(join(tmpdir(), "ghola-level-trigger-"));
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
    process.env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE = "force";
    process.env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT = "true";
  });

  afterEach(() => {
    resetEnv();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("normalizes the directional mandate onto the session policy", async () => {
    const state = createWorkerState(dir);
    const now = new Date(Date.now() + 60_000);
    const session = await armLevelSession(state, recipient, now);
    assert.equal(session.strategy.strategy_id, "level_trigger_v1");
    assert.equal(session.session_policy.agent_side, "buy");
    assert.equal(session.session_policy.agent_mandate.entry_trigger, "break_level");
    assert.equal(session.session_policy.agent_mandate.trigger_level, "100");
    assert.equal(session.status, "running");
  });

  it("holds while the level is not broken, then fires exactly one entry on break", async () => {
    const state = createWorkerState(dir);
    const now = new Date(Date.now() + 60_000);
    const session = await armLevelSession(state, recipient, now);

    const watch = await tickAt(state, recipient, session, new Date(now.getTime() + 60_000), 98);
    assert.equal(watch.ok, false);
    assert.equal(watch.error, "entry_not_triggered");
    assert.equal((await state.getAutopilotSession(session.autopilot_session_id)).order_count, 0);

    const entry = await tickAt(state, recipient, session, new Date(now.getTime() + 120_000), 101);
    assert.equal(entry.ok, true);
    assert.equal(entry.phase, "in_position");

    const stored = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(stored.order_count, 1);
    assert.equal(stored.directive.phase, "in_position");
    assert.equal(stored.directive.entry_filled, true);

    const positions = await state.listAutopilotPositions(session.autopilot_session_id);
    assert.equal(positions.length, 1);
    assert.equal(positions[0].side, "buy");

    const events = (await state.listAutopilotEvents(session.autopilot_session_id)).map((e) => e.type);
    assert.equal(events.includes("live_order_submitted"), true);
    assert.equal(events.includes("receipt"), true);
    assert.equal(events.includes("venue_reconcile"), true);
  });

  it("is idempotent: a second tick after entry does not open another position", async () => {
    const state = createWorkerState(dir);
    const now = new Date(Date.now() + 60_000);
    const session = await armLevelSession(state, recipient, now);

    await tickAt(state, recipient, session, new Date(now.getTime() + 60_000), 101);
    const hold = await tickAt(state, recipient, session, new Date(now.getTime() + 120_000), 102);
    assert.equal(hold.ok, true);
    assert.equal(hold.action, "hold");
    assert.equal((await state.getAutopilotSession(session.autopilot_session_id)).order_count, 1);
  });

  it("exits and completes when the invalidation level is hit", async () => {
    const state = createWorkerState(dir);
    const now = new Date(Date.now() + 60_000);
    const session = await armLevelSession(state, recipient, now);

    await tickAt(state, recipient, session, new Date(now.getTime() + 60_000), 101);
    const exit = await tickAt(state, recipient, session, new Date(now.getTime() + 120_000), 94);
    assert.equal(exit.ok, true);
    assert.equal(exit.phase, "done");
    assert.equal(exit.reason, "invalidation_level");

    const stored = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(stored.status, "done");
    assert.equal(stored.execution_enabled, false);
    assert.equal(stored.order_count, 2);
  });

  it("exits when the time horizon elapses", async () => {
    const state = createWorkerState(dir);
    const now = new Date(Date.now() + 60_000);
    const session = await armLevelSession(state, recipient, now);

    await tickAt(state, recipient, session, new Date(now.getTime() + 60_000), 101);
    // scalp horizon is 15m; tick past it with price still above the stop
    const exit = await tickAt(state, recipient, session, new Date(now.getTime() + 60_000 + 16 * 60_000), 101);
    assert.equal(exit.ok, true);
    assert.equal(exit.phase, "done");
    assert.equal(exit.reason, "time_horizon");
  });

  it("fires a retest entry only after a prior breakout", async () => {
    const state = createWorkerState(dir);
    const now = new Date(Date.now() + 60_000);
    const session = await armLevelSession(state, recipient, now, {
      mandate: levelMandate({ entry_trigger: "retest_level" }),
    });

    // tick 1: price spikes clearly above the band -> records the breakout, no entry
    const broke = await tickAt(state, recipient, session, new Date(now.getTime() + 60_000), 101);
    assert.equal(broke.ok, false);
    assert.equal((await state.getAutopilotSession(session.autopilot_session_id)).directive.broke, true);

    // tick 2: price returns into the band around the level -> retest fires
    const entry = await tickAt(state, recipient, session, new Date(now.getTime() + 120_000), 100);
    assert.equal(entry.ok, true);
    assert.equal(entry.phase, "in_position");
  });

  it("proves the entry without broadcasting when live submit is disabled", async () => {
    process.env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT = "false";
    const state = createWorkerState(dir);
    const now = new Date(Date.now() + 60_000);
    const session = await armLevelSession(state, recipient, now);

    const proof = await tickAt(state, recipient, session, new Date(now.getTime() + 60_000), 101);
    assert.equal(proof.ok, true);
    assert.equal(proof.mode, "no_submit");

    const stored = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(stored.order_count, 0);
    assert.equal(stored.directive.proved_once, true);
    const events = (await state.listAutopilotEvents(session.autopilot_session_id)).map((e) => e.type);
    assert.equal(events.includes("live_order_submitted"), false);
    assert.equal(events.includes("receipt"), true);
  });
});

describe("level_trigger hyperliquid order mode", () => {
  const args = {
    venue: "hyperliquid",
    product: "BTC-USD",
    side: "buy",
    price: 100,
    notional: 200,
    policy: { max_slippage_bps: 50, ttl_ms: 60 * 60_000 },
    now: new Date("2026-06-16T12:00:00Z"),
  };

  it("marks the order tiny_fill when the worker is not in full_ticket mode", () => {
    const instruction = instructionForVenue({ ...args, env: {} });
    assert.equal(instruction.order.live_order_mode, "tiny_fill");
    assert.equal(instruction.order.tif, "Ioc");
  });

  it("omits the tiny_fill marker on a full_ticket worker so full-ticket caps govern", () => {
    const instruction = instructionForVenue({
      ...args,
      env: { PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket" },
    });
    assert.equal("live_order_mode" in instruction.order, false);
    assert.equal(instruction.order.quote_size, "200");
  });

  it("keeps tiny_fill on non-hyperliquid perp venues regardless of the hyperliquid mode", () => {
    const instruction = instructionForVenue({
      ...args,
      venue: "drift",
      env: { PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "full_ticket" },
    });
    assert.equal(instruction.order.live_order_mode, "tiny_fill");
  });
});

describe("level_trigger entry/exit evaluators", () => {
  it("break_level fires on the correct side", () => {
    const mandate = { entry_trigger: "break_level", trigger_level: "100" };
    assert.equal(evaluateEntryTrigger({ price: 101, mandate, side: "buy", directive: {} }).triggered, true);
    assert.equal(evaluateEntryTrigger({ price: 99, mandate, side: "buy", directive: {} }).triggered, false);
    assert.equal(evaluateEntryTrigger({ price: 99, mandate, side: "sell", directive: {} }).triggered, true);
    assert.equal(evaluateEntryTrigger({ price: 101, mandate, side: "sell", directive: {} }).triggered, false);
  });

  it("retest requires a recorded breakout before entry", () => {
    const mandate = { entry_trigger: "retest_level", trigger_level: "100" };
    const first = evaluateEntryTrigger({ price: 101, mandate, side: "buy", directive: {} });
    assert.equal(first.triggered, false);
    assert.equal(first.directive.broke, true);
    const second = evaluateEntryTrigger({ price: 100, mandate, side: "buy", directive: first.directive });
    assert.equal(second.triggered, true);
  });

  it("exit triggers on stop and on horizon deadline", () => {
    const mandate = { invalidation_level: "95" };
    const now = new Date("2026-06-16T12:00:00Z");
    assert.equal(evaluateExit({ price: 94, mandate, side: "buy", now, directive: {} }).exit, true);
    assert.equal(evaluateExit({ price: 96, mandate, side: "buy", now, directive: {} }).exit, false);
    const past = { deadline_at: "2026-06-16T11:00:00Z" };
    assert.equal(evaluateExit({ price: 96, mandate, side: "buy", now, directive: past }).reason, "time_horizon");
  });
});
