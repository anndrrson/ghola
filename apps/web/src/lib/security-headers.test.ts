import { describe, expect, it } from "vitest";

import { SECURITY_HEADERS } from "../../next.config";

function headerMap(headers: Array<{ key: string; value: string }>) {
  const m = new Map<string, string>();
  for (const h of headers) m.set(h.key.toLowerCase(), h.value);
  return m;
}

describe("security headers (next.config)", () => {
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
});
