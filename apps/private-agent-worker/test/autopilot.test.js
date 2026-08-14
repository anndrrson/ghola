import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlAutopilotSession,
  createAutopilotSession,
  resetAutopilotExecutionControlsForTests,
  runAutopilotTick,
  stopAutopilotLoop,
} from "../src/execution/autopilot.js";
import { createWorkerState } from "../src/state/private-state.js";
import { resumeAutopilotLoops } from "../src/server.js";

const OLD_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...OLD_ENV };
}

describe("autonomous autopilot engine", () => {
  let dir;

  beforeEach(() => {
    resetEnv();
    dir = mkdtempSync(join(tmpdir(), "ghola-autopilot-"));
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
    process.env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE = "force";
    process.env.PRIVATE_AGENT_AUTOPILOT_FORCE_PRICE = "100";
    process.env.PRIVATE_AGENT_AUTOPILOT_FORCE_CHANGE_PCT = "1";
    process.env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT = "true";
  });

  afterEach(() => {
    resetAutopilotExecutionControlsForTests();
    resetEnv();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("does not submit or resurrect state when control lands during market or AI work", async (t) => {
    for (const phase of ["market", "ai"]) {
      for (const action of ["pause", "kill"]) {
        await t.test(`${phase}:${action}`, async () => {
          const state = createWorkerState(dir);
          const recipient = { recipient_id: `did:key:${phase}-${action}` };
          const now = new Date(Date.now() + 60_000);
          const session = await createTestSession({
            state,
            recipient,
            now,
            owner: `owner_${phase}_${action}`,
            aiDirect: phase === "ai",
          });
          const delayed = deferred();
          const started = deferred();
          let submitCalls = 0;
          const tick = runAutopilotTick({
            sessionId: session.autopilot_session_id,
            state,
            recipient,
            now: new Date(now.getTime() + 60_000),
            env: process.env,
            marketSnapshot: phase === "market"
              ? async () => { started.resolve(); return delayed.promise; }
              : undefined,
            decideOrder: phase === "ai"
              ? async () => { started.resolve(); return delayed.promise; }
              : undefined,
            executeOrder: async () => { submitCalls += 1; return executionReceipt(); },
          });
          await started.promise;
          const control = controlAutopilotSession({
            sessionId: session.autopilot_session_id,
            action,
            state,
            recipient,
            now: new Date(now.getTime() + 61_000),
          });
          await waitForLatch(state, session.autopilot_session_id, action);
          delayed.resolve(phase === "market" ? forcedMarket(now) : { ok: true });
          assert.deepEqual(await tick, { ok: false, error: "autopilot_control_requested" });
          const acknowledged = await control;
          assert.equal(acknowledged.session.status, action === "kill" ? "killed" : "paused");
          assert.equal(acknowledged.session.control_latch, null);
          assert.equal(submitCalls, 0);
          const stored = await state.getAutopilotSession(session.autopilot_session_id);
          assert.equal(stored.status, action === "kill" ? "killed" : "paused");
          assert.equal(stored.order_count, 0);
        });
      }
    }
  });

  it("keeps live-configured generic autopilot verification-only", async () => {
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:generic-containment" };
    const now = new Date(Date.now() + 60_000);
    const session = await createTestSession({ state, recipient, now, owner: "owner_generic_containment" });
    let executeCalls = 0;
    let verifyCalls = 0;
    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
      executeOrder: async () => { executeCalls += 1; return executionReceipt(); },
      verifyOrder: async (request) => {
        verifyCalls += 1;
        return verificationReceipt(request.work_order_commitment);
      },
    });

    assert.equal(tick.ok, true);
    assert.equal(tick.mode, "no_submit");
    assert.equal(verifyCalls, 1);
    assert.equal(executeCalls, 0);
    const stored = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(stored.autonomous_live_submit_enabled, false);
    assert.equal(stored.autonomous_execution_mode, "no_submit");
    assert.equal(stored.order_count, 0);
  });

  it("creates a ready bounded session and verifies one autonomous proposal", async () => {
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_test",
        session_policy: {
          ai_direct_enabled: false,
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

    assert.equal(session.status, "running");
    assert.equal(session.execution_enabled, true);
    assert.equal(session.autonomous_live_submit_enabled, false);
    assert.equal(session.venue_access.jupiter.status, "ready");

    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });

    assert.equal(tick.ok, true);
    assert.equal(tick.mode, "no_submit");
    assert.equal(tick.proposal.venue_id, "jupiter");
    assert.equal(tick.proposal.operation_class, "swap");
    assert.equal(tick.receipt.status, "verified_no_funds");

    const updated = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(updated.order_count, 0);
    assert.equal(updated.daily_notional_used_bucket, "0");

    const eventTypes = (await state
      .listAutopilotEvents(session.autopilot_session_id))
      .map((event) => event.type);
    assert.deepEqual(eventTypes.slice(-7), [
      "agent_tick",
      "position_update",
      "proposal",
      "ai_score",
      "guardrail",
      "execution",
      "receipt",
    ]);
  });

  it("builds a guarded full-ticket Hyperliquid order without the tiny-fill marker", async () => {
    process.env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT = "false";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "full_ticket";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_full_ticket",
        session_policy: {
          ai_direct_enabled: false,
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
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

    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });

    assert.equal(tick.proposal.venue_id, "hyperliquid");
    assert.equal(tick.proposal.instruction.order.tif, "Ioc");
    assert.equal(tick.proposal.instruction.order.live_order_mode, undefined);
  });

  it("contains a live-configured protective exit without invoking submit", async () => {
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "full_ticket";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-protective" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_protective_containment",
        session_policy: {
          ai_direct_enabled: false,
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["SOL-USD"],
          max_notional_bucket: "50",
          max_position_notional_bucket: "100",
          max_loss_bucket: "5",
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
    await state.putAutopilotPosition(session.autopilot_session_id, {
      venue_id: "hyperliquid",
      market: "SOL-USD",
      side: "buy",
      signed_quantity: 0.5,
      average_entry_price: 100,
      last_mark_price: 100,
      mark_updated_at: now.toISOString(),
      estimated_exposure_notional_usd: 50,
      realized_pnl_usd: 0,
      unrealized_pnl_usd: 0,
      estimated_total_pnl_usd: 0,
      managed_by_session: true,
      last_work_order_commitment: "legacy_autopilot_order",
    });
    process.env.PRIVATE_AGENT_AUTOPILOT_FORCE_PRICE = "80";
    let executeCalls = 0;
    const stopped = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 90_000),
      env: process.env,
      executeOrder: async () => { executeCalls += 1; return executionReceipt(); },
    });
    assert.equal(stopped.ok, false);
    assert.equal(stopped.error, "autonomous_live_submit_contained");
    assert.equal(executeCalls, 0);
    const blocked = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(blocked.status, "risk_halted");
    assert.equal(blocked.execution_enabled, false);
    assert.equal(blocked.order_count, 0);
    assert.equal(blocked.risk_summary.estimated_total_pnl_usd, -10);
    const events = await state.listAutopilotEvents(session.autopilot_session_id);
    assert.equal(events.some((event) => event.type === "live_order_submitted"), false);
  });

  it("resumes persisted running autopilot sessions after worker restart", async () => {
    process.env.PRIVATE_AGENT_AUTOPILOT_INITIAL_DELAY_MS = "60000";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_resume",
        session_policy: {
          ai_direct_enabled: false,
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

    const resumed = await resumeAutopilotLoops({ state, recipient, now });
    stopAutopilotLoop(session.autopilot_session_id);

    assert.equal(resumed.resumed, 1);
    const events = await state.listAutopilotEvents(session.autopilot_session_id);
    assert.equal(
      events.some((event) => event.message === "Autopilot worker loop resumed after restart."),
      true,
    );
  });

  it("does not resume a persisted session with an unresolved control latch", async () => {
    process.env.PRIVATE_AGENT_AUTOPILOT_INITIAL_DELAY_MS = "60000";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-latch" };
    const now = new Date(Date.now() + 60_000);
    const session = await createTestSession({ state, recipient, now, owner: "owner_restart_latch" });
    const stored = await state.getAutopilotSession(session.autopilot_session_id);
    stored.control_epoch = 1;
    stored.control_latch = { action: "kill", requested_at: now.toISOString() };
    stored.execution_enabled = false;
    await state.putAutopilotSession(stored);

    const resumed = await resumeAutopilotLoops({ state, recipient, now });

    assert.equal(resumed.resumed, 0);
    const preserved = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(preserved.control_latch.action, "kill");
    assert.equal(preserved.control_epoch, 1);
  });

  it("keeps agents active with no-submit verification when live submit is not armed", async () => {
    process.env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT = "false";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_shadow",
        session_policy: {
          ai_direct_enabled: false,
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

    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });

    assert.equal(tick.ok, true);
    assert.equal(tick.mode, "no_submit");
    assert.equal(tick.receipt.status, "verified_no_funds");
    assert.equal(tick.receipt.checks.transaction_broadcast, false);

    const updated = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(updated.order_count, 0);
    assert.equal(updated.daily_notional_used_bucket, "0");
    assert.match(updated.last_verified_at, /^\d{4}-/);

    const eventTypes = (await state
      .listAutopilotEvents(session.autopilot_session_id))
      .map((event) => event.type);
    assert.deepEqual(eventTypes.slice(-7), [
      "agent_tick",
      "position_update",
      "proposal",
      "ai_score",
      "guardrail",
      "execution",
      "receipt",
    ]);
    assert.equal(eventTypes.includes("live_order_submitted"), false);
  });

  it("verifies Phoenix no-submit orders through autopilot", async () => {
    process.env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT = "false";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE = "full_ticket";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_ALLOW_MAINNET = "true";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_FULL_TICKET_MAX_NOTIONAL_USD = "1000";
    process.env.PRIVATE_AGENT_LIVE_MAX_ORDER_NOTIONAL_USD = "1000";
    process.env.PRIVATE_AGENT_SOLANA_PERPS_NO_SUBMIT_LOCAL_CHECKS = "true";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_phoenix_shadow",
        session_policy: {
          ai_direct_enabled: false,
          venue_allowlist: ["phoenix"],
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

    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });

    assert.equal(tick.ok, true);
    assert.equal(tick.mode, "no_submit");
    assert.equal(tick.proposal.venue_id, "phoenix");
    assert.equal(tick.proposal.operation_class, "perp_limit_order");
    assert.equal(tick.receipt.status, "verified_no_funds");
    assert.equal(tick.receipt.checks.transaction_broadcast, false);
  });

  it("lets AI mode originate a bounded no-submit proposal after deterministic validation", async () => {
    process.env.PRIVATE_AGENT_AI_DIRECT_ENABLED = "true";
    process.env.PRIVATE_AGENT_AI_DIRECT_MODE = "mock";
    process.env.PRIVATE_AGENT_AI_MAX_DECISIONS_PER_HOUR = "12";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_ai_direct",
        session_policy: {
          decision_model: "ai_direct_order_v1",
          ai_direct_enabled: true,
          venue_allowlist: ["jupiter"],
          market_allowlist: ["SOL-USD"],
          max_notional_bucket: "50",
          max_position_notional_bucket: "100",
          max_daily_notional_bucket: "250",
          max_order_count: 10,
          ttl_ms: 2 * 60 * 60_000,
          max_slippage_bps: 50,
          ai_min_confidence_bps: 6_500,
        },
      },
      recipient,
      state,
      provider: "test",
      startLoop: false,
      now,
    });

    assert.equal(session.strategy.ai_can_execute_directly, false);
    assert.equal(session.strategy.live_submit_enabled, false);
    assert.equal(session.session_policy.ai_direct_enabled, true);

    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });

    assert.equal(tick.ok, true);
    assert.equal(tick.mode, "no_submit");
    assert.equal(tick.proposal.decision_source, "ai_direct_order_v1");
    assert.match(tick.proposal.decision_id, /^aidec_/);
    assert.equal(tick.proposal.venue_id, "jupiter");
    assert.equal(tick.proposal.operation_class, "swap");

    const decisions = await state.listAutopilotDecisions(session.autopilot_session_id);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].status, "accepted");

    const positions = await state.listAutopilotPositions(session.autopilot_session_id);
    assert.equal(positions.length, 0);

    const eventTypes = (await state
      .listAutopilotEvents(session.autopilot_session_id))
      .map((event) => event.type);
    assert.deepEqual(eventTypes.slice(-7), [
      "position_update",
      "ai_decision",
      "proposal",
      "ai_score",
      "guardrail",
      "execution",
      "receipt",
    ]);
  });

  it("fails closed when AI-direct mode is enabled without a model", async () => {
    process.env.PRIVATE_AGENT_AI_DIRECT_ENABLED = "true";
    process.env.PRIVATE_AGENT_AI_DIRECT_MODE = "";
    process.env.PRIVATE_AGENT_AI_MODEL = "";
    process.env.GHOLA_PRIVATE_AGENT_AI_MODEL = "";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_ai_unconfigured",
        session_policy: {
          ai_direct_enabled: true,
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

    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });

    assert.equal(tick.ok, false);
    assert.equal(tick.error, "ai_model_unconfigured");
    assert.equal((await state.listAutopilotDecisions(session.autopilot_session_id)).length, 1);
    assert.equal((await state.listAutopilotPositions(session.autopilot_session_id)).length, 0);

    const eventTypes = (await state
      .listAutopilotEvents(session.autopilot_session_id))
      .map((event) => event.type);
    assert.equal(eventTypes.includes("ai_decision"), true);
    assert.equal(eventTypes.includes("risk_reject"), true);
    assert.equal(eventTypes.includes("execution"), false);
  });
});

