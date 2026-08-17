"use client";

import { memo, useLayoutEffect, useMemo, useState } from "react";
import type { TerminalLiveAccountView } from "@/lib/terminal-live-account";
import { terminalLiveAccountOrderEventKey } from "@/lib/terminal-live-account-events";
import {
  deriveTerminalLiveAccountRisk,
  type TerminalLiveAccountRiskDecision,
} from "@/lib/terminal-live-account-risk";
import { useTerminalLiveAccount } from "@/lib/use-terminal-live-account";
import { TerminalLiveAccountTriage } from "@/components/trade/TerminalLiveAccountTriage";
import { deriveTerminalLiveOrderReconciliation } from "@/lib/terminal-live-order-reconciliation";
import {
  HYPERLIQUID_CLOSE_CONFIRMATION,
  closeHyperliquidPosition,
} from "@/lib/private-account-client";
import { authorizePrivateAccountWalletRequest } from "@/lib/private-account-wallet-step-up";

export const TerminalLiveAccountPanel = memo(function TerminalLiveAccountPanel({
  authenticated,
  subjectScope,
  selectedVenue,
  expectedNetwork,
  coin,
  market,
  reduceOnly,
  onRiskDecision,
  onInspectMarket,
  restartKey = 0,
  onRefresh,
}: {
  authenticated: boolean;
  subjectScope: string | null;
  selectedVenue: string;
  expectedNetwork: "mainnet" | "testnet";
  coin: "BTC" | "ETH" | "SOL" | "HYPE";
  market: string;
  reduceOnly: boolean;
  onRiskDecision: (decision: TerminalLiveAccountRiskDecision) => void;
  onInspectMarket?: (target: { market: string; network: "mainnet" | "testnet" }) => void;
  restartKey?: number;
  onRefresh?: () => void;
}) {
  const view = useTerminalLiveAccount({ authenticated, subjectScope, selectedVenue, expectedNetwork, coin, restartKey });
  const decision = useMemo(() => deriveTerminalLiveAccountRisk({
    authenticated,
    subjectScope,
    selectedVenue,
    expectedNetwork,
    market,
    reduceOnly,
    view,
  }), [authenticated, expectedNetwork, market, reduceOnly, selectedVenue, subjectScope, view]);
  useLayoutEffect(() => onRiskDecision(decision), [decision, onRiskDecision]);
  return <TerminalLiveAccountBlotter view={view} decision={decision} onInspectMarket={onInspectMarket} onRefresh={onRefresh} />;
});

