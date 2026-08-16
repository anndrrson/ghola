import type { GholaChartCandle } from "./ghola-market-chart";
import type {
  TerminalEntryOutcomeMatrix,
  TerminalEntryOutcomeMode,
} from "./terminal-entry-outcome-matrix";
import {
  deriveTerminalRewardLadder,
  TERMINAL_REWARD_LADDER_MULTIPLES,
  type TerminalRewardMultiple,
} from "./terminal-reward-ladder";

export interface TerminalEntryTargetCell {
  rewardMultiple: TerminalRewardMultiple;
  targetPrice: number | null;
  targetProfitUsd: number | null;
  evidenceStatus: "ready" | "thin_sample" | "unavailable";
  resolvedCount: number;
  resolvedHitRatePct: number | null;
  hitRateLowerPct: number | null;
  hitRateUpperPct: number | null;
  requiredWinRatePct: number | null;
  assessment: "above_break_even" | "below_break_even" | "inconclusive" | null;
}

export interface TerminalEntryTargetRow {
  mode: TerminalEntryOutcomeMode;
  entryPrice: number;
  intent: "resting" | "marketable";
  visibleFillPct: number;
  budgetAllowed: boolean | null;
  invalidationPrice: number | null;
  cells: TerminalEntryTargetCell[];
}

export interface TerminalEntryTargetSurface {
  status: "ready" | "degraded" | "unavailable";
  blocker: "entry_outcomes_unavailable" | "historical_evidence_unavailable" | null;
  horizonBars: number;
  rows: TerminalEntryTargetRow[];
}

export function terminalEntryTargetStageSelection(input: {
  surface: TerminalEntryTargetSurface;
  mode: TerminalEntryOutcomeMode;
  expectedEntryPrice: number;
  rewardMultiple: TerminalRewardMultiple;
  expectedTargetPrice: number;
}): { entryPrice: number; targetPrice: number } | null {
  if (input.surface.status === "unavailable") return null;
  const row = input.surface.rows.find((candidate) => candidate.mode === input.mode);
  const cell = row?.cells.find((candidate) => candidate.rewardMultiple === input.rewardMultiple);
  if (
    !row
    || !cell
    || cell.targetPrice == null
    || !Number.isFinite(input.expectedEntryPrice)
    || !Number.isFinite(input.expectedTargetPrice)
    || Math.abs(row.entryPrice - input.expectedEntryPrice) > 1e-9
    || Math.abs(cell.targetPrice - input.expectedTargetPrice) > 1e-9
  ) return null;
  return { entryPrice: row.entryPrice, targetPrice: cell.targetPrice };
}

export function deriveTerminalEntryTargetSurface(input: {
  entryMatrix: TerminalEntryOutcomeMatrix;
  candles: GholaChartCandle[];
  side: "buy" | "sell";
  notionalUsd: number;
  slippageBps: number;
  horizonBars?: number;
}): TerminalEntryTargetSurface {
  const horizonBars = boundedHorizon(input.horizonBars);
  if (input.entryMatrix.status !== "ready") {
    return { status: "unavailable", blocker: "entry_outcomes_unavailable", horizonBars, rows: [] };
  }
  let hasEvidence = false;
  const rows = input.entryMatrix.outcomes.map((outcome): TerminalEntryTargetRow => {
    const ladder = deriveTerminalRewardLadder({
      candles: input.candles,
      side: input.side,
      entryPrice: outcome.price,
      stopPrice: outcome.risk.invalidationPrice,
      notionalUsd: input.notionalUsd,
      slippageBps: input.slippageBps,
      horizonBars,
    });
    const cells = TERMINAL_REWARD_LADDER_MULTIPLES.map((rewardMultiple): TerminalEntryTargetCell => {
      const candidate = ladder.rows.find((row) => row.rewardMultiple === rewardMultiple);
      if (!candidate) return unavailableCell(rewardMultiple);
      if (candidate.status !== "unavailable") hasEvidence = true;
      return {
        rewardMultiple,
        targetPrice: finitePositive(candidate.targetPrice),
        targetProfitUsd: finitePositive(candidate.targetProfitUsd),
        evidenceStatus: candidate.status,
        resolvedCount: candidate.resolvedCount,
        resolvedHitRatePct: finite(candidate.resolvedHitRatePct),
        hitRateLowerPct: finite(candidate.hitRateLowerPct),
        hitRateUpperPct: finite(candidate.hitRateUpperPct),
        requiredWinRatePct: finite(candidate.requiredWinRatePct),
        assessment: candidate.assessment,
      };
    });
    return {
      mode: outcome.mode,
      entryPrice: outcome.price,
      intent: outcome.intent,
      visibleFillPct: outcome.quality.fillPct,
      budgetAllowed: outcome.risk.budgetAllowed,
      invalidationPrice: outcome.risk.invalidationPrice,
      cells,
    };
  });
  return {
    status: hasEvidence ? "ready" : "degraded",
    blocker: hasEvidence ? null : "historical_evidence_unavailable",
    horizonBars,
    rows,
  };
}

export function terminalEntryTargetSurfaceEqual(
  left: TerminalEntryTargetSurface,
  right: TerminalEntryTargetSurface,
) {
  if (left === right) return true;
  if (left.status !== right.status || left.blocker !== right.blocker || left.horizonBars !== right.horizonBars || left.rows.length !== right.rows.length) return false;
  return left.rows.every((row, rowIndex) => {
    const candidate = right.rows[rowIndex];
    return candidate != null
      && row.mode === candidate.mode
      && row.entryPrice === candidate.entryPrice
      && row.intent === candidate.intent
      && row.visibleFillPct === candidate.visibleFillPct
      && row.budgetAllowed === candidate.budgetAllowed
      && row.invalidationPrice === candidate.invalidationPrice
      && row.cells.length === candidate.cells.length
      && row.cells.every((cell, cellIndex) => cellsEqual(cell, candidate.cells[cellIndex]));
  });
}

function unavailableCell(rewardMultiple: TerminalRewardMultiple): TerminalEntryTargetCell {
  return {
    rewardMultiple,
    targetPrice: null,
    targetProfitUsd: null,
    evidenceStatus: "unavailable",
    resolvedCount: 0,
    resolvedHitRatePct: null,
    hitRateLowerPct: null,
    hitRateUpperPct: null,
    requiredWinRatePct: null,
    assessment: null,
  };
}

function cellsEqual(left: TerminalEntryTargetCell, right: TerminalEntryTargetCell | undefined) {
  return right != null
    && left.rewardMultiple === right.rewardMultiple
    && left.targetPrice === right.targetPrice
    && left.targetProfitUsd === right.targetProfitUsd
    && left.evidenceStatus === right.evidenceStatus
    && left.resolvedCount === right.resolvedCount
    && left.resolvedHitRatePct === right.resolvedHitRatePct
    && left.hitRateLowerPct === right.hitRateLowerPct
    && left.hitRateUpperPct === right.hitRateUpperPct
    && left.requiredWinRatePct === right.requiredWinRatePct
    && left.assessment === right.assessment;
}

function finitePositive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedHorizon(value: number | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100 ? value : 20;
}
