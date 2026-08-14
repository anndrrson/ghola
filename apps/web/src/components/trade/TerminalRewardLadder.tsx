"use client";

import { memo } from "react";
import type {
  TerminalRewardLadder as RewardLadder,
  TerminalRewardMultiple,
} from "@/lib/terminal-reward-ladder";

export const TerminalRewardLadder = memo(function TerminalRewardLadder({
  ladder,
  replay,
  selectedMultiple,
  onStage,
}: {
  ladder: RewardLadder;
  replay: boolean;
  selectedMultiple: TerminalRewardMultiple;
  onStage: (rewardMultiple: TerminalRewardMultiple, expectedTargetPrice: number) => void;
}) {
  return (
    <section aria-labelledby="reward-ladder-heading" className="mb-4 overflow-hidden rounded-md border border-[#182234] bg-[#080c13]">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <h2 id="reward-ladder-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">
          Target payoff ladder
        </h2>
        <span className={`font-mono text-[9px] uppercase ${ladder.status === "ready" ? "text-sky-200" : "text-amber-200"}`}>
          {ladder.status === "ready" ? `${ladder.horizonBars} bars · loss ${formatUsd(ladder.stopLossUsd)}` : "paused"}
        </span>
      </div>
      {ladder.status === "unavailable" ? (
        <p role="status" className="border-t border-[#141d2e] px-3 py-3 text-[10px] leading-4 text-amber-200">
          {ladder.rows.length > 0
            ? "Historical evidence is unavailable; target prices remain stageable from the valid entry and invalidation plan."
            : "Unavailable until certified closed history and valid entry, invalidation, notional, and slippage are present."}
        </p>
      ) : null}
      {ladder.rows.length > 0 ? (
        <div className="overflow-x-auto" tabIndex={0} aria-label="Scrollable target payoff ladder">
          <table className="w-full min-w-[38rem] border-collapse font-mono text-[9px] tabular-nums">
            <caption className="sr-only">Target prices compared by slippage-adjusted payoff, resolved historical hit rate, confidence interval, and break-even rate.</caption>
            <thead className="border-t border-[#141d2e] text-[#718097]">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-normal">Target</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Price / payoff</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Resolved hit</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">95% interval</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Break-even</th>
                <th scope="col" className="px-3 py-2 text-right font-normal">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {ladder.rows.map((row) => (
                <tr key={row.rewardMultiple} className={`border-t border-[#141d2e] ${row.rewardMultiple === selectedMultiple ? "bg-sky-300/[0.04]" : ""}`}>
                  <th scope="row" className="px-3 py-2 text-left text-[#c7d2e4]">
                    <button
                      type="button"
                      disabled={replay}
                      aria-pressed={row.rewardMultiple === selectedMultiple}
                      onClick={() => onStage(row.rewardMultiple, row.targetPrice)}
                      className="rounded px-1 py-0.5 text-left outline-none hover:bg-sky-300/10 focus-visible:ring-1 focus-visible:ring-sky-300 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {row.rewardMultiple.toFixed(1)}R{row.rewardMultiple === selectedMultiple ? " · selected" : ""}
                    </button>
                  </th>
                  <td className="px-2 py-2 text-right text-[#aeb9cb]">{formatPrice(row.targetPrice)} · {formatSignedUsd(row.targetProfitUsd)}</td>
                  <td className="px-2 py-2 text-right text-[#c7d2e4]">{formatPct(row.resolvedHitRatePct)} · n={row.resolvedCount}</td>
                  <td className="px-2 py-2 text-right text-[#aeb9cb]">{formatInterval(row.hitRateLowerPct, row.hitRateUpperPct)}</td>
                  <td className="px-2 py-2 text-right text-[#aeb9cb]">{formatPct(row.requiredWinRatePct)}</td>
                  <td className={`px-3 py-2 text-right ${assessmentTone(row.assessment)}`}>{assessmentLabel(row.status, row.assessment)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="border-t border-[#141d2e] px-3 py-2 text-[9px] leading-4 text-[#566278]">
        {replay ? "Revealed replay prefix · target staging disabled" : "Latest certified history"} · selecting a row changes analysis and future attached PAPER OCO only; it never changes or submits the one-shot live order. Fixed current entry and invalidation; non-overlapping resolved episodes with Wilson 95% intervals. Newest, ambiguous, and unresolved bars are excluded. Slippage is modeled; fees, gaps, queue, and venue failure are not. Descriptive only—not a target recommendation, probability, forecast, or execution gate.
      </p>
    </section>
  );
});

function assessmentLabel(status: "ready" | "thin_sample" | "unavailable", assessment: RewardLadder["rows"][number]["assessment"]) {
  if (status === "unavailable") return "unavailable";
  if (status === "thin_sample") return "thin · inconclusive";
  if (assessment === "above_break_even") return "interval above";
  if (assessment === "below_break_even") return "interval below";
  return "inconclusive";
}

function assessmentTone(assessment: RewardLadder["rows"][number]["assessment"]) {
  if (assessment === "above_break_even") return "text-emerald-300";
  if (assessment === "below_break_even") return "text-rose-300";
  return "text-amber-200";
}

function formatPrice(value: number) { return value >= 1_000 ? value.toFixed(1) : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, ""); }
function formatPct(value: number | null) { return value == null ? "—" : `${value.toFixed(1)}%`; }
function formatInterval(lower: number | null, upper: number | null) { return lower == null || upper == null ? "—" : `${lower.toFixed(1)}–${upper.toFixed(1)}%`; }
function formatUsd(value: number | null) { return value == null ? "—" : `$${value.toFixed(2)}`; }
function formatSignedUsd(value: number) { return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`; }
