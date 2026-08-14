"use client";

import { memo } from "react";
import type {
  TerminalInvalidationAtrMultiplier,
  TerminalInvalidationPlan,
} from "@/lib/terminal-invalidation-planner";

export const TerminalInvalidationPlanner = memo(function TerminalInvalidationPlanner({
  plan,
  onStage,
}: {
  plan: TerminalInvalidationPlan;
  onStage: (multiplier: TerminalInvalidationAtrMultiplier, expectedPrice: number) => void;
}) {
  return (
    <section aria-labelledby="invalidation-planner-heading" className="mb-4 rounded-md border border-[#182234] bg-[#080c13] p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="invalidation-planner-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">
          ATR invalidation planner
        </h2>
        <span className={`font-mono text-[9px] uppercase ${plan.status === "ready" ? "text-sky-200" : "text-amber-200"}`}>
          {plan.status === "ready" ? `ATR ${formatPrice(plan.atr)}` : "paused"}
        </span>
      </div>
      {plan.status === "unavailable" ? (
        <p role="status" className="mt-2 text-[10px] leading-4 text-amber-200">
          Waiting for certified candle ATR plus valid entry, notional, slippage, round-trip cost assumptions, and loss budget.
        </p>
      ) : (
        <div role="list" aria-label="ATR invalidation candidates" className="mt-2 grid gap-2 sm:grid-cols-3">
          {plan.candidates.map((candidate) => (
            <article key={candidate.multiplier} role="listitem" className="rounded border border-[#172235] bg-[#0a0f18] p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] font-semibold text-sky-200">{candidate.multiplier.toFixed(1)}× ATR</span>
                <button
                  type="button"
                  onClick={() => onStage(candidate.multiplier, candidate.invalidationPrice)}
                  className="rounded border border-sky-300/30 bg-sky-300/[0.06] px-2 py-1 text-[9px] text-sky-200 hover:bg-sky-300/10"
                  aria-label={`Stage ${candidate.multiplier.toFixed(1)} ATR plan invalidation at ${formatPrice(candidate.invalidationPrice)}`}
                >
                  Stage
                </button>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-[8px] tabular-nums">
                <Metric label="Level" value={formatPrice(candidate.invalidationPrice)} />
                <Metric label="Distance" value={`${candidate.distanceBps.toFixed(0)} bp`} />
                <Metric label="Plan loss" value={`$${candidate.modeledLossUsd.toFixed(2)}`} />
                <Metric label="Budget" value={`${candidate.budgetUtilizationPct.toFixed(0)}%`} />
                <Metric label="Safe size" value={`$${candidate.safeNotionalUsd.toFixed(2)}`} />
              </dl>
            </article>
          ))}
        </div>
      )}
      <p className="mt-2 text-[9px] leading-4 text-[#566278]">
        Certified candle ATR only. Plan loss and safe size include explicit selected-venue round-trip costs. Staging pins the plan invalidation and clears stale bindings; it never previews or submits. ATR is descriptive—not a loss guarantee, venue stop, or bracket order.
      </p>
    </section>
  );
});

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="uppercase tracking-[0.08em] text-[#566278]">{label}</dt>
      <dd className="mt-0.5 text-[#c7d2e4]">{value}</dd>
    </div>
  );
}

function formatPrice(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 1_000 ? value.toFixed(1) : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
}
