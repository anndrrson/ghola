import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { GET as autopilotReadinessRoute } from "@/app/v1/private-account/autopilot/readiness/route";
import { POST as createAutopilotRoute } from "@/app/v1/private-account/autopilot/sessions/route";
import { GET as walletBindingChallengeRoute } from "@/app/v1/private-account/wallet-bindings/challenge/route";
import { POST as walletBindingRoute } from "@/app/v1/private-account/wallet-bindings/route";
import {
  createOrGetStoredPrivateAccount,
  type PrivateAccountRequestOwner,
} from "@/app/v1/private-account/_lib";
import {
  putHyperliquidExecutionVault,
  resetPrivateAccountStoreForTests,
} from "./private-account-store";
import { createHyperliquidExecutionVault } from "./private-account";
import {
  controlAutonomousAutopilotSessionFromBody,
  controlAutopilotSessionFromBody,
  createAutonomousAutopilotSessionFromBody,
  createAutopilotSessionFromBody,
  getAutopilotSessionForOwner,
  listAutopilotEventsForOwner,
  listAutopilotSessionsForOwner,
  resetAutopilotSessionsForTests,
  syncWorkerAutopilotSession,
} from "./private-account-autopilot";
import { probeConfiguredAutopilotWorkerReadiness } from "./private-agent-worker-readiness";
import { privateAccountMobileProofMessage } from "./private-account-mobile-proof";
import { brandPrivateAgentMockTransport } from "./private-agent-spend-policy";

const owner = { owner_commitment: "owner_a" };
const authenticatedOwner: PrivateAccountRequestOwner = {
  owner_commitment: "owner_autopilot_user",
  user: {
    id: "user_autopilot",
    email: "user@example.com",
  },
};

