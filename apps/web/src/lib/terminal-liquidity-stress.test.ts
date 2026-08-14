import { describe, expect, it } from "vitest";
import {
  deriveTerminalLiquidityStress,
  terminalLiquidityStressCurveEqual,
  TERMINAL_LIQUIDITY_STRESS_LEVEL_LIMIT,
} from "./terminal-liquidity-stress";

describe("terminal liquidity stress", () => {
  it("sizes an aggressive buy from its entry and benchmarks it to top-book mid", () => {
    const curve = deriveTerminalLiquidityStress({
      side: "buy",
      orderNotionalUsd: 1_100,
      sizingPrice: 110,
      limitPrice: 110,
      bids: [{ px: 99, sz: 20 }],
      asks: [{ px: 101, sz: 20 }],
    });

    expect(curve).toMatchObject({ status: "ready", benchmarkPrice: 100 });
    expect(curve.currentQuality).toMatchObject({ targetBaseSize: 10, vwap: 101, impactBps: 100 });
  });

  it("uses the same adverse sign for an aggressive sell", () => {
    const curve = deriveTerminalLiquidityStress({
      side: "sell",
      orderNotionalUsd: 900,
      sizingPrice: 90,
      limitPrice: 90,
      bids: [{ px: 99, sz: 20 }],
      asks: [{ px: 101, sz: 20 }],
    });

    expect(curve.currentQuality).toMatchObject({ targetBaseSize: 10, vwap: 99, impactBps: 100 });
  });

  it("shows the first displayed-liquidity cliff and fractional unfilled notional", () => {
    const curve = deriveTerminalLiquidityStress({
      side: "buy",
      orderNotionalUsd: 1_000,
      sizingPrice: 100,
      limitPrice: 102,
      bids: [{ px: 99, sz: 20 }],
      asks: [{ px: 101, sz: 12 }],
    });

    expect(curve.visibleCapacityNotionalUsd).toBe(1_200);
    expect(curve.visibleCapacityMultiple).toBeCloseTo(1.2);
    expect(curve.firstPartialMultiplier).toBe(1.5);
    expect(curve.points.map((point) => point.quality.fillPct)).toEqual([100, 100, 100, 80, 60]);
    expect(curve.points.at(-1)?.quality.unfilledNotionalUsd).toBeCloseTo(800);
  });

  it("respects the staged limit when calculating displayed capacity", () => {
    const curve = deriveTerminalLiquidityStress({
      side: "buy",
      orderNotionalUsd: 1_000,
      sizingPrice: 100,
      limitPrice: 100.5,
      bids: [{ px: 99, sz: 20 }],
      asks: [{ px: 100.5, sz: 4 }, { px: 101, sz: 20 }],
    });

    expect(curve.visibleCapacityNotionalUsd).toBe(400);
    expect(curve.currentQuality).toMatchObject({ status: "partial", fillPct: 40 });
  });

  it.each([
    ["empty", { bids: [], asks: [{ px: 101, sz: 1 }] }, "book_unavailable"],
    ["crossed", { bids: [{ px: 102, sz: 1 }], asks: [{ px: 101, sz: 1 }] }, "book_crossed"],
    ["malformed", { bids: [{ px: 99, sz: 1 }], asks: [{ px: 101, sz: 0 }] }, "book_level_invalid"],
    ["oversized", {
      bids: Array.from({ length: TERMINAL_LIQUIDITY_STRESS_LEVEL_LIMIT + 1 }, (_, index) => ({ px: 99 - index, sz: 1 })),
      asks: [{ px: 101, sz: 1 }],
    }, "book_unavailable"],
  ])("fails closed for %s books", (_label, book, blocker) => {
    expect(deriveTerminalLiquidityStress({
      side: "buy",
      orderNotionalUsd: 100,
      sizingPrice: 100,
      ...book,
    })).toMatchObject({ status: "unavailable", blocker, points: [] });
  });

  it("does not mutate caller book arrays", () => {
    const bids = [{ px: 98, sz: 1 }, { px: 99, sz: 2 }];
    const asks = [{ px: 102, sz: 1 }, { px: 101, sz: 2 }];
    const before = JSON.stringify({ bids, asks });
    deriveTerminalLiquidityStress({ side: "buy", orderNotionalUsd: 100, sizingPrice: 100, bids, asks });
    expect(JSON.stringify({ bids, asks })).toBe(before);
  });

  it("compares equivalent curves semantically", () => {
    const input = {
      side: "buy" as const,
      orderNotionalUsd: 100,
      sizingPrice: 100,
      bids: [{ px: 99, sz: 2 }],
      asks: [{ px: 101, sz: 2 }],
    };
    expect(terminalLiquidityStressCurveEqual(
      deriveTerminalLiquidityStress(input),
      deriveTerminalLiquidityStress(input),
    )).toBe(true);
    expect(terminalLiquidityStressCurveEqual(
      deriveTerminalLiquidityStress(input),
      deriveTerminalLiquidityStress({ ...input, orderNotionalUsd: 101 }),
    )).toBe(false);
  });
});
