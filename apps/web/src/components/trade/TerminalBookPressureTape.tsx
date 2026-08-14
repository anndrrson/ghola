"use client";

import { memo, useEffect, useMemo, useReducer } from "react";
import type { GholaMarketFrame } from "@/lib/ghola-market-chart";
import {
  advanceTerminalBookPressureTape,
  initialTerminalBookPressureState,
  type TerminalBookPressureBlocker,
  type TerminalBookPressureClassification,
  type TerminalBookPressureInput,
  type TerminalBookPressureState,
} from "@/lib/terminal-book-pressure";

export interface TerminalBookPressureTapeProps {
  frame: GholaMarketFrame | null;
  selectedVenue: string;
  selectedProduct: string;
  selectedInterval: string;
  network: string;
  bookAgeMs: number | null | undefined;
  observedAtMs: number;
  controllerStale?: boolean;
  synthetic?: boolean;
}

export const TerminalBookPressureTape = memo(function TerminalBookPressureTape({
  frame,
  selectedVenue,
  selectedProduct,
  selectedInterval,
  network,
  bookAgeMs,
  observedAtMs,
  controllerStale,
  synthetic,
}: TerminalBookPressureTapeProps) {
  const input = useMemo<TerminalBookPressureInput>(() => ({
    frame,
    selectedVenue,
    selectedProduct,
    selectedInterval,
    network,
    bookAgeMs,
    controllerStale,
    synthetic,
    nowMs: observedAtMs,
  }), [
    bookAgeMs,
    controllerStale,
    frame,
    network,
    observedAtMs,
    selectedInterval,
    selectedProduct,
    selectedVenue,
    synthetic,
  ]);
  const [history, ingest] = useReducer(historyReducer, undefined, initialTerminalBookPressureState);
  const preview = useMemo(
    () => advanceTerminalBookPressureTape(history, input),
    [history, input],
  );

  useEffect(() => {
    ingest(input);
  }, [input]);

  const tape = preview.tape;
  if (tape.status === "unavailable" || !tape.latest || !tape.deltas || !tape.classification) {
    return (
      <section aria-labelledby="book-pressure-heading" aria-describedby="book-pressure-disclaimer" className="border-b border-[#182234] bg-[#080c13]">
        <div className="flex items-center justify-between gap-2 border-b border-[#141d2e] px-4 py-2">
          <h3 id="book-pressure-heading" className="text-[9px] font-semibold uppercase tracking-[0.13em] text-[#aebbd0]">
            Rolling book pressure
          </h3>
          <span className="font-mono text-[8px] tabular-nums text-[#6f7d9a]">
            {tape.historyCount}/90 samples
          </span>
        </div>
        <p role="status" className="px-4 py-3 text-center text-[9px] leading-4 text-amber-200">
          Pressure unavailable · {blockerLabel(tape.blocker)}
        </p>
        <PressureDisclaimer />
      </section>
    );
  }

  const { latest, deltas } = tape;
  return (
    <section aria-labelledby="book-pressure-heading" aria-describedby="book-pressure-disclaimer" className="border-b border-[#182234] bg-[#080c13] font-mono tabular-nums">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#141d2e] px-4 py-2">
        <h3 id="book-pressure-heading" className="font-sans text-[9px] font-semibold uppercase tracking-[0.13em] text-[#aebbd0]">
          Rolling book pressure
        </h3>
        <span className={`rounded-sm border px-1.5 py-0.5 text-[7px] uppercase tracking-[0.1em] ${classificationTone(tape.classification)}`}>
          {classificationLabel(tape.classification)}
        </span>
        <span className="text-[8px] text-[#6f7d9a]">
          {formatWindow(tape.horizonSeconds)} · {tape.updateCount} book updates
        </span>
      </div>
      <div className="grid grid-cols-2 gap-px bg-[#141d2e] sm:grid-cols-3">
        <PressureMetric
          label="Bid depth · 10L"
          value={formatUsd(latest.bidDepthUsd)}
          delta={formatSigned(deltas.bidDepthPct, "%")}
          tone="bid"
        />
        <PressureMetric
          label="Ask depth · 10L"
          value={formatUsd(latest.askDepthUsd)}
          delta={formatSigned(deltas.askDepthPct, "%")}
          tone="ask"
        />
        <PressureMetric
          label="Total depth"
          value={formatUsd(latest.totalDepthUsd)}
          delta={formatSigned(deltas.totalDepthPct, "%")}
        />
        <PressureMetric
          label="Imbalance"
          value={formatSigned(latest.imbalancePct, "%")}
          delta={`${formatSigned(deltas.imbalancePctPoints, "pp")} Δ`}
        />
        <PressureMetric
          label="Microprice edge"
          value={formatSigned(latest.micropriceEdgeBps, " bp")}
          delta={`${formatSigned(deltas.micropriceEdgeBps, " bp")} Δ`}
        />
        <PressureMetric
          label="Displayed spread"
          value={`${latest.spreadBps.toFixed(2)} bp`}
          delta={deltas.spreadRegime == null || deltas.spreadPercentile == null
            ? "regime building"
            : `${spreadRegimeLabel(deltas.spreadRegime)} · p${Math.round(deltas.spreadPercentile)}`}
        />
      </div>
      <PressureDisclaimer />
    </section>
  );
});

