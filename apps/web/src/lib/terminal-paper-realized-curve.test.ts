import { describe, expect, it } from "vitest";
import { createPaperTradingState, type PaperFill, type PaperPosition } from "./paper-trading-engine";
import { deriveTerminalPaperRealizedCurve } from "./terminal-paper-realized-curve";

const T1 = "2026-08-13T12:00:01.000Z";
const T2 = "2026-08-13T12:00:02.000Z";

function fill(sequence: number, gross: number, fee = 1, filledAt = T1): PaperFill {
  return {
    fill_id: `paper-fill-${String(sequence).padStart(8, "0")}`,
    order_id: `paper-order-${String(sequence - 1).padStart(8, "0")}`,
    venue_id: "hyperliquid",
    network: "testnet",
    product: "BTC-PERP",
    side: "buy",
    base_size: 1,
    reference_price: 100,
    fill_price: 100,
    notional_usd: 100,
    fee_usd: fee,
    fee_bps: fee * 100,
    slippage_bps: 0,
    realized_pnl_gross_usd: gross,
    filled_at: filledAt,
  };
}

function position(gross: number, fees: number): PaperPosition {
  return {
    position_key: "hyperliquid:testnet:BTC-PERP",
    venue_id: "hyperliquid",
    network: "testnet",
    product: "BTC-PERP",
    quantity_base: 0,
    average_entry_price: null,
    realized_pnl_gross_usd: gross,
    fees_paid_usd: fees,
    opened_at: T1,
    updated_at: T2,
  };
}

describe("terminal PAPER realized curve", () => {
  it("orders retained fills by sequence and derives fee-net drawdown", () => {
    const result = deriveTerminalPaperRealizedCurve({
      assumptions: { starting_equity_usd: 10_000 },
      fills: [fill(4, -20, 1, T2), fill(2, 50, 1, T1)],
      positions: [position(30, 2)],
    });

    expect(result).toMatchObject({ available: true, windowTruncated: false, retainedChangeUsd: 28, currentNetUsd: 28 });
    expect(result.points.map((point) => point.cumulativeNetUsd)).toEqual([49, 28]);
    expect(result.maxDrawdownUsd).toBe(21);
    expect(result.currentDrawdownUsd).toBe(21);
    expect(result.maxDrawdownPct).toBeCloseTo(21 / 10_049 * 100);
  });

  it("anchors a capped retained window to lifetime position totals", () => {
    const result = deriveTerminalPaperRealizedCurve({
      assumptions: { starting_equity_usd: 10_000 },
      fills: [fill(4, 10, 1, T2)],
      positions: [position(109, 10)],
    });

    expect(result.openingNetUsd).toBe(90);
    expect(result.windowTruncated).toBe(true);
    expect(result.points[0]?.cumulativeNetUsd).toBe(99);
    expect(result.currentRealizedEquityUsd).toBe(10_099);
  });

  it("ranks exact lifetime venue and market contributions by absolute P&L", () => {
    const winner = position(120, 20);
    const loser = {
      ...position(-30, 10),
      position_key: "phoenix:mainnet:SOL-PERP",
      venue_id: "phoenix",
      network: "mainnet",
      product: "SOL-PERP",
    };
    const result = deriveTerminalPaperRealizedCurve({
      assumptions: { starting_equity_usd: 10_000 },
      fills: [],
      positions: [loser, winner],
    });

    expect(result.contributions).toEqual([
      expect.objectContaining({ positionKey: winner.position_key, grossRealizedUsd: 120, feesUsd: 20, netRealizedUsd: 100, absoluteSharePct: 100 / 140 * 100 }),
      expect.objectContaining({ positionKey: loser.position_key, grossRealizedUsd: -30, feesUsd: 10, netRealizedUsd: -40, absoluteSharePct: 40 / 140 * 100 }),
    ]);
    expect(result.currentNetUsd).toBe(60);
  });

  it("returns an available flat curve without retained fills", () => {
    const state = createPaperTradingState({ now: T1 });
    const result = deriveTerminalPaperRealizedCurve(state);
    expect(result).toMatchObject({ available: true, retainedFillCount: 0, currentNetUsd: 0, currentRealizedEquityUsd: 10_000, points: [], contributions: [] });
  });

  it("fails closed on chronology or arithmetic corruption", () => {
    const reversed = deriveTerminalPaperRealizedCurve({
      assumptions: { starting_equity_usd: 10_000 },
      fills: [fill(2, 1, 1, T2), fill(4, 1, 1, T1)],
      positions: [position(2, 2)],
    });
    const badFee = fill(2, 1);
    badFee.fee_usd = 2;
    const corrupt = deriveTerminalPaperRealizedCurve({
      assumptions: { starting_equity_usd: 10_000 },
      fills: [badFee],
      positions: [position(1, 1)],
    });
    expect(reversed).toMatchObject({ available: false, dataCorrupt: true });
    expect(corrupt).toMatchObject({ available: false, dataCorrupt: true });
  });
});
