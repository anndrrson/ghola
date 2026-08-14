import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import { createTradingSessionPost } from "./_handler";
import { brandPrivateAgentMockTransport } from "@/lib/private-agent-spend-policy";

const ORIGINAL_ENV = { ...process.env };

function request(headers: Record<string, string>) {
  return new NextRequest("https://ghola.test/api/trading/session", {
    method: "POST",
    headers,
  });
}

describe("trading app session bridge route", () => {
  beforeEach(() => {
    process.env.GHOLA_EXECUTION_BRIDGE_AUTH_TOKEN = "bridge-token";
    delete process.env.GHOLA_EXECUTION_BRIDGE_AUTH_ID;
    delete process.env.GHOLA_EXECUTION_BRIDGE_SIGNING_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("denies the default remote session bridge in nonproduction before lookup or fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(request({
      origin: "https://ghola.test",
      cookie: "ghola_thumper_session=web-session-token",
    }));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "private_execution_session_disabled" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not accept bound global fetch as the injected test transport", async () => {
    const sessionLookup = vi.fn();
    const handler = createTradingSessionPost({
      fetchImpl: globalThis.fetch.bind(globalThis) as typeof fetch,
      fetchSessionUserImpl: sessionLookup,
    });

    const res = await handler(request({
      origin: "https://ghola.test",
      cookie: "ghola_thumper_session=web-session-token",
    }));

    expect(res.status).toBe(503);
    expect(sessionLookup).not.toHaveBeenCalled();
  });

  it("rejects cross-site attempts before branded mock calls", async () => {
    const bridgeFetch = brandPrivateAgentMockTransport(vi.fn<typeof fetch>());
    const sessionLookup = vi.fn();
    const handler = createTradingSessionPost({
      fetchImpl: bridgeFetch,
      fetchSessionUserImpl: sessionLookup,
    });

    const res = await handler(request({
      cookie: "ghola_thumper_session=web-session-token",
    }));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "cross_site_trading_session_rejected" });
    expect(sessionLookup).not.toHaveBeenCalled();
    expect(bridgeFetch).not.toHaveBeenCalled();
  });

  it("serializes a bridge only through explicitly injected mocks", async () => {
    const sessionLookup = vi.fn().mockResolvedValue({
      ok: true as const,
      user: {
        id: "web-user-1",
        email: "investor@example.com",
        name: "Investor",
      },
    });
    const bridgeFetch = brandPrivateAgentMockTransport(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        appSessionBridge: {
          status: "app_session_created",
          sessionToken: "backend-exec-token",
          sessionId: "appsess_test",
          csrfToken: "csrf-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }), { status: 201 })),
    );
    const handler = createTradingSessionPost({
      fetchImpl: bridgeFetch,
      fetchSessionUserImpl: sessionLookup,
    });

    const res = await handler(request({
      origin: "https://ghola.test",
      cookie: "ghola_thumper_session=web-session-token; ghola_exec_session=old-exec-token",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      authenticated: true,
      appSession: {
        status: "app_session_created",
        sessionId: "appsess_test",
        csrfToken: "csrf-token",
        subjectScope: expect.stringMatching(/^subject_[a-f0-9]{32}$/),
      },
    });
    expect(JSON.stringify(body)).not.toContain("backend-exec-token");
    expect(res.headers.get("set-cookie")).toContain("ghola_exec_session=backend-exec-token");

    expect(sessionLookup).toHaveBeenCalledWith("web-session-token");
    expect(String(bridgeFetch.mock.calls[0]?.[0])).toBe(
      "https://ghola-gateway.onrender.com/v1/trading/app/session/bridge",
    );
    const init = bridgeFetch.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("x-bridge-auth")).toBe("bridge-token");
    expect(JSON.parse(String(init.body))).toMatchObject({
      webUserId: "web-user-1",
      email: "investor@example.com",
      name: "Investor",
      existingSessionToken: "old-exec-token",
    });
  });

  it("rejects an invalid verified subject before opening an execution session", async () => {
    const bridgeFetch = brandPrivateAgentMockTransport(vi.fn<typeof fetch>());
    const handler = createTradingSessionPost({
      fetchImpl: bridgeFetch,
      fetchSessionUserImpl: vi.fn().mockResolvedValue({
        ok: true as const,
        user: { id: " ", email: "investor@example.com", name: "Investor" },
      }),
    });

    const res = await handler(request({
      origin: "https://ghola.test",
      cookie: "ghola_thumper_session=web-session-token",
    }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "web_session_subject_invalid" });
    expect(bridgeFetch).not.toHaveBeenCalled();
  });
});
