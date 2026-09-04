import { describe, expect, it } from "vitest";
import { carryMarketStatus, carryTerminalChrome } from "./carry-terminal-chrome";

describe("Carry terminal chrome", () => {
  it("keeps the reference chart while removing venue-owned terminal chrome", () => {
    expect(carryTerminalChrome(true)).toEqual({
      eyebrow: "Cross-venue carry",
      title: "Carry Position",
      marketContext: "Cross-venue reference",
      showProductNavigation: false,
      showVenueReadiness: false,
      showVenueMarketStats: false,
      showVenueActivity: false,
      showVenueOrderTicket: false,
      showReferenceChart: true,
    });
  });

  it("preserves the normal trading terminal outside Carry", () => {
    expect(carryTerminalChrome(false)).toMatchObject({
      eyebrow: "Unified trading",
      title: null,
      marketContext: null,
      showProductNavigation: true,
      showVenueReadiness: true,
      showVenueMarketStats: true,
      showVenueActivity: true,
      showVenueOrderTicket: true,
      showReferenceChart: true,
    });
  });

  it("labels Carry market data without implying execution is live", () => {
    expect(carryMarketStatus("live", true)).toBe("Live market data · execution locked");
    expect(carryMarketStatus("reconnecting", false)).toBe("Market data reconnecting · execution locked");
    expect(carryMarketStatus("stale", true)).toBe("Delayed market data · execution locked");
  });
});
