"use client";

import { memo } from "react";
import {
  terminalLiquidityStressCurveEqual,
  type TerminalLiquidityStressCurve,
} from "@/lib/terminal-liquidity-stress";

export const TerminalLiquidityStress = memo(function TerminalLiquidityStress({
  curve,
}: {
  curve: TerminalLiquidityStressCurve;
}) {
  if (curve.status === "unavailable") {
    return (
      <section aria-label="Visible liquidity size stress" className="mt-3 rounded-md border border-[#1b2638] bg-[#080d15] px-3 py-2.5">
        <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#7d8ba5]">Size stress</p>
        <p className="mt-1 text-[9px] leading-4 text-[#718097]">Unavailable · {blockerLabel(curve.blocker)}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="terminal-liquidity-stress-heading" className="mt-3 rounded-md border border-[#1b2638] bg-[#080d15]">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[#141d2e] px-3 py-2.5">
        <div>
          <h3 id="terminal-liquidity-stress-heading" className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#aeb9cb]">Visible liquidity stress</h3>
          <p className="mt-0.5 text-[8px] text-[#66738c]">Order quantity scales from staged entry; impact uses certified BBO midpoint.</p>
        </div>
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[8px] tabular-nums ${capacityTone(curve.visibleCapacityMultiple)}`}>
          Capacity {formatMultiple(curve.visibleCapacityMultiple)}
        </span>
      </div>
      <div className="overflow-x-auto" tabIndex={0} aria-label="Scrollable visible liquidity stress curve">
        <table className="w-full min-w-[24rem] border-collapse font-mono text-[9px] tabular-nums">
          <caption className="sr-only">Visible book fill and impact at five multiples of the currently staged order size.</caption>
          <thead className="text-[#66738c]">
            <tr>
              <th scope="col" className="px-3 py-1.5 text-left font-normal">Size</th>
              <th scope="col" className="px-2 py-1.5 text-right font-normal">Notional</th>
              <th scope="col" className="px-2 py-1.5 text-right font-normal">Fill</th>
              <th scope="col" className="px-2 py-1.5 text-right font-normal">VWAP</th>
              <th scope="col" className="px-3 py-1.5 text-right font-normal">Impact</th>
            </tr>
          </thead>
          <tbody>
            {curve.points.map((point) => (
              <tr key={point.multiplier} className={`border-t border-[#111a29] ${point.multiplier === 1 ? "bg-[#0d1a2b]" : ""}`}>
                <th scope="row" className="px-3 py-1.5 text-left font-semibold text-[#dce6f4]">{formatMultiple(point.multiplier)}</th>
                <td className="px-2 py-1.5 text-right text-[#aeb9cb]">{formatUsd(point.requestedNotionalUsd)}</td>
                <td className={`px-2 py-1.5 text-right ${fillTone(point.quality.fillPct)}`}>{point.quality.fillPct.toFixed(0)}%</td>
                <td className="px-2 py-1.5 text-right text-[#c7d2e4]">{formatPrice(point.quality.vwap)}</td>
                <td className={`px-3 py-1.5 text-right ${impactTone(point.quality.impactBps)}`}>{formatBps(point.quality.impactBps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-[#141d2e] px-3 py-2 text-[8px] leading-3.5 text-[#66738c]">
        Displayed public depth only. Excludes queue position, hidden liquidity, latency, fees, and execution guarantees.
      </p>
    </section>
  );
}, (previous, next) => terminalLiquidityStressCurveEqual(previous.curve, next.curve));

function blockerLabel(blocker: TerminalLiquidityStressCurve["blocker"]) {
  if (blocker === "order_notional_invalid") return "set a positive order notional";
  if (blocker === "sizing_price_invalid") return "set a valid staged entry";
  if (blocker === "book_level_invalid") return "book levels are malformed";
  if (blocker === "book_crossed") return "top of book is crossed";
  return "waiting for a certified two-sided book";
}

function formatMultiple(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(value < 1 ? 2 : 1)}×`;
}

function formatUsd(value: number) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: value >= 1_000 ? 0 : 2 })}`;
}

function formatPrice(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: value >= 1_000 ? 2 : 4 });
}

function formatBps(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)} bp`;
}

function capacityTone(value: number | null) {
  if (value == null || value < 1) return "border-rose-400/35 bg-rose-400/10 text-rose-200";
  if (value < 2) return "border-amber-400/35 bg-amber-400/10 text-amber-200";
  return "border-emerald-400/35 bg-emerald-400/10 text-emerald-200";
}

function fillTone(value: number) {
  if (value >= 99.999) return "text-emerald-300";
  if (value > 0) return "text-amber-200";
  return "text-rose-300";
}

function impactTone(value: number | null) {
  if (value == null) return "text-[#718097]";
  if (value <= 10) return "text-emerald-300";
  if (value <= 50) return "text-amber-200";
  return "text-rose-300";
}
