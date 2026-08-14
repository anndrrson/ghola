import { describe, expect, it } from "vitest";
import type { PaperFill } from "./paper-trading-engine";
import { createPaperTradingState } from "./paper-trading-engine";
import { derivePaperStatePerformance, deriveTerminalPerformance } from "./terminal-performance";

describe("terminal performance analytics", () => {
  it("matches average-cost fills into closed long and short trades", () => {
    const metrics = deriveTerminalPerformance([
      fill("1", "buy", 2, 100, 0.2, 0, "2026-08-12T12:00:00.000Z"),
      fill("2", "sell", 1, 110, 0.11, 10, "2026-08-12T12:05:00.000Z"),
      fill("3", "sell", 2, 90, 0.18, -10, "2026-08-12T12:10:00.000Z"),
      fill("4", "buy", 1, 80, 0.08, 10, "2026-08-12T12:20:00.000Z"),
    ]);

    expect(metrics.closedTrades).toHaveLength(3);
    expect(metrics.closedTrades[0]).toMatchObject({ side: "long", quantityBase: 1, grossPnlUsd: 10 });
    expect(metrics.closedTrades[1]).toMatchObject({ side: "long", quantityBase: 1, grossPnlUsd: -10 });
    expect(metrics.closedTrades[2]).toMatchObject({ side: "short", quantityBase: 1, grossPnlUsd: 10 });
    expect(metrics.winRatePct).toBeCloseTo(2 / 3 * 100);
    expect(metrics.longestLosingStreak).toBe(1);
  });

  it("uses the engine's average entry instead of FIFO for partial closes", () => {
    const metrics = deriveTerminalPerformance([
      fill("1", "buy", 1, 100, 0, 0, "2026-08-12T12:00:00.000Z"),
      fill("2", "buy", 1, 120, 0, 0, "2026-08-12T12:01:00.000Z"),
      fill("3", "sell", 1, 115, 0, 5, "2026-08-12T12:02:00.000Z"),
    ]);

    expect(metrics.sampleStatus).toBe("validated");
    expect(metrics.closedTrades).toEqual([
      expect.objectContaining({ entryPrice: 110, exitPrice: 115, grossPnlUsd: 5, quantityBase: 1 }),
    ]);
  });

  it("derives profit factor, expectancy, payoff, and drawdown", () => {
    const metrics = deriveTerminalPerformance([
      fill("1", "buy", 1, 100, 0, 0, "2026-08-12T12:00:00.000Z"),
      fill("2", "sell", 1, 110, 0, 10, "2026-08-12T12:01:00.000Z"),
      fill("3", "buy", 1, 100, 0, 0, "2026-08-12T12:02:00.000Z"),
      fill("4", "sell", 1, 95, 0, -5, "2026-08-12T12:03:00.000Z"),
    ], { startingEquityUsd: 100 });
    expect(metrics.totalNetPnlUsd).toBe(5);
    expect(metrics.profitFactor).toBe(2);
    expect(metrics.expectancyUsd).toBe(2.5);
    expect(metrics.payoffRatio).toBe(2);
    expect(metrics.maxDrawdownUsd).toBe(5);
    expect(metrics.maxDrawdownPct).toBeCloseTo(5 / 110 * 100);
  });

  it("returns empty-safe metrics", () => {
    expect(deriveTerminalPerformance([])).toMatchObject({
      sampleStatus: "validated", closedTrades: [], totalNetPnlUsd: 0, winRatePct: null, profitFactor: null, maxDrawdownUsd: 0,
    });
    expect(derivePaperStatePerformance(createPaperTradingState({ now: "2026-08-12T12:00:00.000Z" })).closedTrades).toEqual([]);
  });

  it("fails closed instead of dropping inconsistent fills", () => {
    const badAccounting = fill("1", "buy", 1, 100, 1, 0, "2026-08-12T12:00:00.000Z");
    badAccounting.fee_usd = 2;
    expect(deriveTerminalPerformance([badAccounting])).toMatchObject({ sampleStatus: "invalid", closedTrades: [] });

    const mismatchedRealized = [
      fill("1", "buy", 1, 100, 0, 0, "2026-08-12T12:00:00.000Z"),
      fill("2", "sell", 1, 110, 0, 0, "2026-08-12T12:01:00.000Z"),
    ];
    expect(deriveTerminalPerformance(mismatchedRealized)).toMatchObject({ sampleStatus: "invalid", closedTrades: [] });
  });

  it("labels a reconciled capacity-bounded sample without calling it lifetime", () => {
    expect(deriveTerminalPerformance([], { historyAtCapacity: true })).toMatchObject({
      sampleStatus: "retained_window",
      sourceFillCount: 0,
    });
  });
});

function fill(id: string, side: "buy" | "sell", baseSize: number, price: number, fee: number, realizedGross: number, time: string): PaperFill {
  const notional = baseSize * price;
  return {
    fill_id: id,
    order_id: `order-${id}`,
    venue_id: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    side,
    base_size: baseSize,
    reference_price: price,
    fill_price: price,
    notional_usd: notional,
    fee_usd: fee,
    fee_bps: fee / notional * 10_000,
    slippage_bps: 0,
    realized_pnl_gross_usd: realizedGross,
    filled_at: time,
  };
}
