import type { GholaMarketFrame } from "./ghola-market-chart";

export const TERMINAL_LIQUIDITY_LADDER_LEVEL_LIMIT = 20;

export type TerminalLiquidityLadderBlocker =
  | "frame_unavailable"
  | "synthetic_frame"
  | "stale_frame"
  | "market_identity_mismatch"
  | "requested_notional_invalid"
  | "limit_price_invalid"
  | "entry_price_invalid"
  | "book_empty"
  | "book_level_invalid"
  | "book_crossed";

export interface TerminalLiquidityLadderLevel {
  side: "bid" | "ask";
  price: number;
  size: number;
  cumulativeBase: number;
  cumulativeNotionalUsd: number;
  sweepFraction: number;
  sweepBoundary: boolean;
}

export interface TerminalLiquiditySweep {
  status: "none" | "partial" | "full";
  requestedNotionalUsd: number;
  targetBaseSize: number;
  filledBaseSize: number;
  filledNotionalUsd: number;
  unfilledNotionalUsd: number;
  fillPct: number;
  vwap: number | null;
  impactBps: number | null;
  boundaryPrice: number | null;
  levelsConsumed: number;
}

export interface TerminalLiquidityLadder {
  status: "ready" | "unavailable";
  blocker: TerminalLiquidityLadderBlocker | null;
  side: "buy" | "sell";
  venue: string | null;
  product: string | null;
  interval: string | null;
  bids: TerminalLiquidityLadderLevel[];
  asks: TerminalLiquidityLadderLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  spreadBps: number | null;
  selectedEntryPrice: number | null;
  maxCumulativeNotionalUsd: number;
  sweep: TerminalLiquiditySweep | null;
}

export interface TerminalLiquidityLadderInput {
  frame: GholaMarketFrame | null;
  side: "buy" | "sell";
  requestedNotionalUsd: number;
  limitPrice?: number | null;
  selectedEntryPrice?: number | null;
  selectedVenue?: string;
  selectedProduct?: string;
  selectedInterval?: string;
  stale?: boolean;
  synthetic?: boolean;
}

interface NormalizedLevel {
  price: number;
  size: number;
}

