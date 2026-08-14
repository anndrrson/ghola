"use client";

import { memo } from "react";
import {
  terminalEntryOutcomeMatrixEqual,
  terminalEntrySizeRecommendation,
  type TerminalEntryOutcomeMatrix as TerminalEntryOutcomeMatrixModel,
  type TerminalEntryOutcomeMode,
  type TerminalEntrySizeRecommendation,
} from "@/lib/terminal-entry-outcome-matrix";

export const TerminalEntryOutcomeMatrix = memo(function TerminalEntryOutcomeMatrix({
  matrix,
  onStage,
  onStageSafeSized,
}: {
  matrix: TerminalEntryOutcomeMatrixModel;
  onStage: (mode: Extract<TerminalEntryOutcomeMode, "join" | "cross">) => void;
  onStageSafeSized: (
    mode: Extract<TerminalEntryOutcomeMode, "join" | "cross">,
    expectedPrice: number,
    recommendation: TerminalEntrySizeRecommendation,
  ) => void;
}) {
  if (matrix.status === "unavailable") {
    return (
      <section aria-label="Entry outcome matrix" className="mt-2 rounded-md border border-[#172235] bg-[#080d15] px-2.5 py-2">
        <p className="text-[8px] leading-3.5 text-[#66738c]">Entry outcomes paused · waiting for certified depth and valid prices.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="entry-outcome-heading" className="mt-2 overflow-hidden rounded-md border border-[#172235] bg-[#080d15]">
      <div className="flex items-center justify-between gap-2 border-b border-[#141d2e] px-2.5 py-2">
        <h3 id="entry-outcome-heading" className="text-[8px] font-semibold uppercase tracking-[0.14em] text-[#7d8ba5]">Entry outcomes</h3>
        <span className="text-[8px] text-[#566278]">certified depth · no submit</span>
      </div>
      <div role="list" aria-label="Visible-book and modeled-risk entry outcome comparison">
        {matrix.outcomes.map((outcome) => (
          <article
            key={outcome.mode}
            role="listitem"
            aria-label={`${outcome.mode} entry outcome`}
            className={`border-t border-[#111a29] px-2.5 py-2 first:border-t-0 ${outcome.mode === "current" ? "bg-[#0d1a2b]" : ""}`}
          >
            <div className="flex items-center justify-between gap-2 font-mono text-[8px] tabular-nums">
              <div className="flex items-center gap-1.5">
                {outcome.mode === "current" ? (
                  <span className="font-semibold uppercase text-[#dce6f4]">Current</span>
                ) : (
                  <button type="button" aria-keyshortcuts={outcome.mode === "join" ? "J" : "X"} onClick={() => onStage(outcome.mode === "join" ? "join" : "cross")} className="font-semibold uppercase text-sky-200 underline decoration-sky-300/30 underline-offset-2">
                    Stage {outcome.mode}
                  </button>
                )}
                <span className={`uppercase ${outcome.intent === "marketable" ? "text-amber-200" : "text-[#66738c]"}`}>{outcome.intent}</span>
              </div>
              <span className="text-[10px] text-[#dce6f4]">{formatPrice(outcome.price)}</span>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1.5 font-mono text-[8px] tabular-nums">
              <Metric label="Visible fill" value={`${outcome.quality.fillPct.toFixed(0)}%`} tone={fillTone(outcome.quality.fillPct)} />
              <Metric label="VWAP" value={formatPrice(outcome.quality.vwap)} />
              <Metric label="Impact" value={formatBps(outcome.quality.impactBps)} />
              <Metric label="Unfilled" value={formatUsd(outcome.quality.unfilledNotionalUsd)} />
              <Metric label="Plan loss" value={outcome.risk.stopValid ? formatLossUsd(outcome.risk.modeledLossUsd) : "invalid"} tone={outcome.risk.stopValid ? undefined : "text-rose-300"} />
              <Metric label="Budget" value={formatBudget(outcome.risk.budgetUtilizationPct, outcome.risk.budgetAllowed)} tone={budgetTone(outcome.risk.budgetAllowed)} />
            </dl>
            <div className="mt-2 flex min-h-6 items-center justify-between gap-2 border-t border-[#172235] pt-2 font-mono text-[8px] tabular-nums">
              <span className="text-[#66738c]">Modeled cap <strong className="font-normal text-[#c7d2e4]">{formatUsd(outcome.risk.recommendedNotionalUsd)}</strong>{outcome.risk.recommendationConstraint ? <span> · {constraintLabel(outcome.risk.recommendationConstraint)}</span> : null}</span>
              {outcome.mode !== "current" && outcome.risk.recommendedNotionalUsd != null && outcome.risk.canApplyRecommendedNotional ? (
                <button
                  type="button"
                  aria-keyshortcuts={outcome.mode === "join" ? "Shift+J" : "Shift+X"}
                  onClick={() => {
                    const recommendation = terminalEntrySizeRecommendation(outcome);
                    if (recommendation?.canApply) {
                      onStageSafeSized(outcome.mode === "join" ? "join" : "cross", outcome.price, recommendation);
                    }
                  }}
                  className="rounded border border-sky-300/30 bg-sky-300/[0.06] px-2 py-1 text-sky-200 hover:bg-sky-300/10"
                  aria-label={`Stage ${outcome.mode} and reduce notional to the modeled cap ${formatUsd(outcome.risk.recommendedNotionalUsd)}`}
                >
                  Stage + cap {formatUsd(outcome.risk.recommendedNotionalUsd)}
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <p className="border-t border-[#141d2e] px-2.5 py-1.5 text-[8px] leading-3.5 text-[#566278]">Marketable modeled cap is the smaller of the local risk cap and fully fillable displayed depth. Resting entries use risk only because queue fills are unknowable. Apply actions only reduce exposure; they never upsize. Excludes hidden liquidity, latency, and fees; staging never previews or submits.</p>
    </section>
  );
}, (previous, next) => previous.onStage === next.onStage
  && previous.onStageSafeSized === next.onStageSafeSized
  && terminalEntryOutcomeMatrixEqual(previous.matrix, next.matrix));

function Metric({ label, value, tone = "text-[#aeb9cb]" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-[7px] uppercase tracking-[0.08em] text-[#566278]">{label}</dt>
      <dd className={`mt-0.5 ${tone}`}>{value}</dd>
    </div>
  );
}

function formatPrice(value: number | null) {
  return value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: value >= 1_000 ? 2 : 6 });
}

function formatBps(value: number | null) {
  return value == null ? "—" : `${value.toFixed(1)} bp`;
}

function formatUsd(value: number | null) {
  return value == null ? "—" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatLossUsd(value: number | null) {
  return value == null ? "—" : `$${value.toFixed(2)}`;
}

function fillTone(value: number) {
  return value >= 99.999 ? "text-emerald-300" : value > 0 ? "text-amber-200" : "text-[#718097]";
}

function formatBudget(value: number | null, allowed: boolean | null) {
  if (value == null || allowed == null) return "—";
  return `${value.toFixed(0)}% ${allowed ? "pass" : "block"}`;
}

function budgetTone(value: boolean | null) {
  return value == null ? "text-[#718097]" : value ? "text-emerald-300" : "text-rose-300";
}

function constraintLabel(value: "risk_budget" | "visible_liquidity") {
  return value === "visible_liquidity" ? "depth cap" : "risk cap";
}
