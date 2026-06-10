import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("treasury execution status route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports blocking reasons when partner rails are unavailable", async () => {
    vi.stubEnv("GHOLA_TREASURY_PARTNER_RAIL_READY", "false");

    const res = await GET();
    const body = await res.json();

    expect(body.ready).toBe(false);
    expect(body.blocking_reasons).toContain("partner_rail_unavailable");
  });

  it("reports supported treasury rails when ready", async () => {
    vi.stubEnv(
      "GHOLA_TREASURY_SUPPORTED_RAILS",
      "bank_cash,treasury_bills,stablecoin_shielded,ach",
    );

    const res = await GET();
    const body = await res.json();

    expect(body.ready).toBe(true);
    expect(body.supported_rails).toEqual([
      "bank_cash",
      "treasury_bills",
      "stablecoin_shielded",
      "ach",
    ]);
  });
});
