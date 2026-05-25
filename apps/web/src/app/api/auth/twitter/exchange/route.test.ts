import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pendingCodes } from "../callback/route";
import { POST } from "./route";

function exchangeRequest(body: unknown, origin = "https://ghola.test") {
  return new NextRequest("https://ghola.test/api/auth/twitter/exchange", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });
}

describe("twitter exchange route", () => {
  beforeEach(() => {
    pendingCodes.clear();
  });

  afterEach(() => {
    pendingCodes.clear();
    vi.restoreAllMocks();
  });

  it("sets an HttpOnly session cookie and never returns the bearer token", async () => {
    pendingCodes.set("exchange-code", {
      token: "opaque-thumper-token",
      expires: Date.now() + 60_000,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "user-id",
          email: "alice@example.com",
          display_name: "Alice",
        }),
        { status: 200 },
      ),
    );

    const res = await POST(exchangeRequest({ code: "exchange-code" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      user: {
        id: "user-id",
        email: "alice@example.com",
        name: "Alice",
      },
    });
    expect(JSON.stringify(body)).not.toContain("opaque-thumper-token");
    expect(res.headers.get("set-cookie")).toContain("ghola_thumper_session=");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(pendingCodes.has("exchange-code")).toBe(false);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://thumper-cloud.onrender.com/api/user/profile",
      expect.objectContaining({
        headers: { Authorization: "Bearer opaque-thumper-token" },
      }),
    );
  });

  it("rejects cross-site exchanges without consuming the code", async () => {
    pendingCodes.set("exchange-code", {
      token: "opaque-thumper-token",
      expires: Date.now() + 60_000,
    });

    const res = await POST(exchangeRequest({ code: "exchange-code" }, "https://evil.test"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Cross-site request rejected");
    expect(pendingCodes.has("exchange-code")).toBe(true);
  });

  it("rejects expired codes and deletes them", async () => {
    pendingCodes.set("expired-code", {
      token: "opaque-thumper-token",
      expires: Date.now() - 1,
    });

    const res = await POST(exchangeRequest({ code: "expired-code" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Invalid or expired code");
    expect(pendingCodes.has("expired-code")).toBe(false);
  });

  it("consumes the code when backend session verification fails", async () => {
    pendingCodes.set("exchange-code", {
      token: "opaque-thumper-token",
      expires: Date.now() + 60_000,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "bad token" }), { status: 401 }),
    );

    const res = await POST(exchangeRequest({ code: "exchange-code" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Invalid session");
    expect(pendingCodes.has("exchange-code")).toBe(false);
  });
});
