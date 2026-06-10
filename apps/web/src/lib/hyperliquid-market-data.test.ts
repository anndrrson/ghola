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
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.type === "allMids") return json({ BTC: "68000.5" });
      if (body.type === "l2Book") {
        return json({
          time: 1710000000000,
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
        t: 1710000000000 + index * 300_000,
        T: 1710000299999 + index * 300_000,
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
      now: new Date("2026-05-29T00:00:00Z"),
      fetchImpl: fetchImpl as never,
    });

    expect(snapshot.platform).toBe("hyperliquid");
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
    expect(snapshot.premium).toBe("-0.0001");
    expect(snapshot.max_leverage).toBe(40);
    expect(snapshot.candles).toHaveLength(240);
    expect(snapshot.candles[0]).toMatchObject({
      t: 1710000000000 + 20 * 300_000,
      T: 1710000299999 + 20 * 300_000,
      n: 100,
    });
    expect(snapshot.recent_trades).toHaveLength(20);
    expect(snapshot.recent_trades[0]).toEqual({ side: "buy", px: "68000", sz: "0.01", time: 1710000300000 });
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
});

function json(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}
