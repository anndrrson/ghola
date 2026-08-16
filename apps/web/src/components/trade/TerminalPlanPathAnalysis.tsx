"use client";

import { memo } from "react";
import type { TerminalPlanPathAnalysis as PlanPath } from "@/lib/terminal-plan-path-analysis";

export const TerminalPlanPathAnalysis = memo(function TerminalPlanPathAnalysis({
  analysis,
  replay,
  sourceFresh,
}: {
  analysis: PlanPath;
  replay: boolean;
  sourceFresh: boolean;
}) {
  const outcome = outcomeCopy(analysis.outcome);
  return (
    <section aria-labelledby="plan-path-heading" className="mb-4 rounded-md border border-[#182234] bg-[#080c13] p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="plan-path-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">
          Path-conditioned plan
        </h2>
        <span className={`font-mono text-[9px] font-semibold uppercase tracking-[0.12em] ${outcome.tone}`}>
          {sourceFresh ? outcome.label : "paused"}
        </span>
      </div>
      {!sourceFresh || analysis.outcome === "unavailable" ? (
        <p role="status" className="mt-2 text-[10px] leading-4 text-amber-200">
          Unavailable until certified candle history and valid entry, invalidation, and selected target are present.
        </p>
      ) : analysis.outcome === "entry_not_touched" ? (
        <p className="mt-2 text-[10px] leading-4 text-[#9aa7bc]">
          Entry was not executable in {analysis.sampleSize} closed historical bars; no post-entry excursion is claimed.
        </p>
      ) : analysis.outcome === "awaiting_follow_through" ? (
        <p className="mt-2 text-[10px] leading-4 text-[#9aa7bc]">
          Entry became executable on the latest closed bar. No later closed bar exists for outcome analysis.
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-3 gap-2">
          <PathMetric label="Bars to entry" value={formatBars(analysis.barsToEntry)} />
          <PathMetric label="Bars observed" value={String(analysis.postEntryBars)} />
          <PathMetric label="Resolution" value={outcome.label} tone={outcome.metricTone} />
          <PathMetric
            label="MFE"
            value={formatExcursion(analysis.maxFavorableExcursionBps, analysis.maxFavorableExcursionUsd)}
            tone="good"
          />
          <PathMetric
            label="MAE"
            value={formatExcursion(analysis.maxAdverseExcursionBps, analysis.maxAdverseExcursionUsd)}
            tone="bad"
          />
          <PathMetric label="Closed sample" value={`${analysis.sampleSize} bars`} />
        </div>
      )}
      <p className="mt-2 text-[9px] leading-4 text-[#566278]">
        {replay ? "Revealed replay prefix" : "Latest certified history"} · hypothetical resting limit active before the first bar. Newest and entry bars are excluded; OHLC cannot resolve intrabar ordering. Excursions stop at the first terminal touch. No fill, queue, gap, fee, or probability claim.
      </p>
    </section>
  );
});

function PathMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "warn" | "neutral";
}) {
  const color = tone === "good"
    ? "text-emerald-300"
    : tone === "bad"
      ? "text-rose-300"
      : tone === "warn"
        ? "text-amber-200"
        : "text-[#c7d2e4]";
  return (
    <div className="min-w-0">
      <p className="truncate text-[8px] uppercase tracking-[0.12em] text-[#8491a8]">{label}</p>
      <p className={`mt-0.5 truncate font-mono text-[10px] tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function outcomeCopy(outcome: PlanPath["outcome"]): {
  label: string;
  tone: string;
  metricTone: "good" | "bad" | "warn" | "neutral";
} {
  if (outcome === "target_first") return { label: "target first", tone: "text-emerald-300", metricTone: "good" };
  if (outcome === "stop_first") return { label: "invalidation first", tone: "text-rose-300", metricTone: "bad" };
  if (outcome === "ambiguous_same_bar") return { label: "same-bar ambiguous", tone: "text-amber-200", metricTone: "warn" };
  if (outcome === "neither_touched") return { label: "still open", tone: "text-sky-200", metricTone: "neutral" };
  if (outcome === "entry_not_touched") return { label: "not entered", tone: "text-[#8b95a8]", metricTone: "neutral" };
  if (outcome === "awaiting_follow_through") return { label: "entry touched", tone: "text-sky-200", metricTone: "neutral" };
  return { label: "unavailable", tone: "text-[#6f7d9a]", metricTone: "neutral" };
}

function formatBars(value: number | null) {
  return value == null ? "—" : value === 0 ? "first bar" : `${value} bar${value === 1 ? "" : "s"}`;
}

function formatExcursion(bps: number | null, usd: number | null) {
  return bps == null || usd == null ? "—" : `${bps.toFixed(0)} bp · $${usd.toFixed(2)}`;
}
