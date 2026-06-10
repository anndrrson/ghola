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
  return new Request("https://ghola.test/api/auth/session/email/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("email signup session route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the upstream account and returns a cookie-backed session", async () => {
    const token = jwt({
      sub: "user_signup",
      email: "signup@example.test",
      name: "Signup User",
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
      display_name: " Signup User ",
      email: "signup@example.test",
      password: "correct horse battery staple",
    }));
    const body = await res.json();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://thumper-cloud.onrender.com/api/auth/email/signup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "signup@example.test",
          password: "correct horse battery staple",
          name: "Signup User",
          display_name: "Signup User",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(body).toEqual({
      user: {
        id: "user_signup",
        email: "signup@example.test",
        name: "Signup User",
      },
    });
    expect(res.headers.get("set-cookie")).toContain("ghola_thumper_session=");
  });
});
