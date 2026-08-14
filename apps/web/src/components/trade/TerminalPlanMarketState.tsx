"use client";

import { memo } from "react";
import {
  terminalPlanMarketStateBlockerLabel,
  type TerminalPlanMarketState as PlanState,
} from "@/lib/terminal-plan-market-state";

const PRICE_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const LARGE_PRICE_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export const TerminalPlanMarketState = memo(function TerminalPlanMarketState({
  decision,
}: {
  decision: PlanState;
}) {
  if (!decision.allowed) {
    return (
      <section aria-labelledby="plan-market-state-heading" className="mb-4 rounded-md border border-rose-400/30 bg-rose-400/[0.04] p-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="plan-market-state-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">Plan state</h2>
          <span className="font-mono text-[9px] font-semibold uppercase text-rose-300">blocked</span>
        </div>
        <p role="alert" className="mt-2 text-[10px] leading-4 text-rose-200">
          {terminalPlanMarketStateBlockerLabel(decision.blocker)}. Restage the entry or invalidation before previewing or submitting.
        </p>
      </section>
    );
  }
  const marketable = decision.mode === "marketable";
  return (
    <section aria-labelledby="plan-market-state-heading" className="mb-4 rounded-md border border-[#182234] bg-[#080c13] p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="plan-market-state-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">Plan state</h2>
        <span className={`font-mono text-[9px] font-semibold uppercase ${marketable ? "text-amber-200" : "text-sky-200"}`}>
          {marketable ? "marketable" : "resting"}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <PlanMetric label="Executable BBO" value={formatPrice(decision.executablePrice)} />
        <PlanMetric
          label={marketable ? "Through BBO" : "From BBO"}
          value={`${Math.abs(decision.distanceToMarketBps).toFixed(1)} bp`}
          tone={marketable ? "warn" : "neutral"}
        />
        <PlanMetric label="Risk beyond quote" value={`${decision.remainingRiskBps.toFixed(1)} bp`} tone="good" />
      </div>
      <p className="mt-2 text-[9px] leading-4 text-[#566278]">
        {marketable
          ? "The staged limit crosses current BBO. Submission remains capped by the limit; displayed liquidity and price can change before venue acceptance."
          : "The staged limit currently rests away from BBO. A gap can fill beyond the intended plan state; no bracket protection is implied."}
      </p>
    </section>
  );
});

function PlanMetric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "good" | "warn" | "neutral" }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[8px] uppercase tracking-[0.12em] text-[#8491a8]">{label}</p>
      <p className={`mt-0.5 truncate font-mono text-[10px] tabular-nums ${tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-200" : "text-[#c7d2e4]"}`}>{value}</p>
    </div>
  );
}

function formatPrice(value: number) {
  return (value >= 1_000 ? LARGE_PRICE_FORMAT : PRICE_FORMAT).format(value);
}
