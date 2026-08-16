import { memo } from "react";
import {
  formatGholaTimeframe,
  gholaMultiTimeframeAccessibleSummary,
  type GholaMultiTimeframeConfluence,
  type GholaTimeframeContext,
} from "@/lib/ghola-multi-timeframe-confluence";

export interface GholaMultiTimeframeStripProps {
  context: GholaMultiTimeframeConfluence;
  replay?: boolean;
}

export const GholaMultiTimeframeStrip = memo(function GholaMultiTimeframeStrip({
  context,
  replay = false,
}: GholaMultiTimeframeStripProps) {
  return (
    <section
      className="min-w-0 overflow-hidden border border-[#243451] bg-[#070c15]"
      aria-label={`${replay ? "Replay prefix. " : "Current frame prefix. "}${gholaMultiTimeframeAccessibleSummary(context)}`}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-[#18253b] px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.13em]">
        <span className="text-[#93b9e8]">MTF context</span>
        <span className={confluenceClass(context.confluence)}>
          {confluenceLabel(context)}
        </span>
        <span className="truncate text-[#8090aa]">
          {replay ? "replay prefix" : `${context.completedSourceBars} closed bars`}
        </span>
      </div>
      <div className="grid min-w-0 grid-cols-3 divide-x divide-[#18253b]">
        {context.timeframes.map((timeframe) => (
          <TimeframeCard key={timeframe.factor} timeframe={timeframe} />
        ))}
      </div>
    </section>
  );
});

function TimeframeCard({ timeframe }: { timeframe: GholaTimeframeContext }) {
  const path = sparklinePath(timeframe.sparkline);
  return (
    <article className="grid min-w-0 gap-1 px-2 py-2 font-mono sm:px-2.5">
      <div className="flex min-w-0 items-center justify-between gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#d9e5f5]">
          {formatGholaTimeframe(timeframe.intervalMs)}
        </span>
        <span className={`truncate text-[9px] uppercase ${trendClass(timeframe.trend)}`}>
          {trendLabel(timeframe.trend)}
        </span>
      </div>
      <svg
        viewBox="0 0 100 22"
        preserveAspectRatio="none"
        className="h-6 w-full overflow-visible"
        aria-hidden="true"
      >
        <path d="M0 11H100" stroke="#17243a" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {path ? (
          <path
            d={path}
            fill="none"
            stroke={trendColor(timeframe.trend)}
            strokeWidth="1.25"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <dl className="grid min-w-0 grid-cols-2 gap-x-1 gap-y-0.5 text-[8px] leading-3 sm:text-[9px]">
        <Metric label="Close" value={formatPrice(timeframe.lastClose)} />
        <Metric
          label={`Mom ${timeframe.momentumBars || "—"}`}
          value={formatPercent(timeframe.momentumPct)}
          tone={directionTone(timeframe.momentumPct)}
        />
        <Metric label="ATR" value={formatPercent(timeframe.volatilityPct, false)} />
        <Metric label="Vol" value={volatilityLabel(timeframe)} />
      </dl>
      <span className="truncate text-[8px] text-[#7b8ca7] sm:text-[9px]">
        {timeframe.completedBars} completed bars
      </span>
    </article>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
}) {
  return (
    <div className="min-w-0">
      <dt className="truncate uppercase tracking-[0.08em] text-[#8290a8]">{label}</dt>
      <dd className={tone === "good"
        ? "truncate tabular-nums text-[#6ee7b7]"
        : tone === "bad"
          ? "truncate tabular-nums text-[#fca5a5]"
          : "truncate tabular-nums text-[#b9c6d8]"}
      >
        {value}
      </dd>
    </div>
  );
}

function sparklinePath(values: number[]) {
  if (values.length < 2) return "";
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const span = Math.max(Number.EPSILON, max - min);
  return values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100;
    const y = 20 - ((value - min) / span) * 18;
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

function confluenceLabel(context: GholaMultiTimeframeConfluence) {
  if (context.confluence === "bullish") return `Aligned up ${context.upCount}/${context.timeframes.length}`;
  if (context.confluence === "bearish") return `Aligned down ${context.downCount}/${context.timeframes.length}`;
  if (context.confluence === "mixed") return `Mixed ${context.upCount}↑ ${context.downCount}↓`;
  if (context.confluence === "neutral") return "Neutral agreement";
  return "Building context";
}

function confluenceClass(confluence: GholaMultiTimeframeConfluence["confluence"]) {
  if (confluence === "bullish") return "text-[#6ee7b7]";
  if (confluence === "bearish") return "text-[#fca5a5]";
  if (confluence === "mixed") return "text-[#f8e58b]";
  return "text-[#8ea0b9]";
}

function trendLabel(trend: GholaTimeframeContext["trend"]) {
  if (trend === "up") return "Up ↑";
  if (trend === "down") return "Down ↓";
  if (trend === "flat") return "Flat →";
  return "Pending";
}

function trendClass(trend: GholaTimeframeContext["trend"]) {
  if (trend === "up") return "text-[#6ee7b7]";
  if (trend === "down") return "text-[#fca5a5]";
  return "text-[#8795aa]";
}

function trendColor(trend: GholaTimeframeContext["trend"]) {
  if (trend === "up") return "#6ee7b7";
  if (trend === "down") return "#fca5a5";
  return "#8795aa";
}

function volatilityLabel(timeframe: GholaTimeframeContext) {
  if (timeframe.volatilityRegime === "insufficient") return "Pending";
  return timeframe.volatilityRegime;
}

function directionTone(value: number | null): "good" | "bad" | "neutral" {
  if (value == null || value === 0) return "neutral";
  return value > 0 ? "good" : "bad";
}

function formatPercent(value: number | null, signed = true) {
  if (value == null) return "—";
  return `${signed && value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatPrice(value: number | null) {
  if (value == null) return "—";
  const digits = Math.abs(value) >= 1_000 ? 2 : Math.abs(value) >= 1 ? 4 : 6;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}
