import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCoinbaseMarketSnapshot,
  normalizeCoinbaseCandles,
  normalizeCoinbaseMarketInput,
  resetCoinbaseMarketSnapshotCacheForTests,
} from "./coinbase-market-data";

describe("Coinbase market data", () => {
  afterEach(() => {
    resetCoinbaseMarketSnapshotCacheForTests();
    vi.restoreAllMocks();
  });

  it("normalizes product symbols and intervals", () => {
    expect(normalizeCoinbaseMarketInput({ productId: "eth", interval: "1m" })).toEqual({
      productId: "ETH-USD",
      interval: "1m",
    });
    expect(normalizeCoinbaseMarketInput({ productId: "DOGE-USD", interval: "2m" })).toEqual({
      productId: "BTC-USD",
      interval: "5m",
    });
  });

  it("sorts public candles into ascending chart order", () => {
    const candles = normalizeCoinbaseCandles([
      { start: "1780106400", low: "99", high: "103", open: "100", close: "102", volume: "1" },
      { start: "1780106100", low: "98", high: "101", open: "99", close: "100", volume: "2" },
    ]);
    expect(candles.map((candle) => candle.t)).toEqual([1780106100000, 1780106400000]);
    expect(candles[0]).toMatchObject({ o: "99", c: "100", v: "2" });
  });

  it("builds a public spot snapshot without account data", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.includes("/product_book")) {
        return json({
          pricebook: {
            product_id: "BTC-USD",
            time: "2026-05-30T02:06:59.381744Z",
            bids: Array.from({ length: 22 }, (_, index) => ({
              price: String(73580 - index),
              size: String(0.1 + index / 100),
            })),
            asks: Array.from({ length: 22 }, (_, index) => ({
              price: String(73581 + index),
              size: String(0.2 + index / 100),
            })),
          },
          last: "73580.5",
          mid_market: "73580.5",
          spread_bps: "0.13",
        });
      }
      if (url.includes("/candles")) {
        return json({
          candles: [
            { start: "1780106400", low: "73559.37", high: "73614.37", open: "73559.38", close: "73599.99", volume: "10.13267593" },
            { start: "1780106100", low: "73539.04", high: "73564.19", open: "73545.36", close: "73559.38", volume: "8.50417227" },
          ],
        });
      }
      if (url.includes("/ticker")) {
        return json({
          trades: [
            { trade_id: "1026482541", product_id: "BTC-USD", price: "73594.11", size: "0.00041044", time: "2026-05-30T02:07:00.336174Z", side: "SELL" },
          ],
        });
      }
      return json({
        product_id: "BTC-USD",
        price: "73580.35",
        price_percentage_change_24h: "0.12314625761245",
        volume_24h: "9215.25123164",
        base_increment: "0.00000001",
        quote_increment: "0.01",
        quote_min_size: "1",
        trading_disabled: false,
        product_type: "SPOT",
        base_currency_id: "BTC",
        quote_currency_id: "USD",
        approximate_quote_24h_volume: "678061410.96",
      });
    });

    const snapshot = await getCoinbaseMarketSnapshot({
      productId: "BTC-USD",
      interval: "5m",
      now: new Date("2026-05-30T02:07:01.000Z"),
      fetchImpl: fetchImpl as never,
    });

    expect(snapshot.platform).toBe("coinbase");
    expect(snapshot.stale).toBe(false);
    expect(snapshot.product_id).toBe("BTC-USD");
    expect(snapshot.price).toBe("73580.35");
    expect(snapshot.mid).toBe("73580.5");
    expect(snapshot.best_bid).toBe("73580");
    expect(snapshot.best_ask).toBe("73581");
    expect(snapshot.spread_bps).toBe(0.14);
    expect(snapshot.price_percentage_change_24h).toBe("0.12314625761245");
    expect(snapshot.approximate_quote_24h_volume).toBe("678061410.96");
    expect(snapshot.bids).toHaveLength(20);
    expect(snapshot.asks).toHaveLength(20);
    expect(snapshot.candles.map((candle) => candle.t)).toEqual([1780106100000, 1780106400000]);
    expect(snapshot.recent_trades[0]).toMatchObject({ side: "sell", px: "73594.11", sz: "0.00041044" });
    expect(JSON.stringify(snapshot)).not.toContain("api_key");
    expect(JSON.stringify(snapshot)).not.toContain("wallet_address");
  });

  it("never marks empty successful responses live", async () => {
    const snapshot = await getCoinbaseMarketSnapshot({
      now: new Date("2026-05-30T02:07:01.000Z"),
      fetchImpl: vi.fn(async () => json({})) as never,
    });

    expect(snapshot.stale).toBe(true);
    expect(snapshot.source_timestamp).toBeNull();
    expect(snapshot.bids).toEqual([]);
    expect(snapshot.candles).toEqual([]);
  });

  it("rejects crossed books, invalid OHLC, and aged source data", async () => {
    const now = new Date("2026-05-30T02:07:01.000Z");
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/product_book")) {
        return json({ pricebook: { product_id: "BTC-USD", time: new Date(now.getTime() - 10 * 60_000).toISOString(), bids: [{ price: "101", size: "1" }], asks: [{ price: "100", size: "1" }] } });
      }
      if (url.includes("/candles")) {
        return json({ candles: [{ start: String(Math.floor((now.getTime() - 60_000) / 1000)), open: "100", high: "99", low: "98", close: "101", volume: "1" }] });
      }
      if (url.includes("/ticker")) return json({ trades: [] });
      return json({ product_id: "BTC-USD", price: "100.5" });
    });

    const snapshot = await getCoinbaseMarketSnapshot({ now, fetchImpl: fetchImpl as never });

    expect(snapshot.stale).toBe(true);
    expect(snapshot.spread_bps).toBeNull();
    expect(snapshot.candles).toEqual([]);
  });

  it("preserves original timestamps when serving a stale fallback", async () => {
    const firstNow = new Date("2026-05-30T02:07:01.000Z");
    const first = await getCoinbaseMarketSnapshot({
      now: firstNow,
      fetchImpl: minimalLiveFetch(firstNow.getTime()) as never,
    });
    const second = await getCoinbaseMarketSnapshot({
      now: new Date(firstNow.getTime() + 5_000),
      fetchImpl: vi.fn(async () => { throw new Error("down"); }) as never,
    });

    expect(first.stale).toBe(false);
    expect(second.stale).toBe(true);
    expect(second.fetched_at).toBe(first.fetched_at);
    expect(second.source_timestamp).toBe(first.source_timestamp);
  });
});

function minimalLiveFetch(nowMs: number) {
  return vi.fn(async (url: string) => {
    if (url.includes("/product_book")) {
      return json({
        pricebook: {
          product_id: "BTC-USD",
          time: new Date(nowMs - 1_000).toISOString(),
          bids: [{ price: "100", size: "1" }],
          asks: [{ price: "101", size: "1" }],
        },
      });
    }
    if (url.includes("/candles")) {
      return json({ candles: [{ start: String(Math.floor((nowMs - 60_000) / 1000)), open: "100", high: "102", low: "99", close: "101", volume: "1" }] });
    }
    if (url.includes("/ticker")) return json({ trades: [] });
    return json({ product_id: "BTC-USD", price: "100.5" });
  });
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
