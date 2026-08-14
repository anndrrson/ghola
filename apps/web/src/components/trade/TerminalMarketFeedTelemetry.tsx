"use client";

import { memo, useId, useState } from "react";
import type { MarketFeedTelemetry } from "@/lib/market-feed-telemetry";
import {
  terminalCertifiedSignalBlockerLabel,
  type TerminalCertifiedMarketSignals,
  type TerminalCertifiedSignalComponent,
} from "@/lib/terminal-certified-market-signals";

const COMPONENTS: readonly TerminalCertifiedSignalComponent[] = ["quote", "book", "trades", "candles"];
const COMPONENT_LABELS: Record<TerminalCertifiedSignalComponent, string> = {
  quote: "Quote",
  book: "Book",
  trades: "Trades",
  candles: "Candles",
};

export const TerminalMarketFeedTelemetry = memo(function TerminalMarketFeedTelemetry({
  telemetry,
  peerGrades,
  components,
}: {
  telemetry: MarketFeedTelemetry;
  peerGrades: Array<{ venue: string; grade: MarketFeedTelemetry["healthGrade"] }>;
  components?: TerminalCertifiedMarketSignals["components"];
}) {
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const diagnosticsId = useId();
  const gradeTone = telemetry.healthGrade === "A" || telemetry.healthGrade === "B"
    ? "text-emerald-300"
    : telemetry.healthGrade === "C"
      ? "text-amber-300"
      : "text-rose-300";
  const recentEvents = telemetry.rollingEventCount;
  const componentLabels = components ? COMPONENTS.map((component) => componentAriaLabel(component, components[component])) : [];
  const fullLabel = [
    `Public market feed grade ${telemetry.healthGrade}, score ${telemetry.healthScore}`,
    `source age ${formatTelemetryMs(telemetry.sourceAgeMs)}`,
    `receipt latency ${formatTelemetryMs(telemetry.receiptLatencyMs)}`,
    `update rate ${telemetry.updateRateHz.toFixed(2)} hertz`,
    `${recentEvents} recent health events`,
    `reconnect, fallback, stale counters ${telemetry.reconnectCount}, ${telemetry.fallbackCount}, ${telemetry.staleCount}`,
    `sequence, timestamp, gap rejection counters ${telemetry.sequenceRegressionCount}, ${telemetry.timestampRegressionCount}, ${telemetry.gapRejectCount}`,
    ...componentLabels,
  ].join(". ");

  return (
    <section
      aria-label={fullLabel}
      className="mx-3 mb-2 rounded-md border border-[#182234] bg-[#080d15]/80 px-3 py-2 sm:mx-6 sm:mb-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] tabular-nums text-[#7f8da7]">
        <span className="flex items-center gap-1.5" title={`${telemetry.windowMs / 1_000}s rolling health score`}>
          Feed <b className={`font-semibold ${gradeTone}`}>{telemetry.healthGrade} · {telemetry.healthScore}</b>
        </span>
        <TelemetryValue label="Age" value={formatTelemetryMs(telemetry.sourceAgeMs)} />
        <TelemetryValue label="Rate" value={`${telemetry.updateRateHz.toFixed(2)} Hz`} />
        <span className={recentEvents > 0 ? "text-amber-200" : "text-emerald-300"}>
          {recentEvents > 0 ? `${recentEvents} recent event${recentEvents === 1 ? "" : "s"}` : "clean window"}
        </span>
        <button
          type="button"
          aria-expanded={mobileExpanded}
          aria-controls={diagnosticsId}
          onClick={() => setMobileExpanded((value) => !value)}
          className="ml-auto rounded px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-sky-200 outline-none hover:bg-sky-400/10 focus-visible:ring-1 focus-visible:ring-sky-300 sm:hidden"
        >
          {mobileExpanded ? "Less" : "Details"}
        </button>
      </div>
      {components ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-[#182234] pt-2" aria-label="Decision-surface component freshness">
          <span className="mr-1 text-[8px] font-semibold uppercase tracking-[0.1em] text-[#566278]">Certified</span>
          {COMPONENTS.map((component) => (
            <ComponentFreshness key={component} component={component} state={components[component]} />
          ))}
        </div>
      ) : null}
      <div
        id={diagnosticsId}
        className={`${mobileExpanded ? "mt-2 flex" : "hidden"} flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#182234] pt-2 font-mono text-[10px] tabular-nums text-[#7f8da7] sm:mt-1 sm:flex sm:border-0 sm:pt-0`}
      >
        <TelemetryValue label="Receipt latency" value={formatTelemetryMs(telemetry.receiptLatencyMs)} />
        <TelemetryValue
          label="Reconnect / fallback / stale"
          value={`${telemetry.reconnectCount} / ${telemetry.fallbackCount} / ${telemetry.staleCount}`}
        />
        <TelemetryValue
          label="Reject seq / time / gap"
          value={`${telemetry.sequenceRegressionCount} / ${telemetry.timestampRegressionCount} / ${telemetry.gapRejectCount}`}
        />
        {peerGrades.length > 0 ? (
          <TelemetryValue
            label="Peer grades"
            value={peerGrades.map((item) => `${item.venue} ${item.grade}`).join(" · ")}
          />
        ) : null}
      </div>
    </section>
  );
});

function TelemetryValue({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span>{label}</span>
      <span className="text-[#c7d2e4]">{value}</span>
    </span>
  );
}

function ComponentFreshness({
  component,
  state,
}: {
  component: TerminalCertifiedSignalComponent;
  state: TerminalCertifiedMarketSignals["components"][TerminalCertifiedSignalComponent];
}) {
  const reason = state.ready ? "certified" : terminalCertifiedSignalBlockerLabel(component, state.blocker);
  return (
    <span
      aria-label={componentAriaLabel(component, state)}
      title={`${COMPONENT_LABELS[component]} · ${reason}`}
      className={`rounded border px-1.5 py-0.5 font-mono text-[8px] tabular-nums ${state.ready ? "border-emerald-300/25 bg-emerald-300/[0.06] text-emerald-200" : "border-rose-300/25 bg-rose-300/[0.06] text-rose-200"}`}
    >
      {COMPONENT_LABELS[component]} · {state.ready ? formatTelemetryMs(state.ageMs) : shortBlocker(component, state.blocker)}
    </span>
  );
}

function componentAriaLabel(
  component: TerminalCertifiedSignalComponent,
  state: TerminalCertifiedMarketSignals["components"][TerminalCertifiedSignalComponent],
) {
  const reason = state.ready ? "certified" : terminalCertifiedSignalBlockerLabel(component, state.blocker);
  return `${COMPONENT_LABELS[component]} ${reason}, age ${formatTelemetryMs(state.ageMs)}`;
}

function shortBlocker(
  component: TerminalCertifiedSignalComponent,
  blocker: TerminalCertifiedMarketSignals["components"][TerminalCertifiedSignalComponent]["blocker"],
) {
  const label = terminalCertifiedSignalBlockerLabel(component, blocker);
  if (label.includes("stale")) return "stale";
  if (label.includes("missing") || label.includes("unavailable") || label.includes("no recent")) return "missing";
  if (label.includes("future")) return "future";
  if (label.includes("identity")) return "identity";
  if (label.includes("transport")) return "transport";
  if (label.includes("synthetic")) return "synthetic";
  return "invalid";
}

function formatTelemetryMs(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`;
}
