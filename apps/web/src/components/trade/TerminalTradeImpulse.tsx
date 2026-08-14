"use client";

import { memo } from "react";
import {
  terminalCertifiedTapeViewEqual,
  type TerminalCertifiedMarketSignals,
} from "@/lib/terminal-certified-market-signals";
import {
  deriveTerminalTradeImpulse,
  terminalTradeImpulseAgeBucket,
  type TerminalTradeImpulseClassification,
} from "@/lib/terminal-trade-impulse";

export const TerminalTradeImpulse = memo(function TerminalTradeImpulse({
  signals,
}: {
  signals: TerminalCertifiedMarketSignals;
}) {
  const impulse = deriveTerminalTradeImpulse({
    certified: signals.components.trades.ready,
    componentAgeMs: signals.components.trades.ageMs,
    trades: signals.tape.trades,
  });
  if (impulse.status === "unavailable") return null;
  const classification = impulse.classification;

  return (
    <section aria-labelledby="terminal-trade-impulse-heading" className="mb-3 overflow-hidden rounded border border-[#182234] bg-[#080c13]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#141d2e] px-2.5 py-2">
        <h3 id="terminal-trade-impulse-heading" className="font-sans text-[8px] font-semibold uppercase tracking-[0.12em] text-[#aebbd0]">
          Print impulse
        </h3>
        <span className={`rounded-sm border px-1.5 py-0.5 font-sans text-[7px] uppercase tracking-[0.08em] ${classificationTone(classification)}`}>
          {classificationLabel(classification)}
        </span>
        <span className="text-[8px] text-[#6f7d9a]">
          {impulse.sampleCount} prints · {formatWindow(impulse.windowMs)} · {formatUsd(impulse.totalNotionalUsd)}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-[#141d2e] sm:grid-cols-4">
        <ImpulseMetric
          label="Net aggressor"
          value={formatSignedUsd(impulse.netAggressorNotionalUsd)}
          detail={`${formatPercent(impulse.buySharePct)} buy notional`}
          tone={signedTone(impulse.netAggressorNotionalUsd)}
        />
        <ImpulseMetric
          label="Print drift"
          value={formatSigned(impulse.priceChangeBps, " bp")}
          detail="oldest → newest"
          tone={signedTone(impulse.priceChangeBps)}
        />
        <ImpulseMetric
          label="Burst rate"
          value={impulse.printsPerSecond == null ? "—" : `${impulse.printsPerSecond.toFixed(2)}/s`}
          detail="within retained window"
        />
        <ImpulseMetric
          label="Largest print"
          value={formatUsd(impulse.largestPrintUsd)}
          detail={impulse.largestPrintSide ? `${impulse.largestPrintSide}-initiated` : "—"}
          tone={impulse.largestPrintSide === "buy" ? "good" : impulse.largestPrintSide === "sell" ? "bad" : "neutral"}
        />
      </dl>
      <p className="border-t border-[#141d2e] px-2.5 py-2 font-sans text-[8px] leading-3 text-[#66738c]">
        Latest 30s of certified provider-tagged prints only. Absorption and divergence are descriptive candidates; they do not prove order attribution or hidden liquidity and do not forecast direction.
      </p>
    </section>
  );
}, (previous, next) => terminalCertifiedTapeViewEqual(previous.signals, next.signals)
  && terminalTradeImpulseAgeBucket(previous.signals.components.trades.ageMs)
    === terminalTradeImpulseAgeBucket(next.signals.components.trades.ageMs));

function ImpulseMetric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "good" | "bad" | "neutral";
}) {
  return (
    <div className="min-w-0 bg-[#080c13] px-2.5 py-2">
      <dt className="truncate font-sans text-[7px] uppercase tracking-[0.08em] text-[#687792]">{label}</dt>
      <dd className={`mt-0.5 truncate text-[10px] ${metricTone(tone)}`}>{value}</dd>
      <dd className="mt-0.5 truncate text-[7px] text-[#6f7d9a]">{detail}</dd>
    </div>
  );
}

function classificationLabel(classification: TerminalTradeImpulseClassification | null) {
  if (classification === "buy_impulse") return "Buy impulse";
  if (classification === "buy_absorption_candidate") return "Buy absorption candidate";
  if (classification === "buy_divergence") return "Buy-flow divergence";
  if (classification === "sell_impulse") return "Sell impulse";
  if (classification === "sell_absorption_candidate") return "Sell absorption candidate";
  if (classification === "sell_divergence") return "Sell-flow divergence";
  if (classification === "mixed") return "Mixed flow";
  return "Building sample";
}

function classificationTone(classification: TerminalTradeImpulseClassification | null) {
  if (classification === "buy_impulse") return "border-emerald-300/30 bg-emerald-300/10 text-emerald-200";
  if (classification === "sell_impulse") return "border-rose-300/30 bg-rose-300/10 text-rose-200";
  if (classification?.includes("absorption") || classification?.includes("divergence")) {
    return "border-amber-300/30 bg-amber-300/10 text-amber-100";
  }
  return "border-slate-300/20 bg-slate-300/[0.04] text-slate-300";
}

function metricTone(tone: "good" | "bad" | "neutral") {
  return tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-[#dce6f4]";
}

function signedTone(value: number | null) {
  return value == null || value === 0 ? "neutral" : value > 0 ? "good" : "bad";
}

function formatWindow(value: number | null) {
  return value == null ? "—" : value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(1)}s`;
}

function formatPercent(value: number | null) {
  return value == null ? "—" : `${value.toFixed(0)}%`;
}

function formatUsd(value: number | null) {
  if (value == null) return "—";
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}m`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

function formatSignedUsd(value: number | null) {
  if (value == null) return "—";
  const absolute = formatUsd(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${absolute}`;
}

function formatSigned(value: number | null, suffix: string) {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}
