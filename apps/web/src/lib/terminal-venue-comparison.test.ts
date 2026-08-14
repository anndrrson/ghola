import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import { deriveTerminalVenueBasis, terminalComparisonVenues } from "./terminal-venue-comparison";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

describe("terminal venue comparison", () => {
  it("selects only venues that list the instrument", () => {
    expect(terminalComparisonVenues("hyperliquid", "SOL")).toEqual(["phoenix", "coinbase"]);
    expect(terminalComparisonVenues("coinbase", "BTC")).toEqual(["hyperliquid"]);
    expect(terminalComparisonVenues("hyperliquid", "HYPE")).toEqual([]);
  });

  it("derives executable basis from compatible fresh perpetual BBOs", () => {
    const result = deriveTerminalVenueBasis(
      frame({ venue: "hyperliquid", product: "SOL", mid: "100", bestBid: "99.9", bestAsk: "100.1" }),
      [frame({ venue: "phoenix", product: "SOL-PERP", mid: "99.5", bestBid: "99.4", bestAsk: "99.6" })],
      options(),
    );

    expect(result.status).toBe("live");
    expect(result.bestBuy?.venue).toBe("phoenix");
    expect(result.bestSell?.venue).toBe("hyperliquid");
    expect(result.spanBps).toBeCloseTo((100 / 99.5) * 10_000 - 10_000);
    expect(result.quotes.find((quote) => quote.venue === "phoenix")?.basisBps).toBeCloseTo(-50);
    expect(result.bestExecutableBuy).toMatchObject({ venue: "phoenix", network: "mainnet", price: 99.6 });
    expect(result.bestExecutableSell).toMatchObject({ venue: "hyperliquid", network: "mainnet", price: 99.9 });
    expect(result.executableSpreadBps).toBeCloseTo(((99.9 - 99.6) / 99.6) * 10_000);
  });

  it("excludes spot, wrong-network, and wrong-interval frames", () => {
    const result = deriveTerminalVenueBasis(
      frame({ venue: "hyperliquid", product: "SOL", mid: "100" }),
      [
        frame({ venue: "coinbase", product: "SOL-USD", mid: "90" }),
        frame({ venue: "hyperliquid", product: "SOL", network: "testnet", mid: "80" }),
        frame({ venue: "phoenix", product: "SOL-PERP", interval: "1h", mid: "70" }),
      ],
      options(),
    );

    expect(result.status).toBe("single");
    expect(result.quotes.map((quote) => quote.venue)).toEqual(["hyperliquid"]);
  });

  it("uses the exact quote clock and fails closed on stale or future quotes", () => {
    const result = deriveTerminalVenueBasis(
      frame({ venue: "hyperliquid", product: "SOL", mid: "100", quoteAt: NOW - 30_001 }),
      [
        frame({ venue: "phoenix", product: "SOL-PERP", mid: "99", quoteAt: NOW + 5_001 }),
        { ...frame({ venue: "phoenix", product: "SOL-PERP", mid: "98" }), stale: true },
      ],
      options(),
    );

    expect(result.status).toBe("unavailable");
    expect(result.quotes).toEqual([]);
  });

  it("derives midpoint from validated BBO and rejects crossed quotes", () => {
    const result = deriveTerminalVenueBasis(
      frame({
        venue: "hyperliquid",
        product: "SOL",
        mid: "10000",
        bestBid: "99",
        bestAsk: "101",
      }),
      [frame({ venue: "phoenix", product: "SOL-PERP", mid: "1", bestBid: "102", bestAsk: "101" })],
      options(),
    );

    expect(result.status).toBe("single");
    expect(result.quotes[0]).toMatchObject({ mid: 100, basisBps: 0 });
  });
});

function options() {
  return {
    market: "SOL",
    interval: "5m",
    requiredProductClass: "perpetual" as const,
    requiredNetwork: "mainnet" as const,
    nowMs: NOW,
    maxAgeMs: 30_000,
  };
}

function frame(input: {
  venue: GholaMarketFrame["venue"];
  product: string;
  mid: string;
  network?: "mainnet" | "testnet";
  interval?: string;
  bestBid?: string;
  bestAsk?: string;
  quoteAt?: number;
}): GholaMarketFrame {
  return {
    version: 1,
    venue: input.venue,
    network: input.network ?? "mainnet",
    product: input.product,
    interval: input.interval ?? "5m",
    fetchedAt: new Date(NOW).toISOString(),
    stale: false,
    mid: input.mid,
    bestBid: input.bestBid ?? String(Number(input.mid) - 0.1),
    bestAsk: input.bestAsk ?? String(Number(input.mid) + 0.1),
    spreadBps: null,
    markPrice: null,
    oraclePrice: null,
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [],
    asks: [],
    trades: [],
    routeQuotes: [],
    componentTimestamps: { quote: input.quoteAt ?? NOW },
  };
}
