import { describe, expect, it } from "vitest";
import {
  buildGholaAgentChartOverlays,
  buildGholaExecutableRPlanOverlays,
  decimateCandles,
  FixedRingBuffer,
  GholaChartStore,
  gholaFrameFromHyperliquid,
  gholaFrameFromJupiter,
  gholaReplaySelectionMatches,
  type GholaChartCandle,
} from "./ghola-market-chart";
import type { MobileMarketJupiter } from "./mobile-market-data";
import type { HyperliquidMarketSnapshot } from "./private-account-client";
import type { PrivateExecutionOrderDraft } from "./private-execution-instruction-seal";

describe("ghola market chart model", () => {
  it("invalidates replay when an otherwise identical market changes network identity", () => {
    const source = gholaFrameFromHyperliquid(hyperliquidSnapshot());
    expect(gholaReplaySelectionMatches(source, source, "hyperliquid:mainnet:BTC:5m", "hyperliquid:mainnet:BTC:5m", "candles")).toBe(true);
    expect(gholaReplaySelectionMatches(source, source, "hyperliquid:mainnet:BTC:5m", "hyperliquid:testnet:BTC:5m", "candles")).toBe(false);
  });

  it("normalizes Hyperliquid snapshots into the shared frame", () => {
    const frame = gholaFrameFromHyperliquid(hyperliquidSnapshot());

    expect(frame).toMatchObject({
      version: 1,
      venue: "hyperliquid",
      network: "mainnet",
      product: "BTC",
      interval: "5m",
      mid: "67120.5",
      markPrice: "67119.8",
      oraclePrice: "67125.1",
      fundingRate: "0.000012",
      fundingRateUnit: "decimal_fraction",
      fundingRateSource: "hyperliquid_ws_active_asset_context_received",
      fundingRateTimeBasis: "received_at",
      fundingRateUpdatedAt: "2026-06-03T12:00:00.000Z",
      openInterest: "2000000000",
      dayVolume: "6200000000",
    });
    expect(frame?.candles).toHaveLength(3);
    expect(frame?.candles[0]).toMatchObject({ t: 1_780_000_000_000, o: "67000", c: "67050", n: 11 });
    expect(frame?.bids[0]).toEqual({ px: "67120", sz: "1.5", n: 4 });
    expect(frame?.asks[0]).toEqual({ px: "67121", sz: "1.1", n: 3 });
    expect(frame?.trades[0]).toEqual({ side: "buy", px: "67120.5", sz: "0.01", time: 1_780_000_120_000 });
  });

  it("keeps bounded rolling buffers and exposes the latest item", () => {
    const buffer = new FixedRingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);

    expect(buffer.toArray()).toEqual([2, 3, 4]);
    expect(buffer.last()).toBe(4);
    expect(buffer.length).toBe(3);
  });

  it("accumulates Jupiter quote samples without pretending they are candles", () => {
    const store = new GholaChartStore();
    store.ingest(gholaFrameFromJupiter(jupiterQuote("2026-06-03T12:00:00.000Z", "169.90")));
    store.ingest(gholaFrameFromJupiter(jupiterQuote("2026-06-03T12:00:01.000Z", "170.10")));
    store.ingest(gholaFrameFromJupiter(jupiterQuote("2026-06-03T12:00:01.000Z", "170.10")));

    const frame = store.frame();
    expect(frame?.venue).toBe("jupiter");
    expect(frame?.candles).toEqual([]);
    expect(frame?.bids).toEqual([]);
    expect(frame?.routeQuotes.map((quote) => quote.price)).toEqual(["169.90", "170.10"]);
  });

  it("clears rolling buffers when only network identity changes", () => {
    const store = new GholaChartStore();
    const first = gholaFrameFromJupiter(jupiterQuote("2026-06-03T12:00:00.000Z", "169.90"));
    const second = gholaFrameFromJupiter(jupiterQuote("2026-06-03T12:00:01.000Z", "170.10"));
    if (!first || !second) throw new Error("expected normalized quote frames");

    store.ingest(first);
    store.ingest({ ...second, network: "testnet" });

    expect(store.frame()?.routeQuotes.map((quote) => quote.price)).toEqual(["170.10"]);
  });

  it("retains unchanged collection snapshots across quote-only frames", () => {
    const store = new GholaChartStore();
    const firstInput = gholaFrameFromHyperliquid(hyperliquidSnapshot());
    if (!firstInput) throw new Error("expected normalized market frame");
    store.ingest(firstInput);
    const first = store.frame();

    store.ingest({
      ...firstInput,
      fetchedAt: "2026-06-03T12:00:01.000Z",
      mid: "67121",
      bestBid: "67120.5",
      bestAsk: "67121.5",
    });
    const next = store.frame();

    expect(next).not.toBe(first);
    expect(next?.mid).toBe("67121");
    expect(next?.candles).toBe(first?.candles);
    expect(next?.bids).toBe(first?.bids);
    expect(next?.asks).toBe(first?.asks);
    expect(next?.trades).toBe(first?.trades);
  });

  it("decimates large candle ranges while keeping important extremes and the latest candle", () => {
    const candles = Array.from({ length: 12 }, (_, index) =>
      candle(index, String(100 + index), String(100 + index + 1), String(99 + index), String(100 + index)),
    );
    candles[2] = candle(2, "101", "250", "100", "110");
    candles[6] = candle(6, "106", "107", "40", "90");
    candles[11] = candle(11, "111", "112", "110", "111.5");

    const decimated = decimateCandles(candles, 6);

    expect(decimated).toHaveLength(6);
    expect(decimated.some((item) => item.h === "250")).toBe(true);
    expect(decimated.some((item) => item.l === "40")).toBe(true);
    expect(decimated.at(-1)?.t).toBe(candles.at(-1)?.t);
  });

  it("builds agent overlays for entry, slippage, visibility, preview, and receipt evidence", () => {
    const overlays = buildGholaAgentChartOverlays({
      order: orderDraft(),
      mid: "100",
      previewCommitment: "preview_commitment",
      receiptCommitment: "receipt_commitment",
      accountReady: true,
      venueLabel: "Hyperliquid",
    });

    expect(overlays.map((overlay) => overlay.id)).toEqual([
      "agent-slippage-band",
      "agent-entry",
      "agent-guard",
      "preview",
      "receipt",
    ]);
    expect(overlays[0]).toMatchObject({
      kind: "price_band",
      label: "Slippage band",
      price: 100,
      side: "buy",
      status: "previewed",
    });
    expect(overlays[0].priceEnd).toBeCloseTo(100.5);
    expect(overlays.find((overlay) => overlay.id === "agent-entry")?.label).toBe("Entry");
    expect(overlays.find((overlay) => overlay.id === "agent-guard")?.label).toBe("Slippage cap 50 bps");
    expect(overlays.find((overlay) => overlay.label === "Scout target")).toBeUndefined();
    expect(overlays.find((overlay) => overlay.label === "Venue sees")).toBeUndefined();
    expect(overlays.find((overlay) => overlay.id === "receipt")?.kind).toBe("receipt");
  });

  it("adds strategy condition and range levels to the chart overlays", () => {
    const overlays = buildGholaAgentChartOverlays({
      order: {
        ...orderDraft(),
        agent_trigger_level: "101",
        agent_range_low: "95",
        agent_range_high: "105",
      },
      mid: "100",
      previewCommitment: null,
      receiptCommitment: null,
      accountReady: false,
      venueLabel: "Hyperliquid",
    });

    expect(overlays.map((overlay) => overlay.id)).toEqual([
      "agent-slippage-band",
      "agent-entry",
      "agent-guard",
      "agent-condition-level",
      "agent-range-low",
      "agent-range-high",
    ]);
    expect(overlays.find((overlay) => overlay.id === "agent-condition-level")).toMatchObject({
      kind: "price_line",
      label: "Condition level",
      price: 101,
      status: "access needed",
    });
    expect(overlays.find((overlay) => overlay.id === "agent-range-low")?.label).toBe("Range low");
    expect(overlays.find((overlay) => overlay.id === "agent-range-high")?.label).toBe("Range high");
  });

  it("builds an executable R plan with only entry and invalidation draggable", () => {
    const overlays = buildGholaExecutableRPlanOverlays({
      side: "buy",
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      targetRewardMultiple: 2,
      entryPinned: true,
      stopPinned: false,
      stopValid: true,
    });

    expect(overlays.map((overlay) => overlay.id)).toEqual([
      "trade-plan-risk-band",
      "trade-plan-target",
      "trade-plan-entry",
      "trade-plan-invalidation",
    ]);
    expect(overlays[0]).toMatchObject({ kind: "price_band", price: 95, priceEnd: 100 });
    expect(overlays[1]).toMatchObject({ label: "2.0R target · plan", price: 110 });
    expect(overlays[1].interaction).toBeUndefined();
    expect(overlays[2].interaction?.kind).toBe("drag_price");
    expect(overlays[3].interaction?.kind).toBe("drag_price");
    const invalidOverlays = buildGholaExecutableRPlanOverlays({
      side: "buy",
      entryPrice: 100,
      stopPrice: 105,
      targetPrice: 90,
      targetRewardMultiple: 2,
      entryPinned: false,
      stopPinned: true,
      stopValid: false,
    });
    expect(invalidOverlays.map((overlay) => overlay.id)).toEqual([
      "trade-plan-entry",
      "trade-plan-invalidation",
    ]);
  });

});

