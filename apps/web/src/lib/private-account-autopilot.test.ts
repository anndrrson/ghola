import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { GET as autopilotReadinessRoute } from "@/app/v1/private-account/autopilot/readiness/route";
import { GET as autopilotReplayRoute } from "@/app/v1/private-account/autopilot/sessions/[session_id]/replay/route";
import { POST as createAutopilotRoute } from "@/app/v1/private-account/autopilot/sessions/route";
import { GET as walletBindingChallengeRoute } from "@/app/v1/private-account/wallet-bindings/challenge/route";
import { POST as walletBindingRoute } from "@/app/v1/private-account/wallet-bindings/route";
import { resetPrivateAccountStoreForTests } from "./private-account-store";
import {
  controlAutopilotSessionFromBody,
  createAutonomousAutopilotSessionFromBody,
  createAutopilotSessionFromBody,
  getAutopilotSessionForOwner,
  listAutopilotEventsForOwner,
  listAutopilotReplayForOwner,
  listAutopilotSessionsForOwner,
  resetAutopilotSessionsForTests,
} from "./private-account-autopilot";
import { privateAccountMobileProofMessage } from "./private-account-mobile-proof";

const owner = { owner_commitment: "owner_a" };

describe("private account autopilot sessions", () => {
  beforeEach(() => {
    resetAutopilotSessionsForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE;
    delete process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN;
    delete process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED;
    delete process.env.GHOLA_HYPERLIQUID_LIVE_MODE;
    delete process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS;
    delete process.env.GHOLA_HYPERLIQUID_EXECUTION_VAULT_READY;
    await resetPrivateAccountStoreForTests();
  });

  it("creates conservative APAC retail defaults", async () => {
    const created = await createAutopilotSessionFromBody({}, owner, new Date("2026-06-01T12:00:00.000Z"));

    expect(created.session.status).toBe("pending_worker");
    expect(created.session.execution_enabled).toBe(false);
    expect(created.session.session_policy.venue_allowlist).toEqual([
      "jupiter",
      "phoenix",
      "backpack",
      "hyperliquid",
      "coinbase_advanced",
    ]);
    expect(created.session.session_policy.market_allowlist).toEqual(["SOL-USD", "BTC-USD", "ETH-USD"]);
    expect(created.session.session_policy.max_notional_bucket).toBe("50");
    expect(created.session.session_policy.max_position_notional_bucket).toBe("100");
    expect(created.session.session_policy.max_daily_notional_bucket).toBe("250");
    expect(created.session.session_policy.max_order_count).toBe(10);
    expect(created.session.session_policy.max_slippage_bps).toBe(50);
    expect(created.session.session_policy.strategy_id).toBe("bounded_intent_executor_v1");
    expect(created.session.session_policy.cooldown_ms).toBe(5 * 60_000);
    expect(created.session.session_policy.data_max_age_ms).toBe(30_000);
    expect(created.session.session_policy.ai_direct_enabled).toBe(true);
    expect(created.session.session_policy.decision_model).toBe("ai_direct_order_v1");
    expect(created.session.session_policy.decision_contract).toBe("structured_proposal_v2");
    expect(created.session.session_policy.model_role).toBe("proposal_only");
    expect(created.session.strategy.strategy_id).toBe("bounded_intent_executor_v1");
    expect(created.session.strategy.executable_order_source).toBe("deterministic_cost_router_after_typed_model_proposal");
    expect(created.session.strategy.ai_can_execute_directly).toBe(false);
    expect(created.session.strategy.deterministic_router).toBe(true);
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
    expect(created.session.session_policy.max_notional_bucket).toBe("1000");
    expect(created.session.session_policy.max_position_notional_bucket).toBe("500");
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

  it("arms the private worker and mirrors worker events into the local session", async () => {
    const calls: string[] = [];
    const payloads: unknown[] = [];
    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push(String(input));
      if (typeof init?.body === "string") payloads.push(JSON.parse(init.body));
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
            decision_contract: "structured_proposal_v2",
            model_role: "proposal_only",
            executable_order_source: "deterministic_cost_router_after_typed_model_proposal",
            ai_can_execute_directly: false,
            deterministic_router: true,
          },
          session_policy: {
            decision_model: "ai_direct_order_v1",
            decision_contract: "structured_proposal_v2",
            model_role: "proposal_only",
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
          next_step: "Bounded intent executor is running.",
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
      fetchImpl,
      {
        version: 1,
        reservation_id: "autopilot_meter_test",
        metering_mode: "sparse_metered_v1",
        reserved_seconds: 300,
        lease_started_at: "2026-06-01T12:00:00.000Z",
        lease_expires_at: "2026-06-01T12:05:00.000Z",
      },
    );

    expect(calls).toEqual(["https://worker.example/autopilot/sessions"]);
    expect(payloads).toHaveLength(1);
    expect((payloads[0] as { session_policy: { strategy_id: string } }).session_policy.strategy_id).toBe("bounded_intent_executor_v1");
    expect((payloads[0] as { billing_metering: { reservation_id: string; reserved_seconds: number } }).billing_metering).toMatchObject({
      reservation_id: "autopilot_meter_test",
      reserved_seconds: 300,
    });
    expect(created.session.billing_metering?.reservation_id).toBe("autopilot_meter_test");
    expect(created.session.status).toBe("running");
    expect(created.session.control_plane).toBe("worker");
    expect(created.session.worker_autopilot_session_id).toBe("worker_autopilot_123");
    expect(created.session.strategy.strategy_id).toBe("bounded_intent_executor_v1");
    expect(created.session.session_policy.strategy_id).toBe("bounded_intent_executor_v1");
    expect(created.session.strategy.ai_can_execute_directly).toBe(false);
    expect(created.session.strategy.model_role).toBe("proposal_only");
    expect(created.session.session_policy.decision_model).toBe("ai_direct_order_v1");
    expect(created.session.venue_access.jupiter.status).toBe("ready");
    expect(created.events.some((event) => event.event_id === "worker_event_ready")).toBe(true);
  });

  it("returns a local replay bundle from the authenticated replay route", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS = "true";
    const createRes = await createAutopilotRoute(new Request("https://ghola.test/v1/private-account/autopilot/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: auth("autopilot_route_user"),
      },
      body: JSON.stringify({
        session_policy: {
          venue_allowlist: ["jupiter"],
          market_allowlist: ["SOL-USD"],
        },
      }),
    }));
    const created = await createRes.json();

    const replayRes = await autopilotReplayRoute(
      get(`/v1/private-account/autopilot/sessions/${created.session.autopilot_session_id}/replay`),
      { params: Promise.resolve({ session_id: created.session.autopilot_session_id }) },
    );
    const replay = await replayRes.json();

    expect(replayRes.status).toBe(200);
    expect(replay.session.autopilot_session_id).toBe(created.session.autopilot_session_id);
    expect(replay.metrics.executor_count).toBe(0);
    expect(replay.executors).toEqual([]);
    expect(replay.events.map((event: { type: string }) => event.type)).toContain("session_created");
  });

  it("fetches worker replay records and merges replay events into the local session", async () => {
    const calls: string[] = [];
    const workerSession = {
      version: 2,
      autopilot_session_id: "worker_replay_123",
      agent_controller_id: "agentctl_worker_replay",
      worker_session_commitment: "worker_commitment_replay",
      status: "running",
      strategy: {
        version: 1,
        strategy_id: "tri_venue_market_maker_v1",
        decision_model: "rules_plus_ai_score",
        executable_order_source: "deterministic_guarded_market_maker",
        ai_can_execute_directly: true,
      },
      session_policy: {
        strategy_id: "tri_venue_market_maker_v1",
        decision_model: "rules_plus_ai_score",
        ai_direct_enabled: false,
        venue_allowlist: ["phoenix"],
        market_allowlist: ["SOL-USD"],
        max_notional_bucket: "50",
        max_position_notional_bucket: "100",
        max_daily_notional_bucket: "250",
        max_order_count: 10,
        ttl_ms: 2 * 60 * 60_000,
        max_slippage_bps: 25,
        cooldown_ms: 5 * 60_000,
        data_max_age_ms: 30_000,
        min_ai_score_bps: 6_500,
        ai_min_confidence_bps: 6_500,
        min_signal_bps: 25,
        max_spread_bps: 100,
        kill_switch: false,
        reduce_only_on_reconcile_failure: true,
        locale_hint: "en",
        timezone: "Asia/Singapore",
        policy_commitment: "autopilot_policy_worker_replay",
      },
      venue_access: {
        phoenix: { status: "ready", execution_mode: "ghola_pooled", reason: "dry_run_ready" },
      },
      order_count: 0,
      daily_notional_used_bucket: "0",
      updated_at: "2026-06-01T12:00:00.000Z",
      expires_at: "2026-06-01T14:00:00.000Z",
      next_step: "Private liquidity replay is available.",
      execution_enabled: true,
    };
    const fetchImpl = async (input: URL | RequestInfo) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/autopilot/sessions")) {
        return new Response(JSON.stringify({
          version: 1,
          session: workerSession,
          events: [{
            version: 1,
            event_id: "worker_replay_ready",
            type: "venue_readiness",
            status: "running",
            message: "Worker ready.",
            data: {},
            created_at: "2026-06-01T12:00:00.000Z",
          }],
        }), { status: 201 });
      }
      if (url.endsWith("/autopilot/sessions/worker_replay_123/replay")) {
        return new Response(JSON.stringify({
          version: 1,
          session: workerSession,
          metrics: {
            version: 1,
            agent_controller_id: "agentctl_worker_replay",
            executor_count: 2,
            submitted_executor_count: 0,
          },
          executors: [{
            version: 1,
            executor_id: "executor_quote_buy",
            status: "simulated",
            kind: "quote",
            venue_id: "phoenix",
            market: "SOL-USD",
            side: "buy",
            notional_bucket: "25",
          }],
          tick_snapshots: [{
            version: 1,
            tick_id: "tick_replay",
            status: "simulated",
            executor_ids: ["executor_quote_buy"],
            created_at: "2026-06-01T12:00:01.000Z",
          }],
          positions: [],
          events: [{
            version: 1,
            event_id: "worker_executor_created",
            type: "executor_created",
            status: "running",
            message: "No-submit executor recorded.",
            data: { executor_ids: ["executor_quote_buy"] },
            created_at: "2026-06-01T12:00:01.000Z",
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    };

    const created = await createAutonomousAutopilotSessionFromBody(
      {
        session_policy: {
          strategy_id: "tri_venue_market_maker_v1",
          venue_allowlist: ["phoenix"],
          market_allowlist: ["SOL-USD"],
        },
      },
      owner,
      new Date("2026-06-01T12:00:00.000Z"),
      {
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
      },
      fetchImpl,
    );

    const replay = await listAutopilotReplayForOwner(
      created.session.autopilot_session_id,
      owner,
      {
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
      },
      fetchImpl,
      new Date("2026-06-01T12:00:02.000Z"),
    );

    expect(calls).toContain("https://worker.example/autopilot/sessions/worker_replay_123/replay");
    expect("error" in replay).toBe(false);
    if ("error" in replay) return;
    expect(replay.metrics.executor_count).toBe(2);
    expect(replay.executors[0].executor_id).toBe("executor_quote_buy");
    expect(replay.tick_snapshots[0].status).toBe("simulated");
    expect(replay.events.map((event) => event.event_id)).toContain("worker_executor_created");
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

  it("rejects Android autopilot session creation before worker arming when billing is unpaid", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/api/user/profile")) {
        return new Response(JSON.stringify({
          id: "autopilot_route_user",
          email: "autopilot_route_user@example.com",
        }), { status: 200 });
      }
      if (url.endsWith("/api/billing/status")) {
        return new Response(JSON.stringify({
          tier: "free",
          private_agent_compute: {
            included_seconds: 0,
            reserved_seconds: 0,
            used_seconds: 0,
            remaining_seconds: 0,
            active_agent_limit: 0,
            active_agent_count: 0,
            period_start: "2026-06-01",
            period_end: "2026-07-01",
            metering_unit: "agent_second",
          },
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await createAutopilotRoute(new Request("https://ghola.test/v1/private-account/autopilot/sessions", {
      method: "POST",
      headers: {
        authorization: auth("autopilot_route_user"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_policy: {
          venue_allowlist: ["hyperliquid"],
          market_allowlist: ["BTC-USD"],
          max_notional_bucket: "5",
        },
      }),
    }));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error).toBe("private_agent_billing_required");
    expect(body.blocking_reasons).toContain("subscription_required");
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://worker.example/autopilot/sessions",
      expect.anything(),
    );
  });

  it("reserves a short sparse compute lease before arming the worker", async () => {
    process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_MODE = "report_only";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-token";
    const reserveBodies: unknown[] = [];
    const workerBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/user/profile")) {
        return new Response(JSON.stringify({
          id: "autopilot_route_user",
          email: "autopilot_route_user@example.com",
        }), { status: 200 });
      }
      if (url.endsWith("/api/billing/status")) {
        return new Response(JSON.stringify({
          tier: "private_agent",
          private_agent_compute: {
            included_seconds: 108000,
            reserved_seconds: 0,
            used_seconds: 0,
            remaining_seconds: 108000,
            active_agent_limit: 1,
            active_agent_count: 0,
            period_start: "2026-06-01",
            period_end: "2026-07-01",
            metering_unit: "agent_second",
          },
        }), { status: 200 });
      }
      if (url.endsWith("/api/billing/private-agent/compute/reserve")) {
        reserveBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "https://worker.example/autopilot/sessions") {
        const body = JSON.parse(String(init?.body));
        workerBodies.push(body);
        return new Response(JSON.stringify({
          session: {
            version: 2,
            autopilot_session_id: "worker_sparse_meter_123",
            worker_session_commitment: "worker_commitment",
            owner_commitment: body.owner_commitment,
            status: "running",
            strategy: {
              version: 1,
              strategy_id: "bounded_intent_executor_v1",
              decision_model: "ai_direct_order_v1",
              decision_contract: "structured_proposal_v2",
              model_role: "proposal_only",
              executable_order_source: "deterministic_cost_router_after_typed_model_proposal",
              ai_can_execute_directly: false,
              deterministic_router: true,
            },
            session_policy: body.session_policy,
            venue_access: {
              jupiter: { status: "ready", execution_mode: "ghola_pooled", reason: "dry_run_ready" },
            },
            order_count: 0,
            daily_notional_used_bucket: "0",
            updated_at: "2026-06-01T12:00:00.000Z",
            expires_at: "2026-06-01T14:00:00.000Z",
            next_step: "Bounded intent executor is running.",
            execution_enabled: true,
          },
          events: [],
        }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await createAutopilotRoute(new Request("https://ghola.test/v1/private-account/autopilot/sessions", {
      method: "POST",
      headers: {
        authorization: auth("autopilot_route_user"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_policy: {
          venue_allowlist: ["jupiter"],
          market_allowlist: ["SOL-USD"],
        },
      }),
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(reserveBodies[0]).toMatchObject({
      seconds: 300,
      metering_mode: "sparse_metered_v1",
    });
    expect((workerBodies[0] as { billing_metering: { reservation_id: string; reserved_seconds: number } }).billing_metering)
      .toMatchObject({
        reservation_id: (reserveBodies[0] as { session_id: string }).session_id,
        reserved_seconds: 300,
      });
    expect(body.billing.metering_mode).toBe("sparse_metered_v1");
    expect(body.billing.reserved_seconds).toBe(300);
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
    expect(body.execution_display).toMatchObject({
      mode: "live_capped",
      label: "Live Capped",
      can_trade: true,
    });
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
