"use client";

import { memo } from "react";
import type { TerminalLiveAccountRiskDecision } from "@/lib/terminal-live-account-risk";

export const TerminalLivePortfolioInterlock = memo(function TerminalLivePortfolioInterlock({
  decision,
}: {
  decision: TerminalLiveAccountRiskDecision;
}) {
  if (decision.status === "not_applicable") return null;
  const blocked = !decision.allowed;
  const warning = decision.status === "warning";
  const label = blocked ? "BLOCKED" : warning ? "CAUTION" : "PASS";
  const tone = blocked
    ? "border-rose-400/45 bg-rose-400/10 text-rose-200"
    : warning
      ? "border-amber-300/40 bg-amber-300/10 text-amber-100"
      : "border-emerald-400/35 bg-emerald-400/10 text-emerald-200";
  return (
    <section aria-labelledby="live-portfolio-interlock-heading" className="mb-4 rounded-md border border-[#182234] bg-[#080c13] p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="live-portfolio-interlock-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">Live portfolio interlock</h2>
        <span role="status" aria-live="polite" aria-atomic="true" className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.12em] ${tone}`}>{label}</span>
      </div>
      <p className={`mt-2 text-[9px] leading-4 ${blocked ? "text-rose-200" : warning ? "text-amber-100" : "text-emerald-200/80"}`}>{decision.reason}</p>
      <p className="mt-2 text-[9px] leading-4 text-[#66738c]">Privacy-bucketed Hyperliquid account guard. Exact venue and server policy remain authoritative.</p>
    </section>
  );
});
