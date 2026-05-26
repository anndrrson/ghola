import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("private execution status route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports blocking reasons when fee recipient or private rail is missing", async () => {
    vi.stubEnv("GHOLA_PRIVATE_EXECUTION_SHIELDED_RAIL_READY", "false");
    vi.stubEnv("GHOLA_PRIVATE_EXECUTION_FEE_RECIPIENT", "");

    const res = await GET();
    const body = await res.json();

    expect(body.ready).toBe(false);
    expect(body.blocking_reasons).toContain("fee_recipient_unconfigured");
    expect(body.blocking_reasons).toContain("shielded_rail_unavailable");
  });

  it("reports ready when fee recipient and private rail are configured", async () => {
    vi.stubEnv("GHOLA_PRIVATE_EXECUTION_SHIELDED_RAIL_READY", "true");
    vi.stubEnv("GHOLA_PRIVATE_EXECUTION_FEE_RECIPIENT", "railgun:fee");

    const res = await GET();
    const body = await res.json();

    expect(body.ready).toBe(true);
    expect(body.supported_rails).toEqual(["railgun_private_swap"]);
  });
});
