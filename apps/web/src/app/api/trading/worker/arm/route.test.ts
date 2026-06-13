import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAutopilotSessionsForTests } from "@/lib/private-account-autopilot";
import { POST } from "./route";

const ORIGINAL_ENV = { ...process.env };

function request(headers: Record<string, string>, body?: Record<string, unknown>) {
  return new NextRequest("https://ghola.test/api/trading/worker/arm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body ?? {
      csrfToken: "csrf-token",
      planId: "gltp_plan",
      planPolicyCommitment: "plan_policy_commitment",
      venueIds: ["hyperliquid"],
      market: "BTC-USD",
      delegationProof: {
        walletAddress: "wallet",
        message: "Delegate worker",
        signature: "wallet-signature",
      },
    }),
  });
}

describe("app trading worker arm route", () => {
  beforeEach(() => {
    resetAutopilotSessionsForTests();
    process.env.GHOLA_EXECUTION_BRIDGE_AUTH_TOKEN = "bridge-token";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL = "https://worker.example";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-token";
    delete process.env.GHOLA_EXECUTION_BRIDGE_AUTH_ID;
    delete process.env.GHOLA_EXECUTION_BRIDGE_SIGNING_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("rejects cross-site worker arm attempts before upstream calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(request({
      cookie: "ghola_thumper_session=web-session-token; ghola_exec_session=backend-exec-token",
    }));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "cross_site_trading_worker_arm_rejected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bridges a plan-bound worker grant and passes the raw token only to the worker", async () => {
    let workerPayload: Record<string, unknown> | null = null;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "web-user-1",
        email: "investor@example.com",
        display_name: "Investor",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        appLiveTradingWorkerGrantBridge: {
          status: "worker_grant_created",
          workerGrantToken: "raw-worker-grant-token",
          workerGrantId: "glwg_plan",
          workerGrantCommitment: "worker_grant_commitment",
          planPolicyCommitment: "plan_policy_commitment",
          venueIds: ["hyperliquid"],
          expiresAt: "2026-06-01T14:00:00.000Z",
        },
      }), { status: 201 }))
      .mockImplementationOnce(async (_input: URL | RequestInfo, init?: RequestInit) => {
        workerPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          version: 1,
          session: {
            version: 2,
            autopilot_session_id: "worker_autopilot_app",
            worker_session_commitment: "worker_session_commitment",
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
            app_trading: {
              status: "grant_armed",
              app_plan_id: "gltp_plan",
              worker_grant_id: "glwg_plan",
              worker_grant_commitment: "worker_grant_commitment",
              plan_policy_commitment: "plan_policy_commitment",
              venue_ids: ["hyperliquid"],
              expires_at: "2026-06-01T14:00:00.000Z",
            },
            order_count: 0,
            daily_notional_used_bucket: "0",
            updated_at: "2026-06-01T12:00:00.000Z",
            expires_at: "2026-06-01T14:00:00.000Z",
            next_step: "App trading grant armed.",
            execution_enabled: true,
          },
          events: [],
        }), { status: 201 });
      });

    const res = await POST(request({
      origin: "https://ghola.test",
      cookie: "ghola_thumper_session=web-session-token; ghola_exec_session=backend-exec-token",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.appTradingWorker).toMatchObject({
      status: "running",
      workerGrantId: "glwg_plan",
      workerGrantCommitment: "worker_grant_commitment",
      planId: "gltp_plan",
    });
    expect(JSON.stringify(body)).not.toContain("raw-worker-grant-token");

    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      "https://ghola-gateway.onrender.com/v1/trading/app/worker-grants/bridge",
    );
    const bridgeInit = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(bridgeInit.headers).get("x-bridge-auth")).toBe("bridge-token");
    expect(JSON.parse(String(bridgeInit.body))).toMatchObject({
      sessionToken: "backend-exec-token",
      csrfToken: "csrf-token",
      planId: "gltp_plan",
      venueIds: ["hyperliquid"],
    });

    expect(workerPayload).not.toBeNull();
    expect((workerPayload?.app_trading_grant as Record<string, unknown>).worker_grant_token).toBe("raw-worker-grant-token");
    expect((workerPayload?.app_trading_grant as Record<string, unknown>).worker_grant_id).toBe("glwg_plan");
  });
});
