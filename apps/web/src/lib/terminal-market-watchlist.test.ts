import { describe, expect, it } from "vitest";
import type { GholaChartVenue, GholaMarketFrame } from "./ghola-market-chart";
import {
  defaultTerminalWatchlistPreferences,
  deriveTerminalWatchlistRows,
  mergeTerminalWatchlistSources,
  parseTerminalWatchlistPreferences,
  serializeTerminalWatchlistPreferences,
  setTerminalWatchlistSort,
  setTerminalWatchlistVenue,
  terminalMarketWatchlistStorageKey,
  terminalWatchlistSourcesEqual,
  terminalWatchlistCandleMaxAgeMs,
  terminalWatchlistSupportedVenues,
  type TerminalWatchlistPreferences,
  type TerminalWatchlistSource,
} from "./terminal-market-watchlist";

const NOW = Date.parse("2026-08-12T15:00:00.000Z");

describe("terminal passive market watchlist", () => {
  it("uses exact guest/account namespaces and fails closed for malformed scopes", () => {
    const left = `subject_${"a".repeat(32)}`;
    const right = `subject_${"b".repeat(32)}`;
    expect(terminalMarketWatchlistStorageKey(left)).not.toBe(terminalMarketWatchlistStorageKey(right));
    expect(terminalMarketWatchlistStorageKey("device_guest")).toBe(
      "ghola.terminal-market-watchlist.v2:device_guest",
    );
    expect(terminalMarketWatchlistStorageKey("subject_short")).toBeNull();
  });

  it("round trips the bounded manual venue preferences", () => {
    const defaults = defaultTerminalWatchlistPreferences();
    const changed = setTerminalWatchlistVenue(defaults, "SOL", "coinbase");

    expect(parseTerminalWatchlistPreferences(serializeTerminalWatchlistPreferences(changed))).toEqual(changed);
    expect(terminalWatchlistSupportedVenues("HYPE")).toEqual(["hyperliquid"]);
    expect(setTerminalWatchlistVenue(changed, "BTC", "phoenix")).toBe(changed);
  });

  it("persists sorting, migrates older preferences, and rejects malformed sorting", () => {
    const defaults = defaultTerminalWatchlistPreferences();
    const spread = setTerminalWatchlistSort(defaults, "spread");
    expect(spread.sort).toEqual({ field: "spread", direction: "asc" });
    expect(setTerminalWatchlistSort(spread, "spread").sort).toEqual({ field: "spread", direction: "desc" });
    expect(parseTerminalWatchlistPreferences(serializeTerminalWatchlistPreferences(spread))?.sort).toEqual(spread.sort);

    const legacy: Record<string, unknown> = { ...defaults };
    delete legacy.sort;
    expect(parseTerminalWatchlistPreferences(JSON.stringify(legacy))?.sort).toEqual({ field: "move", direction: "desc" });
    expect(parseTerminalWatchlistPreferences(JSON.stringify({ ...defaults, sort: { field: "clairvoyance", direction: "asc" } }))).toBeNull();
  });

  it("rejects malformed, duplicate, missing, and unsupported persisted rows", () => {
    const defaults = defaultTerminalWatchlistPreferences();
    expect(parseTerminalWatchlistPreferences("not json")).toBeNull();
    expect(parseTerminalWatchlistPreferences(JSON.stringify({ ...defaults, version: 2 }))).toBeNull();
    expect(parseTerminalWatchlistPreferences(JSON.stringify({
      ...defaults,
      entries: defaults.entries.map((entry) => entry.instrument === "BTC" ? { ...entry, venue: "phoenix" } : entry),
    }))).toBeNull();
    expect(parseTerminalWatchlistPreferences(JSON.stringify({
      ...defaults,
      entries: defaults.entries.map((entry) => entry.instrument === "ETH" ? { ...entry, instrument: "BTC" } : entry),
    }))).toBeNull();
    expect(parseTerminalWatchlistPreferences(JSON.stringify({
      ...defaults,
      entries: defaults.entries.slice(0, 3),
    }))).toBeNull();
  });

  it("derives price, executable spread, short-window move, volatility, grade, and freshness", () => {
    const source = liveSource(frame({
      venue: "hyperliquid",
      product: "BTC-PERP",
      fetchedAt: NOW - 500,
      bid: "109",
      ask: "111",
      mid: "110",
    }));
    const [row] = deriveTerminalWatchlistRows({
      preferences: preferences("BTC", "hyperliquid"),
      sources: [source],
      nowMs: NOW,
    });

    expect(row).toMatchObject({
      instrument: "BTC",
      venue: "hyperliquid",
      availability: "live",
      price: 110,
      healthGrade: "A",
      ageMs: 100,
    });
    expect(row.spreadBps).toBeCloseTo(181.818, 2);
    expect(row.changePct).toBeCloseTo(11.5578, 3);
    expect(row.realizedVolatilityBps).toBeGreaterThan(0);
  });

  it("fails closed on stale, expired, synthetic, unhealthy, crossed, and wrong-pair frames", () => {
    const preferencesValue = preferences("BTC", "hyperliquid");
    const base = frame({ venue: "hyperliquid", product: "BTC-PERP", fetchedAt: NOW - 500 });
    const cases: Array<[TerminalWatchlistSource, string]> = [
      [{ ...liveSource({ ...base, stale: true }), stale: true }, "stale"],
      [liveSource({ ...base, fetchedAt: new Date(NOW - 31_000).toISOString() }), "stale"],
      [{ ...liveSource(base), provenance: "synthetic" }, "synthetic_blocked"],
      [{ ...liveSource(base), status: "reconnecting" }, "stale"],
      [liveSource({ ...base, bestBid: "102", bestAsk: "101" }), "stale"],
      [liveSource({ ...base, bestBid: null }), "stale"],
      [liveSource({ ...base, bestAsk: "not-a-number" }), "stale"],
    ];

    for (const [source, availability] of cases) {
      const [row] = deriveTerminalWatchlistRows({
        preferences: preferencesValue,
        sources: [source],
        nowMs: NOW,
      });
      expect(row.availability).toBe(availability);
      expect(row.price).toBeNull();
      expect(row.spreadBps).toBeNull();
      expect(row.changePct).toBeNull();
      expect(row.realizedVolatilityBps).toBeNull();
    }

    const [wrongPair] = deriveTerminalWatchlistRows({
      preferences: preferencesValue,
      sources: [liveSource(frame({ venue: "coinbase", product: "BTC-USD", fetchedAt: NOW - 500 }))],
      nowMs: NOW,
    });
    expect(wrongPair.availability).toBe("not_loaded");
  });

  it("uses interval-aware candle freshness without relaxing executable quote freshness", () => {
    const freshFrame = frame({ venue: "phoenix", product: "SOL-PERP", fetchedAt: NOW - 500 });
    expect(terminalWatchlistCandleMaxAgeMs("1m")).toBe(300_000);
    expect(terminalWatchlistCandleMaxAgeMs("5m")).toBe(900_000);
    expect(terminalWatchlistCandleMaxAgeMs("1h")).toBe(10_800_000);
    for (const componentAgesMs of [{ quote: 100 }, { quote: 100, candles: 900_001 }]) {
      const [row] = deriveTerminalWatchlistRows({
        preferences: preferences("SOL", "phoenix"),
        sources: [{ ...liveSource(freshFrame), componentAgesMs }],
        nowMs: NOW,
      });
      expect(row.availability).toBe("live");
      expect(row.price).not.toBeNull();
      expect(row.changePct).toBeNull();
      expect(row.realizedVolatilityBps).toBeNull();
    }
  });

  it("continues aging cached quote and candle clocks after capture", () => {
    const source = {
      ...liveSource(frame({ venue: "hyperliquid", product: "BTC-PERP", fetchedAt: NOW })),
      componentAgesMs: { quote: 29_000, candles: 899_000 },
      telemetryCapturedAtMs: NOW,
    };
    const [expiredQuote] = deriveTerminalWatchlistRows({
      preferences: preferences("BTC", "hyperliquid"),
      sources: [source],
      nowMs: NOW + 2_000,
    });
    expect(expiredQuote.availability).toBe("stale");

    const [expiredCandles] = deriveTerminalWatchlistRows({
      preferences: preferences("BTC", "hyperliquid"),
      sources: [{ ...source, componentAgesMs: { quote: 100, candles: 899_000 } }],
      nowMs: NOW + 2_000,
    });
    expect(expiredCandles.availability).toBe("live");
    expect(expiredCandles.changePct).toBeNull();
    expect(expiredCandles.realizedVolatilityBps).toBeNull();
  });

  it("ranks absolute 12-bar movement with spread as the explicit tie-breaker", () => {
    const rows = deriveTerminalWatchlistRows({
      preferences: defaultTerminalWatchlistPreferences(),
      sources: [
        liveSource(frame({ venue: "hyperliquid", product: "BTC-PERP", fetchedAt: NOW, candleStep: 3 })),
        liveSource(frame({ venue: "hyperliquid", product: "ETH-PERP", fetchedAt: NOW, candleStep: 2 })),
        liveSource(frame({ venue: "hyperliquid", product: "SOL-PERP", fetchedAt: NOW, candleStep: 1 })),
        liveSource(frame({ venue: "hyperliquid", product: "HYPE-PERP", fetchedAt: NOW, candleStep: 0.1 })),
      ],
      nowMs: NOW,
    });

    expect(Object.fromEntries(rows.map((row) => [row.instrument, row.moveRank]))).toEqual({
      BTC: 1,
      ETH: 2,
      SOL: 3,
      HYPE: 4,
    });
  });

  it("sorts live opportunities by the selected metric with unavailable rows last", () => {
    const sources = [
      liveSource(frame({ venue: "hyperliquid", product: "BTC-PERP", fetchedAt: NOW, bid: "99", ask: "101", candleStep: 1 })),
      liveSource(frame({ venue: "hyperliquid", product: "ETH-PERP", fetchedAt: NOW, bid: "99.9", ask: "100.1", candleStep: 3 })),
      liveSource(frame({ venue: "hyperliquid", product: "SOL-PERP", fetchedAt: NOW, bid: "99.5", ask: "100.5", candleStep: 2 })),
    ];
    const defaults = defaultTerminalWatchlistPreferences();
    const bySpread = deriveTerminalWatchlistRows({
      preferences: { ...defaults, sort: { field: "spread", direction: "asc" } },
      sources,
      nowMs: NOW,
    });
    expect(bySpread.map((row) => row.instrument)).toEqual(["ETH", "SOL", "BTC", "HYPE"]);

    const byMove = deriveTerminalWatchlistRows({ preferences: defaults, sources, nowMs: NOW });
    expect(byMove.map((row) => row.instrument)).toEqual(["ETH", "SOL", "BTC", "HYPE"]);
  });

  it("derives its executable midpoint from BBO instead of an inconsistent mark-like mid", () => {
    const [row] = deriveTerminalWatchlistRows({
      preferences: preferences("BTC", "hyperliquid"),
      sources: [liveSource(frame({
        venue: "hyperliquid",
        product: "BTC-PERP",
        fetchedAt: NOW,
        bid: "99",
        ask: "101",
        mid: "10000",
      }))],
      nowMs: NOW,
    });

    expect(row.price).toBe(100);
    expect(row.spreadBps).toBe(200);
  });

  it("reports executable quote age instead of a newer aggregate frame receipt", () => {
    const [row] = deriveTerminalWatchlistRows({
      preferences: preferences("BTC", "hyperliquid"),
      sources: [{
        ...liveSource(frame({ venue: "hyperliquid", product: "BTC-PERP", fetchedAt: NOW })),
        componentAgesMs: { quote: 29_000, candles: 100 },
        telemetryCapturedAtMs: NOW,
      }],
      nowMs: NOW,
    });

    expect(row.availability).toBe("live");
    expect(row.ageMs).toBe(29_000);
  });

  it("retains only the newest public frame per supported pair in a bounded cache", () => {
    const older = liveSource(frame({ venue: "hyperliquid", product: "BTC-PERP", fetchedAt: NOW - 2_000, mid: "99" }));
    const newer = liveSource(frame({ venue: "hyperliquid", product: "BTC-PERP", fetchedAt: NOW - 1_000, ask: "102" }));
    const unsupported = liveSource(frame({ venue: "phoenix", product: "BTC-PERP", fetchedAt: NOW, mid: "101" }));
    const pairs: TerminalWatchlistSource[] = [
      newer,
      unsupported,
      liveSource(frame({ venue: "coinbase", product: "BTC-USD", fetchedAt: NOW - 1_000 })),
      liveSource(frame({ venue: "hyperliquid", product: "ETH-PERP", fetchedAt: NOW - 1_000 })),
      liveSource(frame({ venue: "coinbase", product: "ETH-USD", fetchedAt: NOW - 1_000 })),
      liveSource(frame({ venue: "hyperliquid", product: "SOL-PERP", fetchedAt: NOW - 1_000 })),
      liveSource(frame({ venue: "phoenix", product: "SOL-PERP", fetchedAt: NOW - 1_000 })),
      liveSource(frame({ venue: "coinbase", product: "SOL-USD", fetchedAt: NOW - 1_000 })),
      liveSource(frame({ venue: "hyperliquid", product: "HYPE-PERP", fetchedAt: NOW - 1_000 })),
    ];
    const result = mergeTerminalWatchlistSources([older], pairs);

    expect(result).toHaveLength(8);
    expect(result.find((source) => source.frame.product === "BTC-PERP" && source.frame.venue === "hyperliquid")?.frame.bestAsk).toBe("102");
    expect(result.some((source) => source.frame.venue === "phoenix" && source.frame.product === "BTC-PERP")).toBe(false);
  });

  it("retains source identity across aggregate-only receipts", () => {
    const previous = liveSource(frame({ venue: "hyperliquid", product: "BTC-PERP", fetchedAt: NOW }));
    const previousSources = [previous];
    const aggregateOnly = {
      ...previous,
      frame: {
        ...previous.frame,
        fetchedAt: new Date(NOW + 1_000).toISOString(),
        trades: [{ side: "buy" as const, px: "101", sz: "0.1", time: NOW + 1_000 }],
        bids: [{ px: "99", sz: "9", n: 3 }],
      },
      componentAgesMs: { quote: 1_100, candles: 2_000 },
      telemetryCapturedAtMs: NOW + 1_000,
    };

    expect(terminalWatchlistSourcesEqual(previousSources, [aggregateOnly])).toBe(true);
    expect(mergeTerminalWatchlistSources(previousSources, [aggregateOnly])).toBe(previousSources);
  });

  it("invalidates semantic equality for quote, candle, identity, and safety changes", () => {
    const previous = liveSource(frame({ venue: "hyperliquid", product: "BTC-PERP", fetchedAt: NOW }));
    const changes: TerminalWatchlistSource[] = [
      { ...previous, frame: { ...previous.frame, bestAsk: "102" } },
      { ...previous, frame: { ...previous.frame, candles: previous.frame.candles.map((candle, index) => index === 11 ? { ...candle, c: "999" } : candle) } },
      { ...previous, frame: { ...previous.frame, network: "testnet" } },
      { ...previous, stale: true },
    ];

    for (const changed of changes) expect(terminalWatchlistSourcesEqual([previous], [changed])).toBe(false);
  });
});

