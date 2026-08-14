import type { GholaMarketFrame } from "./ghola-market-chart";
import {
  simulateTerminalExecution,
  terminalExecutionQualityEqual,
  type TerminalExecutionQuality,
} from "./terminal-execution-quality";
import { floorTerminalNotionalUsd, sizeTerminalPositionForRisk } from "./terminal-position-sizing";
import { terminalRiskBudgetAllows } from "./terminal-risk-budget-interlock";
import { deriveTerminalTradeRisk } from "./trading-terminal-metrics";

export type TerminalEntryOutcomeMode = "join" | "current" | "cross";

export interface TerminalEntryOutcome {
  mode: TerminalEntryOutcomeMode;
  price: number;
  intent: "resting" | "marketable";
  quality: TerminalExecutionQuality;
  risk: {
    stopValid: boolean;
    invalidationPrice: number | null;
    modeledLossUsd: number | null;
    stopDistanceBps: number | null;
    budgetUtilizationPct: number | null;
    budgetAllowed: boolean | null;
    safeNotionalUsd: number | null;
    visibleFullFillNotionalUsd: number | null;
    recommendedNotionalUsd: number | null;
    recommendationConstraint: "risk_budget" | "visible_liquidity" | null;
    canApplyRecommendedNotional: boolean;
    twoRTargetPrice: number | null;
  };
}

export interface TerminalEntryOutcomeMatrix {
  status: "ready" | "unavailable";
  blocker: "book_unavailable" | "book_invalid" | "notional_invalid" | "price_invalid" | "risk_input_invalid" | null;
  outcomes: TerminalEntryOutcome[];
}

export interface TerminalEntrySizeRecommendation {
  notionalUsd: number;
  constraint: "risk_budget" | "visible_liquidity";
  canApply: boolean;
  riskCapNotionalUsd: number;
  visibleFullFillNotionalUsd: number | null;
}

export type TerminalEntryOutcomeBook = Pick<
  GholaMarketFrame,
  "bids" | "asks" | "bestBid" | "bestAsk"
>;

const ENTRY_RISK_KEYS = [
  "stopValid",
  "invalidationPrice",
  "modeledLossUsd",
  "stopDistanceBps",
  "budgetUtilizationPct",
  "budgetAllowed",
  "safeNotionalUsd",
  "visibleFullFillNotionalUsd",
  "recommendedNotionalUsd",
  "recommendationConstraint",
  "canApplyRecommendedNotional",
  "twoRTargetPrice",
] as const satisfies readonly (keyof TerminalEntryOutcome["risk"])[];

export function terminalEntryOutcomeMatrixEqual(
  left: TerminalEntryOutcomeMatrix,
  right: TerminalEntryOutcomeMatrix,
) {
  if (left === right) return true;
  if (left.status !== right.status || left.blocker !== right.blocker || left.outcomes.length !== right.outcomes.length) return false;
  return left.outcomes.every((outcome, index) => {
    const candidate = right.outcomes[index];
    return candidate != null
      && outcome.mode === candidate.mode
      && outcome.price === candidate.price
      && outcome.intent === candidate.intent
      && terminalExecutionQualityEqual(outcome.quality, candidate.quality)
      && ENTRY_RISK_KEYS.every((key) => Object.is(outcome.risk[key], candidate.risk[key]));
  });
}

export function terminalEntrySizeRecommendation(
  outcome: TerminalEntryOutcome | null | undefined,
): TerminalEntrySizeRecommendation | null {
  const risk = outcome?.risk;
  if (
    risk?.recommendedNotionalUsd == null
    || risk.recommendationConstraint == null
    || risk.safeNotionalUsd == null
  ) return null;
  return {
    notionalUsd: risk.recommendedNotionalUsd,
    constraint: risk.recommendationConstraint,
    canApply: risk.canApplyRecommendedNotional,
    riskCapNotionalUsd: risk.safeNotionalUsd,
    visibleFullFillNotionalUsd: risk.visibleFullFillNotionalUsd,
  };
}