describe("private account autopilot sessions", () => {
  beforeEach(() => {
    resetAutopilotSessionsForTests();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN;
    delete process.env.GHOLA_PRIVATE_AGENT_JIT_PROVISIONING;
    delete process.env.GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED;
    delete process.env.GHOLA_PRIVATE_AGENT_ALLOW_UNATTESTED_DEV;
    delete process.env.PHALA_CLOUD_API_KEY;
    delete process.env.PHALA_API_KEY;
    delete process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED;
    delete process.env.GHOLA_HYPERLIQUID_LIVE_MODE;
    delete process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS;
    delete process.env.GHOLA_HYPERLIQUID_EXECUTION_VAULT_READY;
    await resetPrivateAccountStoreForTests();
  });

  it("carries a drawn directional plan onto a level_trigger session policy", async () => {
    const created = await createAutopilotSessionFromBody({
      session_policy: {
        strategy_id: "level_trigger_v1",
        agent_side: "buy",
        agent_mandate: {
          strategy_profile: "breakout_retest",
          entry_trigger: "break_level",
          exit_rule: "exit_on_invalidation",
          time_horizon: "until_invalidated",
          trigger_level: "65000",
          invalidation_level: "64000",
        },
        venue_allowlist: ["hyperliquid"],
        market_allowlist: ["BTC-USD"],
        execution_network: "mainnet",
        exact_notional_usd: "5",
        max_notional_bucket: "5",
        max_slippage_bps: 50,
      },
    }, owner, new Date("2026-06-01T12:00:00.000Z"));

    expect(created.session.session_policy.strategy_id).toBe("level_trigger_v1");
    expect(created.session.session_policy.agent_side).toBe("buy");
    expect(created.session.session_policy.agent_mandate?.entry_trigger).toBe("break_level");
    expect(created.session.session_policy.agent_mandate?.trigger_level).toBe("65000");
    expect(created.session.session_policy.agent_mandate?.invalidation_level).toBe("64000");
    expect(created.session.strategy.strategy_id).toBe("level_trigger_v1");
    expect(created.session.strategy.executable_order_source).toBe("deterministic_level_trigger");
  });

  it("creates conservative APAC retail defaults", async () => {
    const created = await createAutopilotSessionFromBody({}, owner, new Date("2026-06-01T12:00:00.000Z"));

    expect(created.session.status).toBe("pending_worker");
    expect(created.session.execution_enabled).toBe(false);
    expect(created.session.session_policy.venue_allowlist).toEqual(["jupiter", "phoenix", "hyperliquid", "coinbase_advanced"]);
    expect(created.session.session_policy.market_allowlist).toEqual(["SOL-USD", "BTC-USD", "ETH-USD"]);
    expect(created.session.session_policy.max_notional_bucket).toBe("50");
    expect(created.session.session_policy.max_position_notional_bucket).toBe("100");
    expect(created.session.session_policy.max_loss_bucket).toBe("25");
    expect(created.session.session_policy.max_daily_notional_bucket).toBe("250");
    expect(created.session.session_policy.max_order_count).toBe(10);
    expect(created.session.session_policy.max_slippage_bps).toBe(50);
    expect(created.session.session_policy.cooldown_ms).toBe(5 * 60_000);
    expect(created.session.session_policy.data_max_age_ms).toBe(30_000);
    expect(created.session.session_policy.ai_direct_enabled).toBe(true);
    expect(created.session.session_policy.decision_model).toBe("ai_direct_order_v1");
    expect(created.session.strategy.ai_can_execute_directly).toBe(true);
    expect(created.events.map((event) => event.type)).toEqual([
      "session_created",
      "venue_readiness",
      "guardrail",
    ]);
  });

  it("persists sessions and events through the private account store", async () => {
    const created = await createAutopilotSessionFromBody({}, owner, new Date("2026-06-01T12:00:00.000Z"));

    const listed = await listAutopilotSessionsForOwner(owner);
    const events = await listAutopilotEventsForOwner(created.session.autopilot_session_id, owner);

    expect(listed.map((session) => session.autopilot_session_id)).toContain(created.session.autopilot_session_id);
    expect("events" in events && events.events.map((event) => event.type)).toEqual([
      "session_created",
      "venue_readiness",
      "guardrail",
    ]);
  });

  it("normalizes requested venues, markets, and policy caps", async () => {
    const created = await createAutopilotSessionFromBody({
      session_policy: {
        venue_allowlist: ["jupiter", "bad", "coinbase_advanced"],
        market_allowlist: ["sol", "doge", "SOL/USDC"],
        max_notional_bucket: "1000",
        max_position_notional_bucket: "500",
        max_loss_bucket: "1000",
        max_daily_notional_bucket: "250",
        max_order_count: 500,
        ttl_ms: 1,
        max_slippage_bps: 500,
        locale_hint: "id",
        timezone: "Asia/Jakarta",
      },
    }, owner);

    expect(created.session.session_policy.venue_allowlist).toEqual(["jupiter", "coinbase_advanced"]);
    expect(created.session.session_policy.market_allowlist).toEqual(["SOL-USD", "SOL/USDC"]);
    expect(created.session.session_policy.max_notional_bucket).toBe("50");
    expect(created.session.session_policy.max_position_notional_bucket).toBe("500");
    expect(created.session.session_policy.max_loss_bucket).toBe("25");
    expect(created.session.session_policy.max_daily_notional_bucket).toBe("250");
    expect(created.session.session_policy.max_order_count).toBe(25);
    expect(created.session.session_policy.ttl_ms).toBe(5 * 60_000);
    expect(created.session.session_policy.max_slippage_bps).toBe(100);
    expect(created.session.session_policy.locale_hint).toBe("id");
  });

  it("controls pause, resume, and kill for the owning user only", async () => {
    const created = await createAutopilotSessionFromBody({}, owner);
    const id = created.session.autopilot_session_id;

    const rejected = await controlAutopilotSessionFromBody(id, "pause", { owner_commitment: "owner_b" });
    expect(rejected).toEqual({ error: "autopilot_session_not_found" });

    const paused = await controlAutopilotSessionFromBody(id, "pause", owner);
    expect("session" in paused && paused.session.status).toBe("paused");
    const resumed = await controlAutopilotSessionFromBody(id, "resume", owner);
    expect("session" in resumed && resumed.session.status).toBe("pending_worker");
    const killed = await controlAutopilotSessionFromBody(id, "kill", owner);
    expect("session" in killed && killed.session.execution_enabled).toBe(false);
    expect("session" in killed && killed.session.status).toBe("killed");

    const events = await listAutopilotEventsForOwner(id, owner);
    expect("events" in events && events.events.some((event) => event.message === "Autopilot kill.")).toBe(true);
  });

  it("denies autonomous resume before transport or local session mutation", async () => {
    const now = new Date("2026-08-12T12:00:00.000Z");
    const created = await createAutopilotSessionFromBody({}, owner, now);
    const paused = await controlAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "pause",
      owner,
      now,
    );
    expect("session" in paused && paused.session.status).toBe("paused");
    const before = await getAutopilotSessionForOwner(created.session.autopilot_session_id, owner, now);
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "resume",
      owner,
      new Date("2026-08-12T12:01:00.000Z"),
      {
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        GHOLA_PRIVATE_AGENT_SPEND_ARMED: "true",
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
      },
      fetchImpl,
    );
    const after = await getAutopilotSessionForOwner(created.session.autopilot_session_id, owner, now);

    expect(result).toEqual({ error: "private_agent_transport_blocked" });
    expect(fetchCalls).toBe(0);
    expect(after).toEqual(before);
  });

  it("keeps the prior live session on worker control failure and commits only after retry acknowledgment", async () => {
    const createdAt = new Date("2026-08-12T12:00:00.000Z");
    const env = {
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
    };
    let killAttempts = 0;
    const transport = brandPrivateAgentMockTransport((async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/ready")) {
        return Response.json({ ready: true, missing: [] });
      }
      if (url.endsWith("/autopilot/sessions")) {
        return Response.json({
          session: {
            autopilot_session_id: "worker_control_ack",
            status: "running",
            execution_enabled: true,
          },
          events: [],
        }, { status: 201 });
      }
      if (url.endsWith("/worker_control_ack/kill")) {
        killAttempts += 1;
        if (killAttempts === 1) {
          return Response.json({ error: "worker_busy" }, { status: 503 });
        }
        return Response.json({
          session: {
            autopilot_session_id: "worker_control_ack",
            status: "killed",
            execution_enabled: false,
            updated_at: "2026-08-12T12:02:00.000Z",
          },
          event: {
            event_id: "worker_kill_ack",
            type: "session_state",
            status: "killed",
            message: "Autopilot kill.",
            data: { action: "kill" },
          },
        });
      }
      return Response.json({ error: "unexpected_worker_path" }, { status: 500 });
    }) as typeof fetch);
    const created = await createAutonomousAutopilotSessionFromBody(
      {},
      owner,
      createdAt,
      env,
      transport,
    );
    expect(created.session).toMatchObject({
      worker_autopilot_session_id: "worker_control_ack",
      status: "running",
      execution_enabled: true,
    });
    const before = await getAutopilotSessionForOwner(
      created.session.autopilot_session_id,
      owner,
      new Date("2026-08-12T12:01:00.000Z"),
    );

    const failed = await controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "kill",
      owner,
      new Date("2026-08-12T12:01:00.000Z"),
      env,
      transport,
    );
    const afterFailure = await getAutopilotSessionForOwner(
      created.session.autopilot_session_id,
      owner,
      new Date("2026-08-12T12:01:00.000Z"),
    );

    expect(failed).toEqual({
      error: "autopilot_worker_control_unconfirmed",
      action: "kill",
      reason: "worker_busy",
      retryable: true,
    });
    expect(afterFailure).toEqual(before);
    expect(afterFailure).toMatchObject({ status: "running", execution_enabled: true });

    const retried = await controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "kill",
      owner,
      new Date("2026-08-12T12:02:00.000Z"),
      env,
      transport,
    );
    expect(retried).toMatchObject({
      session: { status: "killed", execution_enabled: false },
      event: { event_id: "worker_kill_ack", status: "killed" },
    });
    expect(killAttempts).toBe(2);
  });

  it("rejects 2xx worker responses with mismatched control state or action", async () => {
    const env = {
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
    };
    let controlAttempts = 0;
    const transport = brandPrivateAgentMockTransport((async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/ready")) return Response.json({ ready: true, missing: [] });
      if (url.endsWith("/autopilot/sessions")) return Response.json({
        session: {
          autopilot_session_id: "worker_bad_ack",
          status: "running",
          execution_enabled: true,
        },
        events: [],
      }, { status: 201 });
      controlAttempts += 1;
      const stateMismatch = controlAttempts === 1;
      return Response.json({
        session: {
          autopilot_session_id: "worker_bad_ack",
          status: stateMismatch ? "running" : "killed",
          execution_enabled: stateMismatch,
        },
        event: {
          event_id: "worker_bad_kill_ack",
          type: "session_state",
          status: stateMismatch ? "running" : "killed",
          message: stateMismatch ? "Still running." : "Wrong action.",
          data: { action: stateMismatch ? "kill" : "pause" },
        },
      });
    }) as typeof fetch);
    const created = await createAutonomousAutopilotSessionFromBody(
      {},
      owner,
      new Date("2026-08-12T12:00:00.000Z"),
      env,
      transport,
    );

    const result = await controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "kill",
      owner,
      new Date("2026-08-12T12:01:00.000Z"),
      env,
      transport,
    );
    const stored = await getAutopilotSessionForOwner(
      created.session.autopilot_session_id,
      owner,
      new Date("2026-08-12T12:01:00.000Z"),
    );

    expect(result).toMatchObject({
      error: "autopilot_worker_control_unconfirmed",
      action: "kill",
      reason: "worker_kill_not_acknowledged",
    });
    await expect(controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "kill",
      owner,
      new Date("2026-08-12T12:02:00.000Z"),
      env,
      transport,
    )).resolves.toMatchObject({
      error: "autopilot_worker_control_unconfirmed",
      action: "kill",
      reason: "worker_control_action_mismatch",
    });
    expect(stored).toMatchObject({ status: "running", execution_enabled: true });
    await expect(getAutopilotSessionForOwner(
      created.session.autopilot_session_id,
      owner,
      new Date("2026-08-12T12:02:00.000Z"),
    )).resolves.toMatchObject({ status: "running", execution_enabled: true });
  });

  it("keeps a live session on failed pause and persists only an exact paused acknowledgment", async () => {
    const env = {
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
    };
    let pauseAttempts = 0;
    const transport = brandPrivateAgentMockTransport((async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/ready")) return Response.json({ ready: true, missing: [] });
      if (url.endsWith("/autopilot/sessions")) {
        return Response.json({
          session: {
            autopilot_session_id: "worker_pause_ack",
            status: "running",
            execution_enabled: true,
          },
          events: [],
        }, { status: 201 });
      }
      pauseAttempts += 1;
      if (pauseAttempts === 1) {
        return Response.json({ error: "worker_timeout" }, { status: 504 });
      }
      return Response.json({
        session: {
          autopilot_session_id: "worker_pause_ack",
          status: "paused",
          execution_enabled: false,
        },
        event: {
          event_id: "worker_pause_ack_event",
          type: "session_state",
          status: "paused",
          message: "Autopilot pause.",
          data: { action: "pause" },
        },
      });
    }) as typeof fetch);
    const created = await createAutonomousAutopilotSessionFromBody(
      {},
      owner,
      new Date("2026-08-12T12:00:00.000Z"),
      env,
      transport,
    );

    const failed = await controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "pause",
      owner,
      new Date("2026-08-12T12:01:00.000Z"),
      env,
      transport,
    );
    const afterFailure = await getAutopilotSessionForOwner(
      created.session.autopilot_session_id,
      owner,
      new Date("2026-08-12T12:01:00.000Z"),
    );
    expect(failed).toMatchObject({
      error: "autopilot_worker_control_unconfirmed",
      action: "pause",
      reason: "worker_timeout",
    });
    expect(afterFailure).toMatchObject({ status: "running", execution_enabled: true });

    const acknowledged = await controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "pause",
      owner,
      new Date("2026-08-12T12:02:00.000Z"),
      env,
      transport,
    );
    expect(acknowledged).toMatchObject({
      session: { status: "paused", execution_enabled: false },
      event: {
        status: "paused",
        data: { action: "pause" },
      },
    });
    expect(pauseAttempts).toBe(2);
  });

  it("bounds an unresponsive worker control, returns retryable timeout, and leaves local state live", async () => {
    vi.useFakeTimers();
    const env = {
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
      GHOLA_AUTOPILOT_CONTROL_TIMEOUT_MS: "1",
    };
    const transport = brandPrivateAgentMockTransport((async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/ready")) return Response.json({ ready: true, missing: [] });
      if (url.endsWith("/autopilot/sessions")) {
        return Response.json({
          session: {
            autopilot_session_id: "worker_control_timeout",
            status: "running",
            execution_enabled: true,
          },
          events: [],
        }, { status: 201 });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    }) as typeof fetch);
    const created = await createAutonomousAutopilotSessionFromBody(
      {},
      owner,
      new Date("2026-08-12T12:00:00.000Z"),
      env,
      transport,
    );

    const pending = controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "kill",
      owner,
      new Date("2026-08-12T12:01:00.000Z"),
      env,
      transport,
    );
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      error: "autopilot_worker_control_unconfirmed",
      action: "kill",
      reason: "worker_control_timeout",
      retryable: true,
    });
    await expect(getAutopilotSessionForOwner(
      created.session.autopilot_session_id,
      owner,
      new Date("2026-08-12T12:01:00.000Z"),
    )).resolves.toMatchObject({ status: "running", execution_enabled: true });
    vi.useRealTimers();
  });

  it("arms the private worker and mirrors worker events into the local session", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: URL | RequestInfo) => {
      calls.push(String(input));
      if (String(input).endsWith("/ready")) {
        return new Response(JSON.stringify({ ready: true, missing: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        version: 1,
        session: {
          version: 2,
          autopilot_session_id: "worker_autopilot_123",
          worker_session_commitment: "worker_commitment_123",
          status: "running",
          strategy: {
            version: 1,
            strategy_id: "momentum_micro_trader",
            decision_model: "ai_direct_order_v1",
            executable_order_source: "ai_structured_decision_validated_by_policy",
            ai_can_execute_directly: true,
          },
          session_policy: {
            decision_model: "ai_direct_order_v1",
            ai_direct_enabled: true,
            venue_allowlist: ["jupiter", "coinbase_advanced"],
            market_allowlist: ["SOL-USD"],
            max_notional_bucket: "50",
            max_position_notional_bucket: "100",
            max_daily_notional_bucket: "250",
            max_order_count: 10,
            ttl_ms: 2 * 60 * 60_000,
            max_slippage_bps: 50,
            cooldown_ms: 5 * 60_000,
            data_max_age_ms: 30_000,
            min_ai_score_bps: 6_500,
            ai_min_confidence_bps: 6_500,
            min_signal_bps: 25,
            max_spread_bps: 150,
            kill_switch: false,
            reduce_only_on_reconcile_failure: true,
            locale_hint: "en",
            timezone: "Asia/Singapore",
            policy_commitment: "autopilot_policy_worker",
          },
          venue_access: {
            jupiter: { status: "ready", execution_mode: "ghola_pooled", reason: "dry_run_ready" },
            coinbase_advanced: { status: "needs_funds", execution_mode: null, reason: "isolated_vault_required" },
          },
          order_count: 0,
          daily_notional_used_bucket: "0",
          updated_at: "2026-06-01T12:00:00.000Z",
          expires_at: "2026-06-01T14:00:00.000Z",
          next_step: "Autonomous worker is running.",
          execution_enabled: true,
        },
        events: [{
          version: 1,
          event_id: "worker_event_ready",
          type: "venue_readiness",
          status: "running",
          message: "At least one venue is ready for autonomous execution.",
          data: {},
          created_at: "2026-06-01T12:00:00.000Z",
        }],
      }), { status: 201 });
    };

    const created = await createAutonomousAutopilotSessionFromBody(
      {
        session_policy: {
          venue_allowlist: ["jupiter", "coinbase_advanced"],
          market_allowlist: ["SOL-USD"],
        },
      },
      owner,
      new Date("2026-06-01T12:00:00.000Z"),
      {
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
      },
      brandPrivateAgentMockTransport(fetchImpl as typeof fetch),
    );

    expect(calls).toEqual([
      "https://worker.example/ready",
      "https://worker.example/autopilot/sessions",
    ]);
    expect(created.session.status).toBe("running");
    expect(created.session.control_plane).toBe("worker");
    expect(created.session.worker_autopilot_session_id).toBe("worker_autopilot_123");
    expect(created.session.strategy.ai_can_execute_directly).toBe(true);
    expect(created.session.session_policy.decision_model).toBe("ai_direct_order_v1");
    expect(created.session.venue_access.jupiter.status).toBe("ready");
    expect(created.events.some((event) => event.event_id === "worker_event_ready")).toBe(true);
  });

  it("wakes Phala on demand from configured credentials before arming a worker autopilot session", async () => {
    const calls: string[] = [];
    const wakeReasons: string[] = [];
    const fetchImpl = async (input: URL | RequestInfo) => {
      calls.push(String(input));
      if (String(input).endsWith("/ready")) {
        return new Response(JSON.stringify({ ready: true, missing: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        version: 1,
        session: {
          version: 2,
          autopilot_session_id: "worker_autopilot_jit",
          worker_session_commitment: "worker_commitment_jit",
          status: "running",
          strategy: {
            version: 1,
            strategy_id: "momentum_micro_trader",
            decision_model: "ai_direct_order_v1",
            executable_order_source: "ai_structured_decision_validated_by_policy",
            ai_can_execute_directly: true,
          },
          session_policy: {
            decision_model: "ai_direct_order_v1",
            ai_direct_enabled: true,
            venue_allowlist: ["hyperliquid"],
            market_allowlist: ["BTC-USD"],
            max_notional_bucket: "5",
            max_position_notional_bucket: "100",
            max_daily_notional_bucket: "250",
            max_order_count: 10,
            ttl_ms: 2 * 60 * 60_000,
            max_slippage_bps: 50,
            cooldown_ms: 5 * 60_000,
            data_max_age_ms: 30_000,
            min_ai_score_bps: 6_500,
            ai_min_confidence_bps: 6_500,
            min_signal_bps: 25,
            max_spread_bps: 150,
            kill_switch: false,
            reduce_only_on_reconcile_failure: true,
            locale_hint: "en",
            timezone: "Asia/Singapore",
            policy_commitment: "autopilot_policy_worker_jit",
          },
          venue_access: {
            hyperliquid: { status: "ready", execution_mode: "byo_api_wallet", reason: "scoped_api_wallet_ready" },
          },
          order_count: 0,
          daily_notional_used_bucket: "0",
          updated_at: "2026-06-01T12:00:00.000Z",
          expires_at: "2026-06-01T14:00:00.000Z",
          next_step: "Autonomous worker is running.",
          execution_enabled: true,
        },
        events: [],
      }), { status: 201 });
    };

    const created = await createAutonomousAutopilotSessionFromBody(
      {
        session_policy: {
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
          max_notional_bucket: "5",
        },
      },
      owner,
      new Date("2026-06-01T12:00:00.000Z"),
      {
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
        GHOLA_PRIVATE_AGENT_JIT_PROVISIONING: "false",
        GHOLA_PRIVATE_AGENT_SPEND_ARMED: "true",
        PHALA_CLOUD_API_KEY: "phala-key",
      },
      brandPrivateAgentMockTransport(fetchImpl as typeof fetch),
      {
        wakePhalaForUse: async (input) => {
          wakeReasons.push(input.reason);
          return {
            attempted: true,
            ready: true,
            status: "ready",
            execution_url: "https://worker.example",
          };
        },
        discoverPhalaExecutionUrl: async () => "https://worker.example",
      },
    );

    expect(wakeReasons).toEqual(["autopilot_session_create"]);
    expect(calls).toEqual([
      "https://worker.example/ready",
      "https://worker.example/autopilot/sessions",
    ]);
    expect(created.session.status).toBe("running");
    expect(created.session.worker_autopilot_session_id).toBe("worker_autopilot_jit");
    expect(created.session.venue_access.hyperliquid.status).toBe("ready");
  });

  it("attaches a user's stored Hyperliquid API vault to worker autopilot sessions", async () => {
    const account = await createOrGetStoredPrivateAccount(authenticatedOwner);
    const vault = createHyperliquidExecutionVault({
      account_commitment: account.account_commitment,
      encrypted_execution_vault: {
        ciphertext: "sealed-hyperliquid-autopilot-vault",
        recipient: "mock_attested:dev",
        aad: "ghola/hyperliquid-execution-vault-v1",
      },
      now: new Date("2026-06-01T11:59:00.000Z"),
    });
    expect(vault.ok).toBe(true);
    if (!vault.ok) return;
    await putHyperliquidExecutionVault({
      version: 1,
      owner_commitment: authenticatedOwner.owner_commitment,
      account_commitment: account.account_commitment,
      vault_commitment: vault.vault.vault_commitment,
      encrypted_vault_commitment: vault.vault.encrypted_vault_commitment,
      recipient_commitment: vault.vault.recipient_commitment,
      policy_commitment: vault.vault.policy_commitment,
      status: vault.vault.status,
      vault: vault.vault,
      created_at: vault.vault.created_at,
      updated_at: vault.vault.updated_at,
    });

    let workerPayload: Record<string, unknown> | null = null;
    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith("/ready")) {
        return new Response(JSON.stringify({ ready: true, missing: [] }), { status: 200 });
      }
      workerPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        version: 1,
        session: {
          version: 2,
          autopilot_session_id: "worker_autopilot_hyperliquid_byo",
          worker_session_commitment: "worker_commitment_hyperliquid_byo",
          status: "running",
          strategy: {
            version: 1,
            strategy_id: "momentum_micro_trader",
            decision_model: "ai_direct_order_v1",
            executable_order_source: "ai_structured_decision_validated_by_policy",
            ai_can_execute_directly: true,
          },
          session_policy: (workerPayload?.session_policy ?? {}),
          venue_access: (workerPayload?.venue_access ?? {}),
          order_count: 0,
          daily_notional_used_bucket: "0",
          updated_at: "2026-06-01T12:00:00.000Z",
          expires_at: "2026-06-01T14:00:00.000Z",
          next_step: "Autonomous worker is running.",
          execution_enabled: true,
        },
        events: [],
      }), { status: 201 });
    };

    const created = await createAutonomousAutopilotSessionFromBody(
      {
        session_policy: {
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
          max_notional_bucket: "5",
        },
      },
      authenticatedOwner,
      new Date("2026-06-01T12:00:00.000Z"),
      {
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
      },
      brandPrivateAgentMockTransport(fetchImpl as typeof fetch),
    );

    expect(workerPayload).not.toBeNull();
    const payload = workerPayload as unknown as { venue_access?: Record<string, Record<string, unknown>> };
    const venueAccess = payload.venue_access ?? {};
    expect(venueAccess.hyperliquid.status).toBe("ready");
    expect(venueAccess.hyperliquid.execution_mode).toBe("byo_api_key");
    expect(venueAccess.hyperliquid.encrypted_execution_vault).toMatchObject({
      ciphertext: "sealed-hyperliquid-autopilot-vault",
      recipient: "mock_attested:dev",
    });
    expect(JSON.stringify(workerPayload)).not.toContain("api_wallet_private_key");
    expect(created.session.status).toBe("running");
    expect(created.session.venue_access.hyperliquid.status).toBe("ready");
  });

  it("refuses to arm an autopilot session when the configured worker is not attested-ready", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: URL | RequestInfo) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        ready: false,
        missing: ["attestation", "measurement", "attestation_hash"],
      }), { status: 503 });
    };

    const readiness = await probeConfiguredAutopilotWorkerReadiness({
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
    }, brandPrivateAgentMockTransport(fetchImpl as typeof fetch));
    expect(readiness).toEqual({
      ok: false,
      error: "worker_not_ready:attestation,measurement,attestation_hash",
      missing: ["attestation", "measurement", "attestation_hash"],
      status: 503,
    });

    const created = await createAutonomousAutopilotSessionFromBody(
      {
        session_policy: {
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
        },
      },
      owner,
      new Date("2026-06-01T12:00:00.000Z"),
      {
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
      },
      brandPrivateAgentMockTransport(fetchImpl as typeof fetch),
    );

    expect(calls).toEqual([
      "https://worker.example/ready",
      "https://worker.example/ready",
    ]);
    expect(created.session.status).toBe("pending_worker");
    expect(created.session.execution_enabled).toBe(false);
    expect(created.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Autonomous worker is not armed: the worker is not ready (attestation, measurement, attestation_hash).",
        data: expect.objectContaining({
          error: "worker_not_ready:attestation,measurement,attestation_hash",
        }),
      }),
    ]));
  });

  it("arms an explicitly allowed unattested development worker", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: URL | RequestInfo) => {
      calls.push(String(input));
      if (String(input).endsWith("/ready")) {
        return new Response(JSON.stringify({
          ready: false,
          missing: ["attestation", "image_digest", "measurement", "attestation_hash"],
        }), { status: 503 });
      }
      return new Response(JSON.stringify({
        session: {
          autopilot_session_id: "worker_autopilot_dev",
          status: "running",
          execution_enabled: true,
        },
        events: [],
      }), { status: 201 });
    };

    const created = await createAutonomousAutopilotSessionFromBody(
      {
        session_policy: {
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
        },
      },
      owner,
      new Date("2026-06-01T12:00:00.000Z"),
      {
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
        GHOLA_PRIVATE_AGENT_ALLOW_UNATTESTED_DEV: "true",
      },
      brandPrivateAgentMockTransport(fetchImpl as typeof fetch),
    );

    expect(calls).toEqual([
      "https://worker.example/ready",
      "https://worker.example/autopilot/sessions",
    ]);
    expect(created.session.status).toBe("running");
    expect(created.session.execution_enabled).toBe(true);
  });

  it("blocks a lost worker session and records one actionable sync failure", async () => {
    const createFetch = async (input: URL | RequestInfo) => {
      if (String(input).endsWith("/ready")) {
        return new Response(JSON.stringify({ ready: true, missing: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        session: {
          autopilot_session_id: "worker_autopilot_lost",
          status: "running",
          session_policy: {
            venue_allowlist: ["hyperliquid"],
            market_allowlist: ["BTC-USD"],
          },
          venue_access: {
            hyperliquid: {
              status: "ready",
              execution_mode: "byo_api_key",
              reason: "scoped_api_wallet_ready",
            },
          },
          execution_enabled: true,
        },
        events: [],
      }), { status: 201 });
    };
    const created = await createAutonomousAutopilotSessionFromBody(
      {
        session_policy: {
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
        },
      },
      owner,
      new Date("2026-06-01T12:00:00.000Z"),
      {
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
      },
      brandPrivateAgentMockTransport(createFetch as typeof fetch),
    );

    const missingFetch = brandPrivateAgentMockTransport(
      (async () => new Response(JSON.stringify({
        error: "autopilot_session_not_found",
      }), { status: 404 })) as typeof fetch,
    );
    const first = await syncWorkerAutopilotSession(
      created.session.autopilot_session_id,
      owner,
      {
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
      },
      missingFetch,
      new Date("2026-06-01T12:01:00.000Z"),
    );
    const second = await syncWorkerAutopilotSession(
      created.session.autopilot_session_id,
      owner,
      {
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
      },
      missingFetch,
      new Date("2026-06-01T12:02:00.000Z"),
    );

    expect("session" in first && first.session.status).toBe("blocked");
    expect("session" in first && first.session.execution_enabled).toBe(false);
    expect("session" in first && first.session.next_step).toContain("worker no longer has this run");
    expect("events" in second && second.events.filter((event) =>
      event.data.error === "autopilot_session_not_found"
    )).toHaveLength(1);
  });

  it("does not poll an armed worker through the default test transport", async () => {
    const createFetch = brandPrivateAgentMockTransport((async (input: URL | RequestInfo) => {
      if (String(input).endsWith("/ready")) {
        return Response.json({ ready: true, missing: [] });
      }
      return Response.json({
        session: {
          autopilot_session_id: "worker_autopilot_no_poll",
          status: "running",
          execution_enabled: true,
        },
        events: [],
      }, { status: 201 });
    }) as typeof fetch);
    const env = {
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
    };
    const created = await createAutonomousAutopilotSessionFromBody(
      {},
      owner,
      new Date("2026-06-01T12:00:00.000Z"),
      env,
      createFetch,
    );
    expect(created.session.worker_autopilot_session_id).toBe("worker_autopilot_no_poll");

    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    await syncWorkerAutopilotSession(created.session.autopilot_session_id, owner, env);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("expires sessions without exposing them to other owners", async () => {
    const created = await createAutopilotSessionFromBody({
      session_policy: { ttl_ms: 5 * 60_000 },
    }, owner, new Date("2026-06-01T12:00:00.000Z"));

    await expect(getAutopilotSessionForOwner(created.session.autopilot_session_id, { owner_commitment: "other" })).resolves.toBeNull();
    const expired = await getAutopilotSessionForOwner(
      created.session.autopilot_session_id,
      owner,
      new Date("2026-06-01T12:06:00.000Z"),
    );
    expect(expired?.status).toBe("expired");
    expect(expired?.execution_enabled).toBe(false);
  });

  it("accepts a wallet-signed mobile live proof on autopilot routes without exposing the HMAC secret", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "enforce";
    const secret = ed25519.utils.randomPrivateKey();
    await bindMobileWallet(secret);

    const body = {
      session_policy: {
        venue_allowlist: ["hyperliquid"],
        market_allowlist: ["BTC-USD"],
        max_notional_bucket: "5",
      },
    };
    const req = mobileProofPost("/v1/private-account/autopilot/sessions", body, { secret });
    const res = await createAutopilotRoute(req);
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.session.status).toBe("pending_worker");
    expect(json.session.session_policy.max_notional_bucket).toBe("5");
  });

  it("rejects invalid and replayed mobile live proofs", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "enforce";
    const secret = ed25519.utils.randomPrivateKey();
    await bindMobileWallet(secret);

    const signedBody = { session_policy: { market_allowlist: ["BTC-USD"] } };
    const tamperedBody = { session_policy: { market_allowlist: ["ETH-USD"] } };
    const invalid = await createAutopilotRoute(
      mobileProofPost("/v1/private-account/autopilot/sessions", tamperedBody, {
        signedBody,
        secret,
      }),
    );
    expect(invalid.status).toBe(403);
    await expect(invalid.json()).resolves.toMatchObject({ error: "mobile_proof_invalid" });

    const nonce = "mobile-replay-nonce";
    const first = await createAutopilotRoute(
      mobileProofPost("/v1/private-account/autopilot/sessions", signedBody, { nonce, secret }),
    );
    expect(first.status).toBe(201);
    const replay = await createAutopilotRoute(
      mobileProofPost("/v1/private-account/autopilot/sessions", signedBody, { nonce, secret }),
    );
    expect(replay.status).toBe(403);
    await expect(replay.json()).resolves.toMatchObject({ error: "mobile_proof_replayed" });
  });

  it("rejects unbound and cross-owner mobile live proofs", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "enforce";
    const secret = ed25519.utils.randomPrivateKey();
    const body = { session_policy: { market_allowlist: ["BTC-USD"] } };

    const unbound = await createAutopilotRoute(
      mobileProofPost("/v1/private-account/autopilot/sessions", body, { secret }),
    );
    expect(unbound.status).toBe(403);
    await expect(unbound.json()).resolves.toMatchObject({ error: "mobile_wallet_not_bound" });

    await bindMobileWallet(secret, "other_user");
    const wrongOwner = await createAutopilotRoute(
      mobileProofPost("/v1/private-account/autopilot/sessions", body, { secret }),
    );
    expect(wrongOwner.status).toBe(403);
    await expect(wrongOwner.json()).resolves.toMatchObject({ error: "mobile_wallet_not_bound" });
  });

  it("rejects tampered and stale mobile wallet binding proofs", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    const secret = ed25519.utils.randomPrivateKey();
    const wallet = bs58.encode(ed25519.getPublicKey(secret));
    const challengeRes = await walletBindingChallengeRoute(
      get(`/v1/private-account/wallet-bindings/challenge?wallet_pubkey=${wallet}`),
    );
    const challenge = await challengeRes.json();
    const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(challenge.message), secret)).toString("base64");
    const tampered = await walletBindingRoute(bindingPost({
      wallet_pubkey: wallet,
      message: challenge.message.replace(`wallet:${wallet}`, "wallet:So11111111111111111111111111111111111111112"),
      signature_b64: signature,
    }));
    expect(tampered.status).toBe(403);
    await expect(tampered.json()).resolves.toMatchObject({ error: "mobile_wallet_binding_invalid" });

    const staleMessage = challenge.message.replace(
      `timestamp_ms:${challenge.timestamp_ms}`,
      "timestamp_ms:1",
    );
    const staleSignature = Buffer.from(ed25519.sign(new TextEncoder().encode(staleMessage), secret)).toString("base64");
    const stale = await walletBindingRoute(bindingPost({
      wallet_pubkey: wallet,
      message: staleMessage,
      signature_b64: staleSignature,
    }));
    expect(stale.status).toBe(403);
    await expect(stale.json()).resolves.toMatchObject({ error: "mobile_wallet_binding_stale" });
  });

  it("allows multiple active mobile wallets for one owner", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "enforce";
    const firstSecret = ed25519.utils.randomPrivateKey();
    const secondSecret = ed25519.utils.randomPrivateKey();
    await bindMobileWallet(firstSecret);
    await bindMobileWallet(secondSecret);

    const body = { session_policy: { market_allowlist: ["BTC-USD"], max_notional_bucket: "5" } };
    const first = await createAutopilotRoute(
      mobileProofPost("/v1/private-account/autopilot/sessions", body, { secret: firstSecret }),
    );
    const second = await createAutopilotRoute(
      mobileProofPost("/v1/private-account/autopilot/sessions", body, { secret: secondSecret }),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it("reports Seeker autopilot readiness for tiny live orders", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-token";
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    process.env.GHOLA_HYPERLIQUID_LIVE_MODE = "tiny_fill";
    process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS = "ready";
    process.env.GHOLA_HYPERLIQUID_EXECUTION_VAULT_READY = "true";
    const { wallet } = await bindMobileWallet(ed25519.utils.randomPrivateKey());

    const res = await autopilotReadinessRoute(
      get(`/v1/private-account/autopilot/readiness?product_id=BTC-USD&wallet_pubkey=${wallet}`),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.can_arm).toBe(true);
    expect(body.can_live_submit).toBe(true);
    expect(body.wallet_binding_status).toBe("active");
    expect(body.venue_readiness.find((venue: { venue_id: string }) => venue.venue_id === "hyperliquid").status)
      .toBe("ready");
  });

  it("reports guarded full-ticket Hyperliquid readiness when both account and worker gates are armed", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-token";
    process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED = "true";
    process.env.GHOLA_HYPERLIQUID_LIVE_MODE = "full_ticket";
    process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS = "ready";
    process.env.GHOLA_HYPERLIQUID_EXECUTION_VAULT_READY = "true";
    const { wallet } = await bindMobileWallet(ed25519.utils.randomPrivateKey());

    const res = await autopilotReadinessRoute(
      get(`/v1/private-account/autopilot/readiness?product_id=BTC-USD&wallet_pubkey=${wallet}`),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.can_live_submit).toBe(true);
    expect(body.target_live_mode).toBe("guarded_full_ticket");
    expect(body.venue_readiness.find((venue: { venue_id: string }) => venue.venue_id === "hyperliquid").status)
      .toBe("ready");
  });
});

