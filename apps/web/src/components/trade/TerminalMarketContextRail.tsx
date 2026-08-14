"use client";

import { memo } from "react";

export interface TerminalMarketContextRailProps {
  venue: string;
  product: string;
  side: "buy" | "sell";
  notionalUsd: number;
  quoteReady: boolean;
  quoteMid: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  quoteAgeMs: number | null;
  entryPrice: number | null;
  invalidationPrice: number | null;
  riskAllowed: boolean;
  modeledLossUsd: number | null;
  riskBudgetUsd: number | null;
  onAuto: () => void;
  onJoin: () => void;
  onCross: () => void;
}

/** Hot, bounded context that remains visible while the large workstation scrolls. */
export const TerminalMarketContextRail = memo(function TerminalMarketContextRail({
  venue,
  product,
  side,
  notionalUsd,
  quoteReady,
  quoteMid,
  bestBid,
  bestAsk,
  quoteAgeMs,
  entryPrice,
  invalidationPrice,
  riskAllowed,
  modeledLossUsd,
  riskBudgetUsd,
  onAuto,
  onJoin,
  onCross,
}: TerminalMarketContextRailProps) {
  return (
    <section
      id="terminal-market-context"
      aria-label="Persistent market and staged plan context"
      className="sticky top-0 z-30 border-y border-[#1a273b] bg-[#070b12]/95 shadow-[0_8px_24px_rgba(0,0,0,0.32)] backdrop-blur-md"
    >
      <div className="flex h-11 min-w-0 items-center gap-3 overflow-x-auto overscroll-x-contain px-3 font-mono text-[9px] tabular-nums sm:px-6">
        <div className="shrink-0">
          <span className="block uppercase tracking-[0.12em] text-[#65738a]">{venue}</span>
          <span className="block font-semibold text-[#dce6f4]">{product}</span>
        </div>
        <RailDivider />
        <RailMetric label="BBO mid" value={quoteReady ? formatPrice(quoteMid) : "PAUSED"} tone={quoteReady ? "good" : "bad"} />
        <RailMetric label="Bid / ask" value={quoteReady ? `${formatPrice(bestBid)} / ${formatPrice(bestAsk)}` : "— / —"} />
        <RailMetric label="Quote age" value={quoteReady ? formatAge(quoteAgeMs) : "uncertified"} />
        <RailDivider />
        <RailMetric label={`${side.toUpperCase()} value`} value={formatUsd(notionalUsd)} tone={side === "buy" ? "good" : "bad"} />
        <RailMetric label="Entry" value={formatPrice(entryPrice)} />
        <RailMetric label="Invalidation" value={formatPrice(invalidationPrice)} />
        <RailMetric
          label="Modeled loss"
          value={`${formatUsd(modeledLossUsd)} / ${formatUsd(riskBudgetUsd)}`}
          tone={riskAllowed ? "good" : "bad"}
        />
        <RailDivider />
        <div className="ml-auto flex shrink-0 items-center gap-1" role="group" aria-label="Persistent price intent staging">
          <RailButton label="Auto" shortcut="U" onClick={onAuto} />
          <RailButton label="Join" shortcut="J" disabled={!quoteReady} onClick={onJoin} />
          <RailButton label="Cross" shortcut="X" disabled={!quoteReady} onClick={onCross} />
        </div>
      </div>
    </section>
  );
});

function RailMetric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "bad" }) {
  return (
    <div className="shrink-0">
      <span className="block uppercase tracking-[0.1em] text-[#65738a]">{label}</span>
      <span className={tone === "good" ? "block text-emerald-300" : tone === "bad" ? "block text-rose-300" : "block text-[#c3cede]"}>{value}</span>
    </div>
  );
}

function RailButton({ label, shortcut, disabled = false, onClick }: { label: string; shortcut: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-keyshortcuts={shortcut}
      disabled={disabled}
      onClick={onClick}
      className="h-7 rounded border border-[#2b3a52] bg-[#0b121d] px-2 text-[8px] font-semibold uppercase text-sky-200 hover:border-sky-300/45 disabled:cursor-not-allowed disabled:text-[#566278]"
    >
      {label} <kbd className="ml-0.5 text-[7px] opacity-65">{shortcut}</kbd>
    </button>
  );
}

function RailDivider() {
  return <span aria-hidden className="h-6 w-px shrink-0 bg-[#223048]" />;
}

function formatPrice(value: number | null) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: value >= 1_000 ? 2 : 6 });
}

function formatUsd(value: number | null) {
  return value == null || !Number.isFinite(value) || value < 0
    ? "—"
    : `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatAge(value: number | null) {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}
