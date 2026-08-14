"use client";

import { memo } from "react";
import {
  terminalPlanPayoffCalibrationEqual,
  type TerminalPlanPayoffCalibration as Calibration,
} from "@/lib/terminal-plan-payoff-calibration";

export const TerminalPlanPayoffCalibration = memo(function TerminalPlanPayoffCalibration({
  calibration,
  replay,
}: {
  calibration: Calibration;
  replay: boolean;
}) {
  const unavailable = calibration.status === "unavailable";
  const assessment = calibration.assessment;
  return (
    <section aria-labelledby="plan-payoff-calibration-heading" className="mb-4 rounded-md border border-[#182234] bg-[#080c13] p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="plan-payoff-calibration-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">
          Plan break-even calibration
        </h2>
        <span className={`font-mono text-[9px] font-semibold uppercase tracking-[0.12em] ${
          unavailable || assessment === "inconclusive" ? "text-amber-200" : assessment === "above_break_even" ? "text-emerald-300" : "text-rose-300"
        }`}>
          {unavailable ? "paused" : assessment === "above_break_even" ? "interval above break-even" : assessment === "below_break_even" ? "interval below break-even" : calibration.status === "thin_sample" ? "thin · inconclusive" : "inconclusive"}
        </span>
      </div>
      {unavailable ? (
        <p role="status" className="mt-2 text-[10px] leading-4 text-amber-200">
          Unavailable until the plan has positive slippage-adjusted loss and profit plus resolved certified path episodes.
        </p>
      ) : (
        <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Metric label="Resolved hit" value={formatPct(calibration.resolvedHitRatePct)} />
          <Metric label="95% hit interval" value={formatInterval(calibration.hitRateLowerPct, calibration.hitRateUpperPct)} />
          <Metric label="Break-even" value={formatPct(calibration.requiredWinRatePct)} />
          <Metric label="Point margin" value={formatSignedPct(calibration.edgeMarginPct)} tone={(calibration.edgeMarginPct ?? 0) >= 0 ? "good" : "bad"} />
          <Metric label="Modeled / episode" value={formatSignedUsd(calibration.modeledExpectancyUsd)} tone={(calibration.modeledExpectancyUsd ?? 0) >= 0 ? "good" : "bad"} />
          <Metric label="Resolved coverage" value={`${formatPct(calibration.resolutionCoveragePct)} · n=${calibration.resolvedCount}`} />
        </dl>
      )}
      <p className="mt-2 text-[9px] leading-4 text-[#566278]">
        {replay ? "Revealed replay prefix" : "Latest certified history"} · {calibration.horizonBars}-bar resolved outcomes; Wilson 95% interval versus the current slippage-adjusted target and invalidation payoff. Fees, gaps, queue position, and unresolved or ambiguous episodes are excluded. Descriptive calibration only—not a probability, forecast, or execution gate.
      </p>
    </section>
  );
}, (previous, next) => previous.replay === next.replay
  && terminalPlanPayoffCalibrationEqual(previous.calibration, next.calibration));

function Metric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "good" | "bad" | "neutral" }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[8px] uppercase tracking-[0.12em] text-[#8491a8]">{label}</dt>
      <dd className={`mt-0.5 truncate font-mono text-[10px] tabular-nums ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-[#c7d2e4]"}`}>{value}</dd>
    </div>
  );
}

function formatPct(value: number | null) { return value == null ? "—" : `${value.toFixed(1)}%`; }
function formatInterval(lower: number | null, upper: number | null) { return lower == null || upper == null ? "—" : `${lower.toFixed(1)}–${upper.toFixed(1)}%`; }
function formatSignedPct(value: number | null) { return value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)} pp`; }
function formatSignedUsd(value: number | null) { return value == null ? "—" : `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`; }
