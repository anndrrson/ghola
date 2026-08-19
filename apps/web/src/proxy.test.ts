import { describe, expect, it } from "vitest";

import {
  applySecurityHeaders,
  buildContentSecurityPolicy,
  proxy,
} from "./proxy";

describe("middleware security hardening", () => {
  it("adds unsafe-eval only in development CSP", () => {
    const devCsp = buildContentSecurityPolicy(true);
    const prodCsp = buildContentSecurityPolicy(false);

    expect(devCsp).toContain("'unsafe-eval'");
    expect(prodCsp).not.toContain("'unsafe-eval'");
    expect(prodCsp).toContain("frame-ancestors 'none'");
  });

  it("permits only the pinned public market-data WebSockets", () => {
    const csp = buildContentSecurityPolicy(false);

    expect(csp).toContain("wss://api.hyperliquid.xyz");
    expect(csp).toContain("wss://api.hyperliquid-testnet.xyz");
    expect(csp).toContain("wss://advanced-trade-ws.coinbase.com");
    expect(csp).toContain("https://perp-api.phoenix.trade");
    expect(csp).toContain("wss://perp-api.phoenix.trade");
    expect(csp).not.toContain("wss://*.hyperliquid.xyz");
    expect(csp).not.toContain("wss://*.coinbase.com");
  });

  it("sets HSTS only for https requests", () => {
    const httpsHeaders = new Headers();
    applySecurityHeaders(httpsHeaders, { isDev: false, isHttps: true });
    expect(httpsHeaders.get("Strict-Transport-Security")).toContain("max-age=63072000");

    const httpHeaders = new Headers();
    applySecurityHeaders(httpHeaders, { isDev: false, isHttps: false });
    expect(httpHeaders.get("Strict-Transport-Security")).toBeNull();
  });

  it("disables caching on auth API endpoints", () => {
    const req = {
      headers: new Headers({ "user-agent": "Mozilla/5.0" }),
      nextUrl: {
        pathname: "/api/auth/twitter/exchange",
        protocol: "https:",
      },
    };

    const res = proxy(req as never);

    expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(res.headers.get("Pragma")).toBe("no-cache");
  });

  it("allows Google OAuth popups only on explicit auth and investor-account pages", () => {
    const requestFor = (pathname: string) =>
      ({
        headers: new Headers({ "user-agent": "Mozilla/5.0" }),
        nextUrl: { pathname, protocol: "https:" },
      }) as never;

    expect(
      proxy(requestFor("/signin")).headers.get("Cross-Origin-Opener-Policy"),
    ).toBe("same-origin-allow-popups");
    expect(
      proxy(requestFor("/signup")).headers.get("Cross-Origin-Opener-Policy"),
    ).toBe("same-origin-allow-popups");
    expect(
      proxy(requestFor("/signin")).headers.get("Cross-Origin-Embedder-Policy"),
    ).toBe("unsafe-none");
    expect(
      proxy(requestFor("/signup")).headers.get("Cross-Origin-Embedder-Policy"),
    ).toBe("unsafe-none");
    expect(
      proxy(requestFor("/account")).headers.get("Cross-Origin-Opener-Policy"),
    ).toBe("same-origin-allow-popups");
    expect(
      proxy(requestFor("/account")).headers.get("Cross-Origin-Embedder-Policy"),
    ).toBe("unsafe-none");
    expect(
      proxy(requestFor("/trade")).headers.get("Cross-Origin-Opener-Policy"),
    ).toBe("same-origin");
    expect(
      proxy(requestFor("/trade")).headers.get("Cross-Origin-Embedder-Policy"),
    ).toBeNull();
  });
});
