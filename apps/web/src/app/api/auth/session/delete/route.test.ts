import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DELETE, POST } from "./route";

const completion = {
  ok: true,
  status: "completed",
  personal_data_deleted: true,
  sessions_revoked: true,
  billing_subscription_cancelled: true,
  completion_due_at: "2026-08-30T21:00:00Z",
  retained_record_categories: ["financial_settlement", "security_audit"],
  completed_at: "2026-08-30T21:00:00Z",
  message: "Account deletion completed",
};

const scheduled = {
  ok: true,
  status: "scheduled",
  personal_data_deleted: false,
  sessions_revoked: true,
  billing_subscription_cancelled: false,
  completion_due_at: "2026-08-30T21:00:00.123Z",
  retained_record_categories: ["financial_settlement", "security_audit"],
  message: "Account deletion scheduled",
};

function bearerRequest(method = "DELETE") {
  return new NextRequest("https://ghola.test/api/auth/session/delete", {
    method,
    headers: { authorization: "Bearer native-session-token" },
  });
}

function cookieRequest(origin?: string) {
  const headers: Record<string, string> = {
    cookie: "ghola_thumper_session=browser-session-token",
  };
  if (origin) headers.origin = origin;
  return new NextRequest("https://ghola.test/api/auth/session/delete", {
    method: "DELETE",
    headers,
  });
}

describe("account deletion session proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires authentication before contacting upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await DELETE(
      new NextRequest("https://ghola.test/api/auth/session/delete", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects cookie-backed cross-site requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await DELETE(cookieRequest("https://evil.test"));

    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires Origin for cookie auth but not native bearer auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(completion), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const cookieResponse = await DELETE(cookieRequest());
    const bearerResponse = await DELETE(bearerRequest());

    expect(cookieResponse.status).toBe(403);
    expect(bearerResponse.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows a same-origin browser session and forwards its HttpOnly cookie token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(completion), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await DELETE(cookieRequest("https://ghola.test"));

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer browser-session-token",
        }),
      }),
    );
  });

  it("forwards a native JWT, verifies completion, clears cookies, and disables caching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ...completion,
          personal_data_deleted: true,
          sessions_revoked: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await DELETE(bearerRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("completed");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://thumper-cloud.onrender.com/api/auth/session/delete",
      expect.objectContaining({
        method: "DELETE",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer native-session-token",
        },
        cache: "no-store",
      }),
    );
  });

  it("preserves a truthful scheduled deletion response and clears the revoked session", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(scheduled), {
        status: 202,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...scheduled,
        billing_subscription_cancelled: true,
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }));

    const response = await DELETE(bearerRequest());
    const retry = await DELETE(bearerRequest());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(scheduled);
    expect(retry.status).toBe(202);
    await expect(retry.json()).resolves.toEqual({
      ...scheduled,
      billing_subscription_cancelled: true,
    });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("supports POST clients without changing upstream deletion semantics", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(completion), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await POST(bearerRequest("POST"));

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("does not claim success for incomplete upstream responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await DELETE(bearerRequest());

    expect(response.status).toBe(502);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects status/HTTP mismatches and untruthful scheduled fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(scheduled), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...scheduled,
        personal_data_deleted: true,
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...scheduled,
        retained_record_categories: ["security_audit"],
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...scheduled,
        completed_at: "2026-08-30T21:00:00Z",
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }));

    expect((await DELETE(bearerRequest())).status).toBe(502);
    expect((await DELETE(bearerRequest())).status).toBe(502);
    expect((await DELETE(bearerRequest())).status).toBe(502);
    expect((await DELETE(bearerRequest())).status).toBe(502);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("returns a no-store 503 without leaking upstream failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("secret network detail"));

    const response = await DELETE(bearerRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: "Account deletion service unavailable" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
