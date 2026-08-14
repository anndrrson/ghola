export type TerminalPlanMarketStateBlocker =
  | "quote_unavailable"
  | "plan_invalid"
  | "already_invalidated";

export type TerminalPlanMarketState =
  | {
      allowed: true;
      blocker: null;
      mode: "resting" | "marketable";
      executablePrice: number;
      distanceToMarketBps: number;
      remainingRiskBps: number;
    }
  | {
      allowed: false;
      blocker: TerminalPlanMarketStateBlocker;
      mode: "unavailable" | "marketable";
      executablePrice: number | null;
      distanceToMarketBps: number | null;
      remainingRiskBps: number | null;
    };

/** Checks whether a limit can execute only after its plan is already invalid. */
export function deriveTerminalPlanMarketState(input: {
  side: "buy" | "sell";
  entryPrice: number | null;
  stopPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
}): TerminalPlanMarketState {
  const entry = positive(input.entryPrice);
  const stop = positive(input.stopPrice);
  const bestBid = positive(input.bestBid);
  const bestAsk = positive(input.bestAsk);
  if (bestBid == null || bestAsk == null || bestBid >= bestAsk) return blocked("quote_unavailable");
  const planValid = entry != null && stop != null && (input.side === "buy" ? stop < entry : stop > entry);
  if (!planValid) return blocked("plan_invalid");

  const executablePrice = input.side === "buy" ? bestAsk : bestBid;
  const distanceToMarketBps = input.side === "buy"
    ? (entry - executablePrice) / executablePrice * 10_000
    : (executablePrice - entry) / executablePrice * 10_000;
  const marketable = distanceToMarketBps >= 0;
  const remainingRiskBps = input.side === "buy"
    ? (executablePrice - stop) / executablePrice * 10_000
    : (stop - executablePrice) / executablePrice * 10_000;
  if (marketable && remainingRiskBps <= 0) {
    return {
      allowed: false,
      blocker: "already_invalidated",
      mode: "marketable",
      executablePrice,
      distanceToMarketBps,
      remainingRiskBps,
    };
  }
  return {
    allowed: true,
    blocker: null,
    mode: marketable ? "marketable" : "resting",
    executablePrice,
    distanceToMarketBps,
    remainingRiskBps: marketable
      ? remainingRiskBps
      : Math.abs(entry - stop) / entry * 10_000,
  };
}

export function terminalPlanMarketStateBlockerLabel(blocker: TerminalPlanMarketStateBlocker) {
  if (blocker === "already_invalidated") return "current executable quote is at or beyond the plan invalidation";
  if (blocker === "plan_invalid") return "entry and plan invalidation are inconsistent";
  return "certified two-sided BBO is unavailable";
}

function blocked(blocker: Exclude<TerminalPlanMarketStateBlocker, "already_invalidated">): TerminalPlanMarketState {
  return {
    allowed: false,
    blocker,
    mode: "unavailable",
    executablePrice: null,
    distanceToMarketBps: null,
    remainingRiskBps: null,
  };
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
