import type { GholaMarketFrame } from "./ghola-market-chart";
import { normalizeMarketTimestamp } from "./market-component-clock";
import type { TerminalLiveMarketContext } from "./terminal-live-market-context";

export interface TerminalMarketFieldAuthority {
  ready: boolean;
  ageMs: number | null;
  markPrice: number | null;
  oraclePrice: number | null;
  openInterest: number | null;
  dayVolume: number | null;
}

/** Independently certifies the market-field writer; quote freshness is not enough. */
export function deriveTerminalMarketFieldAuthority(input: {
  frame: GholaMarketFrame | null;
  liveMarketContext: TerminalLiveMarketContext;
  maxAgeMs: number;
  nowMs?: number;
}): TerminalMarketFieldAuthority {
  if (!input.liveMarketContext.allowed || !input.frame || input.frame.stale) return unavailable();
  const nowMs = finiteNonNegative(input.nowMs ?? Date.now());
  const maxAgeMs = positive(input.maxAgeMs);
  const marketAt = normalizeMarketTimestamp(input.frame.componentTimestamps?.market);
  if (nowMs == null || maxAgeMs == null || marketAt == null) return unavailable();
  const ageMs = nowMs - marketAt;
  if (ageMs < -5_000 || ageMs > maxAgeMs) return unavailable(Math.max(0, ageMs));
  return {
    ready: true,
    ageMs: Math.max(0, ageMs),
    markPrice: positive(input.frame.markPrice),
    oraclePrice: positive(input.frame.oraclePrice),
    openInterest: nonNegative(input.frame.openInterest),
    dayVolume: nonNegative(input.frame.dayVolume),
  };
}

function unavailable(ageMs: number | null = null): TerminalMarketFieldAuthority {
  return { ready: false, ageMs, markPrice: null, oraclePrice: null, openInterest: null, dayVolume: null };
}

function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finiteNonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
