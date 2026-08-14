"use client";

import { memo, useMemo } from "react";
import type {
  TerminalRouteCandidate,
  TerminalRouteDecision,
  TerminalRouteExclusionCode,
} from "@/lib/terminal-route-decision";
import type { TerminalRouteImprovement } from "@/lib/terminal-route-alert";
import {
  terminalRouteCostAssumption,
  terminalRouteCostEvidence,
  TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS,
  TERMINAL_ROUTE_COST_MAX_BPS,
  type TerminalAllInRouteModel,
  type TerminalRouteCostField,
  type TerminalRouteCostVenue,
} from "@/lib/terminal-route-cost-policy";
import type { TerminalRouteCostPolicyController } from "@/lib/use-terminal-route-cost-policy";

const ROUTE_EXCLUSION_LABELS: Record<TerminalRouteExclusionCode, string> = {
  route_frame_venue_unsupported: "venue unsupported",
  route_frame_identity_mismatch: "market identity mismatch",
  route_product_class_mismatch: "spot/perpetual mismatch",
  route_network_mismatch: "network mismatch",
  route_frame_stale: "frame stale",
  route_frame_timestamp_invalid: "frame clock invalid",
  route_frame_timestamp_future: "frame clock future",
  route_frame_expired: "frame expired",
  route_reference_price_invalid: "reference invalid",
  route_visible_book_unavailable: "visible book unavailable",
  route_visible_book_malformed: "visible book malformed or unsorted",
  route_visible_book_crossed: "visible book crossed",
  route_visible_book_quote_mismatch: "book and top quote disagree",
  route_visible_book_timestamp_invalid: "book clock missing",
  route_visible_book_timestamp_future: "book clock future",
  route_visible_book_expired: "book expired",
};

export interface TerminalRouteMatrixProps {
  decision: TerminalRouteDecision;
  improvement: TerminalRouteImprovement | null;
  selectedVenue: string;
  costPolicy: TerminalRouteCostPolicyController;
  allInModel: TerminalAllInRouteModel | null;
  onStageCandidate: (candidate: TerminalRouteCandidate) => void;
  onStopPeerFeeds?: () => void;
}

