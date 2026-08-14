"use client";

import { useMemo } from "react";
import type { PaperTradingState } from "@/lib/paper-trading-engine";
import {
  deriveTerminalPaperRiskDesk,
  type TerminalPaperMarketTarget,
} from "@/lib/terminal-paper-risk-desk";

export function PaperRiskDesk({
  state,
  now,
  maxAgeMs,
  pendingPositionKey,
  onLoadMarket,
}: {
  state: PaperTradingState;
  now: string;
  maxAgeMs: number;
  pendingPositionKey: string | null;
  onLoadMarket: (positionKey: string, target: TerminalPaperMarketTarget) => void;
}) {
  const desk = useMemo(
    () => deriveTerminalPaperRiskDesk(state, { now, maxAgeMs }),
    [maxAgeMs, now, state],
  );
  const partialLabel = desk.portfolioFullyPriced ? "Fresh marks" : "Partial marks";

  return (
    <section
      id="paper-risk-desk"
      tabIndex={-1}
      className="scroll-mt-16 border-b border-[#182234] px-4 py-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-400 sm:px-5"
      aria-labelledby="paper-risk-desk-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="paper-risk-desk-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa7ba]">Portfolio risk desk</h3>
          <p className="mt-1 text-[9px] leading-4 text-[#7f8da7]">
            Fresh-mark exposure, concentration, and parallel price shocks · local PAPER state only.
          </p>
        </div>
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.1em] ${desk.portfolioFullyPriced ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-200" : "border-rose-400/45 bg-rose-400/10 text-rose-200"}`}>
          {partialLabel} · {desk.pricedPositionCount}/{desk.openPositionCount}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded border border-[#1b2638] bg-[#1b2638] sm:grid-cols-3 xl:grid-cols-6" aria-label="Paper portfolio exposure summary">
        <RiskDeskMetric label={desk.portfolioFullyPriced ? "Gross notional" : "Priced gross"} value={formatUsd(desk.grossNotionalUsd)} />
        <RiskDeskMetric label={desk.portfolioFullyPriced ? "Net notional" : "Priced net"} value={formatSignedUsd(desk.netNotionalUsd)} tone={desk.netNotionalUsd === 0 ? "neutral" : desk.netNotionalUsd > 0 ? "long" : "short"} />
        <RiskDeskMetric label="Long / short" value={`${formatUsd(desk.longNotionalUsd)} / ${formatUsd(desk.shortNotionalUsd)}`} />
        <RiskDeskMetric label="Net bias" value={formatPercent(desk.netBiasPct)} />
        <RiskDeskMetric label="Largest risk" value={formatPercent(desk.largestConcentrationPct)} tone={(desk.largestConcentrationPct ?? 0) >= 50 ? "warn" : "neutral"} />
        <RiskDeskMetric label="Mark coverage" value={desk.markCoveragePct == null ? "FLAT" : `${formatPercent(desk.markCoveragePct)} · ${formatAge(desk.oldestFreshMarkAgeMs)}`} tone={desk.portfolioFullyPriced ? "good" : "bad"} />
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <RiskDeskUsage label="Session loss" value={desk.sessionLossUsd} limit={desk.sessionLossLimitUsd} utilizationPct={desk.sessionLossUtilizationPct} />
        <RiskDeskUsage label="Peak drawdown" value={desk.drawdownUsd} limit={desk.drawdownLimitUsd} utilizationPct={desk.drawdownUtilizationPct} />
      </div>

      {desk.positions.length ? (
        <div className="mt-3 overflow-x-auto" tabIndex={0} aria-label="Scrollable paper portfolio risk table">
          <table className="w-full min-w-[49rem] border-collapse font-mono text-[9px] tabular-nums">
            <caption className="sr-only">Open paper positions ranked by fresh priced gross notional, with mark freshness, concentration, current P&amp;L, and mark recovery.</caption>
            <thead className="text-[#7f8da7]">
              <tr>
                <th scope="col" className="pb-1 text-left font-normal">Market</th>
                <th scope="col" className="pb-1 text-left font-normal">Side / size</th>
                <th scope="col" className="pb-1 text-right font-normal">Mark / age</th>
                <th scope="col" className="pb-1 text-right font-normal">Gross</th>
                <th scope="col" className="pb-1 text-right font-normal">Risk share</th>
                <th scope="col" className="pb-1 text-right font-normal">Current P&amp;L</th>
                <th scope="col" className="pb-1 text-right font-normal">Mark action</th>
              </tr>
            </thead>
            <tbody>
              {desk.positions.map((position) => {
                const markRefreshTarget = position.markRefreshTarget;
                return (
                  <tr key={position.positionKey} className="border-t border-[#141d2e] text-[#c7d2e4]">
                    <th scope="row" className="py-2 text-left font-normal">
                      {position.product}
                      <span className="ml-1 text-[8px] text-[#7f8da7]">{position.venueId} · {position.network}</span>
                    </th>
                    <td className={position.side === "long" ? "py-2 text-emerald-300" : "py-2 text-rose-300"}>{position.side.toUpperCase()} {formatBase(position.quantityBase)}</td>
                    <td className="py-2 text-right">
                      <span className="block">{formatPrice(position.markPrice)}</span>
                      <span className={`block text-[8px] ${position.markStatus === "fresh" ? "text-[#7f8da7]" : "text-rose-300"}`}>{position.markStatus.toUpperCase()} · {formatAge(position.markAgeMs)}</span>
                    </td>
                    <td className="py-2 text-right">{position.grossNotionalUsd == null ? "UNPRICED" : formatUsd(position.grossNotionalUsd)}</td>
                    <td className="py-2 text-right">{formatPercent(position.riskContributionPct)}</td>
                    <td className={`py-2 text-right ${pnlTone(position.pnlUsd)}`}>{position.pnlUsd == null ? "UNPRICED" : formatSignedUsd(position.pnlUsd)}</td>
                    <td className="py-2 pl-2 text-right">
                      {position.markStatus === "fresh" ? (
                        <span className="text-[#566278]" aria-label="No mark action required">—</span>
                      ) : markRefreshTarget ? (
                        <button
                          type="button"
                          disabled={pendingPositionKey === position.positionKey}
                          aria-label={`${pendingPositionKey === position.positionKey ? "Await fresh mark for" : "Load market for"} ${position.product} on ${position.venueId} ${position.network}`}
                          onClick={() => onLoadMarket(position.positionKey, markRefreshTarget)}
                          className="rounded border border-sky-400/35 bg-sky-400/[0.07] px-2 py-1 text-[8px] font-semibold uppercase tracking-[0.08em] text-sky-200 disabled:cursor-wait disabled:border-amber-300/30 disabled:bg-amber-300/[0.06] disabled:text-amber-100"
                        >
                          {pendingPositionKey === position.positionKey ? "Await fresh mark" : "Load market"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled
                          title="Persisted venue, product, or network is not an exact supported terminal market."
                          className="rounded border border-[#1b2638] px-2 py-1 text-[8px] font-semibold uppercase tracking-[0.08em] text-[#718097]"
                        >
                          Unavailable
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 text-[10px] text-[#7f8da7]">Flat portfolio. Exposure and parallel-shock P&amp;L are zero.</p>
      )}

      <div className="mt-3 overflow-x-auto" tabIndex={0} aria-label="Scrollable paper portfolio shock table">
        <table className="w-full min-w-[34rem] border-collapse font-mono text-[9px] tabular-nums">
          <caption className="sr-only">Portfolio P&amp;L change and stressed equity under parallel market shocks.</caption>
          <thead className="text-[#7f8da7]">
            <tr><th scope="col" className="pb-1 text-left font-normal">Parallel shock</th>{desk.scenarios.map((scenario) => <th key={scenario.shockPct} scope="col" className="pb-1 text-right font-normal">{formatSignedPercent(scenario.shockPct)}</th>)}</tr>
          </thead>
          <tbody>
            <tr className="border-t border-[#141d2e] text-[#c7d2e4]"><th scope="row" className="py-1.5 text-left font-normal">P&amp;L change{desk.portfolioFullyPriced ? "" : " · priced only"}</th>{desk.scenarios.map((scenario) => <td key={scenario.shockPct} className={`py-1.5 text-right ${pnlTone(scenario.pnlChangeUsd)}`}>{formatSignedUsd(scenario.pnlChangeUsd)}</td>)}</tr>
            <tr className="border-t border-[#141d2e] text-[#9ba8bc]"><th scope="row" className="py-1.5 text-left font-normal">Stressed equity</th>{desk.scenarios.map((scenario) => <td key={scenario.shockPct} className="py-1.5 text-right">{scenario.stressedEquityUsd == null ? "UNAVAILABLE" : formatUsd(scenario.stressedEquityUsd)}</td>)}</tr>
          </tbody>
        </table>
      </div>

      <p className={`mt-2 text-[9px] leading-4 ${desk.portfolioFullyPriced ? "text-[#7f8da7]" : "text-rose-200"}`}>
        {desk.openPositionCount === 0
          ? "No open positions require marks."
          : desk.portfolioFullyPriced
            ? `All open positions use marks no older than ${formatAge(desk.markMaxAgeMs)}; oldest current mark ${formatAge(desk.oldestFreshMarkAgeMs)}.`
          : `${desk.unpricedPositionCount} open position${desk.unpricedPositionCount === 1 ? " is" : "s are"} excluded from exposure and shock totals. Stressed equity is withheld until every mark is fresh.`}
        {" "}Shocks are linear, simultaneous, and exclude liquidity, fees, funding, and basis changes.
      </p>
    </section>
  );
}

function RiskDeskMetric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "bad" | "warn" | "long" | "short" }) {
  const toneClass = tone === "good" || tone === "long"
    ? "text-emerald-300"
    : tone === "bad" || tone === "short"
      ? "text-rose-300"
      : tone === "warn"
        ? "text-amber-200"
        : "text-[#dce6f4]";
  return <div className="min-w-0 bg-[#080c13] px-2 py-1.5"><span className="block truncate text-[8px] uppercase tracking-[0.1em] text-[#7f8da7]">{label}</span><span className={`mt-0.5 block truncate font-mono text-[9px] tabular-nums ${toneClass}`} title={value}>{value}</span></div>;
}

function RiskDeskUsage({ label, value, limit, utilizationPct }: { label: string; value: number; limit: number; utilizationPct: number }) {
  const widthPct = Math.min(100, utilizationPct);
  const tone = utilizationPct >= 80 ? "bg-rose-400" : utilizationPct >= 50 ? "bg-amber-300" : "bg-emerald-400";
  return (
    <div>
      <div className="mb-1 flex justify-between gap-2 font-mono text-[8px] tabular-nums text-[#7f8da7]"><span>{label}</span><span>{formatUsd(value)} / {formatUsd(limit)} · {formatPercent(utilizationPct)}</span></div>
      <div role="progressbar" aria-label={`${label} paper risk utilization`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, utilizationPct)} className="h-1 overflow-hidden rounded bg-[#1b2638]">
        <span className={`block h-full ${tone}`} style={{ width: `${widthPct}%` }} />
      </div>
    </div>
  );
}

function formatUsd(value: number) {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatSignedUsd(value: number) {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercent(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;
}

function formatSignedPercent(value: number) {
  return `${value > 0 ? "+" : ""}${value}%`;
}

function formatAge(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "NO MARK";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  return `${Math.round(value / 60_000)}m`;
}

function formatPrice(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: value >= 1_000 ? 1 : 2, maximumFractionDigits: value >= 1_000 ? 1 : 4 });
}

function formatBase(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function pnlTone(value: number | null) {
  if (value == null || value === 0) return "text-[#9ba8bc]";
  return value > 0 ? "text-emerald-300" : "text-rose-300";
}
