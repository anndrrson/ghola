import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCoinbaseMarketSnapshot,
  normalizeCoinbaseCandles,
  normalizeCoinbaseMarketInput,
  resetCoinbaseMarketSnapshotCacheForTests,
  selectCoinbaseDisplayPrice,
  spreadBps,
  validatedBookMid,
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

  it("calculates exchange midpoints without floating-point artifacts", () => {
    expect(validatedBookMid("72.89", "72.90")).toBe("72.895");
    expect(validatedBookMid("68100", "68101")).toBe("68100.5");
    expect(validatedBookMid("102", "100")).toBeNull();
  });

  it("rejects crossed books instead of presenting a fabricated zero spread", () => {
    expect(spreadBps("73.08", "73.09")).toBe(1.37);
    expect(spreadBps("73.10", "73.09")).toBeNull();
  });

  it("builds a public spot snapshot without account data", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
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
    expect(snapshot.product_id).toBe("BTC-USD");
    expect(snapshot.price).toBe("73580.35");
    expect(snapshot.mid).toBe("73580.5");
    expect(snapshot.best_bid).toBe("73580");
    expect(snapshot.best_ask).toBe("73581");
    expect(snapshot.spread_bps).toBe(0.13);
    expect(snapshot.price_percentage_change_24h).toBe("0.12314625761245");
    expect(snapshot.approximate_quote_24h_volume).toBe("678061410.96");
    expect(snapshot.bids).toHaveLength(20);
    expect(snapshot.asks).toHaveLength(20);
    expect(snapshot.candles.map((candle) => candle.t)).toEqual([1780106100000, 1780106400000]);
    expect(snapshot.recent_trades[0]).toMatchObject({ side: "sell", px: "73594.11", sz: "0.00041044" });
    expect(JSON.stringify(snapshot)).not.toContain("api_key");
    expect(JSON.stringify(snapshot)).not.toContain("wallet_address");
  });

  it("preserves source age when every refresh dependency fails", async () => {
    const firstAt = new Date("2026-05-30T02:07:01.000Z");
    const initial = await getCoinbaseMarketSnapshot({
      productId: "SOL-USD",
      interval: "5m",
      now: firstAt,
      fetchImpl: successfulMarketFetch as never,
    });
    const failedAt = new Date("2026-05-30T02:07:06.000Z");
    const failed = await getCoinbaseMarketSnapshot({
      productId: "SOL-USD",
      interval: "5m",
      now: failedAt,
      fetchImpl: vi.fn(async () => { throw new Error("network down"); }) as never,
      cacheMode: "refresh",
    });

    expect(failed.stale).toBe(true);
    expect(failed.fetched_at).toBe(initial.fetched_at);
    expect(failed.request_completed_at).toBe(failedAt.toISOString());
    expect(failed.last_error_at).toBe(failedAt.toISOString());
    expect(failed.book_mid).toBe(initial.book_mid);
  });

  it("serves an expired trustworthy snapshot immediately while one refresh runs", async () => {
    const firstAt = new Date("2026-05-30T02:07:01.000Z");
    const initial = await getCoinbaseMarketSnapshot({
      productId: "BTC-USD",
      interval: "1m",
      now: firstAt,
      fetchImpl: successfulMarketFetch as never,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowFetch = vi.fn(async (url: string) => {
      await gate;
      return successfulMarketFetch(url);
    });
    const staleAt = new Date(firstAt.getTime() + 5_000);
    const first = await getCoinbaseMarketSnapshot({ productId: "BTC-USD", interval: "1m", now: staleAt, fetchImpl: slowFetch as never });
    const second = await getCoinbaseMarketSnapshot({ productId: "BTC-USD", interval: "1m", now: staleAt, fetchImpl: slowFetch as never });

    expect(first).toMatchObject({ mid: initial.mid, stale: true });
    expect(second).toMatchObject({ mid: initial.mid, stale: true });
    expect(slowFetch).toHaveBeenCalledTimes(4);
    release();
    await getCoinbaseMarketSnapshot({ productId: "BTC-USD", interval: "1m", now: staleAt, fetchImpl: slowFetch as never, cacheMode: "refresh" });
  });

  it("selects a fresh book midpoint before last trade and reports delayed fallback", () => {
    const now = Date.parse("2026-05-30T02:07:10.000Z");
    const snapshot = {
      ...emptySnapshotForSelection(now),
      book_mid: "101",
      mid: "101",
      book_updated_at: now - 1_000,
      last_trade_price: "100.5",
      price: "100.5",
      last_trade_updated_at: now - 2_000,
    };
    expect(selectCoinbaseDisplayPrice(snapshot, now)).toMatchObject({ value: "101", kind: "book_mid", stale: false });
    expect(selectCoinbaseDisplayPrice({ ...snapshot, book_updated_at: now - 11_000 }, now)).toMatchObject({
      value: "100.5",
      kind: "last_trade",
      stale: false,
    });
    expect(selectCoinbaseDisplayPrice({ ...snapshot, book_updated_at: now - 11_000, last_trade_updated_at: now - 16_000 }, now)).toMatchObject({
      value: "100.5",
      kind: "last_trade",
      stale: true,
    });
  });
});

async function successfulMarketFetch(url: string) {
  if (url.includes("/product_book")) return json({ pricebook: { time: "2026-05-30T02:07:01.000Z", bids: [{ price: "100", size: "1" }], asks: [{ price: "102", size: "1" }] } });
  if (url.includes("/candles")) return json({ candles: [{ start: "1780106400", low: "99", high: "103", open: "100", close: "101", volume: "1" }] });
  if (url.includes("/ticker")) return json({ trades: [{ trade_id: "1", product_id: "SOL-USD", price: "100.5", size: "1", time: "2026-05-30T02:07:01.000Z", side: "BUY" }] });
  return json({ product_id: "SOL-USD", price: "100.5", quote_increment: "0.01" });
}

function emptySnapshotForSelection(now: number) {
  return {
    version: 1 as const,
    platform: "coinbase" as const,
    product_id: "BTC-USD" as const,
    base_currency_id: "BTC" as const,
    quote_currency_id: "USD" as const,
    interval: "5m" as const,
    fetched_at: new Date(now).toISOString(), request_completed_at: new Date(now).toISOString(),
    source: "http" as const, source_timestamp: now, stale: false, last_error_at: null,
    last_trade_price: null, book_mid: null, last_trade_updated_at: null, book_updated_at: null,
    candle_updated_at: null, last_heartbeat_at: null, price: null, mid: null, best_bid: null, best_ask: null,
    spread_bps: null, price_percentage_change_24h: null, volume_24h: null, approximate_quote_24h_volume: null,
    base_increment: null, quote_increment: null, quote_min_size: null, trading_disabled: false, product_type: null,
    candles: [], bids: [], asks: [], recent_trades: [],
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
