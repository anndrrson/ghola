import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

function requestWithSession(token: string) {
  return new NextRequest("https://ghola.test/api/auth/session/me", {
    headers: { cookie: `ghola_thumper_session=${token}` },
  });
}

describe("session me route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not authenticate a cookie without backend verification", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid token" }), { status: 401 }),
    );

    const res = await GET(requestWithSession("forged.jwt.value"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ authenticated: false, user: null });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("returns the backend-verified profile for a valid session cookie", async () => {
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

    const res = await GET(requestWithSession("opaque-token"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      authenticated: true,
      user: { id: "user-id", email: "alice@example.com", name: "Alice" },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://thumper-cloud.onrender.com/api/user/profile",
      expect.objectContaining({
        headers: { Authorization: "Bearer opaque-token" },
      }),
    );
  });
});
