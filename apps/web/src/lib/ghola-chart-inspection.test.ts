import { describe, expect, it } from "vitest";
import {
  captureGholaReplaySource,
  defaultGholaReplayCursor,
  gholaChartSessionMarkers,
  gholaReplayFrame,
  measureGholaCandleRange,
} from "./ghola-chart-inspection";
import type { GholaChartCandle, GholaMarketFrame } from "./ghola-market-chart";

describe("ghola chart inspection", () => {
  it("measures directional change and inclusive range statistics", () => {
    const measurement = measureGholaCandleRange(candles(), 1, 3);

    expect(measurement).toMatchObject({
      anchorIndex: 1,
      targetIndex: 3,
      bars: 2,
      startPrice: 102,
      endPrice: 108,
      absoluteChange: 6,
      high: 110,
      low: 99,
      volume: 90,
    });
    expect(measurement?.changePct).toBeCloseTo(5.88235, 4);
    expect(measurement?.rangePct).toBeCloseTo(11.1111, 4);
    expect(measurement?.elapsedMs).toBe(120_000);
  });

  it("preserves anchor-to-target direction when measuring backwards", () => {
    const measurement = measureGholaCandleRange(candles(), 3, 1);

    expect(measurement?.bars).toBe(2);
    expect(measurement?.absoluteChange).toBe(-6);
    expect(measurement?.changePct).toBeCloseTo(-5.55556, 4);
    expect(measurement?.high).toBe(110);
    expect(measurement?.low).toBe(99);
  });

  it("replays without leaking future book, funding, or trades", () => {
    const replay = gholaReplayFrame(frame(), 1);

    expect(replay.candles).toHaveLength(2);
    expect(replay.mid).toBe("102");
    expect(replay.markPrice).toBe("102");
    expect(replay.bestBid).toBeNull();
    expect(replay.fundingRate).toBeNull();
    expect(replay.bids).toEqual([]);
    expect(replay.trades).toHaveLength(1);
    expect(replay.fetchedAt).toBe("2026-08-12T23:59:59.999Z");
  });

  it("captures an immutable replay source before live data advances", () => {
    const live = frame();
    const source = captureGholaReplaySource(live);

    live.candles[0].c = "999";
    live.trades[0].px = "999";
    live.bids[0].px = "999";

    expect(source.candles[0].c).toBe("101");
    expect(source.trades[0].px).toBe("102");
    expect(source.bids[0].px).toBe("107.9");
  });

  it("chooses a useful replay start and marks UTC session transitions", () => {
    expect(defaultGholaReplayCursor(100)).toBe(69);
    expect(defaultGholaReplayCursor(10)).toBe(8);
    expect(gholaChartSessionMarkers(candles())).toEqual([
      { index: 2, time: Date.parse("2026-08-13T00:00:00.000Z"), label: "00:00Z" },
    ]);
  });
});

function candles(): GholaChartCandle[] {
  const start = Date.parse("2026-08-12T23:58:00.000Z");
  return [
    candle(start, "100", "104", "98", "101", "10"),
    candle(start + 60_000, "101", "105", "100", "102", "20"),
    candle(start + 120_000, "102", "107", "99", "106", "30"),
    candle(start + 180_000, "106", "110", "103", "108", "40"),
  ];
}

function candle(t: number, o: string, h: string, l: string, c: string, v: string): GholaChartCandle {
  return { t, T: t + 59_999, o, h, l, c, v, n: 1 };
}

function frame(): GholaMarketFrame {
  const frameCandles = candles();
  return {
    version: 1,
    venue: "hyperliquid",
    product: "BTC",
    interval: "1m",
    fetchedAt: "2026-08-13T00:02:00.000Z",
    stale: false,
    mid: "108",
    bestBid: "107.9",
    bestAsk: "108.1",
    spreadBps: 1.85,
    markPrice: "108",
    oraclePrice: "108.2",
    fundingRate: "0.0001",
    openInterest: "1000000",
    dayVolume: "2000000",
    candles: frameCandles,
    bids: [{ px: "107.9", sz: "2", n: 1 }],
    asks: [{ px: "108.1", sz: "2", n: 1 }],
    trades: [
      { side: "buy", px: "102", sz: "1", time: frameCandles[1].t },
      { side: "sell", px: "108", sz: "1", time: frameCandles[3].t },
    ],
    routeQuotes: [],
  };
}
