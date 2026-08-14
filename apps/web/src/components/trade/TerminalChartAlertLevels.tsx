"use client";

import { memo } from "react";
import type { TerminalChartPriceAlertProjection } from "@/lib/terminal-alert-chart";

export const TerminalChartAlertLevels = memo(function TerminalChartAlertLevels({
  projection,
  replayActive,
  onManage,
}: {
  projection: TerminalChartPriceAlertProjection;
  replayActive: boolean;
  onManage: () => void;
}) {
  if (projection.status === "unavailable") {
    return projection.blocker === "scope_mismatch" ? (
      <div role="status" className="mt-2 rounded border border-amber-300/20 bg-amber-300/[0.03] px-3 py-2 text-[9px] text-amber-100">
        Chart alerts paused while the selected instrument changes.
      </div>
    ) : null;
  }
  if (projection.total === 0) return null;

  return (
    <section
      aria-label="Chart price alerts"
      className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 rounded border border-[#182234] bg-[#080c13] px-2.5 py-2 text-[9px]"
    >
      <span className="shrink-0 font-semibold uppercase tracking-[0.12em] text-amber-200">
        Alerts {projection.levels.length}/{projection.total}
      </span>
      {replayActive ? (
        <span role="status" className="text-[#8795ac]">hidden during replay</span>
      ) : projection.levels.map((level) => (
        <span
          key={level.id}
          title={level.label}
          className="max-w-44 truncate rounded-sm border border-amber-300/20 bg-amber-300/[0.04] px-1.5 py-0.5 font-mono tabular-nums text-amber-100"
        >
          {level.operator === "above" ? "↑" : "↓"} {formatPrice(level.threshold)} · {level.label}
        </span>
      ))}
      {!replayActive && projection.hidden > 0 ? (
        <span className="text-[#8795ac]">+{projection.hidden} managed off-chart</span>
      ) : null}
      <button
        type="button"
        onClick={onManage}
        className="term-chip ml-auto h-6 shrink-0 px-2 text-[8px] uppercase"
      >
        Manage
      </button>
      <span className="basis-full text-[8px] leading-3 text-[#66738c]">
        Enabled browser-alert thresholds; re-arm/cooldown state remains in the manager. Lines never stage, preview, or submit orders.
      </span>
    </section>
  );
});

function formatPrice(value: number) {
  if (value >= 1_000) return value.toFixed(1);
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toFixed(6);
}
