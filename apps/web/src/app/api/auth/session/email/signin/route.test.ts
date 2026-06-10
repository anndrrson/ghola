import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

function jwt(payload: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function jsonRequest(body: unknown) {
  return new Request("https://ghola.test/api/auth/session/email/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("email signin session route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a cookie-backed session from the upstream auth token", async () => {
    const token = jwt({
      sub: "user_signin",
      email: "signin@example.test",
      name: "Signin User",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(jsonRequest({
      email: " signin@example.test ",
      password: "correct horse battery staple",
    }));
    const body = await res.json();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://thumper-cloud.onrender.com/api/auth/email/signin",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "signin@example.test",
          password: "correct horse battery staple",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(body).toEqual({
      user: {
        id: "user_signin",
        email: "signin@example.test",
        name: "Signin User",
      },
    });
    expect(res.headers.get("set-cookie")).toContain("ghola_thumper_session=");
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("keeps invalid credentials as a sign-in failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid email or password" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const res = await POST(jsonRequest({
      email: "signin@example.test",
      password: "wrong-password",
    }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "invalid email or password" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
