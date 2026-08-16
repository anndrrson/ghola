"use client";

import { memo } from "react";
import {
  terminalEntryTargetSurfaceEqual,
  type TerminalEntryTargetCell,
  type TerminalEntryTargetSurface as EntryTargetSurface,
} from "@/lib/terminal-entry-target-surface";
import type { TerminalEntryOutcomeMode } from "@/lib/terminal-entry-outcome-matrix";
import type { TerminalRewardMultiple } from "@/lib/terminal-reward-ladder";

export const TerminalEntryTargetSurface = memo(function TerminalEntryTargetSurface({
  surface,
  selectedEntryPrice,
  selectedMultiple,
  replay,
  onStage,
}: {
  surface: EntryTargetSurface;
  selectedEntryPrice: number | null;
  selectedMultiple: TerminalRewardMultiple;
  replay: boolean;
  onStage: (
    mode: TerminalEntryOutcomeMode,
    expectedEntryPrice: number,
    rewardMultiple: TerminalRewardMultiple,
    expectedTargetPrice: number,
  ) => void;
}) {
  if (surface.status === "unavailable") {
    return (
      <section aria-label="Entry and target decision surface" className="mt-2 rounded-md border border-[#172235] bg-[#080d15] px-2.5 py-2">
        <p role="status" className="text-[8px] leading-3.5 text-[#66738c]">Entry × target surface paused · waiting for certified entry outcomes.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="entry-target-surface-heading" className="mt-2 overflow-hidden rounded-md border border-[#172235] bg-[#080d15]">
      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
        <h3 id="entry-target-surface-heading" className="text-[8px] font-semibold uppercase tracking-[0.14em] text-[#7d8ba5]">Entry × target surface</h3>
        <span className={`font-mono text-[8px] uppercase ${surface.status === "ready" ? "text-sky-200" : "text-amber-200"}`}>
          {surface.status === "ready" ? `${surface.horizonBars}-bar evidence` : "prices only"}
        </span>
      </div>
      {surface.status === "degraded" ? (
        <p role="status" className="border-t border-[#141d2e] px-2.5 py-2 text-[8px] leading-3.5 text-amber-200">
          Historical evidence is unavailable; exact R targets remain stageable.
        </p>
      ) : null}
      <div className="overflow-x-auto" tabIndex={0} aria-label="Scrollable entry and target decision surface">
        <table className="w-full min-w-[48rem] border-collapse font-mono text-[8px] tabular-nums">
          <caption className="sr-only">Entry modes compared across one, one-and-a-half, two, and three R targets using visible fill, risk budget, historical hit rate, confidence interval, and break-even rate.</caption>
          <thead className="border-t border-[#141d2e] text-[#718097]">
            <tr>
              <th scope="col" className="px-2.5 py-2 text-left font-normal">Entry / execution</th>
              {surface.rows[0]?.cells.map((cell) => (
                <th key={cell.rewardMultiple} scope="col" className="px-2 py-2 text-right font-normal">{cell.rewardMultiple.toFixed(1)}R target</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {surface.rows.map((row) => (
              <tr key={row.mode} className="border-t border-[#141d2e] align-top">
                <th scope="row" className="px-2.5 py-2 text-left font-normal">
                  <span className="block uppercase text-[#dce6f4]">{row.mode}</span>
                  <span className="mt-0.5 block text-[#8e9aaf]">{formatPrice(row.entryPrice)} · {row.intent}</span>
                  <span className={`mt-0.5 block ${row.budgetAllowed === true ? "text-emerald-300" : row.budgetAllowed === false ? "text-rose-300" : "text-[#718097]"}`}>
                    fill {row.visibleFillPct.toFixed(0)}% · budget {row.budgetAllowed == null ? "—" : row.budgetAllowed ? "pass" : "block"}
                  </span>
                </th>
                {row.cells.map((cell) => {
                  const selected = cell.rewardMultiple === selectedMultiple
                    && selectedEntryPrice != null
                    && Math.abs(row.entryPrice - selectedEntryPrice) <= 1e-9;
                  const disabled = replay || cell.targetPrice == null;
                  return (
                    <td key={cell.rewardMultiple} className={`px-1 py-1 ${selected ? "bg-sky-300/[0.05]" : ""}`}>
                      <button
                        type="button"
                        disabled={disabled}
                        aria-pressed={selected}
                        aria-label={`${selected ? "Selected" : "Stage"} ${row.mode} entry ${formatPrice(row.entryPrice)} with ${cell.rewardMultiple.toFixed(1)}R target ${formatPrice(cell.targetPrice)}`}
                        onClick={() => {
                          if (cell.targetPrice != null) onStage(row.mode, row.entryPrice, cell.rewardMultiple, cell.targetPrice);
                        }}
                        className="w-full rounded px-1 py-1 text-right outline-none hover:bg-sky-300/10 focus-visible:ring-1 focus-visible:ring-sky-300 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="block text-[9px] text-[#dce6f4]">{formatPrice(cell.targetPrice)}{selected ? " · selected" : ""}</span>
                        <span className="mt-0.5 block text-[#8e9aaf]">hit {formatPct(cell.resolvedHitRatePct)} · BE {formatPct(cell.requiredWinRatePct)}</span>
                        <span className={`mt-0.5 block ${assessmentTone(cell)}`}>{evidenceLabel(cell)}</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-[#141d2e] px-2.5 py-2 text-[8px] leading-3.5 text-[#566278]">
        Click stages that entry and analytical/PAPER target together; it never previews or submits. Visible fill is current displayed depth. Historical cells use non-overlapping resolved episodes and Wilson 95% intervals; no fees, queue, hidden liquidity, or execution guarantee. {replay ? "Historical replay is read-only." : ""}
      </p>
    </section>
  );
}, (previous, next) => previous.selectedEntryPrice === next.selectedEntryPrice
  && previous.selectedMultiple === next.selectedMultiple
  && previous.replay === next.replay
  && previous.onStage === next.onStage
  && terminalEntryTargetSurfaceEqual(previous.surface, next.surface));

function evidenceLabel(cell: TerminalEntryTargetCell) {
  if (cell.evidenceStatus === "unavailable") return "evidence unavailable";
  const interval = cell.hitRateLowerPct == null || cell.hitRateUpperPct == null
    ? "interval —"
    : `${cell.hitRateLowerPct.toFixed(0)}–${cell.hitRateUpperPct.toFixed(0)}% · n=${cell.resolvedCount}`;
  if (cell.evidenceStatus === "thin_sample") return `thin · ${interval}`;
  if (cell.assessment === "above_break_even") return `above BE · ${interval}`;
  if (cell.assessment === "below_break_even") return `below BE · ${interval}`;
  return `inconclusive · ${interval}`;
}

function assessmentTone(cell: TerminalEntryTargetCell) {
  if (cell.assessment === "above_break_even") return "text-emerald-300";
  if (cell.assessment === "below_break_even") return "text-rose-300";
  return cell.evidenceStatus === "unavailable" ? "text-[#718097]" : "text-amber-200";
}

function formatPrice(value: number | null) {
  if (value == null) return "—";
  return value >= 1_000 ? value.toFixed(1) : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatPct(value: number | null) {
  return value == null ? "—" : `${value.toFixed(0)}%`;
}
