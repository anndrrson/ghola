import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import {
  controlAutopilotSession,
  createAutopilotSession,
  listAutopilotReplay,
  runDueAutopilotSessions,
  runAutopilotTick,
} from "../src/execution/autopilot.js";
import {
  bytesToBase64,
  bytesToHex,
  didKeyFromVerifying,
  sealForTest,
} from "../src/crypto/envelope.js";
import { createSqliteWorkerState, createWorkerState } from "../src/state/private-state.js";

const OLD_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...OLD_ENV };
}

async function weakMarketFetch() {
  return new Response(JSON.stringify({
    price: "100",
    price_percentage_change_24h: "0.01",
    pricebook: {
      best_bid: "99.99",
      best_ask: "100.01",
    },
  }), { status: 200 });
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

  it("preserves and enforces the owner-bound Hyperliquid account commitment", async () => {
    const recipient = testRecipient();
    const boundAccount = "account_bound_owner_123";
    const encryptedVault = await sealedHyperliquidVault(recipient, boundAccount);
    const now = new Date(Date.now() + 60_000);

    const validState = createWorkerState(join(dir, "valid-account"));
    const valid = await createHyperliquidAutopilot({
      state: validState,
      recipient,
      now,
      encryptedVault,
      accountCommitment: boundAccount,
    });
    const stored = await validState.getAutopilotSession(valid.autopilot_session_id);
    assert.equal(stored.venue_access.hyperliquid.account_commitment, boundAccount);

    const tick = await runAutopilotTick({
      sessionId: valid.autopilot_session_id,
      state: validState,
      recipient,
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });
    assert.equal(tick.ok, true);
    assert.equal(tick.proposal.market, "BTC-USD");
    assert.equal(tick.proposal.venue_id, "hyperliquid");

    for (const [label, accountCommitment, expected] of [
      ["wrong-account", "account_bound_attacker_456", /account binding mismatch/],
      ["missing-account", undefined, /account commitment is unavailable/],
    ]) {
      const state = createWorkerState(join(dir, label));
      const session = await createHyperliquidAutopilot({
        state,
        recipient,
        now,
        encryptedVault,
        accountCommitment,
      });
      await assert.rejects(
        () => runAutopilotTick({
          sessionId: session.autopilot_session_id,
          state,
          recipient,
          now: new Date(now.getTime() + 60_000),
          env: process.env,
        }),
        expected,
      );
      assert.equal(await state.getIdempotency(`autopilot:${session.autopilot_session_id}:1`), null);
    }
  });

  it("never reports execution enabled while the live-submit gate is closed", async () => {
    delete process.env.PRIVATE_AGENT_AUTOPILOT_LIVE_SUBMIT;
    delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    const state = createWorkerState(join(dir, "live-gate-closed"));
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_live_gate_closed",
        session_policy: {
          venue_allowlist: ["jupiter"],
          market_allowlist: ["SOL-USD"],
        },
        venue_access: {
          jupiter: { status: "ready", execution_mode: "ghola_pooled" },
        },
      },
      recipient: { recipient_id: "did:key:live-gate-closed" },
      state,
      provider: "test",
      startLoop: false,
      now,
    });

    assert.equal(session.status, "blocked");
    assert.equal(session.execution_enabled, false);
    assert.match(session.next_step, /Live submission is disabled/);
    const tick = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient: { recipient_id: "did:key:live-gate-closed" },
      now: new Date(now.getTime() + 60_000),
      env: process.env,
    });
    assert.deepEqual(tick, { ok: false, error: "autopilot_not_running" });
  });

  it("blocks create, refresh, and resume while the global kill switch is active", async () => {
    const recipient = { recipient_id: "did:key:global-kill" };
    const now = new Date(Date.now() + 60_000);
    process.env.PRIVATE_AGENT_GLOBAL_KILL_SWITCH = "true";
    const blockedState = createWorkerState(join(dir, "global-kill-create"));
    const blocked = await createAutopilotSession({
      body: {
        owner_commitment: "owner_global_kill_create",
        session_policy: { venue_allowlist: ["jupiter"], market_allowlist: ["SOL-USD"] },
      },
      recipient,
      state: blockedState,
      provider: "test",
      startLoop: false,
      now,
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.execution_enabled, false);

    delete process.env.PRIVATE_AGENT_GLOBAL_KILL_SWITCH;
    const state = createWorkerState(join(dir, "global-kill-refresh"));
    const running = await createAutopilotSession({
      body: {
        owner_commitment: "owner_global_kill_refresh",
        session_policy: { venue_allowlist: ["jupiter"], market_allowlist: ["SOL-USD"] },
      },
      recipient,
      state,
      provider: "test",
      startLoop: false,
      now,
    });
    assert.equal(running.status, "running");
    process.env.PRIVATE_AGENT_GLOBAL_KILL_SWITCH = "true";
    const replay = await listAutopilotReplay({
      sessionId: running.autopilot_session_id,
      state,
      now: new Date(now.getTime() + 1_000),
    });
    assert.equal(replay.session.status, "blocked");
    assert.equal(replay.session.execution_enabled, false);
    const resumed = await controlAutopilotSession({
      sessionId: running.autopilot_session_id,
      action: "resume",
      state,
      recipient,
      now: new Date(now.getTime() + 2_000),
    });
    assert.equal(resumed.session.status, "blocked");
    assert.equal(resumed.session.execution_enabled, false);
  });

  it("caps bounded Hyperliquid orders, binds the network, and refreshes access on resume", async () => {
    const recipient = testRecipient();
    const accountCommitment = "account_network_bound_123";
    const encryptedVault = await sealedHyperliquidVault(recipient, accountCommitment);
    const now = new Date(Date.now() + 60_000);
    const access = {
      hyperliquid: {
        status: "ready",
        execution_mode: "byo_api_key",
        network: "testnet",
        account_commitment: accountCommitment,
        encrypted_execution_vault: encryptedVault,
      },
    };
    const state = createWorkerState(join(dir, "network-bound"));
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_network_bound",
        session_policy: {
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
          max_notional_bucket: "100",
          execution_network: "testnet",
        },
        venue_access: access,
      },
      recipient,
      state,
      provider: "test",
      startLoop: false,
      now,
    });
    assert.equal(session.status, "running");
    assert.equal(session.session_policy.max_notional_bucket, "5");
    assert.equal(session.venue_access.hyperliquid.network, "testnet");

    await controlAutopilotSession({
      sessionId: session.autopilot_session_id,
      action: "pause",
      state,
      recipient,
      now: new Date(now.getTime() + 1_000),
    });
    const rejected = await controlAutopilotSession({
      sessionId: session.autopilot_session_id,
      action: "resume",
      state,
      recipient,
      now: new Date(now.getTime() + 2_000),
    });
    assert.equal(rejected.session.status, "paused");
    assert.equal(rejected.session.execution_enabled, false);
    const resumed = await controlAutopilotSession({
      sessionId: session.autopilot_session_id,
      action: "resume",
      state,
      recipient,
      venueAccess: access,
      now: new Date(now.getTime() + 3_000),
    });
    assert.equal(resumed.session.status, "running");
    assert.equal(resumed.session.execution_enabled, true);

    const mismatchState = createWorkerState(join(dir, "network-mismatch"));
    const mismatch = await createAutopilotSession({
      body: {
        owner_commitment: "owner_network_mismatch",
        session_policy: {
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
          execution_network: "mainnet",
          mainnet_activation_id: "activation:mainnet:test",
          owner_authorization_commitment: "owner_auth:testnet_mismatch",
        },
        venue_access: access,
      },
      recipient,
      state: mismatchState,
      provider: "test",
      startLoop: false,
      now,
    });
    assert.equal(mismatch.venue_access.hyperliquid.status, "blocked");
    assert.equal(mismatch.venue_access.hyperliquid.reason, "execution_network_mismatch");
    assert.equal(mismatch.execution_enabled, false);

    const mainnetState = createWorkerState(join(dir, "mainnet-pending"));
    const mainnet = await createAutopilotSession({
      body: {
        owner_commitment: "owner_mainnet_pending",
        session_policy: {
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
          execution_network: "mainnet",
        },
        venue_access: {
          hyperliquid: { ...access.hyperliquid, network: "mainnet" },
        },
      },
      recipient,
      state: mainnetState,
      provider: "test",
      startLoop: false,
      now,
    });
    assert.equal(mainnet.status, "pending_activation");
    assert.equal(mainnet.execution_enabled, false);

    process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "false";
    delete process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET;
    delete process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE;
    delete process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD;
    const liveTestnet = await createAutopilotSession({
      body: {
        owner_commitment: "owner_live_testnet",
        session_policy: {
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
          execution_network: "testnet",
        },
        venue_access: access,
      },
      recipient,
      state: createWorkerState(join(dir, "live-testnet")),
      provider: "test",
      startLoop: false,
      now,
    });
    assert.equal(liveTestnet.status, "running");
    assert.equal(liveTestnet.execution_enabled, true);

    const activatedPolicy = {
      venue_allowlist: ["hyperliquid"],
      market_allowlist: ["BTC-USD"],
      execution_network: "mainnet",
      mainnet_activation_id: "activation:mainnet:test",
      owner_authorization_commitment: "owner_auth:mainnet:test",
    };
    const activatedAccess = {
      hyperliquid: { ...access.hyperliquid, network: "mainnet" },
    };
    const createMainnet = (label) => createAutopilotSession({
      body: {
        owner_commitment: `owner_${label}`,
        session_policy: activatedPolicy,
        venue_access: activatedAccess,
      },
      recipient,
      state: createWorkerState(join(dir, label)),
      provider: "test",
      startLoop: false,
      now,
    });

    assert.equal((await createMainnet("mainnet-not-allowed")).status, "blocked");

    process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET = "true";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "disabled";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD = "5";
    assert.equal((await createMainnet("mainnet-mode-disabled")).status, "blocked");

    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD = "25";
    assert.equal((await createMainnet("mainnet-cap-too-high")).status, "blocked");

    process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD = "5";
    const activated = await createMainnet("mainnet-activated");
    assert.equal(activated.status, "running");
    assert.equal(activated.execution_enabled, true);
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

  it("routes a typed AI proposal into a bounded dry-run order after deterministic validation", async () => {
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
    assert.equal(session.strategy.model_role, "proposal_only");
    assert.equal(session.strategy.deterministic_router, true);
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
    assert.equal(tick.proposal.decision_source, "ai_structured_proposal_v2");
    assert.equal(tick.proposal.routing.selected_venue_id, "jupiter");
    assert.ok(tick.proposal.routing.expected_net_benefit_bps > 0);
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

  it("skips AI-direct decisions when the market is not actionable", async () => {
    process.env.PRIVATE_AGENT_AI_DIRECT_ENABLED = "true";
    process.env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE = "live";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_ai_sparse",
        session_policy: {
          decision_model: "ai_direct_order_v1",
          ai_direct_enabled: true,
          venue_allowlist: ["jupiter"],
          market_allowlist: ["SOL-USD"],
          max_notional_bucket: "50",
          max_daily_notional_bucket: "250",
          max_order_count: 10,
          ttl_ms: 2 * 60 * 60_000,
          max_slippage_bps: 50,
          min_signal_bps: 25,
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
      fetchImpl: weakMarketFetch,
    });

    assert.equal(tick.ok, false);
    assert.equal(tick.error, "signal_too_weak");
    assert.equal((await state.listAutopilotDecisions(session.autopilot_session_id)).length, 0);
    const updated = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(updated.non_actionable_tick_count, 1);
  });

  it("auto-pauses after repeated non-actionable ticks", async () => {
    process.env.PRIVATE_AGENT_AUTOPILOT_SIGNAL_MODE = "live";
    process.env.PRIVATE_AGENT_AUTOPILOT_AUTO_PAUSE_NOOP_TICKS = "2";
    const state = createWorkerState(dir);
    const recipient = { recipient_id: "did:key:test-autopilot-worker" };
    const now = new Date(Date.now() + 60_000);
    const session = await createAutopilotSession({
      body: {
        owner_commitment: "owner_autopilot_auto_pause",
        session_policy: {
          ai_direct_enabled: false,
          venue_allowlist: ["jupiter"],
          market_allowlist: ["SOL-USD"],
          max_notional_bucket: "50",
          max_daily_notional_bucket: "250",
          max_order_count: 10,
          ttl_ms: 2 * 60 * 60_000,
          max_slippage_bps: 50,
          min_signal_bps: 25,
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
      fetchImpl: weakMarketFetch,
    });
    const second = await runAutopilotTick({
      sessionId: session.autopilot_session_id,
      state,
      recipient,
      now: new Date(now.getTime() + 120_000),
      env: process.env,
      fetchImpl: weakMarketFetch,
    });

    assert.equal(first.error, "signal_too_weak");
    assert.equal(second.error, "signal_too_weak");
    const updated = await state.getAutopilotSession(session.autopilot_session_id);
    assert.equal(updated.status, "paused");
    assert.equal(updated.execution_enabled, false);
    assert.equal(updated.non_actionable_tick_count, 2);
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

async function createHyperliquidAutopilot({
  state,
  recipient,
  now,
  encryptedVault,
  accountCommitment,
}) {
  return createAutopilotSession({
    body: {
      owner_commitment: "owner_hyperliquid_account_binding",
      session_policy: {
        ai_direct_enabled: false,
        venue_allowlist: ["hyperliquid"],
        market_allowlist: ["BTC-USD"],
        max_notional_bucket: "5",
        max_daily_notional_bucket: "25",
        max_order_count: 1,
        ttl_ms: 2 * 60 * 60_000,
        max_slippage_bps: 25,
        execution_network: "testnet",
      },
      venue_access: {
        hyperliquid: {
          status: "ready",
          execution_mode: "byo_api_key",
          network: "testnet",
          account_commitment: accountCommitment,
          vault_commitment: "vault_hyperliquid_account_bound",
          encrypted_vault_commitment: "encrypted_vault_hyperliquid_account_bound",
          encrypted_execution_vault: encryptedVault,
        },
      },
    },
    recipient,
    state,
    provider: "test",
    startLoop: false,
    now,
  });
}

function testRecipient() {
  const secret = x25519.utils.randomPrivateKey();
  return {
    recipient_id: "did:key:test-autopilot-account-bound",
    x25519_secret_hex: bytesToHex(secret),
    x25519_pub_hex: bytesToHex(x25519.getPublicKey(secret)),
  };
}

async function sealedHyperliquidVault(recipient, accountCommitment) {
  const senderSecret = ed25519.utils.randomPrivateKey();
  const aad = [
    "ghola/hyperliquid-execution-vault-v1",
    `account:${accountCommitment}`,
    `recipient:${recipient.recipient_id}`,
    "network:testnet",
  ].join("|");
  const sealed = await sealForTest({
    senderDid: didKeyFromVerifying(ed25519.getPublicKey(senderSecret)),
    recipientId: recipient.recipient_id,
    recipientX25519: x25519.getPublicKey(Buffer.from(recipient.x25519_secret_hex, "hex")),
    associatedData: aad,
    plaintext: {
      kind: "ghola_hyperliquid_execution_vault",
      network: "testnet",
      hyperliquid_account_address: `0x${"1".repeat(40)}`,
      api_wallet_private_key: `0x${"2".repeat(64)}`,
      agent_name: "ghola-account-bound-test",
    },
    signBody: async (digest) => ed25519.sign(digest, senderSecret),
  });
  return {
    alg: "sealed-provider-v1",
    ciphertext: bytesToBase64(sealed),
    recipient: recipient.recipient_id,
    aad,
  };
}
