import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getHyperliquidMarketSnapshot,
  resetHyperliquidMarketSnapshotCacheForTests,
} from "./hyperliquid-market-data";

describe("Hyperliquid market data", () => {
  afterEach(() => {
    resetHyperliquidMarketSnapshotCacheForTests();
    vi.restoreAllMocks();
  });

  it("normalizes public mids, candles, and book levels", async () => {
    const now = new Date("2026-05-29T00:00:00Z");
    const candleStart = now.getTime() - 260 * 300_000;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.type === "allMids") return json({ BTC: "68000.5" });
      if (body.type === "l2Book") {
        return json({
          time: now.getTime() - 1_000,
          levels: [
            Array.from({ length: 25 }, (_, index) => ({
              px: String(67999 - index),
              sz: String(0.4 + index / 10),
              n: index + 1,
            })),
            Array.from({ length: 25 }, (_, index) => ({
              px: String(68001 + index),
              sz: String(0.5 + index / 10),
              n: index + 2,
            })),
          ],
        });
      }
      if (body.type === "metaAndAssetCtxs") {
        return json([
          {
            universe: [
              { name: "BTC", maxLeverage: 40 },
              { name: "ETH", maxLeverage: 25 },
            ],
          },
          [
            {
              funding: "0.0000125",
              openInterest: "123.45",
              prevDayPx: "66000",
              dayNtlVlm: "1000000",
              premium: "-0.0001",
              oraclePx: "68002",
              markPx: "68001",
              dayBaseVlm: "14.7",
            },
            {},
          ],
        ]);
      }
      if (body.type === "recentTrades") {
        return json(Array.from({ length: 22 }, (_, index) => ({
            coin: "BTC",
            side: index % 2 === 0 ? "B" : "A",
            px: String(68000 + index),
            sz: "0.01",
            time: 1710000300000 + index,
            hash: "0xdeadbeef",
            users: ["0xabc", "0xdef"],
          })));
      }
      return json(Array.from({ length: 260 }, (_, index) => ({
        t: candleStart + index * 300_000,
        T: candleStart + (index + 1) * 300_000 - 1,
        o: String(67000 + index),
        h: String(68100 + index),
        l: String(66900 + index),
        c: String(68000 + index),
        v: String(12 + index),
        n: 80 + index,
      })));
    });

    const snapshot = await getHyperliquidMarketSnapshot({
      network: "mainnet",
      coin: "BTC",
      interval: "5m",
      now,
      fetchImpl: fetchImpl as never,
    });

    expect(snapshot.platform).toBe("hyperliquid");
    expect(snapshot.stale).toBe(false);
    expect(snapshot.mid).toBe("68000.5");
    expect(snapshot.best_bid).toBe("67999");
    expect(snapshot.best_ask).toBe("68001");
    expect(snapshot.bids).toHaveLength(20);
    expect(snapshot.asks).toHaveLength(20);
    expect(snapshot.bids[0]?.n).toBe(1);
    expect(snapshot.asks[0]?.n).toBe(2);
    expect(snapshot.spread_bps).toBeGreaterThan(0);
    expect(snapshot.mark_price).toBe("68001");
    expect(snapshot.oracle_price).toBe("68002");
    expect(snapshot.day_notional_volume).toBe("1000000");
    expect(snapshot.open_interest).toBe("123.45");
    expect(snapshot.funding_rate).toBe("0.0000125");
    expect(snapshot).toMatchObject({
      funding_rate_unit: "decimal_fraction",
      funding_rate_source: "hyperliquid_rest_asset_context_received",
      funding_time_basis: "received_at",
      funding_updated_at: now.toISOString(),
    });
    expect(snapshot.premium).toBe("-0.0001");
    expect(snapshot.max_leverage).toBe(40);
    expect(snapshot.candles).toHaveLength(240);
    expect(snapshot.candles[0]).toMatchObject({
      t: candleStart + 20 * 300_000,
      T: candleStart + 21 * 300_000 - 1,
      n: 100,
    });
    expect(snapshot.recent_trades).toHaveLength(20);
    expect(snapshot.recent_trades[0]).toEqual({ side: "sell", px: "68021", sz: "0.01", time: 1710000300021 });
    expect(snapshot.recent_trades.at(-1)).toEqual({ side: "buy", px: "68002", sz: "0.01", time: 1710000300002 });
    expect(JSON.stringify(snapshot)).not.toContain("wallet_address");
    expect(JSON.stringify(snapshot)).not.toContain("api_wallet_private_key");
    expect(JSON.stringify(snapshot)).not.toContain("0xabc");
    expect(JSON.stringify(snapshot)).not.toContain("0xdeadbeef");
  });

  it("returns stale empty data when the public Info API is unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });

    const snapshot = await getHyperliquidMarketSnapshot({
      network: "mainnet",
      coin: "ETH",
      interval: "1m",
      now: new Date("2026-05-29T00:00:00Z"),
      fetchImpl: fetchImpl as never,
    });

    expect(snapshot.stale).toBe(true);
    expect(snapshot.coin).toBe("ETH");
    expect(snapshot.candles).toEqual([]);
    expect(snapshot.recent_trades).toEqual([]);
  });

  it("never marks empty successful responses live", async () => {
    const snapshot = await getHyperliquidMarketSnapshot({
      now: new Date("2026-05-29T00:00:00Z"),
      fetchImpl: vi.fn(async () => json({})) as never,
    });

    expect(snapshot.stale).toBe(true);
    expect(snapshot.source_timestamp).toBeNull();
    expect(snapshot.bids).toEqual([]);
    expect(snapshot.candles).toEqual([]);
  });

  it("rejects crossed books, invalid OHLC, and aged source data", async () => {
    const now = new Date("2026-05-29T00:00:00Z");
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.type === "allMids") return json({ BTC: "100.5" });
      if (body.type === "l2Book") {
        return json({ time: now.getTime() - 10 * 60_000, levels: [[{ px: "101", sz: "1" }], [{ px: "100", sz: "1" }]] });
      }
      if (body.type === "candleSnapshot") {
        return json([{ t: now.getTime() - 60_000, T: now.getTime() - 1, o: "100", h: "99", l: "98", c: "101", v: "1" }]);
      }
      return json([]);
    });

    const snapshot = await getHyperliquidMarketSnapshot({ now, fetchImpl: fetchImpl as never });

    expect(snapshot.stale).toBe(true);
    expect(snapshot.spread_bps).toBeNull();
    expect(snapshot.candles).toEqual([]);
  });

  it("preserves original timestamps when serving a stale fallback", async () => {
    const firstNow = new Date("2026-05-29T00:00:00Z");
    const first = await getHyperliquidMarketSnapshot({
      now: firstNow,
      fetchImpl: minimalLiveFetch(firstNow.getTime()) as never,
    });
    const second = await getHyperliquidMarketSnapshot({
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
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.type === "allMids") return json({ BTC: "100.5" });
    if (body.type === "l2Book") {
      return json({ time: nowMs - 1_000, levels: [[{ px: "100", sz: "1" }], [{ px: "101", sz: "1" }]] });
    }
    if (body.type === "candleSnapshot") {
      return json([{ t: nowMs - 60_000, T: nowMs - 1, o: "100", h: "102", l: "99", c: "101", v: "1" }]);
    }
    return json([]);
  });
}

function json(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}
