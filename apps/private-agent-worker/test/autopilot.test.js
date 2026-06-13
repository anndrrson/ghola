import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAutopilotSession,
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
    resetEnv();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("creates a ready bounded session and submits one dry-run autonomous order", async () => {
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
    assert.equal(session.venue_access.jupiter.status, "ready");

    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });

    assert.equal(tick.ok, true);
    assert.equal(tick.proposal.venue_id, "jupiter");
    assert.equal(tick.proposal.operation_class, "swap");
    assert.equal(tick.receipt.status, "submitted");

    const updated = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(updated.order_count, 1);
    assert.equal(updated.daily_notional_used_bucket, "50");

    const eventTypes = (await state
      .listAutopilotEvents(session.autopilot_session_id))
      .map((event) => event.type);
    assert.deepEqual(eventTypes.slice(-8), [
      "agent_tick",
      "position_update",
      "proposal",
      "ai_score",
      "execution",
      "live_order_submitted",
      "receipt",
      "venue_reconcile",
    ]);
  });

  it("routes app trading grant sessions through backend worker proposals without leaking the grant token", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_app_trading_worker",
        session_policy: {
          ai_direct_enabled: false,
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
          max_notional_bucket: "25",
          max_daily_notional_bucket: "100",
          max_order_count: 10,
          ttl_ms: 2 * 60 * 60_000,
          max_slippage_bps: 50,
        },
        app_trading_grant: {
          backend_url: "https://ghola-api.example",
          worker_grant_token: "raw-app-worker-grant-token",
          worker_grant_id: "glwg_app_worker",
          worker_grant_commitment: "worker_grant_commitment",
          activation_id: "glact_app_activation",
          plan_id: "gltp_app_plan",
          plan_policy_commitment: "plan_policy_commitment",
          venue_ids: ["hyperliquid"],
          expires_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
        },
      },
      recipient,
      state,
      provider: "test",
      startLoop: false,
      now,
    });

    assert.equal(session.status, "running");
    assert.equal(session.venue_access.hyperliquid.status, "ready");
    assert.equal(session.app_trading.status, "grant_armed");
    assert.equal(JSON.stringify(session).includes("raw-app-worker-grant-token"), false);

    let backendRequest = null;
    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
      fetchImpl: async (input, init) => {
        backendRequest = { input, init };
        return new Response(JSON.stringify({
          appLiveTradingWorkerProposal: {
            status: "executed",
            proposalCommitment: "backend_worker_proposal_commitment",
            executionReportCommitment: "backend_execution_report_commitment",
          },
          appLiveTradingExecutionRun: {
            status: "submitted_execution_reported",
            gholaAppLiveTradingExecutionRunCommitment: "backend_execution_report_commitment",
          },
          status: "executed",
        }), { status: 201 });
      },
    });

    assert.equal(tick.ok, true);
    assert.equal(tick.mode, "app_trading_worker_proposal");
    assert.equal(String(backendRequest.input), "https://ghola-api.example/v1/trading/app/worker/proposals");
    assert.equal(backendRequest.init.headers.authorization, "Bearer raw-app-worker-grant-token");
    const body = JSON.parse(backendRequest.init.body);
    assert.deepEqual(body.orderIntent.venueIds, ["hyperliquid"]);
    assert.equal(body.orderIntent.symbol, "BTC-USD");
    assert.equal(body.orderIntent.side, "buy");
    assert.equal(body.activationId, "glact_app_activation");
    assert.equal(body.planId, "gltp_app_plan");
    assert.equal(body.planPolicyCommitment, "plan_policy_commitment");
    assert.equal(body.workerGrantCommitment, "worker_grant_commitment");
    assert.match(body.proposalIntentCommitment, /^autopilot_proposal_/);
    assert.equal(body.refreshAfterSubmit, true);
    assert.equal(body.fetchFills, true);

    const updated = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(updated.app_trading.status, "proposal_executed");
    assert.equal(updated.app_trading.execution_report_commitment, "backend_execution_report_commitment");
    assert.equal(updated.order_count, 1);
    assert.equal(JSON.stringify(await state.listAutopilotEvents(session.autopilot_session_id)).includes("raw-app-worker-grant-token"), false);
    assert.equal(JSON.stringify(tick).includes("raw-app-worker-grant-token"), false);
  });

  it("turns app trading worker proposal blockers into manual approval state", async () => {
    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_app_trading_worker_approval",
        session_policy: {
          ai_direct_enabled: false,
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
          max_notional_bucket: "25",
          max_daily_notional_bucket: "100",
          max_order_count: 10,
          ttl_ms: 2 * 60 * 60_000,
          max_slippage_bps: 50,
        },
        app_trading_grant: {
          backend_url: "https://ghola-api.example",
          worker_grant_token: "raw-app-worker-grant-token",
          worker_grant_id: "glwg_app_worker_approval",
          worker_grant_commitment: "worker_grant_commitment",
          plan_id: "gltp_app_plan",
          plan_policy_commitment: "plan_policy_commitment",
          venue_ids: ["hyperliquid"],
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
      fetchImpl: async () => new Response(JSON.stringify({
        status: "manual_approval_required",
        blockers: ["plan_policy_approval_required"],
        appLiveTradingWorkerProposal: {
          status: "manual_approval_required",
          proposalCommitment: "backend_worker_proposal_commitment",
        },
        appLiveTradingApproval: {
          approvalId: "approval_1",
          gholaAppLiveTradingApprovalCommitment: "approval_commitment",
        },
      }), { status: 202 }),
    });

    assert.equal(tick.ok, false);
    assert.equal(tick.error, "manual_approval_required");
    const updated = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(updated.status, "running");
    assert.equal(updated.app_trading.status, "proposal_pending");
    assert.equal(updated.app_trading.proposal_status, "manual_approval_required");
    assert.equal(updated.order_count, 0);
    assert.equal((await state.listAutopilotPositions(session.autopilot_session_id)).length, 0);
    const events = await state.listAutopilotEvents(session.autopilot_session_id);
    assert.equal(events.some((event) => event.message === "Worker proposal queued for manual approval."), true);
    assert.equal(JSON.stringify(events).includes("raw-app-worker-grant-token"), false);
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

  it("lets AI-direct mode originate a bounded dry-run order after deterministic validation", async () => {
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

    assert.equal(session.strategy.ai_can_execute_directly, true);
    assert.equal(session.session_policy.ai_direct_enabled, true);

    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });

    assert.equal(tick.ok, true);
    assert.equal(tick.proposal.decision_source, "ai_direct_order_v1");
    assert.match(tick.proposal.decision_id, /^aidec_/);
    assert.equal(tick.proposal.venue_id, "jupiter");
    assert.equal(tick.proposal.operation_class, "swap");

    const decisions = await state.listAutopilotDecisions(session.autopilot_session_id);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].status, "accepted");

    const positions = await state.listAutopilotPositions(session.autopilot_session_id);
    assert.equal(positions.length, 1);
    assert.equal(positions[0].venue_id, "jupiter");

    const eventTypes = (await state
      .listAutopilotEvents(session.autopilot_session_id))
      .map((event) => event.type);
    assert.deepEqual(eventTypes.slice(-8), [
      "position_update",
      "ai_decision",
      "proposal",
      "ai_score",
      "execution",
      "live_order_submitted",
      "receipt",
      "venue_reconcile",
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
