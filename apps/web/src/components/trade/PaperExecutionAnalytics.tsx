import { memo } from "react";
import type { PaperFill, PaperOrder } from "@/lib/paper-trading-engine";
import { deriveTerminalPaperExecutionAnalytics } from "@/lib/terminal-paper-execution-analytics";

export const PaperExecutionAnalytics = memo(function PaperExecutionAnalytics({
  orders,
  fills,
}: {
  orders: PaperOrder[];
  fills: PaperFill[];
}) {
  const analytics = deriveTerminalPaperExecutionAnalytics({ orders, fills });
  const outcomesAvailable = analytics.entryNotionalCompletionPct != null;
  const qualityAvailable = analytics.qualityDataComplete && analytics.fillCount > 0;
  const arrivalAvailable = !analytics.arrivalDataCorrupt && analytics.arrivalSampleCount > 0;

  return (
    <section
      id="paper-execution-analytics"
      tabIndex={-1}
      className="scroll-mt-16 border-b border-[#182234] px-4 py-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-400 sm:px-5"
      aria-labelledby="paper-execution-analytics-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="paper-execution-analytics-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa7ba]">Execution analytics</h3>
          <p className="mt-1 text-[9px] leading-4 text-[#7f8da7]">Deterministic local PAPER outcomes · no venue execution claims.</p>
        </div>
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.1em] ${qualityAvailable ? "border-sky-400/35 bg-sky-400/10 text-sky-200" : "border-[#29354a] bg-[#111824] text-[#8795aa]"}`}>
          {qualityAvailable ? `${analytics.fillCount} FILL${analytics.fillCount === 1 ? "" : "S"}` : "NO FILL SAMPLE"}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded border border-[#1b2638] bg-[#1b2638] sm:grid-cols-3 xl:grid-cols-6" aria-label="Paper execution quality summary">
        <ExecutionMetric label="Entry completion" value={formatPercent(analytics.entryNotionalCompletionPct)} title="Requested quote-notional-weighted fill fraction across filled or cancelled entry revisions; pending and replaced revisions are excluded." />
        <ExecutionMetric label="Entries touched" value={formatPercent(analytics.entryTouchedPct)} title="Share of terminal entry revisions receiving at least one PAPER fill." />
        <ExecutionMetric label="Entries full" value={formatPercent(analytics.entryFullyFilledPct)} title="Share of terminal entry revisions fully filled; cancelled partials are not full." />
        <ExecutionMetric label="Fill adjustment" value={formatBps(analytics.executionAdjustmentBps)} tone={(analytics.executionAdjustmentBps ?? 0) > 0 ? "bad" : "neutral"} title="Size-weighted signed difference between PAPER fill price and its persisted fill-time reference. Positive is adverse. This is not arrival-price slippage." />
        <ExecutionMetric label="Effective fee" value={formatBps(analytics.effectiveFeeBps)} title="Total persisted PAPER fees divided by PAPER fill notional." />
        <ExecutionMetric label="Submit → fill" value={formatLatencyPair(analytics.medianSubmitToFillMs, analytics.p95SubmitToFillMs)} title="Median / p95 simulated elapsed time from local order submission to fill observation. This is not venue latency." />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded border border-[#1b2638] bg-[#1b2638] sm:grid-cols-4" aria-label="Local Paper arrival-to-fill analysis">
        <ExecutionMetric label="Wait drift" value={formatBps(analytics.waitDriftBps)} tone={(analytics.waitDriftBps ?? 0) > 0 ? "bad" : "neutral"} title="Signed move from the explicit local PAPER submission benchmark to the persisted fill-time reference. Positive is adverse." />
        <ExecutionMetric label="TCA fill adjustment" value={formatBps(analytics.arrivalExecutionAdjustmentBps)} tone={(analytics.arrivalExecutionAdjustmentBps ?? 0) > 0 ? "bad" : "neutral"} title="Signed move from the fill-time reference to the simulated fill, measured over the same benchmarked entry-fill quantities." />
        <ExecutionMetric label="Arrival slippage" value={formatBps(analytics.arrivalSlippageBps)} tone={(analytics.arrivalSlippageBps ?? 0) > 0 ? "bad" : "neutral"} title="Wait drift plus simulated execution adjustment from explicit submission benchmark to PAPER fill. Positive is adverse." />
        <ExecutionMetric label="All-in shortfall" value={formatBps(analytics.feeInclusiveShortfallBps)} tone={(analytics.feeInclusiveShortfallBps ?? 0) > 0 ? "bad" : "neutral"} title="Signed arrival slippage plus persisted PAPER fees, divided by arrival benchmark notional." />
      </div>
      <p className={`mt-1.5 text-[9px] leading-4 ${analytics.arrivalDataCorrupt ? "text-rose-200" : analytics.arrivalDataComplete ? "text-[#7f8da7]" : "text-amber-200"}`}>
        {arrivalAvailable
          ? `${analytics.arrivalSampleCount}/${analytics.arrivalEligibleFillCount} benchmarked non-reduce entry fills${analytics.arrivalDataComplete ? "" : "; missing legacy benchmarks excluded"} · wait ${formatSignedUsd(analytics.waitDriftUsd)} + execution ${formatSignedUsd(analytics.arrivalExecutionAdjustmentUsd)} = arrival ${formatSignedUsd(analytics.arrivalSlippageUsd)} · fee-inclusive ${formatSignedUsd(analytics.feeInclusiveShortfallUsd)}. Local PAPER analysis, not venue TCA.`
          : analytics.arrivalDataCorrupt
            ? `Arrival-to-fill metrics are withheld because an explicit benchmark or linked entry fill is invalid. ${analytics.arrivalSampleCount}/${analytics.arrivalEligibleFillCount} otherwise valid benchmarked samples; existing fill-time metrics remain independent.`
            : analytics.arrivalDataComplete
              ? "Arrival-to-fill analysis will appear after an entry fill with an explicit local PAPER submission benchmark. This is not venue TCA."
              : `Arrival-to-fill analysis is unavailable: ${analytics.arrivalSampleCount}/${analytics.arrivalEligibleFillCount} entry fills have explicit benchmarks; missing legacy benchmarks are never inferred. Existing fill-time metrics remain independent.`}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,0.8fr)]">
        <div>
          <div className="flex items-center justify-between gap-3 font-mono text-[9px] tabular-nums text-[#8e9cb2]">
            <span>Lifecycle</span>
            <span>{analytics.entryOrderCount} entry revision{analytics.entryOrderCount === 1 ? "" : "s"}</span>
          </div>
          <div className="mt-1.5 grid grid-cols-4 gap-px overflow-hidden rounded border border-[#1b2638] bg-[#1b2638] text-center font-mono text-[9px] tabular-nums">
            <LifecycleMetric label="Terminal" value={analytics.terminalEntryCount} />
            <LifecycleMetric label="Pending" value={analytics.pendingEntryCount} />
            <LifecycleMetric label="Replaced" value={analytics.replacedEntryCount} />
            <LifecycleMetric label="Partial entries" value={analytics.partiallyFilledEntryCount} />
          </div>
          <p className="mt-2 text-[9px] leading-4 text-[#7f8da7]">
            {outcomesAvailable
              ? `${analytics.terminalEntryCount} terminal entry sample${analytics.terminalEntryCount === 1 ? "" : "s"}; ${analytics.cancelledEntryCount} cancelled. All-fill notional ${formatUsd(analytics.fillNotionalUsd)} · fees ${formatUsd(analytics.feesUsd)} · signed adjustment ${formatSignedUsd(analytics.executionAdjustmentUsd)}.`
              : "Entry completion is unavailable until an entry revision fills or cancels."}
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between gap-3 font-mono text-[9px] tabular-nums text-[#8e9cb2]">
            <span>Cancellation drivers · all orders</span>
            <span>{analytics.cancellationSampleCount}</span>
          </div>
          {analytics.cancellationDrivers.length ? (
            <ul className="mt-1.5 grid gap-1" aria-label="Paper order cancellation drivers">
              {analytics.cancellationDrivers.map((driver) => (
                <li key={driver.bucket} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 font-mono text-[9px] tabular-nums text-[#9eabc0]">
                  <span className="truncate">{driver.label}</span>
                  <span>{driver.count} · {formatPercent(driver.sharePct)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-[9px] text-[#7f8da7]">No PAPER cancellations recorded.</p>}
        </div>
      </div>

      <p className={`mt-2 text-[9px] leading-4 ${analytics.qualityDataComplete ? "text-[#7f8da7]" : "text-rose-200"}`}>
        {analytics.qualityDataComplete
          ? "Fill-adjustment benchmark: persisted execution-time trade/book reference. Maker/taker role, venue latency, and rejected-attempt mix remain unavailable in local PAPER state."
          : "Fill-quality metrics are withheld because one or more persisted fill samples are incomplete or internally inconsistent."}
      </p>
    </section>
  );
});

function ExecutionMetric({ label, value, tone = "neutral", title }: { label: string; value: string; tone?: "neutral" | "bad"; title: string }) {
  return <div className="min-w-0 bg-[#080c13] px-2 py-1.5" title={title}><span className="block truncate text-[8px] uppercase tracking-[0.1em] text-[#7f8da7]">{label}</span><span className={`mt-0.5 block truncate font-mono text-[9px] tabular-nums ${tone === "bad" ? "text-rose-300" : "text-[#dce6f4]"}`}>{value}</span></div>;
}

function LifecycleMetric({ label, value }: { label: string; value: number }) {
  return <div className="bg-[#080c13] px-1.5 py-1.5"><span className="block text-[8px] uppercase tracking-[0.08em] text-[#7f8da7]">{label}</span><span className="mt-0.5 block text-[#dce6f4]">{value}</span></div>;
}

function formatPercent(value: number | null) {
  return value == null || !Number.isFinite(value) ? "UNAVAILABLE" : `${value.toFixed(1)}%`;
}

function formatBps(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "UNAVAILABLE";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)} bp`;
}

function formatLatencyPair(medianMs: number | null, p95Ms: number | null) {
  if (medianMs == null || p95Ms == null) return "UNAVAILABLE";
  return `${formatDuration(medianMs)} / ${formatDuration(p95Ms)}`;
}

function formatDuration(valueMs: number) {
  if (valueMs < 1_000) return `${Math.round(valueMs)}ms`;
  if (valueMs < 60_000) return `${(valueMs / 1_000).toFixed(valueMs < 10_000 ? 1 : 0)}s`;
  return `${(valueMs / 60_000).toFixed(valueMs < 600_000 ? 1 : 0)}m`;
}

function formatUsd(value: number | null) {
  return value == null || !Number.isFinite(value)
    ? "UNAVAILABLE"
    : value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatSignedUsd(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "UNAVAILABLE";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