export function deriveTerminalLiquidityLadder(
  input: TerminalLiquidityLadderInput,
): TerminalLiquidityLadder {
  const frame = input.frame;
  if (!frame) return unavailable(input, "frame_unavailable");
  if (input.synthetic) return unavailable(input, "synthetic_frame", frame);
  if (input.stale || frame.stale) return unavailable(input, "stale_frame", frame);
  if (!identityMatches(frame, input)) {
    return unavailable(input, "market_identity_mismatch", frame);
  }

  const requestedNotionalUsd = positive(input.requestedNotionalUsd);
  if (requestedNotionalUsd == null) {
    return unavailable(input, "requested_notional_invalid", frame);
  }
  const hasLimit = input.limitPrice !== undefined && input.limitPrice !== null;
  const limitPrice = hasLimit ? positive(input.limitPrice) : null;
  if (hasLimit && limitPrice == null) {
    return unavailable(input, "limit_price_invalid", frame);
  }
  const hasEntry = input.selectedEntryPrice !== undefined && input.selectedEntryPrice !== null;
  const selectedEntryPrice = hasEntry ? positive(input.selectedEntryPrice) : null;
  if (hasEntry && selectedEntryPrice == null) {
    return unavailable(input, "entry_price_invalid", frame);
  }
  if (frame.bids.length === 0 || frame.asks.length === 0) {
    return unavailable(input, "book_empty", frame);
  }

  const normalizedBids = normalizeSide(frame.bids, "bid");
  const normalizedAsks = normalizeSide(frame.asks, "ask");
  if (!normalizedBids || !normalizedAsks) {
    return unavailable(input, "book_level_invalid", frame);
  }
  const bestBid = normalizedBids[0]?.price ?? null;
  const bestAsk = normalizedAsks[0]?.price ?? null;
  if (bestBid == null || bestAsk == null) {
    return unavailable(input, "book_empty", frame);
  }
  if (bestBid >= bestAsk) {
    return unavailable(input, "book_crossed", frame);
  }

  const spread = bestAsk - bestBid;
  const mid = bestBid + spread / 2;
  const spreadBps = spread / mid * 10_000;
  if (![spread, mid, spreadBps].every(Number.isFinite) || spread <= 0 || mid <= 0) {
    return unavailable(input, "book_level_invalid", frame);
  }
  const baseBids = cumulativeLevels(normalizedBids, "bid");
  const baseAsks = cumulativeLevels(normalizedAsks, "ask");
  if (!baseBids || !baseAsks) {
    return unavailable(input, "book_level_invalid", frame);
  }
  const sizingPrice = limitPrice ?? selectedEntryPrice ?? mid;
  const targetBaseSize = requestedNotionalUsd / sizingPrice;
  if (!Number.isFinite(targetBaseSize) || targetBaseSize <= 0) {
    return unavailable(input, "requested_notional_invalid", frame);
  }
  const sweep = deriveSweep({
    side: input.side,
    requestedNotionalUsd,
    targetBaseSize,
    sizingPrice,
    limitPrice,
    mid,
    levels: input.side === "buy" ? baseAsks : baseBids,
  });
  const bids = markSweep(baseBids, input.side === "sell" ? sweep : null);
  const asks = markSweep(baseAsks, input.side === "buy" ? sweep : null);

  return {
    status: "ready",
    blocker: null,
    side: input.side,
    venue: frame.venue,
    product: frame.product,
    interval: frame.interval,
    bids,
    asks,
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadBps,
    selectedEntryPrice,
    maxCumulativeNotionalUsd: Math.max(
      bids.at(-1)?.cumulativeNotionalUsd ?? 0,
      asks.at(-1)?.cumulativeNotionalUsd ?? 0,
    ),
    sweep,
  };
}

function identityMatches(frame: GholaMarketFrame, input: TerminalLiquidityLadderInput) {
  if (input.selectedVenue !== undefined && canonical(input.selectedVenue) !== canonical(frame.venue)) {
    return false;
  }
  if (
    input.selectedProduct !== undefined
    && canonicalProduct(input.selectedProduct) !== canonicalProduct(frame.product)
  ) {
    return false;
  }
  if (input.selectedInterval !== undefined && canonical(input.selectedInterval) !== canonical(frame.interval)) {
    return false;
  }
  return true;
}

function normalizeSide(
  levels: GholaMarketFrame["bids"],
  side: "bid" | "ask",
): NormalizedLevel[] | null {
  const byPrice = new Map<number, number>();
  for (const level of levels) {
    const price = positive(level.px);
    const size = positive(level.sz);
    if (price == null || size == null) return null;
    const nextSize = (byPrice.get(price) ?? 0) + size;
    if (!Number.isFinite(nextSize) || nextSize <= 0) return null;
    byPrice.set(price, nextSize);
  }
  const normalized = [...byPrice.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price)
    .slice(0, TERMINAL_LIQUIDITY_LADDER_LEVEL_LIMIT);
  return normalized.length > 0 ? normalized : null;
}

function cumulativeLevels(
  levels: NormalizedLevel[],
  side: "bid" | "ask",
): TerminalLiquidityLadderLevel[] | null {
  let cumulativeBase = 0;
  let cumulativeNotionalUsd = 0;
  const result: TerminalLiquidityLadderLevel[] = [];
  for (const level of levels) {
    cumulativeBase += level.size;
    cumulativeNotionalUsd += level.size * level.price;
    if (!Number.isFinite(cumulativeBase) || !Number.isFinite(cumulativeNotionalUsd)) return null;
    result.push({
      side,
      price: level.price,
      size: level.size,
      cumulativeBase,
      cumulativeNotionalUsd,
      sweepFraction: 0,
      sweepBoundary: false,
    });
  }
  return result;
}

