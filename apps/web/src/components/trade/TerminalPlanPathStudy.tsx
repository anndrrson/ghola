"use client";

import { memo } from "react";
import {
  terminalPlanPathStudiesEqual,
  type TerminalPlanPathStudy as PathStudy,
} from "@/lib/terminal-plan-path-study";

export const TerminalPlanPathStudy = memo(function TerminalPlanPathStudy({
  studies,
  replay,
  sourceFresh,
}: {
  studies: PathStudy[];
  replay: boolean;
  sourceFresh: boolean;
}) {
  const primary = studies.find((study) => study.horizonBars === 20) ?? studies[0] ?? null;
  const unavailable = !sourceFresh || primary == null || primary.status === "unavailable";
  return (
    <section aria-labelledby="plan-path-study-heading" className="mb-4 rounded-md border border-[#182234] bg-[#080c13] p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="plan-path-study-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">
          Historical path study
        </h2>
        <span className={`font-mono text-[9px] font-semibold uppercase tracking-[0.12em] ${unavailable ? "text-amber-200" : "text-sky-200"}`}>
          {unavailable ? "paused" : `${primary.episodeCount} episode${primary.episodeCount === 1 ? "" : "s"} · 20 bars`}
        </span>
      </div>
      {unavailable ? (
        <p role="status" className="mt-2 text-[10px] leading-4 text-amber-200">
          Unavailable until certified closed history and a valid entry, invalidation, and target are present.
        </p>
      ) : primary.episodeCount === 0 ? (
        <p className="mt-2 text-[10px] leading-4 text-[#9aa7bc]">
          No non-overlapping entry touch occurred in {primary.sampleSize} closed bars.
        </p>
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StudyMetric label="Target first" value={`${primary.targetFirstCount}`} tone="good" />
            <StudyMetric label="Invalidation first" value={`${primary.stopFirstCount}`} tone="bad" />
            <StudyMetric label="Resolved hit rate" value={`${formatPct(primary.targetFirstRatePct)} · n=${primary.resolvedCount}`} tone="good" />
            <StudyMetric label="Resolved expectancy" value={formatR(primary.expectancyR)} tone={expectancyTone(primary.expectancyR)} />
          </dl>
          <div className="mt-2 overflow-x-auto" tabIndex={0} aria-label="Scrollable historical path horizon comparison">
            <table className="w-full min-w-[32rem] border-collapse font-mono text-[9px] tabular-nums">
              <caption className="sr-only">Non-overlapping path outcomes compared across 5, 20, and 50 post-entry bar horizons.</caption>
              <thead className="text-[#718097]">
                <tr>
                  <th scope="col" className="py-1.5 pr-2 text-left font-normal">Horizon</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-normal">Entries</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-normal">Resolved</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-normal">T / I</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-normal">Amb / open</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-normal">Hit rate</th>
                  <th scope="col" className="py-1.5 pl-2 text-right font-normal">Expectancy</th>
                </tr>
              </thead>
              <tbody>
                {studies.map((study) => (
                  <tr key={study.horizonBars} className={`border-t border-[#141d2e] ${study.horizonBars === 20 ? "bg-sky-300/[0.04]" : ""}`}>
                    <th scope="row" className="py-1.5 pr-2 text-left font-semibold text-[#c7d2e4]">{study.horizonBars} bars</th>
                    <td className="px-2 py-1.5 text-right text-[#aeb9cb]">{study.episodeCount}</td>
                    <td className="px-2 py-1.5 text-right text-[#aeb9cb]">{study.resolvedCount}</td>
                    <td className="px-2 py-1.5 text-right"><span className="text-emerald-300">{study.targetFirstCount}</span> / <span className="text-rose-300">{study.stopFirstCount}</span></td>
                    <td className="px-2 py-1.5 text-right text-amber-200">{study.ambiguousCount} / {study.unresolvedCount}</td>
                    <td className="px-2 py-1.5 text-right text-[#c7d2e4]">{formatPct(study.targetFirstRatePct)}</td>
                    <td className={`py-1.5 pl-2 text-right ${expectancyClass(study.expectancyR)}`}>{formatR(study.expectancyR)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="mt-2 text-[9px] leading-4 text-[#566278]">
        {replay ? "Revealed replay prefix" : "Latest certified history"} · fixed current plan and non-overlapping entries at 5/20/50-bar horizons. Any terminal touch on the entry bar is ambiguous; the newest bar is excluded. Ambiguous and unresolved episodes are excluded from hit rate and expectancy. Descriptive only—not a probability, fill, queue, gap, fee, or forecast claim.
      </p>
    </section>
  );
}, (previous, next) => previous.replay === next.replay
  && previous.sourceFresh === next.sourceFresh
  && terminalPlanPathStudiesEqual(previous.studies, next.studies));

function StudyMetric({
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
      <dt className="truncate text-[8px] uppercase tracking-[0.12em] text-[#8491a8]">{label}</dt>
      <dd className={`mt-0.5 truncate font-mono text-[10px] tabular-nums ${color}`}>{value}</dd>
    </div>
  );
}

function formatPct(value: number | null) {
  return value == null ? "—" : `${value.toFixed(0)}%`;
}

function formatR(value: number | null) {
  return value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function expectancyTone(value: number | null): "good" | "bad" | "neutral" {
  return value == null ? "neutral" : value >= 0 ? "good" : "bad";
}

function expectancyClass(value: number | null) {
  return value == null ? "text-[#718097]" : value >= 0 ? "text-emerald-300" : "text-rose-300";
}
