"use client";

import type {
  TerminalLiveSubmitLiquidityEvidence,
  TerminalLiveSubmitReviewDecision,
  TerminalLiveSubmitReviewSnapshot,
} from "@/lib/terminal-live-submit-review";
import { terminalLiveSubmitReviewBlockerLabel } from "@/lib/terminal-live-submit-review";

export function TerminalLiveSubmitReview({
  review,
  liquidity,
  decision,
  onConfirm,
  onCancel,
}: {
  review: TerminalLiveSubmitReviewSnapshot;
  liquidity: TerminalLiveSubmitLiquidityEvidence;
  decision: TerminalLiveSubmitReviewDecision;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const blocker = decision.allowed ? null : terminalLiveSubmitReviewBlockerLabel(decision.blocker);
  return (
    <section aria-labelledby="live-submit-review-heading" className="rounded-md border border-rose-300/30 bg-rose-950/15 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="live-submit-review-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-rose-200">Exact live-order review</h2>
          <p className="mt-1 font-mono text-[9px] text-[#8290a8]" title={review.planDigest}>{review.planDigest.slice(0, 22)}…</p>
        </div>
        <span className="rounded border border-rose-300/30 bg-rose-300/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-rose-100">real money</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px]">
        <ReviewValue label="Route" value={`${review.venueId} · ${review.network}`} />
        <ReviewValue label="Instrument" value={review.product} />
        <ReviewValue label="Order" value={`${review.side.toUpperCase()} · ${review.timeInForce.toUpperCase()}`} />
        <ReviewValue label="Value" value={`$${review.quoteNotionalUsd}`} />
        <ReviewValue label="Base size" value={review.baseSize} />
        <ReviewValue label="Limit" value={`$${review.limitPrice}`} />
        <ReviewValue label="Executable reference" value={`$${review.executionReferencePrice}`} />
        <ReviewValue label="Plan invalidation" value={`$${review.invalidationLevel}`} />
        <ReviewValue label="Slippage cap" value={`${review.maxSlippageBps} bp`} />
        <ReviewValue label="Stop + slippage loss" value={`$${review.stopAndSlippageLossUsd}`} />
        <ReviewValue label="Route-cost loss" value={`$${review.roundTripCostLossUsd}`} />
        <ReviewValue label="All-in modeled loss" value={`$${review.allInLossUsd}`} />
        <ReviewValue label="Loss budget" value={`$${review.riskBudgetUsd}`} />
        <ReviewValue label="Round-trip assumptions" value={`${review.feeBps} bp fee + ${review.bufferBps} bp buffer`} wide />
        <ReviewValue label="Cost evidence" value={`${formatEvidenceTime(review.feeEvidenceAt)} fee · ${formatEvidenceTime(review.bufferEvidenceAt)} buffer`} wide />
        <ReviewValue label="Bound quote" value={`${formatEvidenceTime(review.marketFetchedAt)} · ${formatAge(review.marketMaxAgeMs)} max`} />
        <ReviewValue label="Binding expires" value={formatEvidenceTime(review.expiresAt)} />
      </dl>
      <div className="mt-3 rounded border border-sky-300/20 bg-sky-950/20 p-2.5">
        <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-sky-200">Current certified visible book · advisory</p>
        {liquidity.status === "unavailable" ? (
          <p className="mt-1 text-[10px] leading-4 text-amber-100">Visible-depth estimate unavailable. Execution gates still use their current fail-closed checks.</p>
        ) : (
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px]">
            <ReviewValue label="Eligible fill" value={`${liquidity.fillPct?.toFixed(1)}% · ${liquidity.status}`} />
            <ReviewValue label="Book age" value={formatAge(liquidity.bookAgeMs)} />
            <ReviewValue label="Filled / unfilled" value={`$${liquidity.filledNotionalUsd?.toFixed(2)} / $${liquidity.unfilledNotionalUsd?.toFixed(2)}`} />
            <ReviewValue label="VWAP / impact" value={liquidity.vwap == null ? "No eligible fill" : `$${formatNumber(liquidity.vwap)} · ${liquidity.impactBps?.toFixed(2)} bp`} />
            <ReviewValue label="Current executable BBO" value={liquidity.currentExecutionReferencePrice == null ? "Unavailable" : `$${formatNumber(liquidity.currentExecutionReferencePrice)}`} />
            <ReviewValue label="Move since binding" value={formatDrift(liquidity.adverseDriftBps)} />
          </dl>
        )}
        <p className="mt-2 text-[9px] leading-4 text-[#8290a8]">Current displayed depth only; not authorization-bound. Fees, latency, queue priority, hidden liquidity, and fill guarantees are excluded.</p>
      </div>
      <p id="live-submit-review-warning" className="mt-3 text-[10px] leading-4 text-amber-100">
        Submits one entry limit only. Plan invalidation is not a venue stop or bracket. The server rechecks the exact bound plan before dispatch.
      </p>
      {blocker ? <p role="alert" className="mt-2 text-[10px] leading-4 text-rose-200">{blocker}</p> : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={onCancel} className="trade-chip h-10 rounded-md text-xs">Cancel</button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!decision.allowed}
          aria-describedby="live-submit-review-warning"
          className="trade-action h-10 rounded-md text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        >
          Confirm live {review.side.toUpperCase()}
        </button>
      </div>
    </section>
  );
}

function formatEvidenceTime(value: string) {
  return value.slice(11, 19) + "Z";
}

function formatAge(value: number | null) {
  if (value == null) return "Unavailable";
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(1)} s`;
}

function formatNumber(value: number) {
  return value >= 1_000 ? value.toFixed(2) : value.toFixed(4);
}

function formatDrift(value: number | null) {
  if (value == null) return "Unavailable";
  if (Math.abs(value) < 0.005) return "0.00 bp";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)} bp ${value > 0 ? "adverse" : "favorable"}`;
}

function ReviewValue({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <dt className="text-[9px] uppercase tracking-[0.1em] text-[#68758c]">{label}</dt>
      <dd className="mt-0.5 break-words font-mono text-[#dbe4f2]">{value}</dd>
    </div>
  );
}
