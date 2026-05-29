import { describe, expect, it } from "vitest";
import { privateAccountReadiness } from "./private-account-readiness";

describe("private account readiness", () => {
  it("blocks RFQ when fewer than five solvers are configured", () => {
    const readiness = privateAccountReadiness({
      paymentHealth: null,
      env: { GHOLA_RFQ_SOLVER_COUNT: "3" },
    });

    const rfq = readiness.profiles.find((profile) => profile.platform_class === "rfq_solver_network");
    expect(rfq?.status).toBe("blocked");
    expect(rfq?.reason_codes).toContain("rfq_solver_set_below_minimum");
  });

  it("marks partner assets blocked until partner readiness exists", () => {
    const readiness = privateAccountReadiness({
      paymentHealth: null,
      env: { GHOLA_PARTNER_ASSETS_READY: "false" },
    });

    const partner = readiness.profiles.find((profile) => profile.platform_class === "partner_tokenized_assets");
    expect(partner?.status).toBe("blocked");
    expect(partner?.reason_codes).toContain("partner_compliance_required");
  });

  it("blocks Hyperliquid until pilot, sealed vault, shielded funding, runtime, and connector readiness are present", () => {
    const blocked = privateAccountReadiness({
      paymentHealth: null,
      env: {},
    }).profiles.find((profile) => profile.platform_class === "hyperliquid_style_market");

    expect(blocked?.status).toBe("blocked");
    expect(blocked?.reason_codes).toEqual(expect.arrayContaining([
      "hyperliquid_pilot_disabled",
      "venue_access_required",
      "hyperliquid_execution_vault_not_ready",
      "hyperliquid_connector_unavailable",
    ]));

    const ready = privateAccountReadiness({
      paymentHealth: null,
      env: {
        GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
        GHOLA_HYPERLIQUID_EXECUTION_VAULT_READY: "true",
        GHOLA_HYPERLIQUID_SHIELDED_FUNDING_READY: "true",
        GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
        GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
      },
    }).profiles.find((profile) => profile.platform_class === "hyperliquid_style_market");

    expect(ready?.status).toBe("ready");
    expect(ready?.ready_rails).toContain("shielded_pool");
  });

  it("allows Hyperliquid BYO tiny-fill readiness without claiming shielded funding", () => {
    const ready = privateAccountReadiness({
      paymentHealth: null,
      env: {
        GHOLA_V6_HYPERLIQUID_PILOT_ENABLED: "true",
        GHOLA_HYPERLIQUID_EXECUTION_VAULT_READY: "true",
        GHOLA_HYPERLIQUID_LIVE_MODE: "tiny_fill",
        GHOLA_PRIVATE_RUNTIME_URL: "https://runtime.ghola.test",
        GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS: "ready",
      },
    }).profiles.find((profile) => profile.platform_class === "hyperliquid_style_market");

    expect(ready?.status).toBe("ready");
    expect(ready?.ready_rails).toEqual(["direct_public_fallback"]);
    expect(ready?.reason_codes).toContain("venue_visible_order_degraded");
    expect(ready?.reason_codes).not.toContain("shielded_rail_unavailable");
  });
});
