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
  const [expanded, setExpanded] = useState(false);
  const diagnosticsId = useId();
  const gradeTone = telemetry.healthGrade === "A" || telemetry.healthGrade === "B"
    ? "text-emerald-300"
    : telemetry.healthGrade === "C"
      ? "text-amber-300"
      : "text-rose-300";
  const recentEvents = telemetry.rollingEventCount;
  const healthy = telemetry.healthGrade === "A" || telemetry.healthGrade === "B";
  const healthLabel = healthy
    ? "Market feed healthy"
    : telemetry.healthGrade === "C"
      ? "Market feed degraded"
      : "Market feed unstable";
  const componentLabels = components ? COMPONENTS.map((component) => componentAriaLabel(component, components[component])) : [];
  const fullLabel = [
    `Public market feed grade ${telemetry.healthGrade}, score ${telemetry.healthScore}`,
    `source age ${formatTelemetryMs(telemetry.sourceAgeMs)}`,
    `receipt latency ${formatTelemetryMs(telemetry.receiptLatencyMs)}`,
    `update rate ${telemetry.updateRateHz.toFixed(2)} hertz`,
    `${recentEvents} health events in the last ${Math.round(telemetry.windowMs / 1_000)} seconds`,
    `reconnect, fallback, stale counters ${telemetry.reconnectCount}, ${telemetry.fallbackCount}, ${telemetry.staleCount}`,
    `sequence, timestamp, gap rejection counters ${telemetry.sequenceRegressionCount}, ${telemetry.timestampRegressionCount}, ${telemetry.gapRejectCount}`,
    ...componentLabels,
  ].join(". ");

  return (
    <section
      aria-label={fullLabel}
      className="mx-3 mb-2 rounded-md border border-[#182234] bg-[#080d15]/70 px-3 py-2 sm:mx-6"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#7f8da7]">
        <span className={`flex items-center gap-1.5 font-medium ${gradeTone}`} title={`${telemetry.windowMs / 1_000}s rolling health score`}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${telemetry.healthGrade === "A" || telemetry.healthGrade === "B" ? "bg-emerald-300" : telemetry.healthGrade === "C" ? "bg-amber-300" : "bg-rose-300"}`} />
          {healthLabel}
        </span>
        <span>
          Updated <span className="trade-market-number text-[#c7d2e4]">{formatTelemetryMs(telemetry.sourceAgeMs)} ago</span>
        </span>
        {recentEvents > 0 ? (
          <span className={healthy ? "text-[#75839a]" : "text-amber-200"}>
            {recentEvents} {healthy ? "recovered " : "health "}event{recentEvents === 1 ? "" : "s"} · {Math.round(telemetry.windowMs / 1_000)}s window
          </span>
        ) : null}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={diagnosticsId}
          onClick={() => setExpanded((value) => !value)}
          className="ml-auto rounded px-2 py-1 text-xs text-sky-200 outline-none hover:bg-sky-400/10 focus-visible:ring-1 focus-visible:ring-sky-300"
        >
          {expanded ? "Hide details" : "Details"}
        </button>
      </div>
      <div
        id={diagnosticsId}
        className={`${expanded ? "mt-2 flex" : "hidden"} flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#182234] pt-2 text-[10px] text-[#7f8da7]`}
      >
        <TelemetryValue label="Health" value={`${telemetry.healthGrade} · ${telemetry.healthScore}`} />
        <TelemetryValue label="Source age" value={formatTelemetryMs(telemetry.sourceAgeMs)} />
        <TelemetryValue label="Update rate" value={`${telemetry.updateRateHz.toFixed(2)} Hz`} />
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
        {components ? (
          <span className="flex flex-wrap items-center gap-1" aria-label="Decision-surface component freshness">
            {COMPONENTS.map((component) => (
              <ComponentFreshness key={component} component={component} state={components[component]} />
            ))}
          </span>
        ) : null}
      </div>
    </section>
  );
});

function TelemetryValue({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span>{label}</span>
      <span className="trade-market-number text-[#c7d2e4]">{value}</span>
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