export const TerminalLiveAccountBlotter = memo(function TerminalLiveAccountBlotter({
  view,
  decision = null,
  onInspectMarket,
  onRefresh,
}: {
  view: TerminalLiveAccountView;
  decision?: TerminalLiveAccountRiskDecision | null;
  onInspectMarket?: (target: { market: string; network: "mainnet" | "testnet" }) => void;
  onRefresh?: () => void;
}) {
  const inspectMarket = view.network && onInspectMarket
    ? (market: string) => onInspectMarket({ market, network: view.network as "mainnet" | "testnet" })
    : undefined;
  const orderReconciliation = deriveTerminalLiveOrderReconciliation(view);
  return (
    <section id="terminal-live-account-blotter" tabIndex={-1} className="border-b border-[#182234] bg-[#070a10] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-300/60" aria-labelledby="live-account-blotter-heading">
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div>
          <h2 id="live-account-blotter-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#dce6f4]">Live account blotter</h2>
          <p className="mt-0.5 text-[9px] text-[#66738c]">Hyperliquid · privacy-bucketed positions, orders, fills, lifecycle</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onRefresh ? <button type="button" onClick={onRefresh} disabled={view.status === "connecting"} aria-label="Refresh live account evidence" className="term-chip h-7 px-2 text-[8px] disabled:cursor-wait disabled:opacity-50">Refresh</button> : null}
          <span className={`rounded border px-2 py-1 font-mono text-[8px] uppercase ${statusTone(view.status)}`}>
            {statusLabel(view)}
          </span>
        </div>
      </div>
      {view.status === "unavailable" || view.status === "connecting" ? (
        <p className="border-t border-[#141d2e] px-4 py-3 text-[10px] leading-4 text-[#8794aa]" role="status">
          {blockerLabel(view.blocker)}
        </p>
      ) : (
        <>
          {view.status === "degraded" ? <p className="border-t border-amber-300/20 bg-amber-300/5 px-4 py-2 text-[9px] text-amber-100" role="status">Retained account rows are degraded: {blockerLabel(view.blocker)}</p> : null}
          {decision && decision.status !== "not_applicable" ? (
            <div className={`flex items-start gap-2 border-t px-4 py-2 ${riskDecisionTone(decision.status)}`} aria-label="Portfolio execution guard">
              <span className="shrink-0 font-mono text-[8px] font-semibold uppercase tracking-[0.1em]">{riskDecisionLabel(decision.status)}</span>
              <p className="text-[9px] leading-4">{decision.reason}</p>
            </div>
          ) : null}
          <TerminalLiveAccountTriage view={view} onInspectMarket={inspectMarket} />
          <section className={`border-t px-4 py-2.5 ${reconciliationTone(orderReconciliation.status)}`} aria-labelledby="live-order-reconciliation-heading">
            <div className="flex items-center justify-between gap-2">
              <h3 id="live-order-reconciliation-heading" className="text-[8px] font-semibold uppercase tracking-[0.12em]">Order-state reconciliation</h3>
              <span className="font-mono text-[8px] uppercase">{orderReconciliation.status}</span>
            </div>
            <p className="mt-1 text-[8px] leading-3">{orderReconciliation.summary}</p>
            {orderReconciliation.items.length ? (
              <ol className="mt-2 grid gap-1" aria-label="Order-state reconciliation findings">
                {orderReconciliation.items.map((item) => (
                  <li key={`${item.code}:${item.orderHandleCommitment}`} className="flex items-start justify-between gap-2 rounded border border-current/15 bg-black/10 px-2 py-1.5 text-[8px] leading-3">
                    <span><strong className="font-semibold">{item.market}</strong> · {item.detail}</span>
                    <span className="shrink-0 font-mono uppercase">{item.blocksExposureIncrease ? "block" : "pending"}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            {orderReconciliation.hiddenItemCount ? <p className="mt-1 text-[8px]">+{orderReconciliation.hiddenItemCount} bounded finding{orderReconciliation.hiddenItemCount === 1 ? "" : "s"} omitted.</p> : null}
          </section>
          <div className="grid grid-cols-2 border-t border-[#141d2e] font-mono text-[9px] sm:grid-cols-4 xl:grid-cols-7">
            <Stat label="Network" value={view.network ?? "—"} />
            <Stat label="Account" value={accountStatusLabel(view.accountStatus)} tone={accountStatusTone(view.accountStatus)} />
            <Stat label="Source" value={accountSourceLabel(view.accountSource)} />
            <Stat label="Equity" value={view.equityBucket ?? "—"} />
            <Stat label="Margin use" value={view.marginUtilizationBucket ?? "—"} tone={marginUtilizationTone(view.marginUtilizationBucket)} />
            <Stat label="Nearest liq" value={liquidationLabel(view.nearestLiquidationDistance)} tone={liquidationTone(view.nearestLiquidationDistance)} />
            <Stat label="Account age" value={formatAge(view.streamAgeMs)} />
          </div>
          <AccountTable
            label="Positions"
            count={view.positionsTruncated ? `${view.positions.length}/${view.positionTotalCount}` : undefined}
            headers={["Market", "Side", "Size", "Entry", "Lev", "Liq dist", "uPnL"]}
            empty="No open positions."
            rows={view.positions.map((position) => ({
              key: position.position_commitment,
              market: position.market,
              cells: [position.market, position.side, position.size_bucket, position.entry_price_bucket, position.leverage_bucket, liquidationLabel(position.liquidation_distance_bucket), position.unrealized_pnl_bucket],
            }))}
            onInspectMarket={inspectMarket}
          />
          <ClosePositionControls positions={view.positions.map((position) => position.market)} onRefresh={onRefresh} />
          <AccountTable
            label="Open orders"
            count={view.openOrdersTruncated ? `${view.openOrders.length}/${view.openOrderTotalCount}` : undefined}
            headers={["Market", "Side", "Size", "Price", "State"]}
            empty="No open orders."
            rows={view.openOrders.map((order) => ({
              key: order.order_handle_commitment,
              market: order.market,
              cells: [order.market, order.side, order.size_bucket, order.price_bucket, `${order.status}${order.reduce_only ? " · RO" : ""}`],
            }))}
            onInspectMarket={inspectMarket}
          />
          <AccountTable
            label="Recent fills"
            headers={["Time", "Market", "Side", "Size", "Price", "Fee"]}
            empty="No recent fills."
            rows={view.recentFills.slice(0, 8).map((fill) => ({
              key: fill.fill_commitment,
              market: fill.market,
              cells: [formatUtcTime(fill.time_bucket), fill.market, fill.side, fill.size_bucket, fill.price_bucket, fill.fee_bucket],
            }))}
            onInspectMarket={inspectMarket}
            inspectColumn={1}
          />
          <AccountTable
            label="Order lifecycle"
            headers={["Time", "Market", "Side", "Size", "Price", "State"]}
            empty="No order updates in this stream."
            rows={view.orderEvents.slice(0, 8).map((event) => ({
              key: terminalLiveAccountOrderEventKey(event),
              market: event.market,
              cells: [formatUtcTime(event.timeBucket), event.market, event.side, event.sizeBucket, event.priceBucket, event.status],
            }))}
            onInspectMarket={inspectMarket}
            inspectColumn={1}
          />
          <p className="border-t border-[#141d2e] px-4 py-2 text-[8px] leading-3 text-[#566278]">Values, leverage, margin use, and liquidation distance are bounded privacy buckets—not exact venue balances or prices. Position close requires a fresh wallet signature and only submits reduce-only.</p>
        </>
      )}
    </section>
  );
});

type CloseEvidence = {
  market_flat?: boolean;
  final_flat_proven?: boolean;
  evidence_commitment?: string;
  closes?: Array<{ venue_order_oid?: string; terminal_status?: string; reduce_only?: boolean; venue_readback_proven?: boolean }>;
};

type CloseState =
  | { status: "idle" }
  | { status: "confirming"; market: "BTC" | "ETH" | "SOL" | "HYPE"; idempotencyKey: string }
  | { status: "closing"; market: "BTC" | "ETH" | "SOL" | "HYPE" }
  | { status: "complete"; market: string; evidence: CloseEvidence }
  | { status: "error"; message: string };

function ClosePositionControls({ positions, onRefresh }: { positions: string[]; onRefresh?: () => void }) {
  const [state, setState] = useState<CloseState>({ status: "idle" });
  const markets = [...new Set(positions.map(closeMarket).filter(Boolean))] as Array<"BTC" | "ETH" | "SOL" | "HYPE">;
  if (!markets.length) return null;

  async function closeConfirmed() {
    if (state.status !== "confirming") return;
    const requestBody = {
      version: 1,
      market: state.market,
      idempotency_key: state.idempotencyKey,
      confirmation: HYPERLIQUID_CLOSE_CONFIRMATION,
    };
    try {
      setState({ status: "closing", market: state.market });
      const path = "/v1/private-account/hyperliquid/positions/close";
      const proofHeaders = await authorizePrivateAccountWalletRequest({ path, body: requestBody });
      const evidence = await closeHyperliquidPosition({
        market: state.market,
        idempotencyKey: state.idempotencyKey,
        proofHeaders,
      }) as CloseEvidence;
      const close = evidence.closes?.[0];
      if (!evidence.market_flat || !evidence.final_flat_proven || !evidence.evidence_commitment ||
          close?.terminal_status !== "filled" || close.reduce_only !== true || close.venue_readback_proven !== true) {
        throw new Error("Venue did not return a reconciled reduce-only close receipt.");
      }
      setState({ status: "complete", market: state.market, evidence });
      onRefresh?.();
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Position close failed." });
    }
  }

  return (
    <section className="border-t border-[#141d2e] px-4 py-2.5" aria-label="Reduce-only position controls">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[8px] font-semibold uppercase tracking-[0.12em] text-[#738099]">Position controls</span>
        {markets.map((market) => (
          <button key={market} type="button" disabled={state.status === "closing"}
            onClick={() => setState({ status: "confirming", market, idempotencyKey: `close_${crypto.randomUUID()}` })}
            className="term-chip h-7 px-2 text-[8px] text-rose-200 disabled:opacity-50">
            Close {market} · RO
          </button>
        ))}
      </div>
      {state.status === "confirming" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-rose-300/20 bg-rose-300/[0.04] px-2 py-2 text-[8px] text-rose-100" role="alert">
          <span>This signs a real reduce-only market close for the full {state.market} position within the release slippage cap.</span>
          <button type="button" onClick={closeConfirmed} className="term-chip h-7 px-2 font-semibold text-rose-100">Sign + close</button>
          <button type="button" onClick={() => setState({ status: "idle" })} className="term-chip h-7 px-2">Cancel</button>
        </div>
      ) : state.status === "closing" ? (
        <p className="mt-2 text-[8px] text-amber-100" role="status">Closing {state.market} reduce-only; waiting for venue fill and flat-position readback…</p>
      ) : state.status === "complete" ? (
        <p className="mt-2 text-[8px] text-emerald-200" role="status">
          {state.market} flat · reduce-only fill verified · venue order {shortEvidence(state.evidence.closes?.[0]?.venue_order_oid)} · evidence {shortEvidence(state.evidence.evidence_commitment)}
        </p>
      ) : state.status === "error" ? (
        <p className="mt-2 text-[8px] text-rose-200" role="alert">{state.message}</p>
      ) : null}
    </section>
  );
}

function closeMarket(value: string): "BTC" | "ETH" | "SOL" | "HYPE" | null {
  const market = value.trim().toUpperCase().split("-")[0]?.split("/")[0] ?? "";
  return market === "BTC" || market === "ETH" || market === "SOL" || market === "HYPE" ? market : null;
}

function shortEvidence(value: string | undefined) {
  return value ? `${value.slice(0, 12)}…` : "verified";
}

function AccountTable({ label, headers, rows, empty, count, onInspectMarket, inspectColumn = 0 }: { label: string; headers: string[]; rows: Array<{ key: string; market: string; cells: string[] }>; empty: string; count?: string; onInspectMarket?: (market: string) => void; inspectColumn?: number }) {
  return (
    <div className="border-t border-[#141d2e]">
      <h3 className="px-4 py-2 text-[8px] font-semibold uppercase tracking-[0.12em] text-[#738099]">{label} · {count ?? rows.length}</h3>
      {rows.length === 0 ? <p className="px-4 pb-2 text-[9px] text-[#566278]">{empty}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] table-fixed font-mono text-[8px] tabular-nums">
            <thead className="text-[#566278]"><tr>{headers.map((header) => <th key={header} scope="col" className="px-2 py-1 text-right first:pl-4 first:text-left">{header}</th>)}</tr></thead>
            <tbody>{rows.map((row) => <tr key={row.key} className="border-t border-[#101827] text-[#aeb9cb]">{row.cells.map((cell, index) => <td key={`${row.key}:${headers[index]}`} className="px-2 py-1.5 text-right first:pl-4 first:text-left">{index === inspectColumn && onInspectMarket ? <button type="button" onClick={() => onInspectMarket(row.market)} className="rounded text-sky-200 underline decoration-sky-300/30 underline-offset-2 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-300" aria-label={`Inspect ${row.market} from ${label}`}>{cell}</button> : cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "text-[#aeb9cb]" }: { label: string; value: string; tone?: string }) {
  return <div className="border-r border-[#141d2e] px-3 py-2 last:border-r-0"><span className="block text-[7px] uppercase text-[#566278]">{label}</span><span className={`mt-0.5 block ${tone}`}>{value}</span></div>;
}
function formatAge(ageMs: number | null) { return ageMs == null ? "—" : ageMs < 1_000 ? "now" : `${Math.floor(ageMs / 1_000)}s`; }
function statusLabel(view: TerminalLiveAccountView) { return view.status === "live" ? "live" : view.status === "degraded" ? "degraded" : view.status === "connecting" ? "connecting" : "unavailable"; }
function statusTone(status: TerminalLiveAccountView["status"]) { return status === "live" ? "border-emerald-300/30 text-emerald-200" : status === "degraded" ? "border-amber-300/30 text-amber-100" : "border-[#263249] text-[#738099]"; }
function liquidationLabel(value: TerminalLiveAccountView["nearestLiquidationDistance"]) { return value === "at_or_beyond" ? "AT/BEYOND" : value ?? "—"; }
function liquidationTone(value: TerminalLiveAccountView["nearestLiquidationDistance"]) { return value === "at_or_beyond" || value === "<2%" || value === "unknown" ? "text-rose-300" : value === "2-5%" || value === "5-10%" ? "text-amber-200" : "text-[#aeb9cb]"; }
function marginUtilizationTone(value: TerminalLiveAccountView["marginUtilizationBucket"]) { return value === "90%+" || value === "unknown" ? "text-rose-300" : value === "75-90%" ? "text-amber-200" : "text-[#aeb9cb]"; }
function accountStatusLabel(value: TerminalLiveAccountView["accountStatus"]) { return value?.replaceAll("_", " ") ?? "—"; }
function accountStatusTone(value: TerminalLiveAccountView["accountStatus"]) { return value === "ready_to_trade" ? "text-emerald-200" : value ? "text-amber-200" : "text-[#aeb9cb]"; }
function accountSourceLabel(value: TerminalLiveAccountView["accountSource"]) { return value?.replaceAll("_", " ") ?? "—"; }
function riskDecisionLabel(status: TerminalLiveAccountRiskDecision["status"]) { return status === "safe" ? "Portfolio pass" : status === "warning" ? "Portfolio warn" : status === "checking" ? "Portfolio wait" : "Portfolio blocked"; }
function riskDecisionTone(status: TerminalLiveAccountRiskDecision["status"]) { return status === "safe" ? "border-emerald-300/20 bg-emerald-300/[0.04] text-emerald-200" : status === "warning" || status === "checking" ? "border-amber-300/20 bg-amber-300/[0.04] text-amber-100" : "border-rose-300/20 bg-rose-300/[0.04] text-rose-200"; }
function reconciliationTone(status: ReturnType<typeof deriveTerminalLiveOrderReconciliation>["status"]) { return status === "clear" ? "border-emerald-300/20 bg-emerald-300/[0.025] text-emerald-100" : status === "conflict" ? "border-rose-300/25 bg-rose-300/[0.05] text-rose-100" : status === "unavailable" ? "border-[#263249] text-[#738099]" : "border-amber-300/20 bg-amber-300/[0.025] text-amber-100"; }
function formatUtcTime(value: string) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(11, 19) : "—"; }
function blockerLabel(blocker: TerminalLiveAccountView["blocker"]) {
  if (blocker === "signed_out") return "Sign in to view privacy-bucketed live account activity.";
  if (blocker === "venue_not_selected") return "Select Hyperliquid to bind this blotter to the active venue.";
  if (blocker === "network_unknown") return "Account network is unverified; rows remain hidden.";
  if (blocker === "network_mismatch") return "Account network does not match the selected terminal network; rows remain hidden.";
  if (blocker === "snapshot_invalid") return "Account payload failed strict validation; rows remain hidden.";
  if (blocker === "stream_not_live") return "Account stream is reconnecting or unavailable.";
  if (blocker === "stream_stale") return "Account snapshot or stream receipt expired.";
  return "Connecting to the privacy-preserving account stream…";
}
