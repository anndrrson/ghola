import { describe, expect, it, vi } from "vitest";
import {
  getPhoenixMarketSnapshot,
  normalizeApiCandles,
  normalizeBookTuples,
  normalizeMarketFills,
  resetPhoenixMarketSnapshotCacheForTests,
  spreadBps,
  type PhoenixMarketSnapshotInput,
} from "./phoenix-market-data";

describe("Phoenix market-data normalizers", () => {
  it("derives side from signed baseQty and uses magnitude for size", () => {
    // Shape observed live from perp-api getMarketFills.
    const trades = normalizeMarketFills({
      data: [
        { marketSymbol: "SOL", baseQty: "-0.21", quoteQty: "17.26", price: "82.22", timestamp: 1780068110000, instructionType: "PlaceMultiLimitOrder" },
        { marketSymbol: "SOL", baseQty: "0.5", quoteQty: "41.1", price: "82.23", timestamp: 1780068111000, instructionType: "PlaceMultiLimitOrder" },
      ],
    });
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({ side: "sell", px: "82.22", sz: "0.21" });
    expect(trades[1]).toMatchObject({ side: "buy", px: "82.23", sz: "0.5" });
  });

  it("normalizes [price,size] book tuples", () => {
    const levels = normalizeBookTuples([[82.22, 87.59], [82.21, 100], ["bad", 1]]);
    expect(levels).toEqual([
      { px: "82.22", sz: "87.59" },
      { px: "82.21", sz: "100" },
    ]);
  });

  it("normalizes live candle records into chart candles", () => {
    const candles = normalizeApiCandles([
      { time: 1780068000000, open: 82.22, high: 82.3, low: 82.1, close: 82.15, volume: 28.83, tradeCount: 11 },
    ]);
    expect(candles[0]).toMatchObject({ t: 1780068000000, o: "82.22", c: "82.15", n: 11 });
  });

  it("falls back to the recent candle window when the ranged Phoenix candle query is empty", async () => {
    resetPhoenixMarketSnapshotCacheForTests();
    const getCandles = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { time: 1780068000000, open: 82.22, high: 82.3, low: 82.1, close: 82.15, volume: 28.83, tradeCount: 11 },
      ])
      .mockResolvedValueOnce([
        { time: 1780068000000, open: 82.22, high: 82.3, low: 82.1, close: 82.15, volumeQuote: 188.32 },
      ]);
    const dispose = vi.fn();
    const fakeClient = {
      api: {
        candles: () => ({ getCandles }),
        orderbook: () => ({ getOrderbook: vi.fn().mockResolvedValue({ bids: [[82.21, 10]], asks: [[82.22, 9]] }) }),
        markets: () => ({
          getMarket: vi.fn().mockResolvedValue(null),
          getMarketStatsHistory: vi.fn().mockResolvedValue({
            stats: [{ timestamp: "2026-05-29T12:00:00Z", mark_price: 82.15, spot_price: 82.14, open_interest: 29001.42 }],
          }),
        }),
        funding: () => ({
          getFundingRateHistory: vi.fn().mockResolvedValue({
            rates: [{ timestamp: 1780068000, fundingRatePercentage: "0.0021" }],
          }),
        }),
        trades: () => ({ getMarketFills: vi.fn().mockResolvedValue({ data: [] }) }),
      },
      dispose,
    };

    const snapshot = await getPhoenixMarketSnapshot({
      symbol: "SOL",
      interval: "1m",
      now: new Date("2026-05-29T12:00:00.000Z"),
      createClient: (() => fakeClient) as unknown as NonNullable<PhoenixMarketSnapshotInput["createClient"]>,
    });

    expect(getCandles).toHaveBeenCalledTimes(3);
    expect(snapshot.candles).toHaveLength(1);
    expect(snapshot.candles[0]).toMatchObject({ o: "82.22", c: "82.15" });
    expect(snapshot.open_interest).toBe("29001.42");
    expect(snapshot.funding_rate).toBe("0.0021");
    expect(snapshot.day_notional_volume).toBe("188.32");
    expect(snapshot.book_updated_at).toBe("2026-05-29T12:00:00.000Z");
    expect(snapshot.market_updated_at).toBe("2026-05-29T12:00:00.000Z");
    expect(snapshot.candles_updated_at).toBe("2026-05-29T12:00:00.000Z");
    expect(dispose).toHaveBeenCalled();
  });

  it("computes spread in bps", () => {
    expect(spreadBps("82.22", "82.23")).toBeGreaterThan(0);
    expect(spreadBps(null, "82.23")).toBeNull();
  });
});
