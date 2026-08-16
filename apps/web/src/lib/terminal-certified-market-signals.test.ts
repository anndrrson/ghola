import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "./ghola-market-chart";
import {
  deriveTerminalCertifiedMarketSignals,
  terminalCertifiedBookViewEqual,
  terminalCertifiedIntelligenceViewEqual,
  terminalCertifiedTapeViewEqual,
  type TerminalCertifiedMarketSignalInput,
} from "./terminal-certified-market-signals";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

describe("terminal certified market signals", () => {
  it("never exposes a synthetic fallback even when its timestamps look fresh", () => {
    const result = deriveTerminalCertifiedMarketSignals({
      ...input(),
      source: "synthetic",
    });

    expect(result.snapshotInstrument).toBeNull();
    expect(result.referencePrice).toBeNull();
    expect(result.bookFrame).toBeNull();
    expect(result.tape.trades).toEqual([]);
    expect(Object.values(result.alertSnapshot).every((value) => value == null)).toBe(true);
    expect(result.surfaces.intelligence).toMatchObject({
      status: "paused",
      message: expect.stringContaining("synthetic fallback excluded"),
    });
  });

  it("fails closed on an exact selection mismatch", () => {
    const result = deriveTerminalCertifiedMarketSignals({
      ...input(),
      selection: { venue: "coinbase", network: "mainnet", market: "BTC", interval: "1m" },
    });

    expect(result.components.quote.blocker).toBe("identity_mismatch");
    expect(result.availableAlertMetrics).toEqual([]);
    expect(result.tape.trades).toEqual([]);
  });

  it("fails closed when the exact public network is missing or mismatched", () => {
    const mismatched = deriveTerminalCertifiedMarketSignals({
      ...input(),
      selection: { ...input().selection, network: "testnet" },
    });
    const missingFrame = liveFrame();
    delete missingFrame.network;
    const missing = deriveTerminalCertifiedMarketSignals({ ...input(), frame: missingFrame });

    expect(mismatched.components.quote.blocker).toBe("identity_mismatch");
    expect(mismatched.evaluationIdentityKey).toBeNull();
    expect(missing.components.quote.blocker).toBe("identity_mismatch");
    expect(missing.availableAlertMetrics).toEqual([]);
  });

  it("certifies fresh quote, book, prints, and candles independently", () => {
    const result = deriveTerminalCertifiedMarketSignals(input());

    expect(result.components).toMatchObject({
      quote: { ready: true, ageMs: 1_000 },
      book: { ready: true, ageMs: 2_000 },
      trades: { ready: true, ageMs: 3_000 },
      candles: { ready: true, ageMs: 60_000 },
    });
    expect(result.referencePrice).toBe(100);
    expect(result.intelligence.sessionChangePct).toBeCloseTo(2.0202);
    expect(result.intelligence.bidDepthUsd).toBe(493);
    expect(result.intelligence.askDepthUsd).toBe(305);
    expect(result.bookFrame).toMatchObject({ mid: "100", bestBid: "99", bestAsk: "101", spreadBps: 200 });
    expect(result.evaluationIdentityKey).toBe("hyperliquid:mainnet:btc:1m");
    expect(result.alertSnapshot).toMatchObject({
      price: 100,
      spread_bps: 200,
      book_imbalance_pct: expect.any(Number),
      microprice_edge_bps: expect.any(Number),
      realized_volatility_bps: expect.any(Number),
      market_age_ms: 1_000,
      book_age_ms: 2_000,
      trades_age_ms: 3_000,
      candles_age_ms: 60_000,
    });
    expect(result.tape.trades.map((trade) => trade.id)).toEqual(["new", "old"]);
    expect(result.tape.tradeVwap).toBeCloseTo(100);
    expect(result.surfaces.alerts.status).toBe("ready");
  });

  it("does not let a fresh quote bless stale book, prints, or candles", () => {
    const result = deriveTerminalCertifiedMarketSignals({
      ...input(),
      componentAgesMs: {
        quote: 100,
        book: 30_001,
        trades: 30_001,
        candles: 90_001,
      },
    });

    expect(result.components.quote.ready).toBe(true);
    expect(result.components.book.blocker).toBe("component_stale");
    expect(result.bookFrame).toBeNull();
    expect(result.components.trades.blocker).toBe("component_stale");
    expect(result.components.candles.blocker).toBe("component_stale");
    expect(result.intelligence).toMatchObject({
      sessionChangePct: null,
      bookImbalancePct: null,
      bidDepthUsd: null,
      askDepthUsd: null,
      realizedVolatilityBps: null,
      tradeVwap: null,
    });
    expect(result.availableAlertMetrics).toEqual(["price", "spread_bps", "market_age_ms", "book_age_ms", "trades_age_ms", "candles_age_ms"]);
    expect(result.surfaces.intelligence.status).toBe("paused");
  });

  it("derives book edge only from the certified BBO midpoint", () => {
    const frame = liveFrame();
    frame.mid = "1000";
    const result = deriveTerminalCertifiedMarketSignals({
      ...input(),
      frame,
      componentAgesMs: { quote: 30_001, book: 100, trades: 30_001, candles: 90_001 },
    });

    expect(result.components.quote.blocker).toBe("component_stale");
    expect(result.components.book.ready).toBe(true);
    expect(result.bookFrame).toMatchObject({ mid: "100", bestBid: "99", bestAsk: "101" });
    expect(result.intelligence.microprice).toBeCloseTo(100.25);
    expect(result.intelligence.micropriceEdgeBps).toBeCloseTo(25);
  });

  it("suppresses actionable signals when the controller is stale but preserves exact quote age", () => {
    const result = deriveTerminalCertifiedMarketSignals({
      ...input(),
      controllerStale: true,
      status: "stale",
      componentAgesMs: { quote: 45_000, book: 45_000, trades: 45_000, candles: 60_000 },
    });

    expect(result.referencePrice).toBeNull();
    expect(result.components.quote.blocker).toBe("controller_stale");
    expect(result.tape.trades).toEqual([]);
    expect(result.alertSnapshot).toEqual({
      price: null,
      spread_bps: null,
      book_imbalance_pct: null,
      microprice_edge_bps: null,
      realized_volatility_bps: null,
      market_age_ms: 45_000,
      book_age_ms: 45_000,
      trades_age_ms: 45_000,
      candles_age_ms: 60_000,
    });
    expect(result.surfaces.alerts).toEqual({
      status: "degraded",
      message: "exact component-age alerts only; actionable signals paused",
    });
  });

  it("fails each component independently on missing, future, and inconsistent clocks", () => {
    const frame = liveFrame();
    frame.componentTimestamps = {
      quote: NOW + 1,
      book: NOW - 2_000,
      trades: NOW - 4_000,
      candles: NOW - 120_000,
    };
    const result = deriveTerminalCertifiedMarketSignals({
      ...input(),
      frame,
      componentAgesMs: { quote: 0, book: 2_000, trades: 4_000 },
    });

    expect(result.components.quote.blocker).toBe("clock_future");
    expect(result.components.book.ready).toBe(true);
    expect(result.components.trades.blocker).toBe("trades_clock_mismatch");
    expect(result.components.candles.blocker).toBe("clock_missing");
    expect(result.availableAlertMetrics).toEqual(["book_imbalance_pct", "microprice_edge_bps", "book_age_ms"]);
  });

  it("rejects malformed books, prints, candles, and conflicting stable trade ids", () => {
    const crossed = liveFrame();
    crossed.asks[0] = { px: "98", sz: "2", n: 1 };
    const crossedResult = deriveTerminalCertifiedMarketSignals({ ...input(), frame: crossed });
    expect(crossedResult.components.book.blocker).toBe("book_invalid");

    const malformedTrade = liveFrame();
    malformedTrade.trades[0] = { id: "new", side: "buy", px: "101", sz: "0", time: NOW - 3_000 };
    expect(deriveTerminalCertifiedMarketSignals({ ...input(), frame: malformedTrade }).components.trades.blocker)
      .toBe("trades_invalid");

    const conflictingId = liveFrame();
    conflictingId.trades.push({ id: "new", side: "sell", px: "99", sz: "1", time: NOW - 3_000 });
    expect(deriveTerminalCertifiedMarketSignals({ ...input(), frame: conflictingId }).components.trades.blocker)
      .toBe("trades_invalid");

    const malformedCandle = liveFrame();
    malformedCandle.candles[1] = { ...malformedCandle.candles[1]!, l: "103" };
    expect(deriveTerminalCertifiedMarketSignals({ ...input(), frame: malformedCandle }).components.candles.blocker)
      .toBe("candles_invalid");
  });

  it("accepts exact age boundaries and pauses one millisecond beyond them", () => {
    const boundary = deriveTerminalCertifiedMarketSignals({
      ...input(),
      componentAgesMs: { quote: 30_000, book: 30_000, trades: 30_000, candles: 90_000 },
    });
    expect(boundary.components.quote.ready).toBe(true);
    expect(boundary.components.book.ready).toBe(true);
    expect(boundary.components.trades.ready).toBe(true);
    expect(boundary.components.candles.ready).toBe(true);

    const expired = deriveTerminalCertifiedMarketSignals({
      ...input(),
      componentAgesMs: { quote: 30_001, book: 30_001, trades: 30_001, candles: 90_001 },
    });
    expect(Object.values(expired.components).every((state) => state.blocker === "component_stale")).toBe(true);
    expect(expired.alertSnapshot.market_age_ms).toBe(30_001);
    expect(expired.alertSnapshot).toMatchObject({ book_age_ms: 30_001, trades_age_ms: 30_001, candles_age_ms: 90_001 });
  });

  it("keeps cold render surfaces semantically equal across quote-age-only publications", () => {
    const shared = input();
    const first = deriveTerminalCertifiedMarketSignals(shared);
    const second = deriveTerminalCertifiedMarketSignals({
      ...shared,
      componentAgesMs: { ...shared.componentAgesMs, quote: 1_100 },
    });

    expect(terminalCertifiedIntelligenceViewEqual(first, second)).toBe(true);
    expect(terminalCertifiedBookViewEqual(first, second)).toBe(true);
    expect(terminalCertifiedTapeViewEqual(first, second)).toBe(true);
  });

  it("invalidates only views whose certified values changed", () => {
    const shared = input();
    const first = deriveTerminalCertifiedMarketSignals(shared);
    const frame = { ...shared.frame!, trades: shared.frame!.trades.map((trade, index) => index === 0 ? { ...trade, sz: "3" } : trade) };
    const second = deriveTerminalCertifiedMarketSignals({ ...shared, frame });

    expect(terminalCertifiedBookViewEqual(first, second)).toBe(true);
    expect(terminalCertifiedTapeViewEqual(first, second)).toBe(false);
    expect(terminalCertifiedIntelligenceViewEqual(first, second)).toBe(false);
  });
});

