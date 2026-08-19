import { describe, expect, it } from "vitest";

import { execSync } from "node:child_process";

import {
  BAKED_WEB_GIT_SHA,
  OAUTH_POPUP_HEADERS,
  SECURITY_HEADERS,
} from "../../next.config";

function headerMap(headers: Array<{ key: string; value: string }>) {
  const m = new Map<string, string>();
  for (const h of headers) m.set(h.key.toLowerCase(), h.value);
  return m;
}

describe("security headers (next.config)", () => {
  it("bakes the exact repository SHA into the web artifact identity", () => {
    expect(BAKED_WEB_GIT_SHA).toBe(
      execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(),
    );
  });

  it("keeps non-CSP browser security headers in next.config.ts", () => {
    const m = headerMap(SECURITY_HEADERS);

    expect(m.get("strict-transport-security")).toContain("max-age=");
    expect(m.get("strict-transport-security")).toContain("includeSubDomains");
    expect(m.get("strict-transport-security")).toContain("preload");
    expect(m.get("x-frame-options")).toBe("DENY");
    expect(m.get("x-content-type-options")).toBe("nosniff");
    expect(m.get("referrer-policy")).toBe("strict-origin-when-cross-origin");

    const perm = m.get("permissions-policy") ?? "";
    for (const dir of [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
    ]) {
      expect(perm).toContain(dir);
    }
  });

  it("does not emit CSP from next.config.ts because the proxy owns nonce CSP", () => {
    const m = headerMap(SECURITY_HEADERS);

    expect(m.has("content-security-policy")).toBe(false);
    expect(m.has("content-security-policy-report-only")).toBe(false);
  });

  it("defines the narrow Google OAuth popup exception used by auth and investor account setup", () => {
    const site = headerMap(SECURITY_HEADERS);
    const oauth = headerMap(OAUTH_POPUP_HEADERS);

    expect(site.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(oauth.get("cross-origin-opener-policy")).toBe(
      "same-origin-allow-popups",
    );
    expect(oauth.get("cross-origin-embedder-policy")).toBe("unsafe-none");
  });
});
