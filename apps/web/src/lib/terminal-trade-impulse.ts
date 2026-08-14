import type { GholaChartTrade } from "./ghola-market-chart";

export const TERMINAL_TRADE_IMPULSE_LIMIT = 20;
export const TERMINAL_TRADE_IMPULSE_WINDOW_MS = 30_000;

export type TerminalTradeImpulseClassification =
  | "buy_impulse"
  | "buy_absorption_candidate"
  | "buy_divergence"
  | "sell_impulse"
  | "sell_absorption_candidate"
  | "sell_divergence"
  | "mixed";

export interface TerminalTradeImpulse {
  status: "ready" | "thin_sample" | "unavailable";
  blocker: "uncertified" | "component_age_invalid" | "prints_empty" | "prints_oversized" | "prints_invalid" | null;
  classification: TerminalTradeImpulseClassification | null;
  sampleCount: number;
  windowMs: number | null;
  totalNotionalUsd: number | null;
  netAggressorNotionalUsd: number | null;
  buySharePct: number | null;
  priceChangeBps: number | null;
  printsPerSecond: number | null;
  largestPrintUsd: number | null;
  largestPrintSide: "buy" | "sell" | null;
}

export type TerminalTradePrintStageDecision =
  | { allowed: true; price: number }
  | { allowed: false; blocker: "stream_uncertified" | "identity_mismatch" | "price_invalid" };

export function terminalTradeImpulseAgeBucket(ageMs: number | null): number {
  const age = finiteNonNegative(ageMs);
  return age == null ? -1 : Math.floor(Math.min(age, TERMINAL_TRADE_IMPULSE_WINDOW_MS) / 1_000);
}

export function terminalTradePrintStageDecision(input: {
  streamCertified: boolean;
  currentIdentityKey: string | null;
  expectedIdentityKey: string;
  price: number;
}): TerminalTradePrintStageDecision {
  if (!input.streamCertified) return { allowed: false, blocker: "stream_uncertified" };
  if (!input.currentIdentityKey || input.currentIdentityKey !== input.expectedIdentityKey) {
    return { allowed: false, blocker: "identity_mismatch" };
  }
  if (!Number.isFinite(input.price) || input.price <= 0) return { allowed: false, blocker: "price_invalid" };
  return { allowed: true, price: input.price };
}

export function deriveTerminalTradeImpulse(input: {
  certified: boolean;
  componentAgeMs: number | null;
  trades: readonly GholaChartTrade[];
}): TerminalTradeImpulse {
  if (!input.certified) return unavailable("uncertified");
  const componentAgeMs = finiteNonNegative(input.componentAgeMs);
  if (componentAgeMs == null || componentAgeMs > TERMINAL_TRADE_IMPULSE_WINDOW_MS) {
    return unavailable("component_age_invalid");
  }
  if (input.trades.length === 0) return unavailable("prints_empty");
  if (input.trades.length > TERMINAL_TRADE_IMPULSE_LIMIT) return unavailable("prints_oversized");
  const normalized = normalizeTrades(input.trades);
  if (!normalized) return unavailable("prints_invalid");

  const latestTime = normalized.at(-1)!.time;
  const remainingWindowMs = TERMINAL_TRADE_IMPULSE_WINDOW_MS - componentAgeMs;
  const windowed = normalized.filter((trade) => latestTime - trade.time <= remainingWindowMs);
  let buyNotional = 0;
  let sellNotional = 0;
  let largestPrintUsd = 0;
  let largestPrintSide: "buy" | "sell" | null = null;
  for (const trade of windowed) {
    const notional = trade.price * trade.size;
    if (!Number.isFinite(notional) || notional <= 0) return unavailable("prints_invalid");
    if (trade.side === "buy") buyNotional += notional;
    else sellNotional += notional;
    if (!Number.isFinite(buyNotional) || !Number.isFinite(sellNotional)) return unavailable("prints_invalid");
    if (notional > largestPrintUsd) {
      largestPrintUsd = notional;
      largestPrintSide = trade.side;
    }
  }
  const totalNotionalUsd = buyNotional + sellNotional;
  const first = windowed[0]!;
  const last = windowed.at(-1)!;
  const windowMs = last.time - first.time;
  const buySharePct = totalNotionalUsd > 0 ? buyNotional / totalNotionalUsd * 100 : null;
  const priceChangeBps = first.price > 0 ? (last.price - first.price) / first.price * 10_000 : null;
  const printsPerSecond = windowed.length > 1 && windowMs > 0
    ? (windowed.length - 1) / (windowMs / 1_000)
    : null;
  const status = windowed.length >= 3 && windowMs > 0 ? "ready" : "thin_sample";
  return {
    status,
    blocker: null,
    classification: status === "ready" && buySharePct != null && priceChangeBps != null
      ? classify(buySharePct, priceChangeBps)
      : null,
    sampleCount: windowed.length,
    windowMs,
    totalNotionalUsd,
    netAggressorNotionalUsd: buyNotional - sellNotional,
    buySharePct,
    priceChangeBps,
    printsPerSecond,
    largestPrintUsd,
    largestPrintSide,
  };
}

function normalizeTrades(trades: readonly GholaChartTrade[]) {
  const byIdentity = new Map<string, NormalizedTrade>();
  for (const trade of trades) {
    const price = positive(trade.px);
    const size = positive(trade.sz);
    const time = finiteTime(trade.time);
    if (price == null || size == null || time == null || (trade.side !== "buy" && trade.side !== "sell")) return null;
    const id = typeof trade.id === "string" && trade.id.trim() ? trade.id.trim() : null;
    const fingerprint = `${time}:${trade.side}:${price}:${size}`;
    const identity = id ? `id:${id}` : `tuple:${fingerprint}`;
    const current = byIdentity.get(identity);
    if (current && current.fingerprint !== fingerprint) return null;
    if (!current) byIdentity.set(identity, { fingerprint, price, size, side: trade.side, time });
  }
  return [...byIdentity.values()].sort((left, right) => left.time - right.time || left.fingerprint.localeCompare(right.fingerprint));
}

type NormalizedTrade = {
  fingerprint: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  time: number;
};

function classify(buySharePct: number, priceChangeBps: number): TerminalTradeImpulseClassification {
  if (buySharePct >= 65) {
    if (priceChangeBps >= 2) return "buy_impulse";
    if (priceChangeBps <= -2) return "buy_divergence";
    if (buySharePct >= 70) return "buy_absorption_candidate";
  }
  if (buySharePct <= 35) {
    if (priceChangeBps <= -2) return "sell_impulse";
    if (priceChangeBps >= 2) return "sell_divergence";
    if (buySharePct <= 30) return "sell_absorption_candidate";
  }
  return "mixed";
}

function unavailable(blocker: Exclude<TerminalTradeImpulse["blocker"], null>): TerminalTradeImpulse {
  return {
    status: "unavailable",
    blocker,
    classification: null,
    sampleCount: 0,
    windowMs: null,
    totalNotionalUsd: null,
    netAggressorNotionalUsd: null,
    buySharePct: null,
    priceChangeBps: null,
    printsPerSecond: null,
    largestPrintUsd: null,
    largestPrintSide: null,
  };
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteTime(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
