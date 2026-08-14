export interface TerminalLiquidityLevel {
  px: string | number;
  sz: string | number;
}

export interface TerminalExecutionQualityInput {
  side: "buy" | "sell";
  orderNotionalUsd: number;
  /** Market arrival benchmark used only for impact and cost attribution. */
  referencePrice: number | null;
  /** Exact order quantity. Omit only when sizing from the market benchmark. */
  targetBaseSize?: number | null;
  levels: TerminalLiquidityLevel[];
  limitPrice?: number | null;
  takerFeeBps?: number;
}

export interface TerminalExecutionQuality {
  status: "no_market" | "none" | "partial" | "full";
  targetBaseSize: number | null;
  filledBaseSize: number;
  filledNotionalUsd: number;
  unfilledNotionalUsd: number | null;
  fillPct: number;
  vwap: number | null;
  worstPrice: number | null;
  impactBps: number | null;
  feeUsd: number;
  arrivalCostUsd: number | null;
  allInImpactBps: number | null;
  levelsConsumed: number;
}

const EXECUTION_QUALITY_KEYS = [
  "status",
  "targetBaseSize",
  "filledBaseSize",
  "filledNotionalUsd",
  "unfilledNotionalUsd",
  "fillPct",
  "vwap",
  "worstPrice",
  "impactBps",
  "feeUsd",
  "arrivalCostUsd",
  "allInImpactBps",
  "levelsConsumed",
] as const satisfies readonly (keyof TerminalExecutionQuality)[];

export function terminalExecutionQualityEqual(
  left: TerminalExecutionQuality,
  right: TerminalExecutionQuality,
) {
  return left === right || EXECUTION_QUALITY_KEYS.every((key) => Object.is(left[key], right[key]));
}

export function simulateTerminalExecution(input: TerminalExecutionQualityInput): TerminalExecutionQuality {
  const referencePrice = positive(input.referencePrice);
  const orderNotionalUsd = positive(input.orderNotionalUsd);
  if (referencePrice == null || orderNotionalUsd == null) return emptyQuality("no_market");

  const targetBaseSize = input.targetBaseSize === undefined
    ? orderNotionalUsd / referencePrice
    : positive(input.targetBaseSize);
  if (targetBaseSize == null) return emptyQuality("no_market");
  const limitPrice = positive(input.limitPrice);
  const levels = normalizedLevels(input.levels, input.side)
    .filter((level) => limitPrice == null || (input.side === "buy" ? level.price <= limitPrice : level.price >= limitPrice));
  let remaining = targetBaseSize;
  let filledBaseSize = 0;
  let filledNotionalUsd = 0;
  let worstPrice: number | null = null;
  let levelsConsumed = 0;

  for (const level of levels) {
    if (remaining <= Number.EPSILON) break;
    const filled = Math.min(remaining, level.size);
    if (filled <= 0) continue;
    filledBaseSize += filled;
    filledNotionalUsd += filled * level.price;
    remaining -= filled;
    worstPrice = level.price;
    levelsConsumed += 1;
  }

  const fillPct = clamp((filledBaseSize / targetBaseSize) * 100, 0, 100);
  const vwap = filledBaseSize > 0 ? filledNotionalUsd / filledBaseSize : null;
  const impactBps = vwap == null
    ? null
    : input.side === "buy"
      ? ((vwap - referencePrice) / referencePrice) * 10_000
      : ((referencePrice - vwap) / referencePrice) * 10_000;
  const feeBps = nonNegative(input.takerFeeBps) ?? 0;
  const feeUsd = filledNotionalUsd * feeBps / 10_000;
  const benchmarkNotional = filledBaseSize * referencePrice;
  const arrivalCostUsd = vwap == null
    ? null
    : (input.side === "buy" ? filledNotionalUsd - benchmarkNotional : benchmarkNotional - filledNotionalUsd) + feeUsd;
  const allInImpactBps = impactBps == null ? null : impactBps + feeBps;
  const unfilledFraction = clamp(Math.max(0, targetBaseSize - filledBaseSize) / targetBaseSize, 0, 1);
  const unfilledNotionalUsd = orderNotionalUsd * unfilledFraction;
  const status = filledBaseSize <= Number.EPSILON
    ? "none"
    : fillPct >= 99.999999
      ? "full"
      : "partial";

  return {
    status,
    targetBaseSize,
    filledBaseSize,
    filledNotionalUsd,
    unfilledNotionalUsd,
    fillPct,
    vwap,
    worstPrice,
    impactBps,
    feeUsd,
    arrivalCostUsd,
    allInImpactBps,
    levelsConsumed,
  };
}

function normalizedLevels(levels: TerminalLiquidityLevel[], side: "buy" | "sell") {
  const byPrice = new Map<number, number>();
  for (const level of levels) {
    const price = positive(level.px);
    const size = positive(level.sz);
    if (price == null || size == null) continue;
    byPrice.set(price, (byPrice.get(price) ?? 0) + size);
  }
  return [...byPrice.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => side === "buy" ? a.price - b.price : b.price - a.price);
}

function emptyQuality(status: "no_market"): TerminalExecutionQuality {
  return {
    status,
    targetBaseSize: null,
    filledBaseSize: 0,
    filledNotionalUsd: 0,
    unfilledNotionalUsd: null,
    fillPct: 0,
    vwap: null,
    worstPrice: null,
    impactBps: null,
    feeUsd: 0,
    arrivalCostUsd: null,
    allInImpactBps: null,
    levelsConsumed: 0,
  };
}

function positive(value: string | number | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
