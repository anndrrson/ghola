import type { GholaMarketFrame } from "./ghola-market-chart";
import { terminalFrameMatchesSelection, type TerminalMarketVenue } from "./terminal-market-identity";

export type TerminalEntryPriceMode = "join" | "cross";
export type TerminalEntryPriceStageBlocker =
  | "frame_unavailable"
  | "identity_mismatch"
  | "controller_stale"
  | "quote_clock_invalid"
  | "quote_clock_future"
  | "quote_expired"
  | "quote_invalid";

export interface TerminalEntryPriceStage {
  mode: TerminalEntryPriceMode;
  price: number;
  quoteAgeMs: number;
  sourceSide: "bid" | "ask";
  marketable: boolean;
}

export interface TerminalEntryPriceStages {
  status: "ready" | "unavailable";
  blocker: TerminalEntryPriceStageBlocker | null;
  quoteAgeMs: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  join: TerminalEntryPriceStage | null;
  cross: TerminalEntryPriceStage | null;
}

export function terminalEntryPriceStageBlockerLabel(
  blocker: TerminalEntryPriceStageBlocker | null,
) {
  if (blocker === "identity_mismatch") return "market identity changed";
  if (blocker === "controller_stale" || blocker === "quote_expired") return "fresh quote required";
  if (blocker === "quote_clock_future") return "quote clock is ahead";
  if (blocker === "quote_invalid") return "two-sided uncrossed BBO required";
  return "certified quote unavailable";
}

export function deriveTerminalEntryPriceStages(input: {
  frame: GholaMarketFrame | null;
  venue: TerminalMarketVenue;
  market: string;
  interval: string;
  network: string;
  side: "buy" | "sell";
  controllerStale: boolean;
  nowMs?: number;
  maxAgeMs: number;
}): TerminalEntryPriceStages {
  if (!input.frame) return unavailable("frame_unavailable");
  if (
    !terminalFrameMatchesSelection(input.frame, input)
    || input.frame.network !== input.network
  ) return unavailable("identity_mismatch");
  if (input.controllerStale || input.frame.stale) return unavailable("controller_stale");

  const nowMs = finiteNonNegative(input.nowMs ?? Date.now());
  const maxAgeMs = positive(input.maxAgeMs);
  const quoteClock = finiteNonNegative(input.frame.componentTimestamps?.quote);
  if (nowMs == null || maxAgeMs == null || quoteClock == null) {
    return unavailable("quote_clock_invalid");
  }
  const quoteAgeMs = nowMs - quoteClock;
  if (quoteAgeMs < -30_000) return unavailable("quote_clock_future");
  if (quoteAgeMs > maxAgeMs) return unavailable("quote_expired", Math.max(0, quoteAgeMs));

  const bestBid = positive(input.frame.bestBid);
  const bestAsk = positive(input.frame.bestAsk);
  if (bestBid == null || bestAsk == null || bestBid >= bestAsk) {
    return unavailable("quote_invalid", Math.max(0, quoteAgeMs));
  }
  const age = Math.max(0, quoteAgeMs);
  const buy = input.side === "buy";
  return {
    status: "ready",
    blocker: null,
    quoteAgeMs: age,
    bestBid,
    bestAsk,
    join: {
      mode: "join",
      price: buy ? bestBid : bestAsk,
      quoteAgeMs: age,
      sourceSide: buy ? "bid" : "ask",
      marketable: false,
    },
    cross: {
      mode: "cross",
      price: buy ? bestAsk : bestBid,
      quoteAgeMs: age,
      sourceSide: buy ? "ask" : "bid",
      marketable: true,
    },
  };
}

function unavailable(
  blocker: TerminalEntryPriceStageBlocker,
  quoteAgeMs: number | null = null,
): TerminalEntryPriceStages {
  return {
    status: "unavailable",
    blocker,
    quoteAgeMs,
    bestBid: null,
    bestAsk: null,
    join: null,
    cross: null,
  };
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
