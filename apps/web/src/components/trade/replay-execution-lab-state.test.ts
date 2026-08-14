import { describe, expect, it } from "vitest";
import type { GholaMarketFrame } from "@/lib/ghola-market-chart";
import { createReplaySession, submitReplayOrder } from "@/lib/terminal-replay-session";
import {
  boundedReplaySyncTarget,
  defaultReplayOrderDraft,
  replayOrderInputFromDraft,
  replaySourceFromFrame,
  syncReplaySessionCursor,
} from "./replay-execution-lab-state";

describe("Replay Execution Lab state", () => {
  it("bounds large forward cursor work while allowing immediate backward seeks", () => {
    expect(boundedReplaySyncTarget(10, 100_000)).toBe(138);
    expect(boundedReplaySyncTarget(10, 100_000, 256)).toBe(266);
    expect(boundedReplaySyncTarget(500, 12, 256)).toBe(12);
  });

  it("creates a normalized immutable source from the chart snapshot", () => {
    const frame = replayFrame();
    const source = replaySourceFromFrame(frame);

    expect(source.source_id).toContain("ghola-chart:hyperliquid:BTC-PERP:5m");
    expect(source.instrument).toEqual({ venue: "hyperliquid", product: "BTC-PERP", interval: "5m" });
    expect(source.candles[1]).toMatchObject({ o: 100, h: 103, l: 99, c: 102 });
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.candles)).toBe(true);
  });

  it("advances exactly to the chart cursor and fills only on the next bar", () => {
    const source = replaySourceFromFrame(replayFrame());
    let state = createReplaySession(source, { cursor: 0, assumptions: { fee_bps: 0, slippage_bps: 0 } });
    state = submitReplayOrder(state, source, { type: "market", side: "buy", size: 1 });

    expect(syncReplaySessionCursor(state, source, 0)).toMatchObject({ state, event: "none" });
    const advanced = syncReplaySessionCursor(state, source, 1);
    expect(advanced.event).toBe("advanced");
    expect(advanced.state.cursor).toBe(1);
    expect(advanced.state.fills[0]).toMatchObject({ bar_cursor: 1, reference_price: 100 });
  });

  it("seeks backward before trading and cleanly forks backward after trading", () => {
    const source = replaySourceFromFrame(replayFrame());
    const clean = createReplaySession(source, { cursor: 2 });
    const sought = syncReplaySessionCursor(clean, source, 1);
    expect(sought).toMatchObject({ event: "seeked", state: { cursor: 1, orders: [] } });

    const placed = submitReplayOrder(sought.state, source, { type: "limit", side: "buy", size: 1, limit_price: 50 });
    const forked = syncReplaySessionCursor(placed, source, 0);
    expect(forked).toMatchObject({ event: "forked", state: { cursor: 0, orders: [], fills: [], journal: [] } });
  });

  it("maps all ticket fields and rejects unsafe OCO combinations", () => {
    const draft = {
      ...defaultReplayOrderDraft(100),
      type: "stop_limit" as const,
      side: "buy" as const,
      size: "2.5",
      limitPrice: "103",
      stopPrice: "102",
      attachOco: true,
      ocoStopPrice: "95",
      ocoTargetPrice: "110",
      riskUsd: "12",
    };
    expect(replayOrderInputFromDraft(draft)).toEqual({
      type: "stop_limit",
      side: "buy",
      size: 2.5,
      limit_price: 103,
      stop_price: 102,
      reduce_only: false,
      attached_oco: { stop_price: 95, target_price: 110 },
      risk_usd: 12,
    });
    expect(() => replayOrderInputFromDraft({ ...draft, reduceOnly: true })).toThrow(
      "Reduce-only orders cannot open an attached OCO.",
    );
    expect(() => replayOrderInputFromDraft({ ...draft, ocoStopPrice: "120" })).toThrow(
      "A buy OCO stop must be below its target.",
    );
  });
});

function replayFrame(): GholaMarketFrame {
  return {
    version: 1,
    venue: "hyperliquid",
    product: "BTC-PERP",
    interval: "5m",
    fetchedAt: "2026-01-01T00:15:00.000Z",
    stale: false,
    mid: "104",
    bestBid: "103.9",
    bestAsk: "104.1",
    spreadBps: 2,
    markPrice: "104",
    oraclePrice: "104",
    fundingRate: "0",
    openInterest: "1000",
    dayVolume: "10000",
    candles: [
      candle(0, 100, 101, 99, 100),
      candle(1, 100, 103, 99, 102),
      candle(2, 102, 105, 101, 104),
      candle(3, 104, 106, 103, 105),
    ],
    bids: [],
    asks: [],
    trades: [],
    routeQuotes: [],
  };
}

function candle(index: number, o: number, h: number, l: number, c: number) {
  const t = 1_767_225_600_000 + index * 300_000;
  return { t, T: t + 299_999, o: String(o), h: String(h), l: String(l), c: String(c), v: "10", n: 1 };
}