function hyperliquidSnapshot(): HyperliquidMarketSnapshot {
  return {
    version: 1,
    platform: "hyperliquid",
    network: "mainnet",
    coin: "BTC",
    interval: "5m",
    fetched_at: "2026-06-03T12:00:00.000Z",
    source_timestamp: 1_780_000_120_000,
    stale: false,
    mid: "67120.5",
    best_bid: "67120",
    best_ask: "67121",
    spread_bps: 0.15,
    mark_price: "67119.8",
    oracle_price: "67125.1",
    prev_day_price: "70400",
    day_notional_volume: "6200000000",
    day_base_volume: "92500",
    open_interest: "2000000000",
    funding_rate: "0.000012",
    funding_rate_unit: "decimal_fraction",
    funding_rate_source: "hyperliquid_ws_active_asset_context_received",
    funding_time_basis: "received_at",
    funding_updated_at: "2026-06-03T12:00:00.000Z",
    premium: "0.0001",
    max_leverage: 50,
    candles: [
      candle(0, "67000", "67100", "66900", "67050", 11),
      candle(1, "67050", "67200", "67000", "67120", 12),
      candle(2, "67120", "67140", "67100", "67120.5", 13),
    ],
    bids: [{ px: "67120", sz: "1.5", n: 4 }],
    asks: [{ px: "67121", sz: "1.1", n: 3 }],
    recent_trades: [{ side: "buy", px: "67120.5", sz: "0.01", time: 1_780_000_120_000 }],
  };
}

function jupiterQuote(fetchedAt: string, price: string): MobileMarketJupiter {
  return {
    platform: "jupiter",
    input_mint: "So11111111111111111111111111111111111111112",
    output_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    input_amount: "1",
    output_amount: "170",
    price,
    price_impact_pct: "0.02",
    slippage_bps: 50,
    route_summary: ["Orca", "Raydium"],
    fetched_at: fetchedAt,
    stale: false,
  };
}

function candle(
  index: number,
  open: string,
  high: string,
  low: string,
  close: string,
  trades = 1,
): GholaChartCandle {
  const t = 1_780_000_000_000 + index * 300_000;
  return {
    t,
    T: t + 299_999,
    o: open,
    h: high,
    l: low,
    c: close,
    v: String(10 + index),
    n: trades,
  };
}

function orderDraft(): PrivateExecutionOrderDraft {
  return {
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    market: "BTC",
    side: "buy",
    base_size: "",
    quote_size: "5",
    limit_price: "100",
    max_slippage_bps: "50",
    order_type: "limit",
    size_mode: "quote",
    tif: "Gtc",
  };
}
