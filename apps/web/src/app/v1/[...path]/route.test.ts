import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";
import { createV1ProxyHandler, type V1ProxyDependencies } from "./_handler";
import { gholaCommitment } from "@/lib/private-account";
import { brandPrivateAgentMockTransport } from "@/lib/private-agent-spend-policy";
import {
  buildTradeOrderPlan,
  tradeOrderPlanIdempotencyKey,
  type TradeOrderPlan,
} from "@/lib/trade-order-plan";
import {
  issueTradeOrderPlanBinding,
  tradeExecutionIdentityCommitments,
} from "@/lib/trade-order-plan-binding.server";

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

const POLICY_ENV_KEYS = [
  "NODE_ENV",
  "VERCEL_ENV",
  "VITEST",
  "GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED",
  "GHOLA_PRIVATE_AGENT_SPEND_ARMED",
  "GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN",
] as const;
const ORIGINAL_POLICY_ENV = Object.fromEntries(
  POLICY_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof POLICY_ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of POLICY_ENV_KEYS) {
    const value = ORIGINAL_POLICY_ENV[key];
    if (value === undefined) delete process.env[key];
    else Reflect.set(process.env, key, value);
  }
});

function sessionLookup(userId = "web-user-1"): V1ProxyDependencies["fetchSessionUserImpl"] {
  return vi.fn(async () => ({
    ok: true as const,
    user: {
      id: userId,
      email: `${userId}@example.com`,
      name: "Investor",
    },
  }));
}

function privateMutationPost(
  fetchImpl: typeof fetch,
  fetchSessionUserImpl = sessionLookup(),
) {
  return createV1ProxyHandler({
    fetchImpl: brandPrivateAgentMockTransport(fetchImpl),
    fetchSessionUserImpl,
    byoExecutionGateImpl: (plan) => {
      const id = plan.venue_id;
      return {
        allowed: true,
        reason_codes: [],
        venue: {
          id,
          label: id,
          submit_source: "user_scoped_credential",
          status: "green",
          reason_codes: [],
        },
      };
    },
    liveAuthorizationImpl: async ({ order_plan }) => ({
      ok: true,
      capability: order_plan.execution_policy.reduce_only ? "reduce_only" : "limit_order",
      account_commitment: tradeExecutionIdentityCommitments("web-user-1", order_plan.venue_id).upstreamAccountId,
      vault_commitment: "test-vault",
      launch_revision: order_plan.execution_policy.reduce_only ? null : 1,
      reservation: null,
    }),
    liveDispatchImpl: async ({ idempotency_key, account_commitment, vault_commitment, plan_digest }) => {
      const headers = new Headers();
      headers.set("idempotency-key", idempotency_key);
      return fetchImpl("https://worker.ghola.test/hyperliquid/orders", {
        method: "POST",
        headers,
        body: JSON.stringify({ account_commitment, vault_commitment, plan_digest }),
      });
    },
  });
}

function request(url: string, init?: NextRequestInit) {
  return new NextRequest(url, init);
}

function forwardedHeaders(fetchSpy: { mock: { calls: unknown[][] } }): Headers {
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

function forwardedUrl(fetchSpy: { mock: { calls: unknown[][] } }): string {
  return String(fetchSpy.mock.calls[0]?.[0]);
}

describe("v1 x402 proxy privacy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards payment headers but strips sensitive correlators", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const res = await POST(
      request("https://ghola.test/v1/chat/completions", {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer sk-ghola-test",
          "content-type": "application/json",
          "payment-signature": "paid",
          "x402-payment": "paid",
          "x-ghola-payment-rail": "railgun_evm_shielded",
          "x-payment-rail": "railgun_evm_shielded",
          "x-request-id": "durable-client-trace",
          "x-user-id": "user-123",
          "x-wallet-address": "0x1111111111111111111111111111111111111111",
          "x-viewing-key": "view-secret",
          "x-forwarded-for": "203.0.113.9",
          cookie: "ghola_thumper_session=session-token",
          referer: "https://wallet.example/private",
        },
        body: JSON.stringify({ model: "agent:test", messages: [] }),
      }),
      { params: Promise.resolve({ path: ["chat", "completions"] }) },
    );

    expect(res.status).toBe(200);
    expect(forwardedUrl(fetchSpy)).toBe(
      "https://thumper-cloud.onrender.com/v1/chat/completions",
    );
    const headers = forwardedHeaders(fetchSpy);
    expect(headers.get("authorization")).toBe("Bearer sk-ghola-test");
    expect(headers.get("payment-signature")).toBe("paid");
    expect(headers.get("x402-payment")).toBe("paid");
    expect(headers.get("x-ghola-payment-rail")).toBe("railgun_evm_shielded");
    expect(headers.get("x-payment-rail")).toBe("railgun_evm_shielded");

    for (const forbidden of [
      "cookie",
      "referer",
      "x-request-id",
      "x-user-id",
      "x-wallet-address",
      "x-viewing-key",
      "x-forwarded-for",
    ]) {
      expect(headers.get(forbidden), forbidden).toBeNull();
    }
  });

  it("strips upstream Set-Cookie while preserving payment response headers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          "payment-response": "settled",
          "x-payment-response": "settled",
          "set-cookie": "leak=1",
          connection: "close",
        },
      }),
    );

    const res = await POST(
      request("https://ghola.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["chat", "completions"] }) },
    );

    expect(res.headers.get("payment-response")).toBe("settled");
    expect(res.headers.get("x-payment-response")).toBe("settled");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("connection")).toBeNull();
  });
});

