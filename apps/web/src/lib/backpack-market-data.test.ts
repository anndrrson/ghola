import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBackpackMarketSnapshot,
  resetBackpackMarketSnapshotCacheForTests,
} from "./backpack-market-data";

describe("Backpack market data", () => {
  afterEach(() => {
    resetBackpackMarketSnapshotCacheForTests();
    vi.restoreAllMocks();
  });

  it("normalizes public SOL perp depth, ticker, mark, and candles", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/depth")) {
        return json({
          bids: [["149.9", "10"], ["149.8", "8"]],
          asks: [["150.1", "11"], ["150.2", "7"]],
          timestamp: 1780106400123,
        });
      }
      if (url.includes("/ticker")) {
        return json({
          symbol: "SOL_USDC_PERP",
          firstPrice: "147",
          lastPrice: "150",
          priceChangePercent: "2.04",
          volume: "12345",
          quoteVolume: "1850000",
        });
      }
      if (url.includes("/markPrices")) {
        return json([{
          symbol: "SOL_USDC_PERP",
          fundingRate: "0.0001",
          indexPrice: "150.02",
          markPrice: "150.03",
          nextFundingTimestamp: 1780107000000,
        }]);
      }
      if (url.includes("/openInterest")) {
        return json([{ symbol: "SOL_USDC_PERP", openInterest: "999", timestamp: 1780106400123 }]);
      }
      if (url.includes("/trades")) {
        return json([{ id: 1, price: "150", quantity: "0.1", timestamp: 1780106400124, isBuyerMaker: false }]);
      }
      return json([
        { start: "1780106100", end: "1780106159", open: "149", high: "151", low: "148", close: "150", volume: "12", trades: "44" },
      ]);
    });

    const snapshot = await getBackpackMarketSnapshot({
      symbol: "SOL_USDC_PERP",
      interval: "1m",
      now: new Date("2026-05-30T02:00:01.000Z"),
      fetchImpl: fetchImpl as never,
    });

    expect(snapshot.platform).toBe("backpack");
    expect(snapshot.symbol).toBe("SOL_USDC_PERP");
    expect(snapshot.best_bid).toBe("149.9");
    expect(snapshot.best_ask).toBe("150.1");
    expect(snapshot.mid).toBe("150");
    expect(snapshot.mark_price).toBe("150.03");
    expect(snapshot.index_price).toBe("150.02");
    expect(snapshot.funding_rate).toBe("0.0001");
    expect(snapshot.open_interest).toBe("999");
    expect(snapshot.candles).toHaveLength(1);
    expect(snapshot.recent_trades[0]).toMatchObject({ side: "buy", px: "150", sz: "0.1" });
    expect(JSON.stringify(snapshot)).not.toContain("api_key");
  });
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
