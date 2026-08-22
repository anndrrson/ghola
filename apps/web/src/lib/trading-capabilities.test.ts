import { describe, expect, it } from "vitest";
import { capabilitiesForProduct, TRADING_CAPABILITIES } from "./trading-capabilities";

describe("trading capabilities", () => {
  it("keeps every product in the unified workspace discoverable", () => {
    expect(capabilitiesForProduct("spot").map((venue) => venue.id)).toContain("coinbase_advanced");
    expect(capabilitiesForProduct("perps").map((venue) => venue.id)).toContain("hyperliquid");
    expect(capabilitiesForProduct("swap").map((venue) => venue.id)).toEqual(["jupiter"]);
    expect(capabilitiesForProduct("automate").length).toBeGreaterThan(1);
  });

  it("does not claim worker-emulated protective orders", () => {
    expect(TRADING_CAPABILITIES.venues.every((venue) =>
      venue.protective_orders === "native" ||
      venue.protective_orders === "unsupported" ||
      venue.protective_orders === "unverified"
    )).toBe(true);
  });
});
