"use client";

import { memo, useEffect, useMemo, useState } from "react";
import type { GholaMarketFrame } from "@/lib/ghola-market-chart";
import {
  cancelReplayOrder,
  createReplaySession,
  forkReplaySession,
  resetReplaySession,
  submitReplayOrder,
  type ReplayOrderType,
  type ReplaySessionState,
  type ReplaySide,
} from "@/lib/terminal-replay-session";
import {
  boundedReplaySyncTarget,
  defaultReplayOrderDraft,
  replayOrderInputFromDraft,
  replaySourceFromFrame,
  syncReplaySessionCursor,
  type ReplayOrderDraft,
} from "./replay-execution-lab-state";

export interface ReplayExecutionLabProps {
  sourceFrame: GholaMarketFrame;
  cursor: number;
  totalBars: number;
}

const ORDER_TYPES: ReadonlyArray<{ value: ReplayOrderType; label: string }> = [
  { value: "market", label: "Market" },
  { value: "limit", label: "Limit" },
  { value: "stop", label: "Stop market" },
  { value: "stop_limit", label: "Stop limit" },
];

export const ReplayExecutionLab = memo(function ReplayExecutionLab({ sourceFrame, cursor, totalBars }: ReplayExecutionLabProps) {
  const source = useMemo(() => replaySourceFromFrame(sourceFrame), [sourceFrame]);
  const initialMark = source.candles[cursor]?.c ?? source.candles[0].c;
  const [sessionState, setSession] = useState<ReplaySessionState>(() => createReplaySession(source, { cursor }));
  const [draft, setDraft] = useState<ReplayOrderDraft>(() => defaultReplayOrderDraft(initialMark));
  const [message, setMessage] = useState("Orders submitted on this bar become eligible on the next revealed bar.");

  const immediateReset = sessionState.source.fingerprint !== source.fingerprint || cursor < sessionState.cursor
    ? syncReplaySessionCursor(sessionState, source, cursor)
    : null;
  const session = immediateReset?.state ?? sessionState;
  const synchronizing = immediateReset !== null || cursor > sessionState.cursor;

  useEffect(() => {
    if (sessionState.source.fingerprint === source.fingerprint && cursor === sessionState.cursor) return;
    const target = sessionState.source.fingerprint === source.fingerprint && cursor > sessionState.cursor
      ? boundedReplaySyncTarget(sessionState.cursor, cursor)
      : cursor;
    const frame = window.requestAnimationFrame(() => {
      const synchronized = syncReplaySessionCursor(sessionState, source, target);
      setSession((current) => current === sessionState ? synchronized.state : current);
      if (synchronized.event === "forked") {
        setMessage("The chart moved backward, so the lab created a clean fork at this bar. Prior simulated actions were discarded.");
      } else if (synchronized.event === "source_changed") {
        setDraft(defaultReplayOrderDraft(source.candles[cursor]?.c ?? source.candles[0].c));
        setMessage("New immutable replay source loaded. This is a clean local session.");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [cursor, sessionState, source]);

  const currentBar = source.candles[Math.min(session.cursor, source.candles.length - 1)] ?? source.candles[0];
  const pendingCount = session.orders.filter((order) => order.status === "pending").length;
  const canSubmit = !synchronizing && session.cursor < source.candles.length - 1;

  function updateDraft<K extends keyof ReplayOrderDraft>(key: K, value: ReplayOrderDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function changeSide(nextSide: ReplaySide) {
    setDraft((current) => ({
      ...defaultReplayOrderDraft(currentBar.c, nextSide),
      type: current.type,
      size: current.size,
      limitPrice: current.limitPrice,
      stopPrice: current.stopPrice,
      reduceOnly: current.reduceOnly,
      attachOco: current.reduceOnly ? false : current.attachOco,
      riskUsd: current.riskUsd,
    }));
  }

  function placeOrder() {
    try {
      const input = replayOrderInputFromDraft(draft);
      const next = submitReplayOrder(session, source, input);
      setSession(next);
      setMessage(`${input.side.toUpperCase()} ${orderTypeLabel(input.type)} accepted at bar ${session.cursor + 1}; eligible on bar ${session.cursor + 2}.`);
    } catch (error) {
      setMessage(replayErrorMessage(error));
    }
  }

  function cancelOrder(orderId: string) {
    try {
      setSession((current) => cancelReplayOrder(current, source, orderId));
      setMessage(`Order ${shortId(orderId)} cancelled locally.`);
    } catch (error) {
      setMessage(replayErrorMessage(error));
    }
  }

  function resetAtCursor() {
    setSession((current) => resetReplaySession(current, source, cursor));
    setMessage("Replay lab reset at the current chart bar.");
  }

  function forkAtCursor() {
    setSession((current) => forkReplaySession(current, source, cursor));
    setMessage("Clean scenario fork created at the current chart bar.");
  }

  return (
    <section className="mt-3 overflow-hidden rounded-md border border-amber-300/25 bg-[#070a10]" aria-labelledby="replay-execution-lab-heading">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[#292319] bg-gradient-to-r from-amber-300/[0.08] to-transparent px-3 py-3 sm:px-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="replay-execution-lab-heading" className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#e7edf7]">Replay Execution Lab</h2>
            <span className="rounded border border-amber-300/40 bg-amber-300/10 px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-[0.12em] text-amber-100">PAPER REPLAY</span>
            <span className="rounded border border-sky-300/30 bg-sky-300/[0.07] px-1.5 py-0.5 font-mono text-[8px] font-semibold tracking-[0.12em] text-sky-100">BAR MODEL</span>
          </div>
          <p className="mt-1 max-w-3xl text-[9px] leading-4 text-[#8b95a8]">
            Deterministic OHLC simulation on the chart’s immutable snapshot. No book execution, network request, wallet, private action, or live order path.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[9px] tabular-nums text-[#aeb9cb]">
          <span>{source.instrument.venue} · {source.instrument.product} · {source.instrument.interval}</span>
          <span aria-hidden className="text-[#566278]">|</span>
          <span>bar {session.cursor + 1}/{Math.min(totalBars, source.candles.length)}</span>
          <button type="button" disabled={synchronizing} onClick={forkAtCursor} className="trade-chip h-7 rounded px-2 disabled:cursor-wait disabled:opacity-40">Fork here</button>
          <button type="button" disabled={synchronizing} onClick={resetAtCursor} className="trade-chip h-7 rounded px-2 disabled:cursor-wait disabled:opacity-40">Reset</button>
        </div>
      </header>

      <div className="grid gap-px bg-[#182234] xl:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.28fr)]">
        <div className="bg-[#070a10] p-3 sm:p-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2">
            <ReplayMetric label="Equity" value={formatUsd(session.performance.equity_usd)} />
            <ReplayMetric label="Net P&L" value={formatSignedUsd(session.performance.net_pnl_usd)} tone={pnlTone(session.performance.net_pnl_usd)} />
            <ReplayMetric label="Unrealized" value={formatSignedUsd(session.performance.unrealized_pnl_gross_usd)} tone={pnlTone(session.performance.unrealized_pnl_gross_usd)} />
            <ReplayMetric label="Realized gross" value={formatSignedUsd(session.performance.realized_pnl_gross_usd)} tone={pnlTone(session.performance.realized_pnl_gross_usd)} />
            <ReplayMetric label="Fees" value={formatUsd(session.performance.fees_usd)} />
            <ReplayMetric label="Realized R" value={session.performance.realized_r == null ? "-" : `${formatSigned(session.performance.realized_r, 2)}R`} tone={pnlTone(session.performance.realized_r ?? 0)} />
            <ReplayMetric label="MAE / MFE" value={`${formatUsd(session.performance.mae_usd)} / ${formatUsd(session.performance.mfe_usd)}`} />
            <ReplayMetric label="Orders / fills" value={`${pendingCount} pending · ${session.fills.length} filled`} />
          </div>
          <p className="mt-2 font-mono text-[9px] text-[#8b95a8]">
            Assumptions · {formatUsd(session.assumptions.starting_equity_usd)} start · {formatNumber(session.assumptions.fee_bps)} bp fee · {formatNumber(session.assumptions.slippage_bps)} bp adverse slippage
          </p>

          <fieldset className="mt-3 rounded border border-[#1b2638] bg-[#080c13] p-3">
            <legend className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa7ba]">Local replay ticket</legend>
            <div className="grid grid-cols-2 gap-2">
              <ReplaySelect
                label="Order type"
                value={draft.type}
                onChange={(value) => updateDraft("type", value as ReplayOrderType)}
                options={ORDER_TYPES}
              />
              <div>
                <span className="mb-1 block text-[8px] uppercase tracking-[0.1em] text-[#8b95a8]">Side</span>
                <div className="grid grid-cols-2 gap-1" role="group" aria-label="Replay order side">
                  {(["buy", "sell"] as const).map((side) => (
                    <button
                      key={side}
                      type="button"
                      aria-pressed={draft.side === side}
                      onClick={() => changeSide(side)}
                      className={`h-8 rounded border text-[10px] font-semibold ${draft.side === side
                        ? side === "buy" ? "border-emerald-400/55 bg-emerald-400/15 text-emerald-200" : "border-rose-400/55 bg-rose-400/15 text-rose-200"
                        : "border-[#263145] bg-[#101620] text-[#aeb9cb]"}`}
                    >
                      {side.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <ReplayInput label="Base size" value={draft.size} onChange={(value) => updateDraft("size", value)} />
              {(draft.type === "limit" || draft.type === "stop_limit") ? (
                <ReplayInput label="Limit price" value={draft.limitPrice} onChange={(value) => updateDraft("limitPrice", value)} />
              ) : null}
              {(draft.type === "stop" || draft.type === "stop_limit") ? (
                <ReplayInput label="Stop trigger" value={draft.stopPrice} onChange={(value) => updateDraft("stopPrice", value)} />
              ) : null}
              <ReplayInput label="Risk USD (optional)" value={draft.riskUsd} onChange={(value) => updateDraft("riskUsd", value)} min={0} />
            </div>

            <label className="mt-2 flex cursor-pointer items-start gap-2 rounded border border-[#182234] px-2 py-2 text-[9px] text-[#aeb9cb]">
              <input type="checkbox" checked={draft.reduceOnly} onChange={(event) => setDraft((current) => ({ ...current, reduceOnly: event.target.checked, attachOco: event.target.checked ? false : current.attachOco }))} className="mt-0.5 h-3.5 w-3.5 accent-amber-300" />
              <span><b className="font-medium text-[#dce6f4]">Reduce only</b><span className="block text-[#8b95a8]">Never opens or reverses a replay position.</span></span>
            </label>
            <label className="mt-2 flex cursor-pointer items-start gap-2 rounded border border-[#182234] px-2 py-2 text-[9px] text-[#aeb9cb]">
              <input type="checkbox" checked={draft.attachOco} disabled={draft.reduceOnly} onChange={(event) => updateDraft("attachOco", event.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-amber-300 disabled:opacity-40" />
              <span><b className="font-medium text-[#dce6f4]">Attach OCO after entry</b><span className="block text-[#8b95a8]">Conservative stop priority when stop and target touch the same bar.</span></span>
            </label>
            {draft.attachOco ? (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <ReplayInput label="OCO stop" value={draft.ocoStopPrice} onChange={(value) => updateDraft("ocoStopPrice", value)} />
                <ReplayInput label="OCO target" value={draft.ocoTargetPrice} onChange={(value) => updateDraft("ocoTargetPrice", value)} />
              </div>
            ) : null}

            <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[9px] tabular-nums">
              <span className="text-[#aeb9cb]">Current close {formatPrice(currentBar.c)}</span>
              <span className="text-amber-100">next-bar eligible</span>
            </div>
            <button
              type="button"
              onClick={placeOrder}
              disabled={!canSubmit}
              className={`mt-2 h-10 w-full rounded-md border text-xs font-semibold tracking-[0.06em] disabled:cursor-not-allowed disabled:border-[#263145] disabled:bg-[#101620] disabled:text-[#8b95a8] ${draft.side === "buy" ? "border-emerald-400/55 bg-emerald-400/15 text-emerald-200" : "border-rose-400/55 bg-rose-400/15 text-rose-200"}`}
            >
              PLACE PAPER REPLAY {draft.side.toUpperCase()} {orderTypeLabel(draft.type).toUpperCase()}
            </button>
            <p role="status" aria-live="polite" aria-atomic="true" className="mt-2 min-h-8 text-[9px] leading-4 text-[#aeb9cb]">
              {synchronizing
                ? `Replaying bars locally… ${session.cursor + 1}/${cursor + 1}`
                : canSubmit ? message : "End of immutable source: no future bar exists, so new orders are blocked."}
            </p>
          </fieldset>
        </div>

        <div className="min-w-0 bg-[#070a10]">
          <ReplayPositions positions={session.positions} mark={currentBar.c} />
          <ReplayOrders session={session} onCancel={cancelOrder} />
          <ReplayFills session={session} />
          <ReplayJournal session={session} />
        </div>
      </div>
    </section>
  );
});

function ReplayPositions({ positions, mark }: { positions: ReplaySessionState["positions"]; mark: number }) {
  return (
    <section className="border-b border-[#182234] px-3 py-3 sm:px-4" aria-labelledby="replay-positions-heading">
      <h3 id="replay-positions-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa7ba]">Positions</h3>
      {positions.length ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left font-mono text-[9px] tabular-nums">
            <thead className="text-[#8b95a8]"><tr><th className="pb-1 font-normal">ID</th><th className="pb-1 font-normal">Side / status</th><th className="pb-1 text-right font-normal">Quantity</th><th className="pb-1 text-right font-normal">Average</th><th className="pb-1 text-right font-normal">Mark / R</th><th className="pb-1 text-right font-normal">MAE / MFE</th></tr></thead>
            <tbody>{positions.slice(-100).reverse().map((position) => <tr key={position.position_id} className="border-t border-[#141d2e] text-[#c7d0df]"><td className="py-2">{shortId(position.position_id)}</td><td className={position.side === "long" ? "py-2 text-emerald-300" : "py-2 text-rose-300"}>{position.side.toUpperCase()} · {position.status.toUpperCase()}</td><td className="py-2 text-right">{formatNumber(position.quantity)}</td><td className="py-2 text-right">{formatPrice(position.average_entry_price)}</td><td className="py-2 text-right">{position.status === "open" ? formatPrice(mark) : position.realized_r == null ? "closed" : `${formatSigned(position.realized_r, 2)}R`}</td><td className="py-2 text-right">{formatUsd(position.mae_usd)} / {formatUsd(position.mfe_usd)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <p className="mt-2 text-[10px] text-[#8b95a8]">No replay position.</p>}
    </section>
  );
}

function ReplayOrders({ session, onCancel }: { session: ReplaySessionState; onCancel: (orderId: string) => void }) {
  return (
    <section className="border-b border-[#182234] px-3 py-3 sm:px-4" aria-labelledby="replay-orders-heading">
      <h3 id="replay-orders-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa7ba]">Order blotter</h3>
      {session.orders.length ? (
        <div className="mt-2 max-h-44 overflow-auto">
          <table className="w-full min-w-[42rem] text-left font-mono text-[9px] tabular-nums">
            <thead className="sticky top-0 bg-[#070a10] text-[#8b95a8]"><tr><th className="pb-1 font-normal">ID</th><th className="pb-1 font-normal">Role / type</th><th className="pb-1 font-normal">Side</th><th className="pb-1 text-right font-normal">Size</th><th className="pb-1 text-right font-normal">Stop / limit</th><th className="pb-1 text-right font-normal">Eligible</th><th className="pb-1 text-right font-normal">Status</th><th aria-label="Actions" /></tr></thead>
            <tbody>{session.orders.slice(-100).reverse().map((order) => <tr key={order.order_id} className="border-t border-[#141d2e] text-[#c7d0df]"><td className="py-2">{shortId(order.order_id)}</td><td className="py-2">{order.role.replaceAll("_", " ")} · {orderTypeLabel(order.type)}</td><td className={order.side === "buy" ? "py-2 text-emerald-300" : "py-2 text-rose-300"}>{order.side.toUpperCase()}</td><td className="py-2 text-right">{formatNumber(order.size)}</td><td className="py-2 text-right">{formatPrice(order.stop_price)} / {formatPrice(order.limit_price)}</td><td className="py-2 text-right">bar {order.eligible_cursor + 1}</td><td className={`py-2 text-right ${order.status === "filled" ? "text-sky-300" : order.status === "cancelled" ? "text-[#8b95a8]" : "text-amber-100"}`}>{order.status.toUpperCase()}</td><td className="py-2 pl-2 text-right">{order.status === "pending" ? <button type="button" onClick={() => onCancel(order.order_id)} aria-label={`Cancel replay order ${order.order_id}`} className="rounded border border-rose-400/30 px-2 py-1 text-[8px] text-rose-200">Cancel</button> : null}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <p className="mt-2 text-[10px] text-[#8b95a8]">No replay orders.</p>}
    </section>
  );
}

function ReplayFills({ session }: { session: ReplaySessionState }) {
  return (
    <section className="border-b border-[#182234] px-3 py-3 sm:px-4" aria-labelledby="replay-fills-heading">
      <h3 id="replay-fills-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa7ba]">Fills · bar model</h3>
      {session.fills.length ? (
        <div className="mt-2 max-h-36 overflow-auto">
          <table className="w-full min-w-[42rem] text-left font-mono text-[9px] tabular-nums">
            <thead className="sticky top-0 bg-[#070a10] text-[#8b95a8]"><tr><th className="pb-1 font-normal">Bar</th><th className="pb-1 font-normal">Order</th><th className="pb-1 font-normal">Trigger</th><th className="pb-1 font-normal">Side</th><th className="pb-1 text-right font-normal">Size</th><th className="pb-1 text-right font-normal">Reference</th><th className="pb-1 text-right font-normal">Fill</th><th className="pb-1 text-right font-normal">Fee</th></tr></thead>
            <tbody>{session.fills.slice(-100).reverse().map((fill) => <tr key={fill.fill_id} className="border-t border-[#141d2e] text-[#c7d0df]"><td className="py-2">{fill.bar_cursor + 1}</td><td className="py-2">{shortId(fill.order_id)}</td><td className="py-2">{fill.trigger.replaceAll("_", " ")}</td><td className={fill.side === "buy" ? "py-2 text-emerald-300" : "py-2 text-rose-300"}>{fill.side.toUpperCase()}</td><td className="py-2 text-right">{formatNumber(fill.size)}</td><td className="py-2 text-right">{formatPrice(fill.reference_price)}</td><td className="py-2 text-right">{formatPrice(fill.fill_price)}</td><td className="py-2 text-right">{formatUsd(fill.fee_usd)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <p className="mt-2 text-[10px] text-[#8b95a8]">Advance the chart after submitting to evaluate the next bar.</p>}
    </section>
  );
}

function ReplayJournal({ session }: { session: ReplaySessionState }) {
  return (
    <section className="px-3 py-3 sm:px-4" aria-labelledby="replay-journal-heading">
      <h3 id="replay-journal-heading" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa7ba]">Deterministic journal</h3>
      {session.journal.length ? (
        <ol className="mt-2 grid max-h-36 gap-1 overflow-y-auto font-mono text-[9px] text-[#aeb9cb]">
          {session.journal.slice(-24).reverse().map((entry) => <li key={entry.journal_id} className="flex gap-2"><span className="shrink-0 text-[#8b95a8]">bar {entry.cursor + 1}</span><span>{entry.message}</span></li>)}
        </ol>
      ) : <p className="mt-2 text-[10px] text-[#8b95a8]">Submissions, triggers, fills, cancels, and position lifecycle events appear here.</p>}
    </section>
  );
}

function ReplayMetric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "bad" }) {
  return <div className="rounded border border-[#1b2638] bg-[#080c13] px-2.5 py-2"><span className="block text-[9px] uppercase tracking-[0.12em] text-[#8b95a8]">{label}</span><span className={`mt-1 block font-mono text-xs tabular-nums ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-[#dce6f4]"}`}>{value}</span></div>;
}

function ReplayInput({ label, value, onChange, min = Number.MIN_VALUE }: { label: string; value: string; onChange: (value: string) => void; min?: number }) {
  return <label><span className="mb-1 block text-[8px] uppercase tracking-[0.1em] text-[#8b95a8]">{label}</span><input type="number" inputMode="decimal" min={min} step="any" value={value} onChange={(event) => onChange(event.target.value)} className="trade-field h-8 w-full rounded-md px-2 text-right font-mono text-[10px] tabular-nums text-[#dce6f4] outline-none" /></label>;
}

function ReplaySelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: ReadonlyArray<{ value: string; label: string }> }) {
  return <label><span className="mb-1 block text-[8px] uppercase tracking-[0.1em] text-[#8b95a8]">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="trade-field h-8 w-full rounded-md px-2 text-[10px] text-[#dce6f4] outline-none">{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

function orderTypeLabel(type: ReplayOrderType) {
  return type === "stop_limit" ? "stop limit" : type === "stop" ? "stop market" : type;
}

function replayErrorMessage(error: unknown) {
  if (error instanceof Error && !error.message.startsWith("replay_")) return error.message;
  const code = error instanceof Error ? error.message : "replay_order_invalid";
  const labels: Record<string, string> = {
    replay_order_has_no_future_candle: "No future candle remains for next-bar eligibility.",
    replay_order_limit_invalid: "Enter a valid limit price.",
    replay_order_stop_invalid: "Enter a valid stop trigger.",
    replay_order_oco_invalid: "OCO levels are invalid for this side.",
    replay_order_risk_invalid: "Risk must be greater than zero when set.",
    replay_reduce_only_oco_invalid: "Reduce-only orders cannot open an attached OCO.",
  };
  return labels[code] ?? "Replay order rejected by the deterministic bar model.";
}

function pnlTone(value: number): "neutral" | "good" | "bad" {
  return value > 0 ? "good" : value < 0 ? "bad" : "neutral";
}

function shortId(value: string) {
  return value.slice(-8);
}

function formatUsd(value: number) {
  return Number.isFinite(value) ? `$${Math.abs(value).toFixed(2)}` : "-";
}

function formatSignedUsd(value: number) {
  if (!Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}$${Math.abs(value).toFixed(2)}`;
}

function formatSigned(value: number, digits: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function formatPrice(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: value >= 1_000 ? 2 : 6 }).format(value);
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value) : "-";
}
