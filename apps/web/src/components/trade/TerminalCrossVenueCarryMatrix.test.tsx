import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TerminalCrossVenueCarryMatrix } from "./TerminalCrossVenueCarryMatrix";

describe("TerminalCrossVenueCarryMatrix", () => {
  it("renders certified basis, signed carry, freshness, and bounded claims", () => {
    const html = renderToStaticMarkup(<TerminalCrossVenueCarryMatrix matrix={{
      status: "live",
      side: "buy",
      notionalUsd: 10_000,
      rows: [{
        venue: "hyperliquid",
        network: "mainnet",
        product: "SOL",
        selected: true,
        mid: 100,
        basisBps: 0,
        quoteAgeMs: 500,
        fundingRateBps: 1,
        signedCarryUsd: -1,
        fundingAgeMs: 1_000,
        fundingSource: "hyperliquid_ws_active_asset_context_received",
        fundingBlocker: null,
      }],
    }} />);

    expect(html).toContain("Certified basis + carry");
    expect(html).toContain("−$1.00");
    expect(html).toContain("Q 500ms · F 1.0s");
    expect(html).toContain("interval duration may differ");
    expect(html).toContain("No fees, borrow, latency, fill, or convergence claim");
    expect(html).toContain("<caption class=\"sr-only\"");
  });

  it("explains why comparison is unavailable", () => {
    const html = renderToStaticMarkup(<TerminalCrossVenueCarryMatrix matrix={{
      status: "unavailable",
      side: "sell",
      notionalUsd: null,
      rows: [],
    }} />);
    expect(html).toContain("no fresh, compatible certified quote");
    expect(html).toContain("role=\"status\"");
  });
});
