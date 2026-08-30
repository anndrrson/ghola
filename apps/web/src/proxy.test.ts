import { describe, expect, it } from "vitest";

import {
  applySecurityHeaders,
  buildApiContentSecurityPolicy,
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

  it("allows production inline bootstrap scripts for statically prerendered pages", () => {
    const prodCsp = buildContentSecurityPolicy(false);
    const scriptSrc = prodCsp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'nonce-test-nonce'");
    expect(scriptSrc).not.toContain("'strict-dynamic'");
    // WASM step for WebLLM is still allowed.
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
  });

  it("uses a compact CSP instead of build-time inline-script hashes", () => {
    const prodCsp = buildContentSecurityPolicy(false);
    expect(prodCsp.length).toBeLessThan(2_000);
    expect(prodCsp).not.toContain("sha256-");
  });

  it("keeps 'unsafe-inline' in development so HMR/React-refresh works", () => {
    const devCsp = buildContentSecurityPolicy(true);
    const scriptSrc = devCsp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(devCsp).not.toContain("upgrade-insecure-requests");
    expect(devCsp).not.toContain("block-all-mixed-content");
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

  it("allows the exact Cloudflare Turnstile origin on every required directive", () => {
    const prodCsp = buildContentSecurityPolicy(false);
    for (const directive of ["script-src", "connect-src", "frame-src"]) {
      const value = prodCsp
        .split(";")
        .map((item) => item.trim())
        .find((item) => item.startsWith(`${directive} `));
      expect(value).toContain("https://challenges.cloudflare.com");
    }
    expect(prodCsp).not.toContain("https://*.cloudflare.com");
  });

  it("sets HSTS only for https requests", () => {
    const httpsHeaders = new Headers();
    applySecurityHeaders(httpsHeaders, { isDev: false, isHttps: true, nonce: "test-nonce" });
    expect(httpsHeaders.get("Strict-Transport-Security")).toContain("max-age=63072000");
    expect(httpsHeaders.get("x-nonce")).toBe("test-nonce");

    const httpHeaders = new Headers();
    applySecurityHeaders(httpHeaders, { isDev: false, isHttps: false, nonce: "test-nonce" });
    expect(httpHeaders.get("Strict-Transport-Security")).toBeNull();
  });

  it("uses compact API CSP with no nonce or browser-only directives", () => {
    const csp = buildApiContentSecurityPolicy();
    const headers = new Headers();
    applySecurityHeaders(headers, { isDev: false, isHttps: true, api: true });

    expect(headers.get("Content-Security-Policy")).toBe(csp);
    expect(csp.length).toBeLessThan(200);
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("nonce-");
    expect(csp).not.toContain("unsafe-inline");
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
    expect(res.headers.get("Content-Security-Policy")).toBe(buildApiContentSecurityPolicy());
  });
});
