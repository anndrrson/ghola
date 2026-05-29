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
            [{ px: "67999", sz: "0.4" }],
            [{ px: "68001", sz: "0.5" }],
          ],
        });
      }
      return json([
        { t: 1710000000000, o: "67000", h: "68100", l: "66900", c: "68000", v: "12" },
        { t: 1710000300000, o: "68000", h: "68200", l: "67900", c: "68100", v: "11" },
      ]);
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
    expect(snapshot.spread_bps).toBeGreaterThan(0);
    expect(snapshot.candles).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toContain("wallet_address");
    expect(JSON.stringify(snapshot)).not.toContain("api_wallet_private_key");
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
  });
});

function json(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}
