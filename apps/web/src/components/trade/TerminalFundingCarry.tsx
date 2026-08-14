"use client";

import { memo } from "react";
import {
  terminalFundingCarryPreviewEqual,
  type TerminalFundingCarryPreview,
} from "@/lib/terminal-funding-carry";

export interface TerminalFundingCarryProps {
  preview: TerminalFundingCarryPreview;
}

export const TerminalFundingCarry = memo(function TerminalFundingCarry({
  preview,
}: TerminalFundingCarryProps) {
  const statusTone = preview.available
    ? "border-sky-400/35 bg-sky-400/10 text-sky-200"
    : "border-amber-300/35 bg-amber-300/10 text-amber-100";

  return (
    <section
      aria-labelledby="funding-carry-heading"
      aria-describedby="funding-carry-detail funding-carry-disclaimer"
      className="mb-4 rounded-md border border-[#182234] bg-[#080c13] p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="funding-carry-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7d8ba5]">
          Funding snapshot carry
        </h2>
        <span role="status" aria-live="polite" aria-atomic="true" className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.12em] ${statusTone}`}>
          {preview.available ? "LIVE SNAPSHOT" : "UNAVAILABLE"}
        </span>
      </div>

      {preview.available ? (
        <>
          <dl className="mt-2 grid grid-cols-3 gap-2 font-mono tabular-nums">
            <FundingValue label="Snapshot rate" value={formatRate(preview.ratePercent)} />
            <FundingValue label="Position" value={preview.position} />
            <FundingValue label="Signed carry" value={formatSignedUsd(preview.signedCarryUsd)} />
          </dl>
          <p id="funding-carry-detail" className={`mt-2 text-[10px] leading-4 ${preview.direction === "receives" ? "text-emerald-200" : preview.direction === "pays" ? "text-rose-200" : "text-[#aab5c8]"}`}>
            At this snapshot rate, {preview.position} {carryPhrase(preview.direction, preview.absoluteCarryUsd)} per {preview.intervalLabel}.
          </p>
          <p className="mt-1 text-[9px] leading-4 text-[#718097]">
            Interval duration and next settlement are unavailable from this unified frame.
          </p>
        </>
      ) : (
        <p id="funding-carry-detail" className="mt-2 text-[10px] leading-4 text-amber-100/85">
          {preview.reason}
        </p>
      )}

      <p id="funding-carry-disclaimer" className="mt-2 text-[9px] leading-4 text-[#718097]">
        Informational snapshot projection only—not an execution blocker or trigger-bound signal. It does not alter the order price.
      </p>
    </section>
  );
}, (previous, next) => terminalFundingCarryPreviewEqual(previous.preview, next.preview));

function FundingValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="trade-field min-w-0 rounded px-2 py-1.5">
      <dt className="truncate text-[8px] uppercase tracking-[0.1em] text-[#66738c]">{label}</dt>
      <dd className="mt-0.5 truncate text-[10px] text-[#dce6f4]" title={value}>{value}</dd>
    </div>
  );
}

function carryPhrase(direction: "pays" | "receives" | "neutral", amountUsd: number) {
  if (direction === "neutral") return "neither pays nor receives $0.00";
  return `${direction} ${formatUsd(amountUsd)}`;
}

function formatRate(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(6).replace(/\.?0+$/u, "") || "0"}%`;
}

function formatSignedUsd(value: number) {
  if (value === 0) return "$0.00";
  return `${value > 0 ? "+" : "−"}${formatUsd(Math.abs(value))}`;
}

function formatUsd(value: number) {
  const digits = value > 0 && value < 0.01 ? 4 : 2;
  return `$${value.toFixed(digits)}`;
}
