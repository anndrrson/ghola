import type { GholaMarketFrame } from "./ghola-market-chart";
import { normalizeMarketTimestamp } from "./market-component-clock";
import { terminalFrameMatchesSelection, type TerminalMarketVenue } from "./terminal-market-identity";
import type { UnifiedLiveMarketStatus } from "./unified-live-market";

export type TerminalLiveMarketContextBlocker =
  | "frame_unavailable"
  | "identity_mismatch"
  | "transport_unavailable"
  | "controller_stale"
  | "quote_clock_missing"
  | "quote_clock_future"
  | "quote_expired"
  | "quote_invalid";

export interface TerminalLiveMarketContextInput {
  frame: GholaMarketFrame | null;
  venue: TerminalMarketVenue;
  network: string;
  market: string;
  interval: string;
  status: UnifiedLiveMarketStatus;
  controllerStale: boolean;
  maxAgeMs: number;
  nowMs?: number;
}

export type TerminalLiveMarketContext =
  | {
      allowed: true;
      blocker: null;
      quoteAgeMs: number;
      quoteFetchedAt: string;
      referencePrice: number;
      spreadBps: number;
      bestBid: number;
      bestAsk: number;
    }
  | {
      allowed: false;
      blocker: TerminalLiveMarketContextBlocker;
      quoteAgeMs: number | null;
      quoteFetchedAt: null;
      referencePrice: null;
      spreadBps: null;
      bestBid: null;
      bestAsk: null;
    };

const USABLE_STATUSES = new Set<UnifiedLiveMarketStatus>(["live", "fallback_polling"]);

/** Exact public BBO context allowed to authorize a live plan or submit. */
export function deriveTerminalLiveMarketContext(
  input: TerminalLiveMarketContextInput,
): TerminalLiveMarketContext {
  if (!USABLE_STATUSES.has(input.status)) return blocked("transport_unavailable");
  if (!input.frame) return blocked("frame_unavailable");
  if (
    !terminalFrameMatchesSelection(input.frame, input)
    || canonical(input.frame.network) !== canonical(input.network)
  ) return blocked("identity_mismatch");
  if (input.controllerStale || input.frame.stale) return blocked("controller_stale");

  const nowMs = finiteNonNegative(input.nowMs ?? Date.now());
  const maxAgeMs = positive(input.maxAgeMs);
  const quoteClock = normalizeMarketTimestamp(input.frame.componentTimestamps?.quote);
  if (nowMs == null || maxAgeMs == null || quoteClock == null) {
    return blocked("quote_clock_missing");
  }
  const quoteAgeMs = nowMs - quoteClock;
  if (quoteAgeMs < -5_000) return blocked("quote_clock_future", quoteAgeMs);
  if (quoteAgeMs > maxAgeMs) return blocked("quote_expired", quoteAgeMs);

  const bestBid = positive(input.frame.bestBid);
  const bestAsk = positive(input.frame.bestAsk);
  if (bestBid == null || bestAsk == null || bestBid >= bestAsk) {
    return blocked("quote_invalid", Math.max(0, quoteAgeMs));
  }
  return {
    allowed: true,
    blocker: null,
    quoteAgeMs: Math.max(0, quoteAgeMs),
    quoteFetchedAt: new Date(quoteClock).toISOString(),
    referencePrice: (bestBid + bestAsk) / 2,
    spreadBps: ((bestAsk - bestBid) / ((bestBid + bestAsk) / 2)) * 10_000,
    bestBid,
    bestAsk,
  };
}

export function terminalLiveMarketContextBlockerLabel(
  blocker: TerminalLiveMarketContextBlocker,
): string {
  if (blocker === "identity_mismatch") return "selected market identity changed";
  if (blocker === "transport_unavailable") return "public market transport is not live";
  if (blocker === "controller_stale") return "public market controller is stale";
  if (blocker === "quote_clock_missing") return "authoritative quote clock is missing";
  if (blocker === "quote_clock_future") return "authoritative quote clock is too far ahead";
  if (blocker === "quote_expired") return "authoritative quote has expired";
  if (blocker === "quote_invalid") return "two-sided uncrossed BBO is required";
  return "public market frame is unavailable";
}

function blocked(
  blocker: TerminalLiveMarketContextBlocker,
  quoteAgeMs: number | null = null,
): TerminalLiveMarketContext {
  return {
    allowed: false,
    blocker,
    quoteAgeMs,
    quoteFetchedAt: null,
    referencePrice: null,
    spreadBps: null,
    bestBid: null,
    bestAsk: null,
  };
}

function canonical(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
