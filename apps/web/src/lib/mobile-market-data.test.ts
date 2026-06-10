import { describe, expect, it, vi } from "vitest";
import {
  getMobileMarketSnapshot,
  normalizeMobileMarketInput,
} from "./mobile-market-data";
import type { CoinbaseMarketSnapshot } from "./coinbase-market-data";
import type { PhoenixMarketSnapshot } from "./phoenix-market-data";

describe("mobile market data fusion", () => {
  it("normalizes product and interval input through the Coinbase allowlist", () => {
    expect(normalizeMobileMarketInput({ productId: "sol", interval: "1m" })).toEqual({
      productId: "SOL-USD",
      interval: "1m",
    });
    expect(normalizeMobileMarketInput({ productId: "DOGE", interval: "2m" })).toEqual({
      productId: "BTC-USD",
      interval: "5m",
    });
  });

  it("fuses SOL Coinbase, Phoenix, and Jupiter context", async () => {
    const snapshot = await getMobileMarketSnapshot({
      productId: "SOL-USD",
      interval: "1m",
      now: new Date("2026-06-01T12:00:00.000Z"),
      getCoinbaseSnapshot: vi.fn(async () => coinbaseSnapshot("SOL-USD")),
      getPhoenixSnapshot: vi.fn(async () => phoenixSnapshot()),
      fetchImpl: vi.fn(async () => json({
        inAmount: "1000000000",
        outAmount: "151230000",
        priceImpactPct: "0.012",
        slippageBps: 50,
        routePlan: [
          { percent: 100, swapInfo: { label: "Meteora DLMM" } },
        ],
      })) as never,
    });

    expect(snapshot.product_id).toBe("SOL-USD");
    expect(snapshot.live_status).toBe("live");
    expect(snapshot.primary.price).toBe("151.2");
    expect(snapshot.primary.candles).toHaveLength(1);
    expect(snapshot.solana_dex?.phoenix?.best_bid).toBe("151.19");
    expect(snapshot.solana_dex?.jupiter?.price).toBe("151.23");
    expect(snapshot.solana_dex?.jupiter?.route_summary).toEqual(["Meteora DLMM 100%"]);
  });

  it("keeps Coinbase data when Solana DEX sources degrade", async () => {
    const snapshot = await getMobileMarketSnapshot({
      productId: "SOL-USD",
      interval: "5m",
      now: new Date("2026-06-01T12:00:00.000Z"),
      getCoinbaseSnapshot: vi.fn(async () => coinbaseSnapshot("SOL-USD")),
      getPhoenixSnapshot: vi.fn(async () => ({ ...phoenixSnapshot(), stale: true, candles: [] })),
      fetchImpl: vi.fn(async () => new Response("bad", { status: 503 })) as never,
    });

    expect(snapshot.primary.price).toBe("151.2");
    expect(snapshot.live_status).toBe("degraded");
    expect(snapshot.warnings).toContain("phoenix_limited");
    expect(snapshot.warnings).toContain("jupiter_limited");
    expect(snapshot.solana_dex?.jupiter).toBeNull();
  });

  it("does not attach Solana DEX panels to BTC", async () => {
    const getPhoenixSnapshot = vi.fn(async () => phoenixSnapshot());
    const fetchImpl = vi.fn(async () => json({}));
    const snapshot = await getMobileMarketSnapshot({
      productId: "BTC-USD",
      interval: "5m",
      getCoinbaseSnapshot: vi.fn(async () => coinbaseSnapshot("BTC-USD")),
      getPhoenixSnapshot,
      fetchImpl: fetchImpl as never,
    });

    expect(snapshot.solana_dex).toBeNull();
    expect(getPhoenixSnapshot).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function coinbaseSnapshot(productId: "BTC-USD" | "ETH-USD" | "SOL-USD"): CoinbaseMarketSnapshot {
  const base = productId.split("-")[0] as "BTC" | "ETH" | "SOL";
  return {
    version: 1,
    platform: "coinbase",
    product_id: productId,
    base_currency_id: base,
    quote_currency_id: "USD",
    interval: "5m",
    fetched_at: "2026-06-01T12:00:00.000Z",
    source: "http",
    source_timestamp: 1780315200000,
    stale: false,
    price: productId === "BTC-USD" ? "71300" : "151.2",
    mid: productId === "BTC-USD" ? "71300" : "151.2",
    best_bid: productId === "BTC-USD" ? "71299" : "151.19",
    best_ask: productId === "BTC-USD" ? "71301" : "151.21",
    spread_bps: 0.13,
    price_percentage_change_24h: "1.2",
    volume_24h: "1000",
    approximate_quote_24h_volume: "151200",
    base_increment: "0.0001",
    quote_increment: "0.01",
    quote_min_size: "1",
    trading_disabled: false,
    product_type: "SPOT",
    candles: [{ t: 1780315200000, T: null, o: "150", h: "152", l: "149", c: "151.2", v: "10", n: null }],
    bids: [{ px: "151.19", sz: "5", n: null }],
    asks: [{ px: "151.21", sz: "4", n: null }],
    recent_trades: [],
  };
}

function phoenixSnapshot(): PhoenixMarketSnapshot {
  return {
    version: 1,
    platform: "phoenix",
    network: "mainnet",
    symbol: "SOL",
    interval: "1m",
    fetched_at: "2026-06-01T12:00:00.000Z",
    source: "http",
    source_timestamp: 1780315200000,
    book_updated_at: "2026-06-01T12:00:00.000Z",
    market_updated_at: "2026-06-01T12:00:00.000Z",
    candles_updated_at: "2026-06-01T12:00:00.000Z",
    trades_updated_at: null,
    slot: 1,
    stale: false,
    mid: "151.2",
    mark_price: "151.22",
    oracle_price: "151.18",
    best_bid: "151.19",
    best_ask: "151.21",
    spread_bps: 0.13,
    prev_day_price: "148",
    day_notional_volume: "500000",
    funding_rate: "0.001",
    open_interest: "10000",
    candles: [{ t: 1780315200000, T: null, o: "150", h: "152", l: "149", c: "151.2", v: "10", n: 1 }],
    bids: [{ px: "151.19", sz: "11" }],
    asks: [{ px: "151.21", sz: "12" }],
    recent_trades: [],
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
