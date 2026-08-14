import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import {
  deriveTerminalRouteDecision,
  terminalRouteAnalysisFrames,
  terminalRouteFreshnessMs,
  type TerminalRouteDecisionInput,
} from "./terminal-route-decision";

const NOW = Date.parse("2026-08-12T18:00:00.000Z");

describe("terminal route decision", () => {
  it("keeps inactive route inputs stable without retaining live frames", () => {
    const primary = frame("hyperliquid");
    const peers = [frame("phoenix", { product: "BTC-PERP" })];
    const first = terminalRouteAnalysisFrames({ active: false, primary, peers });
    const second = terminalRouteAnalysisFrames({
      active: false,
      primary: frame("hyperliquid", { fetchedAt: iso(NOW) }),
      peers: [frame("phoenix", { product: "BTC-PERP", fetchedAt: iso(NOW) })],
    });

    expect(first).toBe(second);
    expect(first).toEqual([]);
    expect(terminalRouteAnalysisFrames({ active: true, primary, peers })).toEqual([primary, ...peers]);
    expect(terminalRouteAnalysisFrames({ active: true, primary: null, peers })).toBe(peers);
  });

  it("ranks buys by visible fill, then lower VWAP, impact, and freshness", () => {
    const decision = mainnetPerpDecision({
      frames: [
        frame("hyperliquid", { product: "SOL-PERP", asks: [{ px: "101", sz: "20", n: 1 }], fetchedAt: iso(NOW - 1_000) }),
        frame("phoenix", { product: "SOL-PERP", asks: [{ px: "100.5", sz: "20", n: 1 }], fetchedAt: iso(NOW - 500) }),
      ],
      market: "SOL",
      interval: "5m",
      side: "buy",
      orderNotionalUsd: 1_000,
      limitPrice: 102,
      nowMs: NOW,
    });

    expect(decision.status).toBe("full_available");
    expect(decision.candidates.map((candidate) => candidate.venue)).toEqual([
      "phoenix",
      "hyperliquid",
    ]);
    expect(decision.candidates.every((candidate) => candidate.fillPct === 100)).toBe(true);
    expect(decision.best?.vwap).toBe(100.5);
  });

  it("ranks sells by higher VWAP after fill percentage", () => {
    const decision = mainnetPerpDecision({
      frames: [
        frame("hyperliquid", { product: "SOL-PERP", bids: [{ px: "99", sz: "20", n: 1 }] }),
        frame("phoenix", { product: "SOL-PERP", bids: [{ px: "99.5", sz: "20", n: 1 }] }),
      ],
      market: "SOL",
      interval: "5m",
      side: "sell",
      orderNotionalUsd: 1_000,
      limitPrice: 98,
      nowMs: NOW,
    });

    expect(decision.candidates.map((candidate) => candidate.venue)).toEqual(["phoenix", "hyperliquid"]);
    expect(decision.best?.vwap).toBe(99.5);
  });

  it("recognizes the bare product identity emitted by live Hyperliquid frames", () => {
    const decision = mainnetPerpDecision({
      frames: [frame("hyperliquid", { product: "BTC", componentTimestamps: { book: NOW - 250 } })],
      market: "BTC",
      interval: "5m",
      side: "buy",
      orderNotionalUsd: 100,
      limitPrice: 101,
      nowMs: NOW,
    });

    expect(decision.best).toMatchObject({
      venue: "hyperliquid",
      productClass: "perpetual",
      bookAgeMs: 250,
      bookObservedAt: iso(NOW - 250),
    });
  });

  it("prefers a fuller visible fill even when its VWAP is worse", () => {
    const decision = mainnetPerpDecision({
      frames: [
        frame("hyperliquid", { product: "SOL-PERP", asks: [{ px: "100.1", sz: "4", n: 1 }] }),
        frame("phoenix", { product: "SOL-PERP", asks: [{ px: "101", sz: "20", n: 1 }] }),
      ],
      market: "SOL",
      interval: "5m",
      side: "buy",
      orderNotionalUsd: 1_000,
      limitPrice: 102,
      nowMs: NOW,
    });

    expect(decision.candidates[0]).toMatchObject({ venue: "phoenix", status: "full", fillPct: 100 });
    expect(decision.candidates[1]).toMatchObject({ venue: "hyperliquid", status: "partial" });
    expect(decision.candidates[1].fillPct).toBeCloseTo(40.8);
    expect(decision.candidates[1].unfilledNotionalUsd).toBeCloseTo(592);
  });

  it("uses asks for buys, bids for sells, and reports limit-constrained no-fill honestly", () => {
    const source = frame("hyperliquid", {
      asks: [{ px: "101", sz: "20", n: 1 }],
      bids: [{ px: "99", sz: "20", n: 1 }],
    });
    const buy = mainnetPerpDecision({
      frames: [source], market: "BTC", interval: "5m", side: "buy",
      orderNotionalUsd: 1_000, limitPrice: 100.5, nowMs: NOW,
    });
    const sell = mainnetPerpDecision({
      frames: [source], market: "BTC", interval: "5m", side: "sell",
      orderNotionalUsd: 1_000, limitPrice: 98, nowMs: NOW,
    });

    expect(buy.status).toBe("unavailable");
    expect(buy.best).toMatchObject({ status: "none", fillPct: 0, unfilledNotionalUsd: 1_000 });
    expect(sell.best).toMatchObject({ status: "full", vwap: 99 });
  });

  it("sizes at the limit while attributing aggressive-limit impact to market mid", () => {
    const buy = mainnetPerpDecision({
      frames: [frame("hyperliquid", { mid: "10000", asks: [{ px: "101", sz: "20", n: 1 }] })],
      market: "BTC",
      interval: "5m",
      side: "buy",
      orderNotionalUsd: 1_100,
      limitPrice: 110,
      nowMs: NOW,
    });
    const sell = mainnetPerpDecision({
      frames: [frame("hyperliquid", { mid: null, bids: [{ px: "99", sz: "20", n: 1 }] })],
      market: "BTC",
      interval: "5m",
      side: "sell",
      orderNotionalUsd: 900,
      limitPrice: 90,
      nowMs: NOW,
    });

    expect(buy.best).toMatchObject({ status: "full", fillPct: 100, vwap: 101 });
    expect(buy.best?.impactBps).toBeCloseTo(((101 - 100.45) / 100.45) * 10_000);
    expect(sell.best).toMatchObject({ status: "full", fillPct: 100, vwap: 99 });
    expect(sell.best?.impactBps).toBeCloseTo(((99.55 - 99) / 99.55) * 10_000);
  });

  it.each([
    ["wrong venue/instrument identity", frame("coinbase", { product: "ETH-USD" }), "route_frame_identity_mismatch"],
    ["unsupported venue market", frame("phoenix"), "route_frame_identity_mismatch"],
    ["wrong interval identity", frame("coinbase", { interval: "1m" }), "route_frame_identity_mismatch"],
    ["explicit stale flag", frame("coinbase", { stale: true }), "route_frame_stale"],
    ["invalid timestamp", frame("coinbase", { fetchedAt: "yesterday" }), "route_frame_timestamp_invalid"],
    ["future timestamp", frame("coinbase", { fetchedAt: iso(NOW + 5_001) }), "route_frame_timestamp_future"],
    ["expired timestamp", frame("coinbase", { fetchedAt: iso(NOW - 30_001) }), "route_frame_expired"],
    ["missing visible side", frame("hyperliquid", { asks: [] }), "route_visible_book_unavailable"],
    ["unsorted visible book", frame("hyperliquid", { asks: [{ px: "100.1", sz: "1", n: 1 }, { px: "100", sz: "1", n: 1 }] }), "route_visible_book_malformed"],
    ["malformed visible level", frame("hyperliquid", { asks: [{ px: "100.1", sz: "0", n: 1 }] }), "route_visible_book_malformed"],
    ["crossed visible book", frame("hyperliquid", { bids: [{ px: "102", sz: "1", n: 1 }] }), "route_visible_book_crossed"],
  ] as const)("excludes %s", (_label, source, code) => {
    const decision = mainnetPerpDecision({
      frames: [source], market: "BTC", interval: "5m", side: "buy",
      orderNotionalUsd: 100, limitPrice: 102, nowMs: NOW, maxAgeMs: 30_000,
    });

    expect(decision.candidates).toEqual([]);
    expect(decision.exclusions).toEqual([{ venue: source.venue, product: source.product, code }]);
  });

  it("never ranks depth whose top levels disagree with the displayed BBO", () => {
    const buy = mainnetPerpDecision({
      frames: [frame("hyperliquid", {
        bestBid: "99.9",
        bestAsk: "101",
        asks: [{ px: "100.1", sz: "20", n: 1 }],
      })],
      market: "BTC", interval: "5m", side: "buy",
      orderNotionalUsd: 100, limitPrice: 102, nowMs: NOW,
    });
    const sell = mainnetPerpDecision({
      frames: [frame("hyperliquid", {
        bestBid: "99",
        bestAsk: "100.1",
        bids: [{ px: "99.9", sz: "20", n: 1 }],
      })],
      market: "BTC", interval: "5m", side: "sell",
      orderNotionalUsd: 100, limitPrice: 98, nowMs: NOW,
    });

    expect(buy.candidates).toEqual([]);
    expect(sell.candidates).toEqual([]);
    expect(buy.exclusions[0]?.code).toBe("route_visible_book_quote_mismatch");
    expect(sell.exclusions[0]?.code).toBe("route_visible_book_quote_mismatch");
  });

  it("fails closed when the exact book component clock is missing or expired", () => {
    const source = frame("hyperliquid", { componentTimestamps: {} });
    const missing = mainnetPerpDecision({
      frames: [source], market: "BTC", interval: "5m", side: "buy",
      orderNotionalUsd: 100, limitPrice: 102, nowMs: NOW,
    });
    const expired = mainnetPerpDecision({
      frames: [frame("hyperliquid", { componentTimestamps: { book: NOW - 30_001 } })], market: "BTC", interval: "5m", side: "buy",
      orderNotionalUsd: 100, limitPrice: 102, nowMs: NOW, maxAgeMs: 30_000,
    });

    expect(missing.exclusions[0]?.code).toBe("route_visible_book_timestamp_invalid");
    expect(expired.exclusions[0]?.code).toBe("route_visible_book_expired");
  });

  it("prefers the frame's exact book clock and never launders it through telemetry age", () => {
    const fresh = mainnetPerpDecision({
      frames: [frame("hyperliquid", { componentTimestamps: { book: NOW - 500 } })],
      market: "BTC", interval: "5m", side: "buy",
      orderNotionalUsd: 100, limitPrice: 102, nowMs: NOW,
    });
    const expired = mainnetPerpDecision({
      frames: [frame("hyperliquid", { componentTimestamps: { book: NOW - 30_001 } })],
      market: "BTC", interval: "5m", side: "buy",
      orderNotionalUsd: 100, limitPrice: 102, nowMs: NOW, maxAgeMs: 30_000,
    });
    const future = mainnetPerpDecision({
      frames: [frame("hyperliquid", { componentTimestamps: { book: NOW + 5_001 } })],
      market: "BTC", interval: "5m", side: "buy",
      orderNotionalUsd: 100, limitPrice: 102, nowMs: NOW,
    });

    expect(fresh.best?.bookAgeMs).toBe(500);
    expect(expired.exclusions[0]?.code).toBe("route_visible_book_expired");
    expect(future.exclusions[0]?.code).toBe("route_visible_book_timestamp_future");
  });

  it("never ranks spot against perpetuals or testnet against mainnet", () => {
    const decision = deriveTerminalRouteDecision({
      frames: [
        frame("coinbase"),
        frame("hyperliquid", { network: "testnet" }),
        frame("phoenix", { product: "SOL-PERP" }),
      ],
      market: "BTC",
      interval: "5m",
      side: "buy",
      orderNotionalUsd: 100,
      limitPrice: 102,
      nowMs: NOW,
      requiredProductClass: "perpetual",
      requiredNetwork: "mainnet",
    });

    expect(decision.candidates).toEqual([]);
    expect(decision.exclusions).toEqual(expect.arrayContaining([
      { venue: "coinbase", product: "BTC-USD", code: "route_product_class_mismatch" },
      { venue: "hyperliquid", product: "BTC-PERP", code: "route_network_mismatch" },
      { venue: "phoenix", product: "SOL-PERP", code: "route_frame_identity_mismatch" },
    ]));
  });

  it("requires network provenance on the frame itself", () => {
    const decision = mainnetPerpDecision({
      frames: [frame("hyperliquid", { network: null })],
      market: "BTC",
      interval: "5m",
      side: "buy",
      orderNotionalUsd: 100,
      limitPrice: 102,
      nowMs: NOW,
    });

    expect(decision.candidates).toEqual([]);
    expect(decision.exclusions[0]?.code).toBe("route_network_mismatch");
  });

  it("fails closed for invalid decision inputs", () => {
    const source = frame("hyperliquid");
    expect(mainnetPerpDecision({
      frames: [source], market: "BTC", interval: "5m", side: "buy",
      orderNotionalUsd: 0, limitPrice: 101, nowMs: NOW,
    }).blocker).toBe("route_notional_invalid");
    expect(mainnetPerpDecision({
      frames: [source], market: "BTC", interval: "5m", side: "buy",
      orderNotionalUsd: 100, limitPrice: null, nowMs: NOW,
    }).blocker).toBe("route_limit_invalid");
    expect(mainnetPerpDecision({
      frames: [source], market: "BTC", interval: "5m", side: "buy",
      orderNotionalUsd: 100, limitPrice: 101, nowMs: Number.NaN,
    }).blocker).toBe("route_clock_invalid");
    expect(terminalRouteFreshnessMs("2m")).toBe(0);
  });
});