function auth(userId: string) {
  return `Bearer ${[
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "sig",
  ].join(".")}`;
}

function get(path: string, authorization = auth("autopilot_route_user")) {
  return new Request(`https://ghola.test${path}`, {
    headers: { authorization },
  });
}

async function bindMobileWallet(secret: Uint8Array, userId = "autopilot_route_user") {
  const wallet = bs58.encode(ed25519.getPublicKey(secret));
  const challengeRes = await walletBindingChallengeRoute(
    get(`/v1/private-account/wallet-bindings/challenge?wallet_pubkey=${wallet}`, auth(userId)),
  );
  expect(challengeRes.status).toBe(200);
  const challenge = await challengeRes.json();
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(challenge.message), secret)).toString("base64");
  const bindRes = await walletBindingRoute(new Request("https://ghola.test/v1/private-account/wallet-bindings", {
    ...bindingPostInit({
      wallet_pubkey: wallet,
      message: challenge.message,
      signature_b64: signature,
    }, userId),
  }));
  expect(bindRes.status).toBe(201);
  return { wallet, secret };
}

function bindingPost(body: unknown, userId = "autopilot_route_user") {
  return new Request("https://ghola.test/v1/private-account/wallet-bindings", {
    ...bindingPostInit(body, userId),
  });
}

