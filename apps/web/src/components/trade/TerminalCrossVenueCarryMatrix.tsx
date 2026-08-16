"use client";

import { memo } from "react";
import type {
  TerminalCrossVenueCarryMatrix as CarryMatrix,
  TerminalCrossVenueCarryRow,
} from "@/lib/terminal-cross-venue-carry";

export interface TerminalCrossVenueCarryMatrixProps {
  matrix: CarryMatrix;
}

export const TerminalCrossVenueCarryMatrix = memo(function TerminalCrossVenueCarryMatrix({
  matrix,
}: TerminalCrossVenueCarryMatrixProps) {
  return (
    <section
      className="mx-3 mb-3 overflow-hidden rounded-md border border-[#182234] bg-[#080c13] sm:mx-6"
      aria-labelledby="cross-venue-carry-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[#182234] px-3 py-2.5">
        <div>
          <h2 id="cross-venue-carry-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#9aa7ba]">
            Certified basis + carry
          </h2>
          <p className="mt-1 text-[9px] text-[#7f8da7]">
            {matrix.side.toUpperCase()} {matrix.notionalUsd == null ? "notional unavailable" : formatUsd(matrix.notionalUsd)} · basis versus selected venue
          </p>
        </div>
        <span className={matrix.status === "live"
          ? "font-mono text-[9px] uppercase text-emerald-300"
          : matrix.status === "single"
            ? "font-mono text-[9px] uppercase text-amber-200"
            : "font-mono text-[9px] uppercase text-rose-300"}
        >
          {matrix.status === "live" ? `${matrix.rows.length} venues` : matrix.status}
        </span>
      </div>
      {matrix.rows.length ? (
        <div className="overflow-x-auto" tabIndex={0} aria-label="Scrollable venue basis and funding comparison">
          <table className="min-w-[44rem] w-full border-collapse font-mono text-[10px] tabular-nums">
            <caption className="sr-only">Compatible venues compared by certified quote basis and independent funding snapshot.</caption>
            <thead className="text-[#7f8da7]">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-normal">Venue / market</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Mid</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Basis</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Funding</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Side carry</th>
                <th scope="col" className="px-3 py-2 text-right font-normal">Freshness</th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => <CarryRow key={`${row.venue}:${row.network}:${row.product}`} row={row} />)}
            </tbody>
          </table>
        </div>
      ) : (
        <p role="status" className="px-3 py-3 text-[10px] text-amber-100">
          The selected venue has no fresh, compatible certified quote to anchor this comparison.
        </p>
      )}
      <p className="border-t border-[#141d2e] px-3 py-2 text-[9px] leading-4 text-[#7f8da7]">
        Quote basis and funding are certified independently. Carry uses each venue&apos;s reported snapshot interval; interval duration may differ and is not normalized. No fees, borrow, latency, fill, or convergence claim.
      </p>
    </section>
  );
});

function CarryRow({ row }: { row: TerminalCrossVenueCarryRow }) {
  const funding = row.fundingRateBps == null ? fundingBlockerLabel(row) : `${signed(row.fundingRateBps)} bp`;
  const carry = row.signedCarryUsd == null ? "—" : signedUsd(row.signedCarryUsd);
  return (
    <tr className="border-t border-[#141d2e] text-[#c7d2e4]">
      <th scope="row" className="px-3 py-2 text-left font-normal">
        <span className={row.selected ? "text-sky-300" : "text-[#c7d2e4]"}>{row.venue.toUpperCase()}</span>
        {row.selected ? <span className="ml-1 text-[8px] uppercase text-sky-300">selected</span> : null}
        <span className="mt-0.5 block text-[8px] uppercase text-[#7f8da7]">{row.product} · {row.network}</span>
      </th>
      <td className="px-2 py-2 text-right">{price(row.mid)}</td>
      <td className={row.basisBps > 0 ? "px-2 py-2 text-right text-emerald-200" : row.basisBps < 0 ? "px-2 py-2 text-right text-rose-200" : "px-2 py-2 text-right text-[#9aa7ba]"}>
        {signed(row.basisBps)} bp
      </td>
      <td className="px-2 py-2 text-right" title={row.fundingSource ?? undefined}>{funding}</td>
      <td className={row.signedCarryUsd != null && row.signedCarryUsd > 0 ? "px-2 py-2 text-right text-emerald-200" : row.signedCarryUsd != null && row.signedCarryUsd < 0 ? "px-2 py-2 text-right text-rose-200" : "px-2 py-2 text-right text-[#9aa7ba]"}>
        {carry}
      </td>
      <td className="px-3 py-2 text-right text-[#8b95a8]">
        Q {age(row.quoteAgeMs)}{row.fundingAgeMs == null ? "" : ` · F ${age(row.fundingAgeMs)}`}
      </td>
    </tr>
  );
}

function fundingBlockerLabel(row: TerminalCrossVenueCarryRow) {
  if (row.fundingBlocker === "spot_market") return "spot · n/a";
  if (row.fundingBlocker === "notional_invalid") return "set notional";
  return "unavailable";
}

function price(value: number) {
  return value >= 1_000 ? value.toFixed(1) : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
}

function signed(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatUsd(value: number) {
  return `$${value.toFixed(2)}`;
}

function signedUsd(value: number) {
  if (value === 0) return "$0.00";
  return `${value > 0 ? "+" : "−"}$${Math.abs(value).toFixed(Math.abs(value) < 0.01 ? 4 : 2)}`;
}

function age(value: number) {
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}
