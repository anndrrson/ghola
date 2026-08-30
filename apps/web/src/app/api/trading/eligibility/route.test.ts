import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const ENV_KEYS = [
  "GHOLA_LIVE_TRADING_COUNTRY_ALLOWLIST",
  "VERCEL",
  "VERCEL_ENV",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("GET /api/trading/eligibility", () => {
  it("returns the iOS eligibility schema for an allowed test jurisdiction", async () => {
    process.env.GHOLA_LIVE_TRADING_COUNTRY_ALLOWLIST = "CA,GB";
    const response = await GET(request({ "x-ghola-test-country": "CA" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      live_trading_enabled: true,
      country: "CA",
      region: null,
      reason: "allowed",
      next_step: "Live trading is available in this jurisdiction.",
      reason_codes: ["allowed"],
    });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("returns the same schema with 451 when verification fails", async () => {
    process.env.GHOLA_LIVE_TRADING_COUNTRY_ALLOWLIST = "CA";
    const response = await GET(request({ "x-country-code": "CA" }));

    expect(response.status).toBe(451);
    await expect(response.json()).resolves.toMatchObject({
      live_trading_enabled: false,
      country: null,
      region: null,
      reason: "country_header_missing",
      next_step: "Live trading is unavailable because jurisdiction could not be verified.",
    });
  });
});

function request(headers: Record<string, string>) {
  return new Request("https://ghola.test/api/trading/eligibility", { headers });
}
