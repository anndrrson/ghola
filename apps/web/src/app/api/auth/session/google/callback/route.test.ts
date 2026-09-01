import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "./route";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function callbackRequest(
  options: {
    csrfBody?: string;
    csrfCookie?: string;
    credential?: string;
    redirect?: string;
  } = {},
) {
  const csrfBody = options.csrfBody ?? "csrf-token";
  const csrfCookie = options.csrfCookie ?? "csrf-token";
  const credential = options.credential ?? "google-id-token";
  const redirect = options.redirect ?? encodeURIComponent("/trade?market=HYPE-PERP");
  const body = new URLSearchParams({
    credential,
    g_csrf_token: csrfBody,
  });
  return new NextRequest("https://ghola.test/api/auth/session/google/callback", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `g_csrf_token=${csrfCookie}; ghola_google_redirect=${redirect}`,
    },
    body,
  });
}

describe("Google redirect callback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exchanges the ID token, sets the server session, and returns to the trade", async () => {
    const token = makeJwt({
      sub: "user-id",
      email: "alice@example.com",
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

    const res = await POST(callbackRequest());

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://ghola.test/trade?market=HYPE-PERP");
    expect(res.headers.get("set-cookie")).toContain("ghola_thumper_session=");
  });

  it("returns Carry onboarding to the same exact pair after Google authentication", async () => {
    const token = makeJwt({
      sub: "user-id",
      email: "alice@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ token }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "user-id", email: "alice@example.com" }),
          { status: 200 },
        ),
      );
    const carrySetup = "/account?setup=carry&long_venue=hyperliquid&short_venue=aster&return_to=%2Ftrade%3Fproduct%3Dperps%26venue%3Dhyperliquid%26market%3DBTC-PERP%26carry%3Dopen%26long_venue%3Dhyperliquid%26short_venue%3Daster";

    const res = await POST(callbackRequest({ redirect: encodeURIComponent(carrySetup) }));

    const location = new URL(res.headers.get("location") || "");
    expect(location.pathname).toBe("/account");
    expect(location.searchParams.get("long_venue")).toBe("hyperliquid");
    expect(location.searchParams.get("short_venue")).toBe("aster");
    expect(location.searchParams.get("return_to")).toBe(
      "/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open&long_venue=hyperliquid&short_venue=aster",
    );
  });

  it("rejects a mismatched Google CSRF token before contacting the backend", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await POST(callbackRequest({ csrfCookie: "different" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://ghola.test/signin?google_error=1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not allow the redirect cookie to leave Ghola", async () => {
    const token = makeJwt({
      sub: "user-id",
      email: "alice@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ token }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "user-id", email: "alice@example.com" }),
          { status: 200 },
        ),
      );

    const res = await POST(callbackRequest({ redirect: "https://evil.test/steal" }));

    expect(res.headers.get("location")).toBe("https://ghola.test/trade");
  });
});
