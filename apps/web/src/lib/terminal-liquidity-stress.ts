import {
  simulateTerminalExecution,
  terminalExecutionQualityEqual,
  type TerminalExecutionQuality,
  type TerminalLiquidityLevel,
} from "./terminal-execution-quality";

export const TERMINAL_LIQUIDITY_STRESS_MULTIPLIERS = [0.25, 0.5, 1, 1.5, 2] as const;
export const TERMINAL_LIQUIDITY_STRESS_LEVEL_LIMIT = 20;

export type TerminalLiquidityStressBlocker =
  | "order_notional_invalid"
  | "sizing_price_invalid"
  | "book_unavailable"
  | "book_level_invalid"
  | "book_crossed";

export interface TerminalLiquidityStressPoint {
  multiplier: number;
  requestedNotionalUsd: number;
  quality: TerminalExecutionQuality;
}

export interface TerminalLiquidityStressCurve {
  status: "ready" | "unavailable";
  blocker: TerminalLiquidityStressBlocker | null;
  benchmarkPrice: number | null;
  sizingPrice: number | null;
  visibleCapacityNotionalUsd: number | null;
  visibleCapacityMultiple: number | null;
  firstPartialMultiplier: number | null;
  currentQuality: TerminalExecutionQuality;
  points: TerminalLiquidityStressPoint[];
}

export interface TerminalLiquidityStressInput {
  side: "buy" | "sell";
  orderNotionalUsd: number;
  sizingPrice: number | null;
  limitPrice?: number | null;
  bids: TerminalLiquidityLevel[];
  asks: TerminalLiquidityLevel[];
  takerFeeBps?: number;
}

const CURVE_KEYS = [
  "status",
  "blocker",
  "benchmarkPrice",
  "sizingPrice",
  "visibleCapacityNotionalUsd",
  "visibleCapacityMultiple",
  "firstPartialMultiplier",
] as const satisfies readonly (keyof TerminalLiquidityStressCurve)[];

export function terminalLiquidityStressCurveEqual(
  left: TerminalLiquidityStressCurve,
  right: TerminalLiquidityStressCurve,
) {
  if (left === right) return true;
  return CURVE_KEYS.every((key) => Object.is(left[key], right[key]))
    && terminalExecutionQualityEqual(left.currentQuality, right.currentQuality)
    && left.points.length === right.points.length
    && left.points.every((point, index) => {
      const candidate = right.points[index];
      return candidate != null
        && point.multiplier === candidate.multiplier
        && point.requestedNotionalUsd === candidate.requestedNotionalUsd
        && terminalExecutionQualityEqual(point.quality, candidate.quality);
    });
}

/**
 * Builds a bounded visible-book size curve. Order quantity is sized from the
 * staged entry while every point is benchmarked to the certified top-book mid.
 */
export function deriveTerminalLiquidityStress(
  input: TerminalLiquidityStressInput,
): TerminalLiquidityStressCurve {
  const orderNotionalUsd = positive(input.orderNotionalUsd);
  if (orderNotionalUsd == null) return unavailable("order_notional_invalid");
  const sizingPrice = positive(input.sizingPrice);
  if (sizingPrice == null) return unavailable("sizing_price_invalid");
  if (
    input.bids.length === 0
    || input.asks.length === 0
    || input.bids.length > TERMINAL_LIQUIDITY_STRESS_LEVEL_LIMIT
    || input.asks.length > TERMINAL_LIQUIDITY_STRESS_LEVEL_LIMIT
  ) return unavailable("book_unavailable");
  if (!input.bids.every(validLevel) || !input.asks.every(validLevel)) {
    return unavailable("book_level_invalid");
  }

  const bestBid = Math.max(...input.bids.map((level) => Number(level.px)));
  const bestAsk = Math.min(...input.asks.map((level) => Number(level.px)));
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid >= bestAsk) {
    return unavailable("book_crossed");
  }
  const benchmarkPrice = (bestBid + bestAsk) / 2;
  const targetBaseSize = orderNotionalUsd / sizingPrice;
  const levels = input.side === "buy" ? input.asks : input.bids;
  const limitPrice = positive(input.limitPrice);
  const points = TERMINAL_LIQUIDITY_STRESS_MULTIPLIERS.map((multiplier) => ({
    multiplier,
    requestedNotionalUsd: orderNotionalUsd * multiplier,
    quality: simulateTerminalExecution({
      side: input.side,
      orderNotionalUsd: orderNotionalUsd * multiplier,
      referencePrice: benchmarkPrice,
      targetBaseSize: targetBaseSize * multiplier,
      limitPrice,
      levels,
      takerFeeBps: input.takerFeeBps,
    }),
  }));
  const eligibleBaseSize = levels.reduce((sum, level) => {
    const price = Number(level.px);
    const eligible = limitPrice == null
      || (input.side === "buy" ? price <= limitPrice : price >= limitPrice);
    return eligible ? sum + Number(level.sz) : sum;
  }, 0);
  const visibleCapacityNotionalUsd = eligibleBaseSize * sizingPrice;
  const visibleCapacityMultiple = visibleCapacityNotionalUsd / orderNotionalUsd;
  const firstPartialMultiplier = points.find((point) => point.quality.status !== "full")?.multiplier ?? null;
  const currentQuality = points.find((point) => point.multiplier === 1)?.quality
    ?? unavailableQuality();

  return {
    status: "ready",
    blocker: null,
    benchmarkPrice,
    sizingPrice,
    visibleCapacityNotionalUsd,
    visibleCapacityMultiple,
    firstPartialMultiplier,
    currentQuality,
    points,
  };
}

function unavailable(blocker: TerminalLiquidityStressBlocker): TerminalLiquidityStressCurve {
  return {
    status: "unavailable",
    blocker,
    benchmarkPrice: null,
    sizingPrice: null,
    visibleCapacityNotionalUsd: null,
    visibleCapacityMultiple: null,
    firstPartialMultiplier: null,
    currentQuality: unavailableQuality(),
    points: [],
  };
}

function unavailableQuality() {
  return simulateTerminalExecution({
    side: "buy",
    orderNotionalUsd: 1,
    referencePrice: null,
    levels: [],
  });
}

function validLevel(level: TerminalLiquidityLevel) {
  return positive(level.px) != null && positive(level.sz) != null;
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