function bindingPostInit(body: unknown, userId = "autopilot_route_user"): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: auth(userId),
    },
    body: JSON.stringify(body),
  };
}

function mobileProofPost(
  path: string,
  body: unknown,
  options: {
    signedBody?: unknown;
    nonce?: string;
    timestamp?: string;
    secret?: Uint8Array;
  } = {},
) {
  const secret = options.secret ?? ed25519.utils.randomPrivateKey();
  const wallet = bs58.encode(ed25519.getPublicKey(secret));
  const timestamp = options.timestamp ?? String(Date.now());
  const nonce = options.nonce ?? `mobile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const bodyHash = createHash("sha256")
    .update(stableJson(options.signedBody ?? body))
    .digest("hex");
  const message = privateAccountMobileProofMessage({
    method: "POST",
    path,
    timestamp,
    nonce,
    bodyHash,
    wallet,
  });
  const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(message), secret)).toString("base64");
  return new Request(`https://ghola.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: auth("autopilot_route_user"),
      "x-ghola-mobile-proof-version": "1",
      "x-ghola-mobile-wallet": wallet,
      "x-ghola-mobile-proof-timestamp": timestamp,
      "x-ghola-mobile-proof-nonce": nonce,
      "x-ghola-mobile-proof-signature-b64": signature,
    },
    body: JSON.stringify(body),
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