function input(): TerminalCertifiedMarketSignalInput {
  return {
    frame: liveFrame(),
    source: "public_live",
    selection: { venue: "hyperliquid", network: "mainnet", market: "BTC", interval: "1m" },
    status: "live",
    controllerStale: false,
    componentAgesMs: { quote: 1_000, book: 2_000, trades: 3_000, candles: 60_000 },
    nowMs: NOW,
  };
}

function liveFrame(): GholaMarketFrame {
  const candleStart = NOW - 180_000;
  return {
    version: 1,
    venue: "hyperliquid",
    network: "mainnet",
    product: "BTC",
    interval: "1m",
    fetchedAt: new Date(NOW - 500).toISOString(),
    stale: false,
    mid: "100",
    bestBid: "99",
    bestAsk: "101",
    spreadBps: 200,
    markPrice: "100",
    oraclePrice: "100",
    fundingRate: "0.0001",
    openInterest: "1000000",
    dayVolume: "10000000",
    candles: [
      candle(candleStart, 99, 102, 98, 100),
      candle(candleStart + 60_000, 100, 103, 99, 102),
      candle(candleStart + 120_000, 102, 104, 100, 101),
    ],
    bids: [{ px: "99", sz: "3", n: 2 }, { px: "98", sz: "2", n: 1 }],
    asks: [{ px: "101", sz: "1", n: 1 }, { px: "102", sz: "2", n: 1 }],
    trades: [
      { id: "old", side: "sell", px: "99", sz: "2", time: NOW - 4_000 },
      { id: "new", side: "buy", px: "101", sz: "2", time: NOW - 3_000 },
    ],
    routeQuotes: [],
    componentTimestamps: {
      quote: NOW - 1_000,
      book: NOW - 2_000,
      trades: NOW - 3_000,
      candles: NOW - 60_000,
    },
  };
}

function candle(t: number, o: number, h: number, l: number, c: number) {
  return {
    t,
    T: t + 59_999,
    o: String(o),
    h: String(h),
    l: String(l),
    c: String(c),
    v: "10",
    n: 2,
  };
}
