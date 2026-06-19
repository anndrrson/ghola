import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlAutopilotSession,
  createAutopilotSession,
  listAutopilotReplay,
  runDueAutopilotSessions,
  runAutopilotTick,
} from "../src/execution/autopilot.js";
import { createSqliteWorkerState, createWorkerState } from "../src/state/private-state.js";

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
    process.env.PRIVATE_AGENT_JUPITER_PLATFORM_FEE_BPS = "10";
    process.env.PRIVATE_AGENT_JUPITER_FEE_ACCOUNT = "11111111111111111111111111111111";
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
    assert.equal(session.session_policy.strategy_id, "bounded_intent_executor_v1");
    assert.equal(session.strategy.strategy_id, "bounded_intent_executor_v1");
    assert.equal(session.strategy.executable_order_source, "deterministic_bounded_intent_executor");
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
    assert.equal(tick.revenue_quote.fee_bucket, "0.05");
    assert.match(tick.revenue_evidence.revenue_event_id, /^revevt_/);
    assert.match(tick.revenue_evidence.event_hash, /^sha256_/);
    assert.equal(tick.revenue_evidence.expected_fee_bucket, "0.05");
    assert.equal(tick.receipt.final_proof.integrator_fee_bps, 10);

    const updated = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(updated.order_count, 1);
    assert.equal(updated.daily_notional_used_bucket, "50");
    assert.match(updated.agent_controller_id, /^agentctl_/);
    assert.equal(updated.last_completed_execution.revenue_receipt.fee_bucket, "0.05");
    assert.equal(updated.last_completed_execution.revenue_receipt.fee_recipient, "jupiter_fee_account");
    assert.equal(updated.last_completed_execution.revenue_evidence_hash, tick.revenue_evidence.event_hash);

    const revenueEvents = await state.listRevenueEvidence({
      autopilot_session_id: session.autopilot_session_id,
    });
    assert.equal(revenueEvents.length, 1);
    assert.equal(revenueEvents[0].revenue_status, "dry_run");
    assert.equal(revenueEvents[0].collection_status, "dry_run_quoted");
    assert.equal(revenueEvents[0].work_order_commitment, tick.work_order_commitment);
    assert.equal(revenueEvents[0].event_hash, tick.revenue_evidence.event_hash);
    assert.equal(revenueEvents[0].previous_event_hash, null);
    assert.equal(revenueEvents[0].ledger_sequence, 1);

    const executors = await state.listExecutorRecords(session.autopilot_session_id);
    assert.equal(executors.length, 1);
    assert.equal(executors[0].status, "reconciled");
    assert.equal(executors[0].kind, "order");
    assert.equal(executors[0].venue_id, "jupiter");
    assert.equal(executors[0].fee_quote_bucket, "0.05");
    assert.equal(executors[0].metadata.revenue_model, "jupiter_integrator_fee");
    assert.equal(executors[0].metadata.fee_collection_status, "dry_run_quoted");

    const ticks = await state.listTickSnapshots(session.autopilot_session_id);
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].status, "submitted");
    assert.deepEqual(ticks[0].executor_ids, [executors[0].executor_id]);

    const replay = await listAutopilotReplay({
      sessionId: session.autopilot_session_id,
      state,
      now: new Date(now.getTime() + 90_000),
    });
    assert.equal(replay.metrics.executor_count, 1);
    assert.equal(replay.metrics.submitted_executor_count, 1);
    assert.equal(replay.metrics.fee_bucket, "0.05");
    assert.equal(replay.tick_snapshots.length, 1);

    const eventTypes = (await state
      .listAutopilotEvents(session.autopilot_session_id))
      .map((event) => event.type);
    assert.deepEqual(eventTypes.slice(-10), [
      "agent_tick",
      "position_update",
      "proposal",
      "ai_score",
      "executor_created",
      "execution",
      "live_order_submitted",
      "receipt",
      "venue_reconcile",
      "tick_snapshot",
    ]);
  });

  it("does not run a tick while another worker owns the durable lease", async () => {
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_lease",
        session_policy: {
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

    const claimed = await state.claimAutopilotTickLease(session.autopilot_session_id, {
      lease_id: "lease-held-by-worker-a",
      lease_ms: 60_000,
      now: new Date(now.getTime() + 60_000),
    });
    assert.equal(claimed.ok, true);

    const blocked = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, "tick_lease_active");
    assert.equal((await state.listExecutorRecords(session.autopilot_session_id)).length, 0);

    const released = await state.releaseAutopilotTickLease(
      session.autopilot_session_id,
      "lease-held-by-worker-a",
      { now: new Date(now.getTime() + 61_000) },
    );
    assert.equal(released.ok, true);

    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 62_000),
      env: process.env,
    });
    assert.equal(tick.ok, true);
    assert.equal((await state.listExecutorRecords(session.autopilot_session_id)).length, 1);
  });

  it("claims and releases tick leases through the sqlite state adapter", async () => {
    const state = createSqliteWorkerState(join(dir, "autopilot-state.sqlite"));
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_sqlite_lease",
        session_policy: {
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

    const claimed = await state.claimAutopilotTickLease(session.autopilot_session_id, {
      lease_id: "sqlite-lease-a",
      lease_ms: 60_000,
      now,
    });
    assert.equal(claimed.ok, true);

    const blocked = await state.claimAutopilotTickLease(session.autopilot_session_id, {
      lease_id: "sqlite-lease-b",
      lease_ms: 60_000,
      now: new Date(now.getTime() + 1_000),
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, "tick_lease_active");

    const wrongRelease = await state.releaseAutopilotTickLease(
      session.autopilot_session_id,
      "sqlite-lease-b",
      { now: new Date(now.getTime() + 2_000) },
    );
    assert.equal(wrongRelease.ok, false);
    assert.equal(wrongRelease.error, "tick_lease_not_owned");

    const released = await state.releaseAutopilotTickLease(
      session.autopilot_session_id,
      "sqlite-lease-a",
      { now: new Date(now.getTime() + 3_000) },
    );
    assert.equal(released.ok, true);
    const afterRelease = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(afterRelease.tick_lease_id, undefined);
  });

  it("uses a stable work order when a completed slot is replayed after restart", async () => {
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_idempotent_slot",
        session_policy: {
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

    const first = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });
    assert.equal(first.ok, true);
    assert.match(first.work_order_commitment, /^autopilot_work_order_/);

    const afterFirst = await state.getAutopilotSession(session.autopilot_session_id);
    await state.putAutopilotSession({
      ...afterFirst,
      order_count: 0,
      tick_count: 0,
      daily_notional_used_bucket: "0",
      last_execution_at: null,
      last_tick_at: null,
      pending_execution: null,
    });

    const second = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 5 * 60_000),
      env: process.env,
    });
    assert.equal(second.ok, true);
    assert.equal(second.work_order_commitment, first.work_order_commitment);
    assert.equal(second.receipt.result_commitment, first.receipt.result_commitment);

    const idempotency = await state.getIdempotency(first.work_order_commitment);
    assert.equal(idempotency.receipt.result_commitment, first.receipt.result_commitment);
    const executors = await state.listExecutorRecords(session.autopilot_session_id);
    assert.equal(new Set(executors.map((executor) => executor.work_order_commitment)).size, 1);
  });

  it("reuses a persisted pending execution proposal after a worker restart", async () => {
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_pending_restart",
        session_policy: {
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

    const first = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });
    assert.equal(first.ok, true);

    const completed = await state.getAutopilotSession(session.autopilot_session_id);
    await state.putAutopilotSession({
      ...completed,
      order_count: 0,
      tick_count: 0,
      daily_notional_used_bucket: "0",
      last_execution_at: null,
      last_tick_at: null,
      pending_execution: {
        version: 1,
        execution_slot: 1,
        tick_id: first.tick_id,
        status: "created",
        proposal: first.proposal,
        proposal_commitment: first.proposal.proposal_commitment,
        work_order_commitment: first.work_order_commitment,
        created_at: new Date(now.getTime() + 60_000).toISOString(),
        updated_at: new Date(now.getTime() + 60_000).toISOString(),
      },
      last_completed_execution: null,
    });

    process.env.PRIVATE_AGENT_AUTOPILOT_FORCE_PRICE = "250";
    process.env.PRIVATE_AGENT_AUTOPILOT_FORCE_CHANGE_PCT = "-5";
    const replayed = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 4 * 60_000),
      env: process.env,
    });

    assert.equal(replayed.ok, true);
    assert.equal(replayed.proposal.proposal_commitment, first.proposal.proposal_commitment);
    assert.equal(replayed.work_order_commitment, first.work_order_commitment);
    assert.equal(replayed.receipt.result_commitment, first.receipt.result_commitment);
    const afterReplay = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(afterReplay.pending_execution, null);
    assert.equal(afterReplay.last_completed_execution.work_order_commitment, first.work_order_commitment);
  });

  it("keeps kill terminal and prevents pending execution from resuming", async () => {
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_kill_terminal",
        session_policy: {
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

    const first = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });
    assert.equal(first.ok, true);

    const completed = await state.getAutopilotSession(session.autopilot_session_id);
    await state.putAutopilotSession({
      ...completed,
      order_count: 0,
      tick_count: 0,
      daily_notional_used_bucket: "0",
      last_execution_at: null,
      last_tick_at: null,
      pending_execution: {
        version: 1,
        execution_slot: 1,
        tick_id: first.tick_id,
        status: "created",
        proposal: first.proposal,
        proposal_commitment: first.proposal.proposal_commitment,
        work_order_commitment: first.work_order_commitment,
        created_at: new Date(now.getTime() + 60_000).toISOString(),
        updated_at: new Date(now.getTime() + 60_000).toISOString(),
      },
      last_completed_execution: null,
    });

    const killed = await controlAutopilotSession({
      sessionId: session.autopilot_session_id,
      action: "kill",
      state,
      recipient,
      now: new Date(now.getTime() + 2 * 60_000),
    });
    assert.equal(killed.session.status, "killed");
    assert.equal(killed.session.execution_enabled, false);
    assert.equal(killed.session.session_policy.kill_switch, true);
    assert.equal(killed.session.pending_execution.status, "cancelled_by_kill");

    const resumed = await controlAutopilotSession({
      sessionId: session.autopilot_session_id,
      action: "resume",
      state,
      recipient,
      now: new Date(now.getTime() + 3 * 60_000),
    });
    assert.equal(resumed.session.status, "killed");
    assert.equal(resumed.session.execution_enabled, false);

    const due = await runDueAutopilotSessions({
      state,
      recipient,
      now: new Date(now.getTime() + 4 * 60_000),
      env: process.env,
    });
    assert.equal(due.due_count, 0);

    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 5 * 60_000),
      env: process.env,
    });
    assert.equal(tick.ok, false);
    assert.equal(tick.error, "autopilot_not_running");
    const afterTick = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(afterTick.order_count, 0);
    assert.equal(afterTick.pending_execution.status, "cancelled_by_kill");
    assert.equal((await state.listExecutorRecords(session.autopilot_session_id)).length, 1);
  });

  it("runs due autonomous sessions without a UI-open loop", async () => {
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_due_runner",
        session_policy: {
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

    const result = await runDueAutopilotSessions({
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });

    assert.equal(result.checked_count, 1);
    assert.equal(result.due_count, 1);
    assert.equal(result.ran_count, 1);
    assert.equal(result.results[0].autopilot_session_id, session.autopilot_session_id);
    assert.equal(result.results[0].ok, true);
    const updated = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(updated.order_count, 1);
    assert.equal((await state.listExecutorRecords(session.autopilot_session_id)).length, 1);
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
    assert.equal(session.strategy.strategy_id, "bounded_intent_executor_v1");
    assert.equal(session.session_policy.strategy_id, "bounded_intent_executor_v1");
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

    const executors = await state.listExecutorRecords(session.autopilot_session_id);
    assert.equal(executors.length, 1);
    assert.equal(executors[0].decision_id, decisions[0].decision_id);
    assert.equal((await state.listTickSnapshots(session.autopilot_session_id)).length, 1);

    const eventTypes = (await state
      .listAutopilotEvents(session.autopilot_session_id))
      .map((event) => event.type);
    assert.deepEqual(eventTypes.slice(-10), [
      "position_update",
      "ai_decision",
      "proposal",
      "ai_score",
      "executor_created",
      "execution",
      "live_order_submitted",
      "receipt",
      "venue_reconcile",
      "tick_snapshot",
    ]);
  });

  it("simulates a no-submit private liquidity quote pair with replay records", async () => {
    process.env.PRIVATE_AGENT_MARKET_MAKER_QUOTE_SPREAD_BPS = "30";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_maker",
        session_policy: {
          strategy_id: "tri_venue_market_maker_v1",
          venue_allowlist: ["phoenix", "backpack", "hyperliquid"],
          market_allowlist: ["SOL-USD"],
          max_notional_bucket: "50",
          max_daily_notional_bucket: "250",
          max_order_count: 10,
          ttl_ms: 2 * 60 * 60_000,
          max_slippage_bps: 25,
          max_spread_bps: 100,
        },
      },
      recipient,
      state,
      provider: "test",
      startLoop: false,
      now,
    });

    assert.equal(session.status, "running");
    assert.equal(session.strategy.strategy_id, "tri_venue_market_maker_v1");

    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });

    assert.equal(tick.ok, true);
    assert.equal(tick.status, "simulated");
    assert.equal(tick.executors.length, 2);
    assert.deepEqual(tick.executors.map((executor) => executor.side).sort(), ["buy", "sell"]);
    assert.equal(tick.executors.every((executor) => executor.status === "simulated"), true);
    assert.equal(tick.executors.every((executor) => executor.operation_class === "perp_limit_order"), true);

    const updated = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(updated.order_count, 0);
    assert.equal(updated.daily_notional_used_bucket, "0");

    const executors = await state.listExecutorRecords(session.autopilot_session_id);
    assert.equal(executors.length, 2);
    assert.equal(executors.every((executor) => executor.close_reason === "no_submit_private_liquidity_simulation"), true);
    assert.equal(executors.every((executor) => executor.metadata.no_submit === true), true);

    const ticks = await state.listTickSnapshots(session.autopilot_session_id);
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].status, "simulated");
    assert.deepEqual(ticks[0].executor_ids.sort(), executors.map((executor) => executor.executor_id).sort());

    const replay = await listAutopilotReplay({
      sessionId: session.autopilot_session_id,
      state,
      now: new Date(now.getTime() + 90_000),
    });
    assert.equal(replay.metrics.executor_count, 2);
    assert.equal(replay.metrics.submitted_executor_count, 0);
    assert.equal(replay.tick_snapshots.length, 1);

    const eventTypes = (await state
      .listAutopilotEvents(session.autopilot_session_id))
      .map((event) => event.type);
    assert.equal(eventTypes.includes("executor_created"), true);
    assert.equal(eventTypes.includes("tick_snapshot"), true);
    assert.equal(eventTypes.includes("live_order_submitted"), false);
    assert.equal(eventTypes.includes("execution"), false);
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
    const snapshots = await state.listTickSnapshots(session.autopilot_session_id);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots.at(-1).status, "rejected");
    assert.equal(snapshots.at(-1).risk_result.reason, "ai_model_unconfigured");

    const eventTypes = (await state
      .listAutopilotEvents(session.autopilot_session_id))
      .map((event) => event.type);
    assert.equal(eventTypes.includes("ai_decision"), true);
    assert.equal(eventTypes.includes("risk_reject"), true);
    assert.equal(eventTypes.includes("execution"), false);
  });
});
