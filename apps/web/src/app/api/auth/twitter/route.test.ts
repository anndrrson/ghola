import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { GET } from "./route";

describe("twitter oauth start route", () => {
  const originalClientId = process.env.TWITTER_CLIENT_ID;
  const originalClientSecret = process.env.TWITTER_CLIENT_SECRET;

  afterEach(() => {
    if (originalClientId === undefined) {
      delete process.env.TWITTER_CLIENT_ID;
    } else {
      process.env.TWITTER_CLIENT_ID = originalClientId;
    }
    if (originalClientSecret === undefined) {
      delete process.env.TWITTER_CLIENT_SECRET;
    } else {
      process.env.TWITTER_CLIENT_SECRET = originalClientSecret;
    }
  });

  it("fails closed when the OAuth client is not fully configured", async () => {
    delete process.env.TWITTER_CLIENT_ID;
    delete process.env.TWITTER_CLIENT_SECRET;

    const res = await GET(new NextRequest("https://ghola.test/api/auth/twitter"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Twitter not configured");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("sets HttpOnly OAuth cookies without caching the redirect", async () => {
    process.env.TWITTER_CLIENT_ID = "client-id";
    process.env.TWITTER_CLIENT_SECRET = "client-secret";

    const res = await GET(new NextRequest("https://ghola.test/api/auth/twitter"));
    const location = res.headers.get("location") ?? "";
    const setCookie = res.headers.get("set-cookie") ?? "";

    expect(res.status).toBe(307);
    expect(location).toContain("https://twitter.com/i/oauth2/authorize?");
    expect(location).toContain("client_id=client-id");
    expect(setCookie).toContain("twitter_code_verifier=");
    expect(setCookie).toContain("twitter_oauth_state=");
    expect(setCookie).toContain("HttpOnly");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
