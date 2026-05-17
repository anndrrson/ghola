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
});