function deriveSweep(input: {
  side: "buy" | "sell";
  requestedNotionalUsd: number;
  targetBaseSize: number;
  sizingPrice: number;
  limitPrice: number | null;
  mid: number;
  levels: TerminalLiquidityLadderLevel[];
}): TerminalLiquiditySweep {
  let remainingBase = input.targetBaseSize;
  let filledBaseSize = 0;
  let filledNotionalUsd = 0;
  let boundaryPrice: number | null = null;
  let levelsConsumed = 0;

  for (const level of input.levels) {
    const eligible = input.limitPrice == null
      || (input.side === "buy" ? level.price <= input.limitPrice : level.price >= input.limitPrice);
    if (!eligible) continue;
    if (remainingBase <= Number.EPSILON) break;
    const fillBase = Math.min(remainingBase, level.size);
    if (fillBase <= 0) continue;
    remainingBase -= fillBase;
    filledBaseSize += fillBase;
    filledNotionalUsd += fillBase * level.price;
    boundaryPrice = level.price;
    levelsConsumed += 1;
  }

  const fillPct = clamp(filledBaseSize / input.targetBaseSize * 100, 0, 100);
  const vwap = filledBaseSize > 0 ? filledNotionalUsd / filledBaseSize : null;
  const impactBps = vwap == null
    ? null
    : input.side === "buy"
      ? (vwap - input.mid) / input.mid * 10_000
      : (input.mid - vwap) / input.mid * 10_000;
  const status = filledBaseSize <= Number.EPSILON
    ? "none"
    : fillPct >= 99.999999
      ? "full"
      : "partial";
  const unfilledAtSizingPrice = Math.max(
    0,
    input.requestedNotionalUsd - filledBaseSize * input.sizingPrice,
  );

  return {
    status,
    requestedNotionalUsd: input.requestedNotionalUsd,
    targetBaseSize: input.targetBaseSize,
    filledBaseSize,
    filledNotionalUsd,
    unfilledNotionalUsd: unfilledAtSizingPrice <= input.requestedNotionalUsd * 1e-12
      ? 0
      : unfilledAtSizingPrice,
    fillPct,
    vwap,
    impactBps,
    boundaryPrice,
    levelsConsumed,
  };
}

function markSweep(
  levels: TerminalLiquidityLadderLevel[],
  sweep: TerminalLiquiditySweep | null,
): TerminalLiquidityLadderLevel[] {
  if (!sweep || sweep.boundaryPrice == null) return levels;
  let remaining = sweep.filledBaseSize;
  return levels.map((level) => {
    const filled = Math.min(level.size, Math.max(0, remaining));
    remaining -= filled;
    return {
      ...level,
      sweepFraction: filled / level.size,
      sweepBoundary: level.price === sweep.boundaryPrice,
    };
  });
}

function unavailable(
  input: TerminalLiquidityLadderInput,
  blocker: TerminalLiquidityLadderBlocker,
  frame: GholaMarketFrame | null = input.frame,
): TerminalLiquidityLadder {
  return {
    status: "unavailable",
    blocker,
    side: input.side,
    venue: frame?.venue ?? null,
    product: frame?.product ?? null,
    interval: frame?.interval ?? null,
    bids: [],
    asks: [],
    bestBid: null,
    bestAsk: null,
    mid: null,
    spread: null,
    spreadBps: null,
    selectedEntryPrice: positive(input.selectedEntryPrice),
    maxCumulativeNotionalUsd: 0,
    sweep: null,
  };
}

function positive(value: string | number | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function canonical(value: string) {
  return value.trim().toUpperCase();
}

function canonicalProduct(value: string) {
  return canonical(value).replace(/-(USD|PERP)$/u, "");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