export const TerminalRouteMatrix = memo(function TerminalRouteMatrix({
  decision,
  improvement,
  selectedVenue,
  costPolicy,
  allInModel,
  onStageCandidate,
  onStopPeerFeeds,
}: TerminalRouteMatrixProps) {
  const { storageKey, loadedStorageKey, inspection: policyInspection, message: policyMessage } = costPolicy;
  const displayRows = allInModel?.status === "ready"
    ? allInModel.rows
    : decision.candidates.map((candidate) => ({ rank: candidate.rank, candidate, feeBps: 0, bufferBps: 0, frictionBps: 0, frictionUsd: 0, netVwap: candidate.vwap }));
  const bestCandidate = allInModel?.best?.candidate ?? decision.best;
  const policyVenues = useMemo(() => [...new Set(decision.candidates.map((candidate) => candidate.venue))]
    .filter((venue): venue is TerminalRouteCostVenue => venue === "hyperliquid" || venue === "phoenix" || venue === "coinbase"), [decision.candidates]);
  const exclusionSummary = summarizeExclusions(decision.exclusions);
  const status = decision.status === "full_available"
    ? "full visible fill"
    : decision.status === "partial_only"
      ? "partial visible fill only"
      : "no visible fill";
  function resetPolicy() {
    if (!storageKey || !window.confirm("Clear all local route fee and execution-buffer assumptions? Live risk checks will wait for explicit replacements.")) return;
    costPolicy.reset();
  }
  return (
    <section
      id="terminal-route-matrix"
      tabIndex={-1}
      className="mx-3 mb-3 overflow-hidden rounded-md border border-[#182234] bg-[#080c13] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-300 sm:mx-6"
      aria-labelledby="route-matrix-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[#182234] px-3 py-2.5">
        <div>
          <h2 id="route-matrix-heading" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#9aa7ba]">Visible-depth route matrix</h2>
          <p className="mt-1 text-[9px] text-[#7f8da7]">{decision.side.toUpperCase()} ${formatMoney(decision.requestedNotionalUsd)} · limit {formatPrice(decision.limitPrice)}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={decision.status === "full_available"
            ? "font-mono text-[9px] uppercase text-emerald-300"
            : decision.status === "partial_only"
              ? "font-mono text-[9px] uppercase text-amber-200"
              : "font-mono text-[9px] uppercase text-rose-300"}
          >
            {status}
          </span>
          {bestCandidate && bestCandidate.venue !== selectedVenue && bestCandidate.fillPct > 0 ? (
            <button
              type="button"
              onClick={() => onStageCandidate(bestCandidate as TerminalRouteCandidate)}
              title={allInModel?.status === "ready" ? "Stages the best route after local cost assumptions" : "Stages the gross visible-depth leader"}
              className="rounded border border-sky-300/35 bg-sky-300/10 px-2 py-1 text-[9px] font-medium text-sky-200 hover:bg-sky-300/15"
            >
              Stage best route
            </button>
          ) : null}
          {onStopPeerFeeds ? (
            <button
              type="button"
              onClick={onStopPeerFeeds}
              className="rounded border border-[#2a3951] px-2 py-1 text-[9px] text-[#9aa7ba] hover:border-[#52617a]"
            >
              Stop peer feeds
            </button>
          ) : null}
        </div>
      </div>
      {improvement ? (
        <div className="border-b border-[#141d2e] bg-[#0a111d] px-3 py-2 font-mono text-[9px] tabular-nums">
          {improvement.improvementUsd > 0 ? (
            <p className="text-emerald-200">
              Gross visible edge · {improvement.peerVenue.toUpperCase()} has {formatUsd(improvement.improvementUsd)} / {formatSigned(improvement.improvementBps)} bp price advantage versus {improvement.selectedVenue.toUpperCase()}
              <span className="ml-1 text-[#718097]">({formatPrice(improvement.peerVwap)} vs {formatPrice(improvement.selectedVwap)} VWAP)</span>
            </p>
          ) : (
            <p className="text-[#8b95a8]">No compatible full-fill peer improves the selected venue&apos;s visible VWAP.</p>
          )}
        </div>
      ) : null}
      {allInModel?.status === "ready" ? (
        <div className="border-b border-[#141d2e] bg-[#0a111d] px-3 py-2 font-mono text-[9px] tabular-nums">
          {allInModel.improvementUsd != null && allInModel.improvementUsd > 0 && allInModel.improvementBps != null && allInModel.bestPeer ? (
            <p className="text-emerald-200">
              Modeled all-in edge · {allInModel.bestPeer.candidate.venue.toUpperCase()} improves on selected by {formatUsd(allInModel.improvementUsd)} / {formatSigned(allInModel.improvementBps)} bp using your local assumptions.
            </p>
          ) : (
            <p className="text-[#8b95a8]">No full-fill peer improves the selected venue after your local fee and execution-buffer assumptions.</p>
          )}
        </div>
      ) : decision.candidates.length > 0 ? (
        <p role="status" className="border-b border-amber-300/15 bg-amber-300/[0.03] px-3 py-2 text-[9px] text-amber-100">
          All-in ranking withheld until every displayed venue has current fee and execution-buffer evidence. Gross depth remains informational.
        </p>
      ) : null}
      <details className="border-b border-[#141d2e] bg-[#080d15] px-3 py-2">
        <summary className="cursor-pointer text-[9px] font-medium text-sky-200">Local all-in assumptions</summary>
        {!storageKey ? (
          <p role="status" className="mt-2 text-[9px] text-amber-100">A verified local persistence scope is required before all-in ranking is enabled.</p>
        ) : loadedStorageKey !== storageKey ? (
          <p role="status" className="mt-2 text-[9px] text-[#8b95a8]">Loading account-scoped cost assumptions…</p>
        ) : policyInspection.status === "blocked" ? (
          <div role="alert" className="mt-2 rounded border border-rose-300/30 bg-rose-300/[0.04] p-2 text-[9px] text-rose-200">
            Existing cost-policy bytes are unreadable and preserved. Gross routing remains available; all-in ranking is locked.
            <button type="button" onClick={resetPolicy} className="term-chip mt-2 block h-7 px-2 text-[8px]">Reset cost policy</button>
          </div>
        ) : (
          <>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {policyVenues.map((venue) => {
                const assumption = terminalRouteCostAssumption(policyInspection.policy, venue);
                const evidence = terminalRouteCostEvidence(policyInspection, venue, costPolicy.nowMs);
                return (
                  <fieldset key={venue} className="rounded border border-[#182234] p-2">
                    <legend className="px-1 text-[8px] font-semibold uppercase text-[#8b95a8]">{venue}</legend>
                    <div className="grid grid-cols-2 gap-1.5">
                      <CostInput label="Fee bp" state={fieldState(evidence.feeConfigured, evidence.feeCurrent, evidence.status)} venue={venue} field="feeBps" value={assumption.feeBps} onCommit={costPolicy.commit} />
                      <CostInput label="Buffer bp" state={fieldState(evidence.bufferConfigured, evidence.bufferCurrent, evidence.status)} venue={venue} field="bufferBps" value={assumption.bufferBps} onCommit={costPolicy.commit} />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <span className={`font-mono text-[7px] ${evidence.status === "ready" ? "text-[#66738c]" : "text-amber-200"}`}>{costEvidenceAgeLabel(evidence, costPolicy.nowMs)}</span>
                      <button
                        type="button"
                        disabled={!evidence.feeConfigured || !evidence.bufferConfigured}
                        onClick={() => costPolicy.reconfirm(venue)}
                        className="rounded border border-[#2a3951] px-1.5 py-1 text-[7px] text-sky-200 hover:border-sky-300/45 disabled:cursor-not-allowed disabled:text-[#566278]"
                      >Reconfirm both</button>
                    </div>
                  </fieldset>
                );
              })}
            </div>
            <button type="button" onClick={resetPolicy} className="term-chip mt-2 h-7 px-2 text-[8px]">Clear assumptions</button>
          </>
        )}
        <p aria-live="polite" className="mt-1 min-h-3 text-[8px] text-amber-100">{policyMessage}</p>
        <p className="text-[8px] leading-3 text-[#66738c]">0–{TERMINAL_ROUTE_COST_MAX_BPS} bp per field. Reconfirm at least every {Math.round(TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS / 86_400_000)} days. Values are your account-local assumptions—not venue fee data or execution guarantees.</p>
      </details>
      {decision.candidates.length ? (
        <div className="overflow-x-auto" tabIndex={0} aria-label="Scrollable venue route comparison">
          <table className="min-w-[52rem] w-full border-collapse font-mono text-[10px] tabular-nums">
            <caption className="sr-only">Venues ranked by visible fill percentage, locally modeled net price, then source freshness.</caption>
            <thead className="text-[#7f8da7]">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-normal">Rank / market</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Visible fill</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">VWAP</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Local friction</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Net VWAP</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Impact</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Unfilled</th>
                <th scope="col" className="px-3 py-2 text-right font-normal">Book age</th>
                <th scope="col" className="px-3 py-2 text-right font-normal">Ticket</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row) => {
                const candidate = row.candidate;
                return (
                <tr key={`${candidate.venue}:${candidate.product}`} className="border-t border-[#141d2e] text-[#c7d2e4]">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <span className={row.rank === 1 ? "text-sky-300" : "text-[#8b95a8]"}>{allInModel?.status === "ready" ? "A" : "G"}#{row.rank}</span>{" "}
                    <span className="uppercase">{candidate.venue}</span>
                    <span className="mt-0.5 block text-[8px] uppercase text-[#7f8da7]">
                      {allInModel?.status === "ready" ? `G#${candidate.rank} · ` : ""}{candidate.product} · {candidate.productClass} · {candidate.network}
                    </span>
                  </th>
                  <td className={candidate.status === "full" ? "px-2 py-2 text-right text-emerald-300" : candidate.fillPct > 0 ? "px-2 py-2 text-right text-amber-200" : "px-2 py-2 text-right text-rose-300"}>
                    {candidate.fillPct.toFixed(1)}% · {candidate.status}
                  </td>
                  <td className="px-2 py-2 text-right">{formatPrice(candidate.vwap)}</td>
                  <td className="px-2 py-2 text-right">{formatSigned(row.frictionBps)} bp · {formatUsd(row.frictionUsd)}</td>
                  <td className="px-2 py-2 text-right">{formatPrice(row.netVwap)}</td>
                  <td className="px-2 py-2 text-right">{candidate.impactBps == null ? "—" : `${formatSigned(candidate.impactBps)} bp`}</td>
                  <td className="px-2 py-2 text-right">${formatMoney(candidate.unfilledNotionalUsd)}</td>
                  <td className="px-3 py-2 text-right">{formatAge(candidate.bookAgeMs)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      disabled={candidate.venue === selectedVenue || candidate.fillPct <= 0}
                      onClick={() => onStageCandidate(candidate)}
                      className="rounded border border-[#2a3951] px-2 py-1 text-[9px] text-sky-200 hover:border-sky-300/45 disabled:cursor-not-allowed disabled:text-[#66738c]"
                    >
                      {candidate.venue === selectedVenue ? "Selected" : candidate.fillPct > 0 ? "Stage" : "No fill"}
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p role="status" className="px-3 py-3 text-[10px] text-[#8b95a8]">
          {decision.blocker ? blockerLabel(decision.blocker) : "No fresh identity-matched venue has usable visible depth."}
        </p>
      )}
      <p className="border-t border-[#141d2e] px-3 py-2 text-[9px] leading-4 text-[#7f8da7]">
        Staging changes the ticket venue only; it clears bound levels and never previews or submits. Gross VWAP uses certified public visible depth. Net VWAP adds only your stored fee and buffer assumptions; latency, queue position, hidden liquidity, and guarantees remain excluded.
        {exclusionSummary ? ` Excluded: ${exclusionSummary}.` : ""}
      </p>
    </section>
  );
});

function CostInput({
  label,
  state,
  venue,
  field,
  value,
  onCommit,
}: {
  label: string;
  state: "required" | "set" | "expired" | "invalid";
  venue: TerminalRouteCostVenue;
  field: TerminalRouteCostField;
  value: number;
  onCommit: (venue: TerminalRouteCostVenue, field: TerminalRouteCostField, value: number) => boolean;
}) {
  return (
    <label className="min-w-0 text-[8px] text-[#66738c]">
      <span className={`block truncate ${state === "set" ? "text-emerald-300" : state === "required" ? "text-amber-200" : "text-rose-300"}`}>{label} · {state}</span>
      <input
        key={`${venue}:${field}:${value}`}
        type="number"
        min={0}
        max={TERMINAL_ROUTE_COST_MAX_BPS}
        step="0.1"
        inputMode="decimal"
        aria-label={`${venue} ${label}`}
        defaultValue={value}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={(event) => {
          if (!onCommit(venue, field, event.currentTarget.valueAsNumber)) event.currentTarget.value = String(value);
        }}
        className="trade-field mt-1 h-7 w-full rounded px-1.5 font-mono text-[9px] text-[#dce6f4] outline-none"
      />
    </label>
  );
}

function fieldState(configured: boolean, current: boolean, status: ReturnType<typeof terminalRouteCostEvidence>["status"]): "required" | "set" | "expired" | "invalid" {
  return !configured ? "required" : status === "invalid" ? "invalid" : current ? "set" : "expired";
}

function costEvidenceAgeLabel(evidence: ReturnType<typeof terminalRouteCostEvidence>, nowMs: number) {
  if (!evidence.feeConfigured || !evidence.bufferConfigured) return "both fields required";
  if (evidence.status === "invalid") return "timestamp invalid";
  if (evidence.ageMs == null || evidence.expiresAtMs == null) return "age unavailable";
  if (evidence.status === "expired") return `expired ${formatDuration(evidence.ageMs - TERMINAL_ROUTE_COST_EVIDENCE_MAX_AGE_MS)} ago`;
  return `age ${formatDuration(evidence.ageMs)} · expires in ${formatDuration(Math.max(0, evidence.expiresAtMs - nowMs))}`;
}

function formatDuration(valueMs: number) {
  if (valueMs < 60_000) return "<1m";
  if (valueMs < 3_600_000) return `${Math.floor(valueMs / 60_000)}m`;
  if (valueMs < 86_400_000) return `${Math.floor(valueMs / 3_600_000)}h`;
  return `${Math.floor(valueMs / 86_400_000)}d`;
}

function summarizeExclusions(exclusions: TerminalRouteDecision["exclusions"]) {
  const counts = new Map<TerminalRouteExclusionCode, number>();
  for (const exclusion of exclusions) {
    counts.set(exclusion.code, (counts.get(exclusion.code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => `${count} ${ROUTE_EXCLUSION_LABELS[code]}`)
    .join(" · ");
}

function formatPrice(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 1_000 ? value.toFixed(1) : value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatMoney(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "—";
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

function formatSigned(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function formatAge(value: number) {
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(1)} s`;
}

function blockerLabel(blocker: Exclude<TerminalRouteDecision["blocker"], null>) {
  if (blocker === "route_notional_invalid") return "Enter a positive notional to compare visible routes.";
  if (blocker === "route_limit_invalid") return "Set a positive limit to compare visible routes.";
  if (blocker === "route_clock_invalid") return "A valid local clock is required to compare route freshness.";
  if (blocker === "route_context_invalid") return "A trusted product and network context is required to compare routes.";
  return "The route freshness window is invalid.";
}
