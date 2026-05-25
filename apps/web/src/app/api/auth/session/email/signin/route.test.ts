import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "./route";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function jsonRequest(body: unknown, origin = "https://ghola.test") {
  return new NextRequest("https://ghola.test/api/auth/session/email/signin", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

describe("email session sign-in proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 503 instead of blaming the request when auth upstream is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failed"));

    const res = await POST(jsonRequest({ email: "alice@example.com", password: "secret" }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toBe("Auth provider unavailable");
  });

  it("rejects cross-site login attempts before contacting auth upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(
      jsonRequest(
        { email: "alice@example.com", password: "secret" },
        "https://evil.test",
      ),
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("cross-site session request rejected");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the backend-verified profile instead of trusting the JWT payload", async () => {
    const token = makeJwt({
      sub: "attacker",
      email: "attacker@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ token }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "user-id",
            email: "alice@example.com",
            display_name: "Alice",
          }),
          { status: 200 },
        ),
      );

    const res = await POST(jsonRequest({ email: "alice@example.com", password: "secret" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.user).toEqual({
      id: "user-id",
      email: "alice@example.com",
      name: "Alice",
    });
  });
});
