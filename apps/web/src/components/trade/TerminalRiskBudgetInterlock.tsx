"use client";

import { memo } from "react";
import type { TerminalRiskBudgetDecision } from "@/lib/terminal-risk-budget-interlock";
import type { TerminalEntrySizeRecommendation } from "@/lib/terminal-entry-outcome-matrix";
import type { TerminalPlanLossEnvelope } from "@/lib/terminal-plan-loss-envelope";

export interface TerminalRiskBudgetInterlockProps {
  decision: TerminalRiskBudgetDecision;
  lossEnvelope: TerminalPlanLossEnvelope;
  sizeRecommendation: TerminalEntrySizeRecommendation | null;
  onApplySafeNotional: (notionalUsd: number) => void;
  onOpenCostPolicy: () => void;
}

export const TerminalRiskBudgetInterlock = memo(function TerminalRiskBudgetInterlock({
  decision,
  lossEnvelope,
  sizeRecommendation,
  onApplySafeNotional,
  onOpenCostPolicy,
}: TerminalRiskBudgetInterlockProps) {
  const statusLabel = decision.allowed ? "PASS" : "BLOCKED";
  const statusTone = decision.allowed
    ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-200"
    : "border-rose-400/45 bg-rose-400/10 text-rose-200";
  const progressValue = decision.utilizationPct == null
    ? null
    : Math.max(0, Math.min(100, decision.utilizationPct));
  const reductionAvailable = sizeRecommendation?.canApply === true;

  return (
    <section
      id="risk-budget-interlock"
      aria-labelledby="risk-budget-interlock-heading"
      aria-describedby="risk-budget-interlock-reason risk-budget-interlock-disclaimer"
      className="mb-4 rounded-md border border-[#182234] bg-[#080c13] p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="risk-budget-interlock-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">
          Risk-budget interlock
        </h2>
        <span role="status" aria-live="polite" aria-atomic="true" className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.12em] ${statusTone}`}>
          {statusLabel}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-2 font-mono tabular-nums sm:grid-cols-5">
        <RiskValue label="Stop + slip" value={formatUsd(lossEnvelope.stopAndSlippageLossUsd)} />
        <RiskValue label="Round-trip cost" value={formatUsd(lossEnvelope.roundTripCostLossUsd)} />
        <RiskValue label="All-in loss" value={formatUsd(decision.modeledLossUsd)} />
        <RiskValue label="Budget" value={formatUsd(decision.riskBudgetUsd)} />
        <RiskValue label="Utilization" value={formatPercent(decision.utilizationPct)} />
      </dl>

      <div className="mt-2 h-1 overflow-hidden rounded bg-[#1b2638]" role="progressbar" aria-label="Modeled loss budget utilization" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressValue ?? undefined} aria-valuetext={decision.utilizationPct == null ? "Unavailable" : formatPercent(decision.utilizationPct)}>
        {progressValue == null ? null : (
          <span className={`block h-full ${decision.allowed ? "bg-emerald-400" : "bg-rose-400"}`} style={{ width: `${progressValue}%` }} />
        )}
      </div>

      <div className="mt-2 flex items-start justify-between gap-3">
        <p id="risk-budget-interlock-reason" className={`text-[9px] leading-4 ${decision.allowed ? "text-emerald-200/80" : "text-rose-200"}`}>
          {decision.reason}
        </p>
        {lossEnvelope.ready ? <button
          id="terminal-apply-safe-size"
          type="button"
          disabled={!reductionAvailable}
          onClick={() => {
            if (reductionAvailable && sizeRecommendation) onApplySafeNotional(sizeRecommendation.notionalUsd);
          }}
          className="trade-chip h-8 shrink-0 rounded-md px-2.5 text-[9px] font-semibold disabled:cursor-not-allowed disabled:opacity-35"
        >
          {reductionAvailable ? "Reduce to" : "Modeled cap"} {sizeRecommendation == null ? "—" : `${formatUsd(sizeRecommendation.notionalUsd)} · ${constraintLabel(sizeRecommendation.constraint)}`}
        </button> : <button
          type="button"
          onClick={onOpenCostPolicy}
          className="trade-chip h-8 shrink-0 rounded-md px-2.5 text-[9px] font-semibold"
        >Set route costs</button>}
      </div>

      <p id="risk-budget-interlock-disclaimer" className="mt-2 text-[9px] leading-4 text-amber-200/75">
        {lossEnvelope.ready
          ? `All-in uses explicit ${formatBps(lossEnvelope.feeBps)} fee + ${formatBps(lossEnvelope.bufferBps)} execution buffer on both entry and exit. `
          : `${lossEnvelope.reason} `}
        Marketable sizing also caps to certified displayed depth. Apply only reduces and never upsizes. The plan invalidation is not a venue bracket order; gaps, hidden liquidity, outages, funding, or venue failures may exceed the model.
      </p>
    </section>
  );
}, (previous, next) => previous.onApplySafeNotional === next.onApplySafeNotional
  && previous.onOpenCostPolicy === next.onOpenCostPolicy
  && riskDecisionEqual(previous.decision, next.decision)
  && lossEnvelopeEqual(previous.lossEnvelope, next.lossEnvelope)
  && sizeRecommendationEqual(previous.sizeRecommendation, next.sizeRecommendation));

function lossEnvelopeEqual(left: TerminalPlanLossEnvelope, right: TerminalPlanLossEnvelope) {
  return left === right || Object.keys(left).every((key) => Object.is(left[key as keyof TerminalPlanLossEnvelope], right[key as keyof TerminalPlanLossEnvelope]));
}

const RISK_DECISION_KEYS = [
  "allowed",
  "status",
  "riskBudgetUsd",
  "modeledLossUsd",
  "utilizationPct",
  "safeNotionalUsd",
  "canApplySafeSize",
  "reason",
] as const satisfies readonly (keyof TerminalRiskBudgetDecision)[];

function riskDecisionEqual(left: TerminalRiskBudgetDecision, right: TerminalRiskBudgetDecision) {
  return left === right || RISK_DECISION_KEYS.every((key) => Object.is(left[key], right[key]));
}

function sizeRecommendationEqual(
  left: TerminalEntrySizeRecommendation | null,
  right: TerminalEntrySizeRecommendation | null,
) {
  return left === right || Boolean(left && right
    && left.notionalUsd === right.notionalUsd
    && left.constraint === right.constraint
    && left.canApply === right.canApply
    && left.riskCapNotionalUsd === right.riskCapNotionalUsd
    && left.visibleFullFillNotionalUsd === right.visibleFullFillNotionalUsd);
}

function constraintLabel(value: TerminalEntrySizeRecommendation["constraint"]) {
  return value === "visible_liquidity" ? "depth cap" : "risk cap";
}

function RiskValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="trade-field min-w-0 rounded px-2 py-1.5">
      <dt className="truncate text-[8px] uppercase tracking-[0.1em] text-[#66738c]">{label}</dt>
      <dd className="mt-0.5 truncate text-[10px] text-[#dce6f4]" title={value}>{value}</dd>
    </div>
  );
}

function formatUsd(value: number | null) {
  return value == null ? "—" : `$${value.toFixed(2)}`;
}

function formatPercent(value: number | null) {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function formatBps(value: number | null) {
  return value == null ? "—" : `${value.toFixed(2)} bp`;
}
