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

  it("never emits 'unsafe-inline' in the production script-src (matches build-time hashed CSP)", () => {
    const prodCsp = buildContentSecurityPolicy(false);
    const scriptSrc = prodCsp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toBeDefined();
    // 'unsafe-inline' would defeat the hash-based CSP that next.config.ts
    // emits; the middleware must not reintroduce it in production.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // WASM step for WebLLM is still allowed.
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
  });

  it("splices build-time inline-script hashes into the production script-src", () => {
    const hashes = [
      "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    ];
    const prodCsp = buildContentSecurityPolicy(false, hashes);
    const scriptSrc = prodCsp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).toContain(`'${hashes[0]}'`);
    expect(scriptSrc).toContain(`'${hashes[1]}'`);
  });

  it("keeps 'unsafe-inline' in development so HMR/React-refresh works", () => {
    const devCsp = buildContentSecurityPolicy(true);
    const scriptSrc = devCsp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toContain("'unsafe-inline'");
  });

  it("allows exact WebLLM model download hosts without wildcarding GitHub", () => {
    const prodCsp = buildContentSecurityPolicy(false);

    expect(prodCsp).toContain("https://huggingface.co");
    expect(prodCsp).toContain("https://hf.co");
    expect(prodCsp).toContain("https://cas-bridge.xethub.hf.co");
    expect(prodCsp).toContain("https://cas-server.xethub.hf.co");
    expect(prodCsp).toContain("https://raw.githubusercontent.com");
    expect(prodCsp).not.toContain("https://*.githubusercontent.com");
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