describe("v1 execution proxy routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GHOLA_ORDER_PLAN_BINDING_SECRET;
  });

  it("routes trading readiness through the Ghola execution gateway", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    );

    const res = await GET(
      request("https://ghola.test/v1/trading/live/readiness?venue=phoenix", {
        method: "GET",
        headers: { accept: "application/json" },
      }),
      {
        params: Promise.resolve({
          path: ["trading", "live", "readiness"],
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(forwardedUrl(fetchSpy)).toBe(
      "https://ghola-gateway.onrender.com/v1/trading/live/readiness?venue=phoenix",
    );
    expect(forwardedHeaders(fetchSpy).get("accept")).toBe("application/json");
  });

  it.each([
    "localhost",
    "127.0.0.1",
    "[::1]",
    "192.168.1.42",
    "trader.local",
    "custom.dev.example",
  ])(
    "blocks app execution on nonproduction host %s before forwarding",
    async (hostname) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const res = await POST(
        request(`http://${hostname}:3000/v1/trading/app/execute`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vercel-env": "production",
            "x-ghola-private-agent-spend-armed": "true",
          },
          body: JSON.stringify({ symbol: "BTC", side: "buy" }),
        }),
        { params: Promise.resolve({ path: ["trading", "app", "execute"] }) },
      );

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: "private execution mutations are disabled outside armed production",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("preserves public read-only market proxying on LAN hosts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ source: "hyperliquid", status: "live" }), { status: 200 }),
    );

    const res = await GET(
      request("http://192.168.1.42:3000/v1/private-account/hyperliquid/market-snapshot?coin=BTC"),
      {
        params: Promise.resolve({
          path: ["private-account", "hyperliquid", "market-snapshot"],
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(forwardedUrl(fetchSpy)).toBe(
      "https://ghola-gateway.onrender.com/v1/private-account/hyperliquid/market-snapshot?coin=BTC",
    );
  });

  it.each([
    ["POST", ["trading", "orders", "preflight"]],
    ["POST", ["private-account", "hyperliquid", "orders"]],
    ["POST", ["onboarding", "session"]],
    ["POST", ["trading", "app", "session", "bridge"]],
    ["POST", ["trading", "app", "execute", "extra"]],
    ["POST", ["Trading", "app", "execute"]],
    ["POST", ["chat", "completions", "extra"]],
    ["POST", ["Chat", "completions"]],
    ["POST", ["unknown", "mutation"]],
    ["PUT", ["trading", "app", "execute"]],
    ["PATCH", ["trading", "app", "execute"]],
    ["DELETE", ["trading", "app", "execute"]],
  ] as const)("default-denies unsupported catch-all mutation %s /v1/%s", async (method, path) => {
    const fetchSpy = vi.fn<typeof fetch>();
    const sessionUser = sessionLookup();
    const proxyPost = createV1ProxyHandler({
      fetchImpl: brandPrivateAgentMockTransport(fetchSpy),
      fetchSessionUserImpl: sessionUser,
    });

    const res = await proxyPost(
      request(`https://ghola.test/v1/${path.join("/")}`, {
        method,
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: [...path] }) },
    );

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "upstream_mutation_route_not_allowed" });
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sessionUser).not.toHaveBeenCalled();
  });

  it.each([
    [["trading", "app", "execute"]],
    [["chat", "completions"]],
  ] as const)("rejects query-bearing mutation /v1/%s", async (path) => {
    const fetchSpy = vi.fn<typeof fetch>();
    const proxyPost = createV1ProxyHandler({
      fetchImpl: brandPrivateAgentMockTransport(fetchSpy),
      fetchSessionUserImpl: sessionLookup(),
    });
    const res = await proxyPost(
      request(`https://ghola.test/v1/${path.join("/")}?mode=alternate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: [...path] }) },
    );

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "upstream_mutation_route_not_allowed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, undefined],
    ["TRUE", undefined],
    ["true", "true"],
  ])("requires exact production arming and no lockdown before app execution", async (armed, lockdown) => {
    delete process.env.VITEST;
    Reflect.set(process.env, "NODE_ENV", "production");
    process.env.VERCEL_ENV = "production";
    if (armed === undefined) delete process.env.GHOLA_PRIVATE_AGENT_SPEND_ARMED;
    else process.env.GHOLA_PRIVATE_AGENT_SPEND_ARMED = armed;
    if (lockdown === undefined) delete process.env.GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN;
    else process.env.GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN = lockdown;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(
      request("https://ghola.example/v1/trading/app/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["trading", "app", "execute"] }) },
    );

    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("routes onboarding through the Ghola execution gateway", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ products: [] }), { status: 200 }));

    const res = await GET(
      request("https://ghola.test/v1/onboarding/products", {
        method: "GET",
        headers: { accept: "application/json" },
      }),
      {
        params: Promise.resolve({
          path: ["onboarding", "products"],
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(forwardedUrl(fetchSpy)).toBe(
      "https://ghola-gateway.onrender.com/v1/onboarding/products",
    );
    expect(forwardedHeaders(fetchSpy).get("accept")).toBe("application/json");
  });

  it("dispatches only the verified execution identity to the live worker adapter", async () => {
    process.env.GHOLA_ORDER_PLAN_BINDING_SECRET = "proxy-binding-test-secret";
    const sessionToken = sessionJwt("web-user-1");
    const plan = orderPlan();
    const binding = orderPlanBinding(plan, "web-user-1");
    const body = executionBody(plan, binding);
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", { status: 201, headers: {
        "x-ghola-execution-dispatch": "not_dispatched",
        "x-ghola-execution-plan-digest": `sha256:${"f".repeat(64)}`,
      } }),
    );
    const proxyPost = privateMutationPost(fetchSpy, sessionLookup("web-user-1"));

    const res = await proxyPost(
      request("https://ghola.test/v1/trading/app/execute", {
        method: "POST",
        headers: {
          origin: "https://ghola.test",
          "content-type": "application/json",
          authorization: "Bearer caller-controlled",
          "idempotency-key": "caller-controlled",
          "x-idempotency-key": "caller-controlled",
          "x-ghola-idempotency-key": "caller-controlled",
          "x-ghola-account-id": "caller-controlled",
          "x-ghola-api-key": "caller-controlled",
          "x-ghola-venue": "coinbase",
          "x-request-id": "browser-trace",
          cookie: `ghola_exec_session=exec-session-token; ghola_thumper_session=${sessionToken}`,
        },
        body: JSON.stringify(body),
      }),
      {
        params: Promise.resolve({
          path: ["trading", "app", "execute"],
        }),
      },
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("x-ghola-execution-dispatch")).toBe("dispatched");
    expect(res.headers.get("x-ghola-execution-plan-digest")).toBe(binding.plan_digest);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://worker.ghola.test/hyperliquid/orders",
    );
    const headers = new Headers((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("idempotency-key")).toBe(body.idempotencyKey);
    expect(headers.get("x-idempotency-key")).toBeNull();
    expect(headers.get("x-ghola-idempotency-key")).toBeNull();
    expect(headers.get("x-ghola-account-id")).toBeNull();
    expect(headers.get("x-ghola-api-key")).toBeNull();
    expect(headers.get("x-ghola-venue")).toBeNull();
    expect(headers.get("x-request-id")).toBeNull();
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      account_commitment: body.hyperliquidAccountCommitment,
      vault_commitment: "test-vault",
      plan_digest: binding.plan_digest,
    });
  });

  it.each([
    ["not_dispatched", "released", "not_dispatched"],
    ["no_fill", "released", "dispatched"],
    ["filled", "filled", "dispatched"],
    ["submitted", null, "dispatched"],
    [null, null, "dispatched"],
  ] as const)("settles billing truthfully for %s disposition", async (disposition, expectedSettlement, publicDispatch) => {
    process.env.GHOLA_ORDER_PLAN_BINDING_SECRET = "proxy-binding-test-secret";
    const settle = vi.fn<NonNullable<V1ProxyDependencies["settleNotionalReservationImpl"]>>(async () => undefined);
    const dispatch = vi.fn<NonNullable<V1ProxyDependencies["liveDispatchImpl"]>>(async () => Response.json(
      { disposition },
      {
        status: disposition === "not_dispatched" ? 409 : 202,
        headers: disposition ? { "x-ghola-live-trading-disposition": disposition } : undefined,
      },
    ));
    const proxyPost = createV1ProxyHandler({
      fetchImpl: brandPrivateAgentMockTransport(vi.fn<typeof fetch>()),
      fetchSessionUserImpl: sessionLookup("web-user-1"),
      byoExecutionGateImpl: (plan) => ({
        allowed: true,
        reason_codes: [],
        venue: { id: plan.venue_id, label: plan.venue_id, submit_source: "user_scoped_credential", status: "green", reason_codes: [] },
      }),
      liveAuthorizationImpl: async ({ order_plan }) => ({
        ok: true,
        capability: "limit_order",
        account_commitment: tradeExecutionIdentityCommitments("web-user-1", order_plan.venue_id).upstreamAccountId,
        vault_commitment: "test-vault",
        launch_revision: 1,
        reservation: {
          version: 2,
          reservation_id: "reservation_dispatch_truth",
          owner_commitment: "owner_dispatch_truth",
          account_commitment: "account_dispatch_truth",
          idempotency_key: "idempotency_dispatch_truth",
          request_commitment: `sha256:${"7".repeat(64)}`,
          notional_usd: 25,
          status: "reserved",
          created_at: "2026-08-19T12:00:00.000Z",
          expires_at: "2026-08-19T12:05:00.000Z",
          updated_at: "2026-08-19T12:00:00.000Z",
        },
      }),
      settleNotionalReservationImpl: settle,
      liveDispatchImpl: dispatch,
    });
    const plan = orderPlan();
    const sessionToken = sessionJwt("web-user-1");
    const response = await proxyPost(
      request("https://ghola.test/v1/trading/app/execute", {
        method: "POST",
        headers: {
          origin: "https://ghola.test",
          "content-type": "application/json",
          cookie: `ghola_exec_session=exec-session-token; ghola_thumper_session=${sessionToken}`,
        },
        body: JSON.stringify(executionBody(plan, orderPlanBinding(plan, "web-user-1"))),
      }),
      { params: Promise.resolve({ path: ["trading", "app", "execute"] }) },
    );

    expect(response.headers.get("x-ghola-execution-dispatch")).toBe(publicDispatch);
    expect(response.headers.get("x-ghola-live-trading-disposition")).toBeNull();
    if (expectedSettlement) {
      expect(settle).toHaveBeenCalledWith({
        reservation_id: "reservation_dispatch_truth",
        status: expectedSettlement,
      });
    } else {
      expect(settle).not.toHaveBeenCalled();
    }
  });

  it("routes an existing durable plan to recovery before closed opening gates", async () => {
    process.env.GHOLA_ORDER_PLAN_BINDING_SECRET = "proxy-binding-test-secret";
    process.env.GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED = "true";
    const authorization = vi.fn<NonNullable<V1ProxyDependencies["liveAuthorizationImpl"]>>();
    const gate = vi.fn<NonNullable<V1ProxyDependencies["byoExecutionGateImpl"]>>(() => ({
      allowed: false,
      reason_codes: ["closed"],
      venue: { id: "hyperliquid", label: "hyperliquid", submit_source: "user_scoped_credential", status: "red", reason_codes: ["closed"] },
    }));
    const dispatch = vi.fn<NonNullable<V1ProxyDependencies["liveDispatchImpl"]>>(async () => Response.json({
      version: 1,
      status: "pending",
      planDigest: `sha256:${"a".repeat(64)}`,
      workerWorkOrderCommitment: `live_trade_work_order_${"b".repeat(48)}`,
      checkedAt: "2026-08-19T12:00:00.000Z",
    }, { status: 202, headers: { "x-ghola-live-trading-disposition": "submitted" } }));
    const proxyPost = createV1ProxyHandler({
      fetchImpl: brandPrivateAgentMockTransport(vi.fn<typeof fetch>()),
      fetchSessionUserImpl: sessionLookup("web-user-1"),
      byoExecutionGateImpl: gate,
      liveAuthorizationImpl: authorization,
      getLiveRecoveryImpl: vi.fn(async ({ owner_commitment, plan_digest }) => ({
        owner_commitment,
        plan_digest,
        account_commitment: "account_recovery_existing",
        vault_commitment: "vault_recovery_existing",
        reservation_id: "reservation_recovery_existing",
      } as never)),
      liveDispatchImpl: dispatch,
    });
    const order = orderPlan();
    const binding = orderPlanBinding(order, "web-user-1");
    const response = await proxyPost(request("https://ghola.test/v1/trading/app/execute", {
      method: "POST",
      headers: {
        origin: "https://ghola.test",
        "content-type": "application/json",
        cookie: `ghola_exec_session=exec-session-token; ghola_thumper_session=${sessionJwt("web-user-1")}`,
      },
      body: JSON.stringify(executionBody(order, binding)),
    }), { params: Promise.resolve({ path: ["trading", "app", "execute"] }) });

    expect(response.status).toBe(202);
    expect(response.headers.get("x-ghola-execution-dispatch")).toBe("dispatched");
    expect(gate).not.toHaveBeenCalled();
    expect(authorization).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("fails closed when the server-issued app session is unavailable", async () => {
    process.env.GHOLA_ORDER_PLAN_BINDING_SECRET = "proxy-binding-test-secret";
    const fetchSpy = vi.fn<typeof fetch>();
    const sessionUser = sessionLookup("web-user-1");
    const proxyPost = privateMutationPost(fetchSpy, sessionUser);
    const sessionToken = sessionJwt("web-user-1");

    const res = await proxyPost(
      request("https://ghola.test/v1/trading/app/execute", {
        method: "POST",
        headers: {
          origin: "https://ghola.test",
          "content-type": "application/json",
          authorization: "Bearer caller-controlled",
          "x-ghola-api-key": "caller-controlled",
          cookie: `ghola_thumper_session=${sessionToken}`,
        },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["trading", "app", "execute"] }) },
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("x-ghola-execution-dispatch")).toBe("not_dispatched");
    expect(await res.json()).toEqual({ error: "execution_app_session_required" });
    expect(sessionUser).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an account commitment not derived from the verified session", async () => {
    process.env.GHOLA_ORDER_PLAN_BINDING_SECRET = "proxy-binding-test-secret";
    const fetchSpy = vi.fn<typeof fetch>();
    const sessionUser = sessionLookup("web-user-1");
    const proxyPost = privateMutationPost(fetchSpy, sessionUser);
    const sessionToken = sessionJwt("web-user-1");
    const plan = orderPlan();
    const body = executionBody(plan, orderPlanBinding(plan, "web-user-1"));
    body.hyperliquidAccountCommitment =
      tradeExecutionIdentityCommitments("other-web-user", plan.venue_id)
        .venueAccountCommitment || "";

    const res = await proxyPost(
      request("https://ghola.test/v1/trading/app/execute", {
        method: "POST",
        headers: {
          origin: "https://ghola.test",
          "content-type": "application/json",
          cookie: `ghola_exec_session=exec-session-token; ghola_thumper_session=${sessionToken}`,
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: ["trading", "app", "execute"] }) },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "execution_account_subject_mismatch" });
    expect(sessionUser).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a credential handle not derived from the verified session", async () => {
    process.env.GHOLA_ORDER_PLAN_BINDING_SECRET = "proxy-binding-test-secret";
    const fetchSpy = vi.fn<typeof fetch>();
    const sessionUser = sessionLookup("web-user-1");
    const proxyPost = privateMutationPost(fetchSpy, sessionUser);
    const sessionToken = sessionJwt("web-user-1");
    const plan = orderPlan();
    const body = executionBody(plan, orderPlanBinding(plan, "web-user-1"));
    body.executionCredentialHandleCommitmentsByVenue[plan.venue_id] =
      tradeExecutionIdentityCommitments("other-web-user", plan.venue_id)
        .executionCredentialHandleCommitment;

    const res = await proxyPost(
      request("https://ghola.test/v1/trading/app/execute", {
        method: "POST",
        headers: {
          origin: "https://ghola.test",
          "content-type": "application/json",
          cookie: `ghola_exec_session=exec-session-token; ghola_thumper_session=${sessionToken}`,
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: ["trading", "app", "execute"] }) },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "execution_credential_subject_mismatch" });
    expect(sessionUser).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires a valid bound plan before forwarding app execution", async () => {
    process.env.GHOLA_ORDER_PLAN_BINDING_SECRET = "proxy-binding-test-secret";
    const fetchSpy = vi.fn<typeof fetch>();
    const proxyPost = privateMutationPost(fetchSpy);
    const sessionToken = sessionJwt("web-user-1");
    const plan = orderPlan();

    const res = await proxyPost(
      request("https://ghola.test/v1/trading/app/execute", {
        method: "POST",
        headers: {
          origin: "https://ghola.test",
          "content-type": "application/json",
          cookie: `ghola_exec_session=exec-session-token; ghola_thumper_session=${sessionToken}`,
        },
        body: JSON.stringify({ ...executionBody(plan, orderPlanBinding(plan, "web-user-1")), tradeOrderPlanBinding: undefined }),
      }),
      { params: Promise.resolve({ path: ["trading", "app", "execute"] }) },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "order_plan_binding_missing" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rechecks the global and selected-venue BYO gate before forwarding app execution", async () => {
    process.env.GHOLA_ORDER_PLAN_BINDING_SECRET = "proxy-binding-test-secret";
    const fetchSpy = vi.fn<typeof fetch>();
    const sessionToken = sessionJwt("web-user-1");
    const plan = orderPlan();
    const gateSpy = vi.fn<NonNullable<V1ProxyDependencies["byoExecutionGateImpl"]>>(
      (boundPlan) => {
        const id = boundPlan.venue_id;
        return {
          allowed: false,
          reason_codes: ["live_trading_public_flag_disabled"],
          venue: {
            id,
            label: id,
            submit_source: "user_scoped_credential",
            status: "green",
            reason_codes: [],
          },
        };
      },
    );
    const proxyPost = createV1ProxyHandler({
      fetchImpl: brandPrivateAgentMockTransport(fetchSpy),
      fetchSessionUserImpl: sessionLookup("web-user-1"),
      byoExecutionGateImpl: gateSpy,
    });

    const res = await proxyPost(
      request("https://ghola.test/v1/trading/app/execute", {
        method: "POST",
        headers: {
          origin: "https://ghola.test",
          "content-type": "application/json",
          cookie: `ghola_exec_session=exec-session-token; ghola_thumper_session=${sessionToken}`,
        },
        body: JSON.stringify(executionBody(plan, orderPlanBinding(plan, "web-user-1"))),
      }),
      { params: Promise.resolve({ path: ["trading", "app", "execute"] }) },
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: "live_trading_gate_closed",
      reason_codes: ["live_trading_public_flag_disabled"],
    });
    expect(gateSpy).toHaveBeenCalledWith(plan, process.env);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a signed reduce-only close available through a closed exposure gate", async () => {
    process.env.GHOLA_ORDER_PLAN_BINDING_SECRET = "proxy-binding-test-secret";
    const fetchSpy = brandPrivateAgentMockTransport(vi.fn<typeof fetch>());
    const authorizationSpy = vi.fn<NonNullable<V1ProxyDependencies["liveAuthorizationImpl"]>>(async ({ order_plan }) => ({
      ok: true,
      capability: "reduce_only",
      account_commitment: tradeExecutionIdentityCommitments("web-user-1", order_plan.venue_id).upstreamAccountId,
      vault_commitment: "test-vault",
      launch_revision: null,
      reservation: null,
    }));
    const dispatchSpy = vi.fn<NonNullable<V1ProxyDependencies["liveDispatchImpl"]>>(async () =>
      Response.json({ appLiveTradingExecutionRun: { status: "submitted" } }, { status: 202 }));
    const proxyPost = createV1ProxyHandler({
      fetchImpl: fetchSpy,
      fetchSessionUserImpl: sessionLookup("web-user-1"),
      byoExecutionGateImpl: (plan) => ({
        allowed: false,
        reason_codes: ["live_trading_killed"],
        venue: {
          id: plan.venue_id,
          label: plan.venue_id,
          submit_source: "user_scoped_credential",
          status: "red",
          reason_codes: ["live_trading_killed"],
        },
      }),
      liveAuthorizationImpl: authorizationSpy,
      liveDispatchImpl: dispatchSpy,
    });
    const sessionToken = sessionJwt("web-user-1");
    const plan = orderPlan(true);
    const response = await proxyPost(
      request("https://ghola.test/v1/trading/app/execute", {
        method: "POST",
        headers: {
          origin: "https://ghola.test",
          "content-type": "application/json",
          cookie: `ghola_exec_session=exec-session-token; ghola_thumper_session=${sessionToken}`,
        },
        body: JSON.stringify(executionBody(plan, orderPlanBinding(plan, "web-user-1"))),
      }),
      { params: Promise.resolve({ path: ["trading", "app", "execute"] }) },
    );

    expect(response.status).toBe(202);
    expect(authorizationSpy).toHaveBeenCalledOnce();
    expect(dispatchSpy).toHaveBeenCalledOnce();
  });

  it("rejects a changed limit before forwarding app execution", async () => {
    process.env.GHOLA_ORDER_PLAN_BINDING_SECRET = "proxy-binding-test-secret";
    const fetchSpy = vi.fn<typeof fetch>();
    const proxyPost = privateMutationPost(fetchSpy);
    const sessionToken = sessionJwt("web-user-1");
    const plan = orderPlan();
    const body = executionBody(plan, orderPlanBinding(plan, "web-user-1"));
    body.orderIntent.limitPrice = "62501";

    const res = await proxyPost(
      request("https://ghola.test/v1/trading/app/execute", {
        method: "POST",
        headers: {
          origin: "https://ghola.test",
          "content-type": "application/json",
          cookie: `ghola_exec_session=exec-session-token; ghola_thumper_session=${sessionToken}`,
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: ["trading", "app", "execute"] }) },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "bound_order_limit_price_mismatch" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects browser-supplied signed actions before session lookup or worker dispatch", async () => {
    process.env.GHOLA_ORDER_PLAN_BINDING_SECRET = "proxy-binding-test-secret";
    const fetchSpy = vi.fn<typeof fetch>();
    const sessionUser = sessionLookup("web-user-1");
    const proxyPost = privateMutationPost(fetchSpy, sessionUser);
    const sessionToken = sessionJwt("web-user-1");
    const plan = orderPlan();
    const body = executionBody(plan, orderPlanBinding(plan, "web-user-1"));
    Object.assign(body, {
      signedAction: {
        action: { type: "order", orders: [], grouping: "na" },
        nonce: Date.now(),
        signature: { r: `0x${"1".repeat(64)}`, s: `0x${"2".repeat(64)}`, v: 27 },
        network: plan.network,
      },
    });

    const res = await proxyPost(
      request("https://ghola.test/v1/trading/app/execute", {
        method: "POST",
        headers: {
          origin: "https://ghola.test",
          "content-type": "application/json",
          cookie: `ghola_exec_session=exec-session-token; ghola_thumper_session=${sessionToken}`,
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: ["trading", "app", "execute"] }) },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "sealed_execution_request_shape_invalid" });
    expect(sessionUser).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dispatches the bound sealed plan without browser signing or asset-index configuration", async () => {
    process.env.GHOLA_ORDER_PLAN_BINDING_SECRET = "proxy-binding-test-secret";
    const fetchSpy = vi.fn<typeof fetch>(async () => Response.json({
      appLiveTradingExecutionRun: {
        status: "submitted",
        gholaAppLiveTradingExecutionRunCommitment: "sealed_worker_receipt",
      },
    }, { status: 202 }));
    const proxyPost = privateMutationPost(fetchSpy);
    const sessionToken = sessionJwt("web-user-1");
    const plan = orderPlan();

    const res = await proxyPost(
      request("https://ghola.test/v1/trading/app/execute", {
        method: "POST",
        headers: {
          origin: "https://ghola.test",
          "content-type": "application/json",
          cookie: `ghola_exec_session=exec-session-token; ghola_thumper_session=${sessionToken}`,
        },
        body: JSON.stringify(executionBody(plan, orderPlanBinding(plan, "web-user-1"))),
      }),
      { params: Promise.resolve({ path: ["trading", "app", "execute"] }) },
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      appLiveTradingExecutionRun: { status: "submitted" },
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("rejects cross-site app-session trading posts before proxying", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const proxyPost = privateMutationPost(fetchSpy);

    const res = await proxyPost(
      request("https://ghola.test/v1/trading/app/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "ghola_exec_session=exec-session-token",
        },
        body: "{}",
      }),
      {
        params: Promise.resolve({
          path: ["trading", "app", "execute"],
        }),
      },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "cross-site app-session request rejected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function sessionJwt(userId: string) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: userId, email: `${userId}@example.com` })).toString("base64url"),
    "signature",
  ].join(".");
}

function orderPlan(reduceOnly = false): TradeOrderPlan {
  const nowMs = Date.now();
  const plan = buildTradeOrderPlan({
    venueId: "hyperliquid",
    network: "testnet",
    coin: "BTC",
    product: "BTC-PERP",
    side: "buy",
    timeInForce: "ioc",
    quoteNotionalUsd: 25,
    baseSize: 0.0004,
    limitPrice: 62_500,
    maxSlippageBps: 50,
    stopLevel: 62_000,
    strategyProfile: "breakout",
    entryTrigger: "break_level",
    exitRule: "exit_on_invalidation",
    timeHorizon: "intraday",
    triggerLevel: 62_550,
    interval: "5m",
    marketFetchedAt: new Date(nowMs).toISOString(),
    executionReferencePrice: 62_490,
    frameVersion: 1,
    riskEnvelope: testRiskEnvelope(nowMs),
    reduceOnly,
    nowMs,
  });
  if (!plan) throw new Error("test_order_plan_invalid");
  return plan;
}

function testRiskEnvelope(nowMs: number) {
  return { riskBudgetUsd: 1, stopAndSlippageLossUsd: 0.325, roundTripCostLossUsd: 0.05, allInLossUsd: 0.375, feeBps: 5, bufferBps: 5, feeEvidenceAtMs: nowMs, bufferEvidenceAtMs: nowMs };
}

function orderPlanBinding(plan: TradeOrderPlan, userId: string) {
  return issueTradeOrderPlanBinding({
    orderPlan: plan,
    previewCommitment: "preview_proxy_test",
    subjectCommitment: gholaCommitment("owner", userId),
    previewExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    secret: "proxy-binding-test-secret",
  });
}

function executionBody(plan: TradeOrderPlan, binding: ReturnType<typeof orderPlanBinding>) {
  const idempotencyKey = tradeOrderPlanIdempotencyKey(binding);
  if (!idempotencyKey) throw new Error("test_idempotency_key_invalid");
  const webUserId = "web-user-1";
  const identity = tradeExecutionIdentityCommitments(webUserId, plan.venue_id);
  const credentialCommitment = identity.executionCredentialHandleCommitment;
  const accountCommitment = identity.venueAccountCommitment || "";
  return {
    csrfToken: "csrf",
    venueIds: [plan.venue_id],
    ensureWallet: false,
    executionCredentialHandleCommitmentsByVenue: {
      [plan.venue_id]: credentialCommitment,
    },
    idempotencyKey,
    submit: true,
    refreshAfterSubmit: true,
    fetchFills: true,
    cancelIfOpen: false,
    tradeOrderPlanBinding: binding,
    orderIntent: {
      idempotencyKey,
      venueIds: [plan.venue_id],
      symbol: plan.coin,
      productId: plan.product,
      side: plan.side,
      orderType: plan.order_type,
      timeInForce: plan.time_in_force,
      network: plan.network,
      quoteSize: plan.quote_notional_usd,
      baseSize: plan.base_size,
      limitPrice: plan.limit_price,
      slippageBps: String(plan.max_slippage_bps),
    },
    hyperliquidAccountCommitment: accountCommitment,
  };
}