export function deriveTerminalEntryOutcomeMatrix(input: {
  frame: TerminalEntryOutcomeBook | null;
  side: "buy" | "sell";
  notionalUsd: number;
  joinPrice: number | null;
  currentPrice: number | null;
  crossPrice: number | null;
  stopPrice: number | null;
  stopPinned: boolean;
  autoStopDistancePct: number;
  slippageBps: number;
  roundTripCostBps?: number;
  riskBudgetUsd: number;
  minNotionalUsd: number;
  maxNotionalUsd: number;
}): TerminalEntryOutcomeMatrix {
  if (!input.frame || input.frame.bids.length === 0 || input.frame.asks.length === 0) {
    return unavailable("book_unavailable");
  }
  const bestBid = positive(input.frame.bestBid);
  const bestAsk = positive(input.frame.bestAsk);
  const bookBid = validBookSide(input.frame.bids, "bid");
  const bookAsk = validBookSide(input.frame.asks, "ask");
  if (
    bestBid == null
    || bestAsk == null
    || bestBid >= bestAsk
    || bookBid == null
    || bookAsk == null
    || bestBid !== bookBid
    || bestAsk !== bookAsk
  ) {
    return unavailable("book_invalid");
  }
  const notionalUsd = positive(input.notionalUsd);
  if (notionalUsd == null) return unavailable("notional_invalid");
  const stopPrice = positive(input.stopPrice);
  const autoStopDistancePct = positive(input.autoStopDistancePct);
  const slippageBps = nonNegative(input.slippageBps);
  const roundTripCostBps = input.roundTripCostBps === undefined ? 0 : nonNegative(input.roundTripCostBps);
  const riskBudgetUsd = positive(input.riskBudgetUsd);
  const minNotionalUsd = positive(input.minNotionalUsd);
  const maxNotionalUsd = positive(input.maxNotionalUsd);
  if (
    stopPrice == null
    || autoStopDistancePct == null
    || autoStopDistancePct >= 1
    || slippageBps == null
    || roundTripCostBps == null
    || riskBudgetUsd == null
    || minNotionalUsd == null
    || maxNotionalUsd == null
    || minNotionalUsd > maxNotionalUsd
  ) {
    return unavailable("risk_input_invalid");
  }
  const prices = [
    ["join", input.joinPrice],
    ["current", input.currentPrice],
    ["cross", input.crossPrice],
  ] as const;
  if (prices.some(([, price]) => positive(price) == null)) return unavailable("price_invalid");
  const referencePrice = (bestBid + bestAsk) / 2;
  const levels = input.side === "buy" ? input.frame.asks : input.frame.bids;
  const outcomes = prices.map(([mode, rawPrice]) => {
    const price = positive(rawPrice) as number;
    const outcomeStopPrice = input.stopPinned
      ? stopPrice
      : input.side === "buy"
        ? price * (1 - autoStopDistancePct)
        : price * (1 + autoStopDistancePct);
    const intent = input.side === "buy"
      ? price >= bestAsk ? "marketable" as const : "resting" as const
      : price <= bestBid ? "marketable" as const : "resting" as const;
    const tradeRisk = deriveTerminalTradeRisk({
      side: input.side,
      notionalUsd,
      entryPrice: price,
      stopPrice: outcomeStopPrice,
      slippageBps,
    });
    const safeSizing = sizeTerminalPositionForRisk({
      side: input.side,
      riskBudgetUsd,
      entryPrice: price,
      stopPrice: outcomeStopPrice,
      slippageBps,
      roundTripCostBps,
      maxNotionalUsd,
    });
    const stopValid = tradeRisk.stopValid === true;
    const modeledLossUsd = stopValid && tradeRisk.maxLossUsd != null
      ? tradeRisk.maxLossUsd + notionalUsd * roundTripCostBps / 10_000
      : null;
    const budgetUtilizationPct = modeledLossUsd == null
      ? null
      : (modeledLossUsd / riskBudgetUsd) * 100;
    const safeNotionalUsd = safeSizing.status === "ready" ? safeSizing.notionalUsd : null;
    const visibleFullFillNotionalUsd = intent === "marketable"
      ? eligibleVisibleBaseSize(levels, input.side, price) * price
      : null;
    const rawRecommendedNotionalUsd = safeNotionalUsd == null
      ? null
      : visibleFullFillNotionalUsd == null
        ? safeNotionalUsd
        : Math.min(safeNotionalUsd, visibleFullFillNotionalUsd);
    const recommendedNotionalUsd = rawRecommendedNotionalUsd == null
      ? null
      : floorTerminalNotionalUsd(rawRecommendedNotionalUsd);
    const recommendationConstraint = recommendedNotionalUsd == null
      ? null
      : safeNotionalUsd != null && visibleFullFillNotionalUsd != null && visibleFullFillNotionalUsd < safeNotionalUsd - 0.005
        ? "visible_liquidity" as const
        : "risk_budget" as const;
    return {
      mode,
      price,
      intent,
      quality: simulateTerminalExecution({
        side: input.side,
        orderNotionalUsd: notionalUsd,
        targetBaseSize: notionalUsd / price,
        referencePrice,
        limitPrice: price,
        levels,
      }),
      risk: {
        stopValid,
        invalidationPrice: stopValid ? outcomeStopPrice : null,
        modeledLossUsd,
        stopDistanceBps: stopValid ? tradeRisk.stopDistanceBps : null,
        budgetUtilizationPct,
        budgetAllowed: modeledLossUsd == null ? null : terminalRiskBudgetAllows(modeledLossUsd, riskBudgetUsd),
        safeNotionalUsd,
        visibleFullFillNotionalUsd,
        recommendedNotionalUsd,
        recommendationConstraint,
        canApplyRecommendedNotional: recommendedNotionalUsd != null
          && recommendedNotionalUsd >= minNotionalUsd
          && recommendedNotionalUsd < notionalUsd - 0.005,
        twoRTargetPrice: stopValid ? tradeRisk.twoRTargetPrice : null,
      },
    };
  });
  return { status: "ready", blocker: null, outcomes };
}

function eligibleVisibleBaseSize(
  levels: GholaMarketFrame["asks"],
  side: "buy" | "sell",
  limitPrice: number,
) {
  let total = 0;
  for (const level of levels) {
    const price = Number(level.px);
    const size = Number(level.sz);
    if (side === "buy" ? price <= limitPrice : price >= limitPrice) total += size;
  }
  return total;
}

function unavailable(blocker: Exclude<TerminalEntryOutcomeMatrix["blocker"], null>): TerminalEntryOutcomeMatrix {
  return { status: "unavailable", blocker, outcomes: [] };
}

function validBookSide(levels: GholaMarketFrame["bids"], side: "bid" | "ask") {
  if (levels.length === 0 || levels.length > 20) return null;
  let previous: number | null = null;
  for (const level of levels) {
    const price = positive(level.px);
    if (
      price == null
      || positive(level.sz) == null
      || (previous != null && (side === "bid" ? price >= previous : price <= previous))
    ) return null;
    previous = price;
  }
  return positive(levels[0]?.px);
}

function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
