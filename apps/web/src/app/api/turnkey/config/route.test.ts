import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("Turnkey iOS public config", () => {
  it("fails closed when wallet auth is not configured", async () => {
    delete process.env.NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID;
    delete process.env.NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID;

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      error: "Turnkey wallet authentication is unavailable",
    });
  });

  it("returns only the public wallet-kit configuration", async () => {
    process.env.NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID = "parent-org";
    process.env.NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID = "proxy-config";

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      organizationId: "parent-org",
      authProxyConfigId: "proxy-config",
      apiUrl: "https://api.turnkey.com",
      authProxyUrl: "https://authproxy.turnkey.com",
      rpId: "ghola.xyz",
      appleServiceId: null,
      xClientId: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/private|secret/i);
  });
});