function historyReducer(
  state: TerminalBookPressureState,
  input: TerminalBookPressureInput,
) {
  return advanceTerminalBookPressureTape(state, input).state;
}

function PressureMetric({
  label,
  value,
  delta,
  tone = "neutral",
}: {
  label: string;
  value: string;
  delta: string;
  tone?: "bid" | "ask" | "neutral";
}) {
  const valueTone = tone === "bid"
    ? "text-emerald-300"
    : tone === "ask"
      ? "text-rose-300"
      : "text-[#dce6f4]";
  return (
    <div className="min-w-0 bg-[#080c13] px-3 py-2">
      <p className="truncate font-sans text-[7px] uppercase tracking-[0.1em] text-[#687792]">{label}</p>
      <p className={`mt-0.5 truncate text-[10px] ${valueTone}`}>{value}</p>
      <p className="mt-0.5 truncate text-[8px] text-[#8795ac]">{delta}</p>
    </div>
  );
}

function PressureDisclaimer() {
  return (
    <p id="book-pressure-disclaimer" className="border-t border-[#141d2e] px-3 py-2 text-[8px] leading-3.5 text-[#6f7d9a]">
      Public top-10 displayed-depth change only; not order intent or add/cancel attribution. Hidden liquidity, queue position, and future direction are unknown.
    </p>
  );
}

function blockerLabel(blocker: TerminalBookPressureBlocker | null) {
  if (blocker === "frame_unavailable") return "waiting for a public live book";
  if (blocker === "synthetic_frame") return "synthetic depth is excluded";
  if (blocker === "stale_frame") return "the public book is stale";
  if (blocker === "market_identity_mismatch") return "book identity does not match the selection";
  if (blocker === "network_invalid") return "network identity is unavailable";
  if (blocker === "book_age_invalid") return "book age is unavailable";
  if (blocker === "book_clock_missing") return "exact book source time is missing";
  if (blocker === "book_clock_future") return "book source time is in the future";
  if (blocker === "book_clock_expired") return "book source time is older than 30s";
  if (blocker === "book_empty") return "both displayed book sides are required";
  if (blocker === "book_level_invalid") return "displayed depth contains invalid levels";
  if (blocker === "book_crossed") return "the displayed book is crossed";
  if (blocker === "book_clock_regression") return "book source time regressed";
  if (blocker === "book_clock_collision") return "depth changed without a new book clock";
  return "collecting 5–30s of exact book-clock history";
}

function classificationLabel(classification: TerminalBookPressureClassification) {
  if (classification === "bid_strengthening") return "Bid depth strengthening";
  if (classification === "ask_strengthening") return "Ask depth strengthening";
  return "Displayed depth balanced";
}

function classificationTone(classification: TerminalBookPressureClassification) {
  if (classification === "bid_strengthening") return "border-emerald-400/35 bg-emerald-400/10 text-emerald-200";
  if (classification === "ask_strengthening") return "border-rose-400/35 bg-rose-400/10 text-rose-200";
  return "border-slate-400/25 bg-slate-400/10 text-slate-300";
}

function spreadRegimeLabel(regime: "tight" | "normal" | "wide") {
  return regime === "tight" ? "tight 30s" : regime === "wide" ? "wide 30s" : "normal 30s";
}

function formatUsd(value: number) {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}m`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

function formatSigned(value: number, suffix: string) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}${suffix}`;
}

function formatWindow(value: number | null) {
  return value == null ? "5–30s" : `${value.toFixed(value % 1 === 0 ? 0 : 1)}s`;
}
