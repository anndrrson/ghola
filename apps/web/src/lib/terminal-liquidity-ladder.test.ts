import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import {
  deriveTerminalLiquidityLadder,
  TERMINAL_LIQUIDITY_LADDER_LEVEL_LIMIT,
  type TerminalLiquidityLadderInput,
} from "./terminal-liquidity-ladder";

describe("terminal liquidity ladder", () => {
  it("normalizes, deduplicates, sorts, and calculates cumulative depth", () => {
    const ladder = derive({
      frame: frame({
        bids: [level(98, 2), level(99, 1), level(99, 3)],
        asks: [level(102, 2), level(101, 1), level(101, 0.5)],
      }),
      requestedNotionalUsd: 100,
    });

    expect(ladder.status).toBe("ready");
    expect(ladder.bids).toMatchObject([
      { price: 99, size: 4, cumulativeBase: 4, cumulativeNotionalUsd: 396 },
      { price: 98, size: 2, cumulativeBase: 6, cumulativeNotionalUsd: 592 },
    ]);
    expect(ladder.asks).toMatchObject([
      { price: 101, size: 1.5, cumulativeBase: 1.5, cumulativeNotionalUsd: 151.5 },
      { price: 102, size: 2, cumulativeBase: 3.5, cumulativeNotionalUsd: 355.5 },
    ]);
    expect(ladder).toMatchObject({ bestBid: 99, bestAsk: 101, mid: 100, spread: 2, spreadBps: 200 });
  });

  it("matches a selected base instrument to its venue product suffix", () => {
    const ladder = derive({ selectedProduct: "BTC" });

    expect(ladder.status).toBe("ready");
    expect(ladder.product).toBe("BTC-PERP");
  });

  it("caps each side at the nearest 20 unique levels", () => {
    const ladder = derive({
      frame: frame({
        bids: Array.from({ length: 25 }, (_, index) => level(99 - index, 1)),
        asks: Array.from({ length: 25 }, (_, index) => level(101 + index, 1)),
      }),
      requestedNotionalUsd: 100,
    });

    expect(ladder.bids).toHaveLength(TERMINAL_LIQUIDITY_LADDER_LEVEL_LIMIT);
    expect(ladder.asks).toHaveLength(TERMINAL_LIQUIDITY_LADDER_LEVEL_LIMIT);
    expect(ladder.bids.at(-1)?.price).toBe(80);
    expect(ladder.asks.at(-1)?.price).toBe(120);
  });

  it.each([
    ["missing frame", { frame: null }, "frame_unavailable"],
    ["synthetic frame", { synthetic: true }, "synthetic_frame"],
    ["supplied stale state", { stale: true }, "stale_frame"],
    ["frame stale state", { frame: frame({ stale: true }) }, "stale_frame"],
    ["venue mismatch", { selectedVenue: "coinbase" }, "market_identity_mismatch"],
    ["product mismatch", { selectedProduct: "ETH-PERP" }, "market_identity_mismatch"],
    ["interval mismatch", { selectedInterval: "1m" }, "market_identity_mismatch"],
    ["empty book", { frame: frame({ asks: [] }) }, "book_empty"],
    ["zero price", { frame: frame({ asks: [level(0, 1)] }) }, "book_level_invalid"],
    ["negative size", { frame: frame({ bids: [level(99, -1)] }) }, "book_level_invalid"],
    ["non-finite level", { frame: frame({ asks: [level(Number.NaN, 1)] }) }, "book_level_invalid"],
    ["crossed book", { frame: frame({ bids: [level(102, 1)] }) }, "book_crossed"],
  ] as const)("fails closed for %s", (_label, overrides, blocker) => {
    const ladder = derive({ requestedNotionalUsd: 100, ...overrides });

    expect(ladder.status).toBe("unavailable");
    expect(ladder.blocker).toBe(blocker);
    expect(ladder.bids).toEqual([]);
    expect(ladder.asks).toEqual([]);
    expect(ladder.sweep).toBeNull();
  });

  it("fails closed for invalid notional, limit, and selected entry", () => {
    expect(derive({ requestedNotionalUsd: 0 }).blocker).toBe("requested_notional_invalid");
    expect(derive({ requestedNotionalUsd: Number.MIN_VALUE }).blocker).toBe("requested_notional_invalid");
    expect(derive({ requestedNotionalUsd: 100, limitPrice: 0 }).blocker).toBe("limit_price_invalid");
    expect(derive({ requestedNotionalUsd: 100, selectedEntryPrice: -1 }).blocker).toBe("entry_price_invalid");
  });

  it("reports a full visible-depth fill and exact sweep boundary", () => {
    const ladder = derive({
      frame: frame({ asks: [level(101, 4), level(102, 10)] }),
      requestedNotionalUsd: 1_000,
      limitPrice: 102,
      selectedEntryPrice: 102,
    });

    expect(ladder.sweep).toMatchObject({
      status: "full",
      targetBaseSize: 1_000 / 102,
      filledBaseSize: 1_000 / 102,
      fillPct: 100,
      boundaryPrice: 102,
      levelsConsumed: 2,
    });
    expect(ladder.sweep?.vwap).toBeCloseTo(101.592);
    expect(ladder.asks[0]?.sweepFraction).toBe(1);
    expect(ladder.asks[1]?.sweepFraction).toBeCloseTo(0.580_392);
    expect(ladder.asks[1]?.sweepBoundary).toBe(true);
  });

  it("reports partial visible depth without inventing hidden liquidity", () => {
    const ladder = derive({
      frame: frame({ asks: [level(101, 2), level(102, 2)] }),
      requestedNotionalUsd: 1_000,
      limitPrice: 102,
    });

    expect(ladder.sweep).toMatchObject({
      status: "partial",
      filledBaseSize: 4,
      boundaryPrice: 102,
    });
    expect(ladder.sweep?.fillPct).toBeCloseTo(40.8);
    expect(ladder.sweep?.unfilledNotionalUsd).toBeCloseTo(592);
  });

  it("sizes staged limits at their bound price while benchmarking impact against mid", () => {
    const passive = derive({
      frame: frame({ bids: [level(90, 20)], asks: [level(110, 20)] }),
      side: "sell",
      requestedNotionalUsd: 900,
      limitPrice: 90,
      selectedEntryPrice: 90,
    });

    expect(passive.sweep?.targetBaseSize).toBe(10);
    expect(passive.sweep?.filledBaseSize).toBe(10);
    expect(passive.sweep?.vwap).toBe(90);
    expect(passive.sweep?.impactBps).toBeCloseTo(1_000);
  });

  it("reports no fill when the selected limit cannot cross the visible book", () => {
    const ladder = derive({ requestedNotionalUsd: 1_000, limitPrice: 100.5 });

    expect(ladder.sweep).toMatchObject({
      status: "none",
      filledBaseSize: 0,
      fillPct: 0,
      unfilledNotionalUsd: 1_000,
      boundaryPrice: null,
    });
    expect(ladder.sweep?.vwap).toBeNull();
    expect(ladder.sweep?.impactBps).toBeNull();
  });

  it("uses asks for buys and bids for sells with symmetric adverse impact", () => {
    const source = frame({
      bids: [level(99, 1), level(98, 1)],
      asks: [level(101, 1), level(102, 1)],
    });
    const buy = derive({ frame: source, side: "buy", requestedNotionalUsd: 200 });
    const sell = derive({ frame: source, side: "sell", requestedNotionalUsd: 200 });

    expect(buy.sweep).toMatchObject({ status: "full", vwap: 101.5, boundaryPrice: 102 });
    expect(sell.sweep).toMatchObject({ status: "full", vwap: 98.5, boundaryPrice: 98 });
    expect(buy.sweep?.impactBps).toBeCloseTo(150);
    expect(sell.sweep?.impactBps).toBeCloseTo(150);
    expect(buy.bids.every((item) => item.sweepFraction === 0)).toBe(true);
    expect(sell.asks.every((item) => item.sweepFraction === 0)).toBe(true);
  });
});

function derive(overrides: Partial<TerminalLiquidityLadderInput>) {
  return deriveTerminalLiquidityLadder({
    frame: frame(),
    side: "buy",
    requestedNotionalUsd: 100,
    selectedVenue: "hyperliquid",
    selectedProduct: "BTC-PERP",
    selectedInterval: "5m",
    ...overrides,
  });
}

function frame(overrides: Partial<GholaMarketFrame> = {}): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    product: "BTC-PERP",
    interval: "5m",
    fetchedAt: "2026-08-12T18:00:00.000Z",
    stale: false,
    mid: "100",
    bestBid: "99",
    bestAsk: "101",
    spreadBps: 200,
    markPrice: "100",
    oraclePrice: "100",
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles: [],
    bids: [level(99, 20)],
    asks: [level(101, 20)],
    trades: [],
    routeQuotes: [],
    ...overrides,
  };
}

function level(price: number, size: number) {
  return { px: String(price), sz: String(size), n: 1 };
}