function frame(
  venue: GholaMarketFrame["venue"],
  overrides: Partial<GholaMarketFrame> = {},
): GholaMarketFrame {
  const value: GholaMarketFrame = {
    version: 1,
    venue,
    network: "mainnet",
    product: venue === "coinbase" ? "BTC-USD" : "BTC-PERP",
    interval: "5m",
    fetchedAt: iso(NOW - 1_000),
    stale: false,
    mid: "100",
    bestBid: "99.9",
    bestAsk: "100.1",
    spreadBps: 20,
    markPrice: "100",
    oraclePrice: null,
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [{ px: "99.9", sz: "20", n: 1 }],
    asks: [{ px: "100.1", sz: "20", n: 1 }],
    trades: [],
    routeQuotes: [],
    componentTimestamps: { book: NOW - 1_000 },
    ...overrides,
  };
  if (overrides.bids && overrides.bestBid === undefined) {
    value.bestBid = overrides.bids[0]?.px ?? null;
  }
  if (overrides.asks && overrides.bestAsk === undefined) {
    value.bestAsk = overrides.asks[0]?.px ?? null;
  }
  return value;
}

function mainnetPerpDecision(
  input: Omit<TerminalRouteDecisionInput, "requiredProductClass" | "requiredNetwork">,
) {
  return deriveTerminalRouteDecision({
    ...input,
    requiredProductClass: "perpetual",
    requiredNetwork: "mainnet",
  });
}

function iso(value: number) {
  return new Date(value).toISOString();
}
