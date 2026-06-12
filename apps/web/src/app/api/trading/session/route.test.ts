import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

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

  it("rejects cross-site session bridge attempts before upstream calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(request({
      cookie: "ghola_thumper_session=web-session-token",
    }));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "cross_site_trading_session_rejected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bridges a web session into an HttpOnly execution session", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "web-user-1",
        email: "investor@example.com",
        display_name: "Investor",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        appSessionBridge: {
          status: "app_session_created",
          sessionToken: "backend-exec-token",
          sessionId: "appsess_test",
          csrfToken: "csrf-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }), { status: 201 }));

    const res = await POST(request({
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
      },
    });
    expect(JSON.stringify(body)).not.toContain("backend-exec-token");
    expect(res.headers.get("set-cookie")).toContain("ghola_exec_session=backend-exec-token");

    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      "https://ghola-gateway.onrender.com/v1/trading/app/session/bridge",
    );
    const init = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("x-bridge-auth")).toBe("bridge-token");
    expect(JSON.parse(String(init.body))).toMatchObject({
      webUserId: "web-user-1",
      email: "investor@example.com",
      name: "Investor",
      existingSessionToken: "old-exec-token",
    });
  });
});