function preferences(
  instrument: "BTC" | "ETH" | "SOL" | "HYPE",
  venue: "hyperliquid" | "phoenix" | "coinbase",
): TerminalWatchlistPreferences {
  const defaults = defaultTerminalWatchlistPreferences();
  return {
    ...defaults,
    entries: [
      { instrument, venue },
      ...defaults.entries.filter((entry) => entry.instrument !== instrument),
    ],
  };
}

function liveSource(value: GholaMarketFrame): TerminalWatchlistSource {
  return {
    frame: value,
    status: "live",
    stale: false,
    provenance: "public_live",
    healthGrade: "A",
    componentAgesMs: { quote: 100, candles: 1_000 },
    telemetryCapturedAtMs: NOW,
  };
}

function frame(input: {
  venue: GholaChartVenue;
  product: string;
  fetchedAt: number;
  bid?: string;
  ask?: string;
  mid?: string;
  candleStep?: number;
}): GholaMarketFrame {
  const candles = Array.from({ length: 12 }, (_, index) => {
    const close = 100 + index * (input.candleStep ?? 1);
    return {
      t: NOW - (12 - index) * 60_000,
      T: NOW - (11 - index) * 60_000 - 1,
      o: String(close - 0.5),
      h: String(close + 1),
      l: String(close - 1),
      c: String(close),
      v: "10",
      n: 2,
    };
  });
  return {
    version: 1,
    venue: input.venue,
    product: input.product,
    interval: "5m",
    fetchedAt: new Date(input.fetchedAt).toISOString(),
    stale: false,
    mid: input.mid ?? "100",
    bestBid: input.bid ?? "99",
    bestAsk: input.ask ?? "101",
    spreadBps: 200,
    markPrice: input.mid ?? "100",
    oraclePrice: input.mid ?? "100",
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles,
    bids: [{ px: input.bid ?? "99", sz: "1", n: 1 }],
    asks: [{ px: input.ask ?? "101", sz: "1", n: 1 }],
    trades: [],
    routeQuotes: [],
  };
}
