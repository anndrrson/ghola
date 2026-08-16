import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import { deriveTerminalCrossVenueCarryMatrix } from "./terminal-cross-venue-carry";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

describe("terminal cross-venue carry matrix", () => {
  it("anchors basis to the selected venue and signs long carry correctly", () => {
    const result = deriveTerminalCrossVenueCarryMatrix({
      ...input(),
      frames: [
        frame({ venue: "hyperliquid", product: "SOL", bid: 99, ask: 101, funding: "0.0001" }),
        frame({ venue: "phoenix", product: "SOL-PERP", bid: 101, ask: 103, funding: "-0.0002" }),
      ],
    });

    expect(result.status).toBe("live");
    expect(result.rows[0]).toMatchObject({ venue: "hyperliquid", selected: true, basisBps: 0, fundingRateBps: 1, signedCarryUsd: -1 });
    expect(result.rows[1]).toMatchObject({ venue: "phoenix", selected: false, fundingRateBps: -2, signedCarryUsd: 2 });
    expect(result.rows[1]?.basisBps).toBeCloseTo(200);
  });

  it("reverses carry cash for a short without changing the reported rate", () => {
    const result = deriveTerminalCrossVenueCarryMatrix({
      ...input(),
      side: "sell",
      frames: [frame({ venue: "hyperliquid", product: "SOL", bid: 99, ask: 101, funding: "0.0001" })],
    });
    expect(result.rows[0]).toMatchObject({ fundingRateBps: 1, signedCarryUsd: 1 });
  });

  it("isolates missing or stale funding from otherwise certified quote basis", () => {
    const result = deriveTerminalCrossVenueCarryMatrix({
      ...input(),
      frames: [
        frame({ venue: "hyperliquid", product: "SOL", bid: 99, ask: 101, funding: null }),
        frame({ venue: "phoenix", product: "SOL-PERP", bid: 100, ask: 102, funding: "0.0002", fundingAt: NOW - 10_001 }),
      ],
    });
    expect(result.status).toBe("live");
    expect(result.rows.every((row) => row.fundingBlocker === "funding_unavailable")).toBe(true);
    expect(result.rows[1]?.basisBps).toBeCloseTo(100);
  });

  it("fails closed without the exact selected quote and excludes incompatible frames", () => {
    const result = deriveTerminalCrossVenueCarryMatrix({
      ...input(),
      frames: [
        frame({ venue: "hyperliquid", product: "SOL", bid: 101, ask: 100 }),
        frame({ venue: "phoenix", product: "SOL-PERP", bid: 99, ask: 101, network: "testnet" }),
        frame({ venue: "coinbase", product: "SOL-USD", bid: 99, ask: 101 }),
      ],
    });
    expect(result).toMatchObject({ status: "unavailable", rows: [] });
  });

  it("fails closed on stale or future quote clocks", () => {
    for (const quoteAt of [NOW - 30_001, NOW + 5_001]) {
      expect(deriveTerminalCrossVenueCarryMatrix({
        ...input(),
        frames: [frame({ venue: "hyperliquid", product: "SOL", bid: 99, ask: 101, quoteAt })],
      }).status).toBe("unavailable");
    }
  });

  it("keeps certified basis visible when notional is invalid but withholds carry cash", () => {
    const result = deriveTerminalCrossVenueCarryMatrix({
      ...input(),
      notionalUsd: 0,
      frames: [frame({ venue: "hyperliquid", product: "SOL", bid: 99, ask: 101, funding: "0.0001" })],
    });
    expect(result.rows[0]).toMatchObject({ basisBps: 0, signedCarryUsd: null, fundingBlocker: "notional_invalid" });
  });
});

function input() {
  return {
    selectedVenue: "hyperliquid" as const,
    market: "SOL",
    interval: "5m",
    requiredProductClass: "perpetual" as const,
    requiredNetwork: "mainnet" as const,
    side: "buy" as const,
    notionalUsd: 10_000,
    nowMs: NOW,
    maxQuoteAgeMs: 30_000,
  };
}

function frame(input: {
  venue: "hyperliquid" | "phoenix" | "coinbase";
  product: string;
  bid: number;
  ask: number;
  network?: "mainnet" | "testnet";
  quoteAt?: number;
  funding?: string | null;
  fundingAt?: number;
}): GholaMarketFrame {
  const fundingSource = input.venue === "hyperliquid"
    ? "hyperliquid_ws_active_asset_context_received" as const
    : input.venue === "phoenix"
      ? "phoenix_ws_market_stats" as const
      : null;
  return {
    version: 1,
    venue: input.venue,
    network: input.network ?? "mainnet",
    product: input.product,
    interval: "5m",
    fetchedAt: new Date(NOW).toISOString(),
    stale: false,
    mid: "100",
    bestBid: String(input.bid),
    bestAsk: String(input.ask),
    spreadBps: null,
    markPrice: null,
    oraclePrice: null,
    fundingRate: input.funding ?? null,
    fundingRateUnit: input.funding == null ? null : "decimal_fraction",
    fundingRateSource: input.funding == null ? null : fundingSource,
    fundingRateTimeBasis: input.funding == null
      ? null
      : input.venue === "hyperliquid"
        ? "received_at"
        : "venue_event_time",
    fundingRateUpdatedAt: input.funding == null ? null : new Date(input.fundingAt ?? NOW - 1_000).toISOString(),
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [],
    asks: [],
    trades: [],
    routeQuotes: [],
    componentTimestamps: { quote: input.quoteAt ?? NOW - 500 },
  };
}