async function createTestSession({ state, recipient, now, owner, aiDirect = false }) {
  if (aiDirect) {
    process.env.PRIVATE_AGENT_AI_DIRECT_ENABLED = "true";
    process.env.PRIVATE_AGENT_AI_DIRECT_MODE = "mock";
    process.env.PRIVATE_AGENT_AI_MAX_DECISIONS_PER_HOUR = "12";
  }
  return createAutopilotSession({
    body: {
      owner_commitment: owner,
      session_policy: {
        ai_direct_enabled: aiDirect,
        decision_model: aiDirect ? "ai_direct_order_v1" : undefined,
        venue_allowlist: ["jupiter"],
        market_allowlist: ["SOL-USD"],
        max_notional_bucket: "50",
        max_position_notional_bucket: "100",
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitForLatch(state, sessionId, action) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = await state.getAutopilotSession(sessionId);
    if (session?.control_latch?.action === action) return session;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("control latch was not persisted");
}

function forcedMarket(now) {
  return {
    product_id: "SOL-USD",
    price: 100,
    mid: 100,
    change_24h: 1,
    spread_bps: 10,
    fetched_at: now.toISOString(),
    live_status: "forced",
    stale: false,
  };
}

function executionReceipt() {
  return {
    status: "submitted",
    work_order_commitment: "work_order_test",
    provider_ref_commitment: "provider_test",
    result_commitment: "result_test",
    fill_summary: null,
  };
}

function verificationReceipt(workOrderCommitment) {
  return {
    status: "verified_no_funds",
    work_order_commitment: workOrderCommitment,
    provider_ref_commitment: "provider_verification_test",
    result_commitment: "result_verification_test",
    checks: { transaction_broadcast: false },
  };
}
