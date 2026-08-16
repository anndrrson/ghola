import type { GholaChartCandle } from "./ghola-market-chart";
import { deriveTerminalPlanPayoffCalibration } from "./terminal-plan-payoff-calibration";
import { studyTerminalPlanPaths } from "./terminal-plan-path-study";

export const TERMINAL_REWARD_LADDER_MULTIPLES = [1, 1.5, 2, 3] as const;
export type TerminalRewardMultiple = (typeof TERMINAL_REWARD_LADDER_MULTIPLES)[number];

export type TerminalRewardLadderBlocker =
  | "plan_invalid"
  | "notional_invalid"
  | "slippage_invalid"
  | "history_unavailable";

export interface TerminalRewardLadderRow {
  rewardMultiple: TerminalRewardMultiple;
  targetPrice: number;
  targetProfitUsd: number;
  status: "ready" | "thin_sample" | "unavailable";
  resolvedCount: number;
  episodeCount: number;
  resolvedHitRatePct: number | null;
  hitRateLowerPct: number | null;
  hitRateUpperPct: number | null;
  requiredWinRatePct: number | null;
  assessment: "above_break_even" | "below_break_even" | "inconclusive" | null;
}

export interface TerminalRewardLadder {
  status: "ready" | "unavailable";
  blocker: TerminalRewardLadderBlocker | null;
  horizonBars: number;
  stopLossUsd: number | null;
  rows: TerminalRewardLadderRow[];
}

export function terminalRewardTargetPrice(input: {
  side: "buy" | "sell";
  entryPrice: number | null;
  stopPrice: number | null;
  rewardMultiple: TerminalRewardMultiple;
}): number | null {
  const entryPrice = positive(input.entryPrice);
  const stopPrice = positive(input.stopPrice);
  if (
    entryPrice == null
    || stopPrice == null
    || !TERMINAL_REWARD_LADDER_MULTIPLES.includes(input.rewardMultiple)
    || (input.side === "buy" ? stopPrice >= entryPrice : stopPrice <= entryPrice)
  ) return null;
  const riskDistance = Math.abs(entryPrice - stopPrice);
  const targetPrice = input.side === "buy"
    ? entryPrice + riskDistance * input.rewardMultiple
    : entryPrice - riskDistance * input.rewardMultiple;
  return Number.isFinite(targetPrice) && targetPrice > 0 ? targetPrice : null;
}

export function deriveTerminalRewardLadder(input: {
  candles: GholaChartCandle[];
  side: "buy" | "sell";
  entryPrice: number | null;
  stopPrice: number | null;
  notionalUsd: number;
  slippageBps: number;
  horizonBars?: number;
}): TerminalRewardLadder {
  const entryPrice = positive(input.entryPrice);
  const stopPrice = positive(input.stopPrice);
  const stopValid = entryPrice != null && stopPrice != null
    && (input.side === "buy" ? stopPrice < entryPrice : stopPrice > entryPrice);
  const horizonBars = boundedHorizon(input.horizonBars);
  if (!stopValid) return unavailable("plan_invalid", horizonBars);
  const notionalUsd = positive(input.notionalUsd);
  if (notionalUsd == null) return unavailable("notional_invalid", horizonBars);
  const slippageBps = nonNegative(input.slippageBps);
  if (slippageBps == null) return unavailable("slippage_invalid", horizonBars);
  const riskDistance = Math.abs((entryPrice as number) - (stopPrice as number));
  const stopDistanceBps = riskDistance / (entryPrice as number) * 10_000;
  const stopLossUsd = notionalUsd * (stopDistanceBps + slippageBps) / 10_000;

  const rows = TERMINAL_REWARD_LADDER_MULTIPLES.map((rewardMultiple) => {
    const targetPrice = terminalRewardTargetPrice({
      side: input.side,
      entryPrice,
      stopPrice,
      rewardMultiple,
    }) ?? Number.NaN;
    const targetDistanceBps = riskDistance * rewardMultiple / (entryPrice as number) * 10_000;
    const targetProfitUsd = notionalUsd * Math.max(0, targetDistanceBps - slippageBps) / 10_000;
    if (!Number.isFinite(targetPrice) || targetPrice <= 0 || targetProfitUsd <= 0) {
      return unavailableRow(rewardMultiple, targetPrice, Math.max(0, targetProfitUsd));
    }
    const study = studyTerminalPlanPaths({
      candles: input.candles,
      side: input.side,
      entryPrice,
      stopPrice,
      targetPrice,
      horizonBars,
    });
    const calibration = deriveTerminalPlanPayoffCalibration({
      studies: [study],
      stopLossUsd,
      targetProfitUsd,
      horizonBars,
    });
    return {
      rewardMultiple,
      targetPrice,
      targetProfitUsd,
      status: calibration.status,
      resolvedCount: calibration.resolvedCount,
      episodeCount: calibration.episodeCount,
      resolvedHitRatePct: calibration.resolvedHitRatePct,
      hitRateLowerPct: calibration.hitRateLowerPct,
      hitRateUpperPct: calibration.hitRateUpperPct,
      requiredWinRatePct: calibration.requiredWinRatePct,
      assessment: calibration.assessment,
    } satisfies TerminalRewardLadderRow;
  });
  return rows.some((row) => row.status !== "unavailable")
    ? { status: "ready", blocker: null, horizonBars, stopLossUsd, rows }
    : unavailable("history_unavailable", horizonBars, stopLossUsd, rows);
}

function unavailableRow(
  rewardMultiple: TerminalRewardMultiple,
  targetPrice: number,
  targetProfitUsd: number,
): TerminalRewardLadderRow {
  return {
    rewardMultiple,
    targetPrice,
    targetProfitUsd,
    status: "unavailable",
    resolvedCount: 0,
    episodeCount: 0,
    resolvedHitRatePct: null,
    hitRateLowerPct: null,
    hitRateUpperPct: null,
    requiredWinRatePct: null,
    assessment: null,
  };
}

function unavailable(
  blocker: TerminalRewardLadderBlocker,
  horizonBars: number,
  stopLossUsd: number | null = null,
  rows: TerminalRewardLadderRow[] = [],
): TerminalRewardLadder {
  return { status: "unavailable", blocker, horizonBars, stopLossUsd, rows };
}

function boundedHorizon(value: number | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100 ? value : 20;
}

function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
