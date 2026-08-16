import type { TerminalPlanPathStudy } from "./terminal-plan-path-study";

export const TERMINAL_PLAN_CALIBRATION_MIN_RESOLVED = 10;

export type TerminalPlanPayoffCalibrationBlocker =
  | "payoff_invalid"
  | "study_unavailable"
  | "resolved_sample_empty";

export interface TerminalPlanPayoffCalibration {
  status: "ready" | "thin_sample" | "unavailable";
  blocker: TerminalPlanPayoffCalibrationBlocker | null;
  horizonBars: number;
  episodeCount: number;
  resolvedCount: number;
  resolvedHitRatePct: number | null;
  hitRateLowerPct: number | null;
  hitRateUpperPct: number | null;
  requiredWinRatePct: number | null;
  edgeMarginPct: number | null;
  modeledExpectancyUsd: number | null;
  resolutionCoveragePct: number | null;
  assessment: "above_break_even" | "below_break_even" | "inconclusive" | null;
}

const CALIBRATION_KEYS = [
  "status",
  "blocker",
  "horizonBars",
  "episodeCount",
  "resolvedCount",
  "resolvedHitRatePct",
  "hitRateLowerPct",
  "hitRateUpperPct",
  "requiredWinRatePct",
  "edgeMarginPct",
  "modeledExpectancyUsd",
  "resolutionCoveragePct",
  "assessment",
] as const satisfies readonly (keyof TerminalPlanPayoffCalibration)[];

export function deriveTerminalPlanPayoffCalibration(input: {
  studies: readonly TerminalPlanPathStudy[];
  stopLossUsd: number | null;
  targetProfitUsd: number | null;
  horizonBars?: number;
}): TerminalPlanPayoffCalibration {
  const horizonBars = boundedHorizon(input.horizonBars);
  const stopLossUsd = positive(input.stopLossUsd);
  const targetProfitUsd = positive(input.targetProfitUsd);
  if (stopLossUsd == null || targetProfitUsd == null) {
    return unavailable("payoff_invalid", horizonBars);
  }
  const study = input.studies.find((candidate) => candidate.horizonBars === horizonBars);
  if (!study || study.status !== "ready" || !validStudyAggregate(study)) {
    return unavailable("study_unavailable", horizonBars);
  }
  if (study.resolvedCount <= 0 || study.targetFirstRatePct == null) {
    return unavailable("resolved_sample_empty", horizonBars, study.episodeCount);
  }
  const requiredWinRatePct = stopLossUsd / (stopLossUsd + targetProfitUsd) * 100;
  const resolvedHitRatePct = study.targetFirstRatePct;
  const interval = wilsonInterval(study.targetFirstCount, study.resolvedCount);
  const edgeMarginPct = resolvedHitRatePct - requiredWinRatePct;
  const resolvedProbability = resolvedHitRatePct / 100;
  const modeledExpectancyUsd = resolvedProbability * targetProfitUsd
    - (1 - resolvedProbability) * stopLossUsd;
  const resolutionCoveragePct = study.episodeCount > 0
    ? study.resolvedCount / study.episodeCount * 100
    : null;
  const assessment = interval.lowerPct > requiredWinRatePct
    ? "above_break_even"
    : interval.upperPct < requiredWinRatePct
      ? "below_break_even"
      : "inconclusive";
  return {
    status: study.resolvedCount >= TERMINAL_PLAN_CALIBRATION_MIN_RESOLVED ? "ready" : "thin_sample",
    blocker: null,
    horizonBars,
    episodeCount: study.episodeCount,
    resolvedCount: study.resolvedCount,
    resolvedHitRatePct: finite(resolvedHitRatePct),
    hitRateLowerPct: finite(interval.lowerPct),
    hitRateUpperPct: finite(interval.upperPct),
    requiredWinRatePct: finite(requiredWinRatePct),
    edgeMarginPct: finite(edgeMarginPct),
    modeledExpectancyUsd: finite(modeledExpectancyUsd),
    resolutionCoveragePct: finite(resolutionCoveragePct),
    assessment,
  };
}

export function terminalPlanPayoffCalibrationEqual(
  left: TerminalPlanPayoffCalibration,
  right: TerminalPlanPayoffCalibration,
) {
  return left === right || CALIBRATION_KEYS.every((key) => Object.is(left[key], right[key]));
}

function unavailable(
  blocker: TerminalPlanPayoffCalibrationBlocker,
  horizonBars: number,
  episodeCount = 0,
): TerminalPlanPayoffCalibration {
  return {
    status: "unavailable",
    blocker,
    horizonBars,
    episodeCount,
    resolvedCount: 0,
    resolvedHitRatePct: null,
    hitRateLowerPct: null,
    hitRateUpperPct: null,
    requiredWinRatePct: null,
    edgeMarginPct: null,
    modeledExpectancyUsd: null,
    resolutionCoveragePct: null,
    assessment: null,
  };
}

function wilsonInterval(successes: number, total: number) {
  const proportion = successes / total;
  const z = 1.959963984540054;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    proportion * (1 - proportion) / total + zSquared / (4 * total * total),
  ) / denominator;
  return {
    lowerPct: Math.max(0, center - margin) * 100,
    upperPct: Math.min(1, center + margin) * 100,
  };
}

function validStudyAggregate(study: TerminalPlanPathStudy) {
  const counts = [
    study.episodeCount,
    study.resolvedCount,
    study.targetFirstCount,
    study.stopFirstCount,
    study.ambiguousCount,
    study.unresolvedCount,
  ];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) return false;
  if (study.resolvedCount !== study.targetFirstCount + study.stopFirstCount) return false;
  if (study.episodeCount !== study.resolvedCount + study.ambiguousCount + study.unresolvedCount) return false;
  if (study.resolvedCount === 0) return study.targetFirstRatePct == null;
  const expectedRate = study.targetFirstCount / study.resolvedCount * 100;
  return typeof study.targetFirstRatePct === "number"
    && Number.isFinite(study.targetFirstRatePct)
    && Math.abs(study.targetFirstRatePct - expectedRate) <= 1e-8;
}

function boundedHorizon(value: number | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100
    ? value
    : 20;
}

function positive(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finite(value: number | null) {
  return value != null && Number.isFinite(value) ? value : null;
}
