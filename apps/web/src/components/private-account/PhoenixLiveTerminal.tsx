"use client";

// Live Phoenix SOL terminal for Private Mode (analog of HyperliquidTradingPanel).
// Hosts the from-scratch canvas chart + L2 depth ladder + trade tape, and bridges
// click-to-trade into the existing tiny-fill IOC order ticket. It does NOT own the
// ticket: every interaction calls `onOrderChange({ ...order, ...patch })` and the
// cockpit normalizes + stores it as `orderDraft`, so the existing preview/execute
// path is reused unchanged.

import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import {
  formatPhoenixPrice,
} from "@/lib/phoenix-chart-helpers";
import {
  buildGholaAgentChartOverlays,
  gholaFrameFromPhoenix,
  type GholaChartMode,
} from "@/lib/ghola-market-chart";
import { phoenixOrderbookClickSide } from "@/lib/private-account-trading-ui";
import type {
  PhoenixBookLevel,
  PhoenixCandleInterval,
  PhoenixMarketSnapshot,
  PhoenixRecentTrade,
  PhoenixMarketSymbol,
} from "@/lib/phoenix-market-data";
import { validatePrivateExecutionOrderDraft, type PrivateExecutionOrderDraft } from "@/lib/private-execution-instruction-seal";
import type { PhoenixLiveMarketStatus } from "@/lib/phoenix-live-market";
import { GholaMarketChart } from "./GholaMarketChart";

const INTERVALS: ReadonlyArray<readonly [PhoenixCandleInterval, string]> = [
  ["1m", "1m"],
  ["5m", "5m"],
  ["15m", "15m"],
  ["1h", "1h"],
];
export interface PhoenixLiveTerminalProps {
  symbol: PhoenixMarketSymbol;
  interval: PhoenixCandleInterval;
  snapshot: PhoenixMarketSnapshot | null;
  marketStatus: PhoenixLiveMarketStatus;
  order: PrivateExecutionOrderDraft;
  previewCommitment?: string | null;
  working?: boolean;
  onIntervalChange: (interval: PhoenixCandleInterval) => void;
  onOrderChange: (order: PrivateExecutionOrderDraft) => void;
  onPreview?: () => void;
}

export function PhoenixLiveTerminal({
  symbol,
  interval,
  snapshot,
  marketStatus,
  order,
  previewCommitment,
  working = false,
  onIntervalChange,
  onOrderChange,
  onPreview,
}: PhoenixLiveTerminalProps) {
  const [mode, setMode] = useState<GholaChartMode>("candles");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const connection = connectionCopy(marketStatus, snapshot);
  const errors = validatePrivateExecutionOrderDraft(order);
  const tinyFill = order.live_order_mode === "tiny_fill";

  const midNum = numberOrNull(snapshot?.mid ?? snapshot?.mark_price);
  const midLabel = midNum != null ? formatPhoenixPrice(midNum) : "—";

  function update(patch: Partial<PrivateExecutionOrderDraft>) {
    onOrderChange({ ...order, ...patch });
  }
  function selectPrice(price: string, side: "buy" | "sell") {
    update({ limit_price: price, side });
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="bg-[linear-gradient(180deg,#0a0f18_0%,#06090f_100%)] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-[#a8d8ff]" />
          <div>
            <h3 className="text-lg font-medium tracking-tight text-[#eef1f8]">Phoenix · {symbol}-PERP</h3>
            <p className="mt-1 text-xs leading-5 text-[#8b95a8]">
              Live on-chain market, rendered from scratch. Click the chart or book to set a price.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-[#8b95a8]">no key needed</span>
          <span
            className={
              connection.tone === "good"
                ? "text-xs text-emerald-200"
                : connection.tone === "bad"
                  ? "text-xs text-red-200"
                  : "text-xs text-amber-200"
            }
          >
            {connection.label}
          </span>
        </div>
      </div>

      <MarketHealthStrip snapshot={snapshot} status={marketStatus} nowMs={nowMs} />

      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
        <Chips label="Interval" value={interval} options={INTERVALS} onChange={(v) => onIntervalChange(v)} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="rounded-md border border-[#1b2a41] bg-[linear-gradient(180deg,#080d15,#05080e)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-[#7f90aa]">{symbol} mid</p>
              <p className="text-4xl font-medium tracking-tight text-[#eef1f8]">{midLabel}</p>
            </div>
            <div className="text-right text-xs tabular-nums text-[#8b95a8]">
              <div>Bid {fmt(snapshot?.best_bid)}</div>
              <div>Ask {fmt(snapshot?.best_ask)}</div>
              <div>Spread {snapshot?.spread_bps == null ? "—" : `${snapshot.spread_bps} bps`}</div>
              <div>Mark {fmt(snapshot?.mark_price)}</div>
            </div>
          </div>
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            <Stat label="Funding" value={fmtSigned(snapshot?.funding_rate)} />
            <Stat label="Open interest" value={fmt(snapshot?.open_interest)} />
            <Stat label="24h vol" value={fmt(snapshot?.day_notional_volume)} />
          </div>
          <GholaMarketChart
            label="Phoenix"
            frame={gholaFrameFromPhoenix(snapshot)}
            overlays={buildGholaAgentChartOverlays({
              order,
              mid: snapshot?.mid || snapshot?.mark_price || null,
              previewCommitment,
              accountReady: errors.length === 0,
              venueLabel: "Phoenix",
            })}
            mode={mode}
            onModeChange={setMode}
            size="large"
            height={360}
            onSelectPrice={selectPrice}
          />
          <p className="mt-2 text-[11px] leading-4 text-[#6f7d9a]">
            Smoothness is interpolation between ticks. Solana settles in ~400ms slots, so new prints arrive at
            slot/feed cadence — not sub-slot.
          </p>
        </div>

        <div className="grid gap-3">
          <div className="rounded-md border border-[#1b2a41] bg-[linear-gradient(180deg,#080d15,#05080e)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
            <div className="mb-2 flex items-center justify-between text-xs text-[#6f7d9a]">
              <span>Orderbook</span>
              <span>{symbol}</span>
            </div>
            <OrderbookRows side="ask" levels={snapshot?.asks ?? []} onPick={selectPrice} />
            <div className="my-2 flex items-center justify-between border-y border-[#162337] py-1 text-xs tabular-nums text-[#aab5c8]">
              <span>{midLabel}</span>
              <span className="text-[#6f7d9a]">mid</span>
            </div>
            <OrderbookRows side="bid" levels={snapshot?.bids ?? []} onPick={selectPrice} />
          </div>

          <TradeTape trades={snapshot?.recent_trades ?? []} />

          <div id="trade-intent" className="scroll-mt-24 rounded-md border border-[#1b2a41] bg-[linear-gradient(180deg,#080d15,#05080e)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-xs text-[#6f7d9a]">Intent</span>
              <span className={errors.length === 0 ? "text-xs text-emerald-200" : "text-xs text-amber-200"}>
                {errors.length === 0 ? "ready" : "needs fields"}
              </span>
            </div>
            <StatusLine label="Side" value={order.side === "sell" ? "Sell" : "Buy"} tone="good" />
            <StatusLine label="Price limit" value={order.limit_price || "—"} tone="good" />
            <StatusLine label="Size" value={tinyFill ? `$${order.quote_size || "5"} IOC` : order.base_size || "—"} tone="good" />
            <StatusLine label="Mode" value={tinyFill ? "tiny live IOC" : order.operation_class} tone="good" />
            <p className="mt-2 text-[11px] leading-4 text-[#8b95a8]">
              {tinyFill
                ? "Clicking sets price and side. Size stays under the tiny-fill cap; adjust it in the order ticket."
                : "Clicking sets the limit price and side on the order ticket."}
            </p>
            {onPreview && (
              <button
                type="button"
                onClick={onPreview}
                disabled={working || errors.length > 0}
                className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-md bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {working ? "Working" : previewCommitment ? "Re-run privacy check" : "Preview intent"}
              </button>
            )}
            <div className="mt-3 grid gap-2 border-t border-[#162337] pt-3">
              <StatusLine label="Main wallet" value="not exposed" tone="good" />
              <StatusLine label="Phoenix sees" value="trading authority + order" tone="warn" />
              <StatusLine label="Public chain" value="order settlement only" tone="good" />
            </div>
          </div>
        </div>
      </div>
      {errors[0] && <p className="mt-3 text-xs text-amber-200">{errors[0]}</p>}
    </div>
  );
}

function MarketHealthStrip({
  snapshot,
  status,
  nowMs,
}: {
  snapshot: PhoenixMarketSnapshot | null;
  status: PhoenixLiveMarketStatus;
  nowMs: number;
}) {
  const source = marketSourceLabel(status, snapshot);
  const last = ageLabel(snapshot?.fetched_at, nowMs);
  const book = ageLabel(snapshot?.book_updated_at, nowMs);
  const candles = snapshot?.candles.length ?? 0;
  const trades = ageLabel(snapshot?.trades_updated_at, nowMs);
  const tone = healthTone(status, snapshot, nowMs);
  const toneClass =
    tone === "good"
      ? "border-emerald-400/20 bg-emerald-400/5 text-emerald-200"
      : tone === "bad"
        ? "border-red-400/20 bg-red-400/5 text-red-200"
        : "border-amber-300/20 bg-amber-300/5 text-amber-200";

  return (
    <div className={`mt-4 grid gap-2 rounded-md border px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] ${toneClass} lg:grid-cols-[auto_repeat(4,minmax(0,1fr))]`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${tone === "good" ? "bg-emerald-300" : tone === "bad" ? "bg-red-300" : "bg-amber-300"}`} />
        <span className="text-xs font-medium">{source}</span>
      </div>
      <HealthStat label="Last tick" value={last} />
      <HealthStat label="Book" value={book} />
      <HealthStat label="Candles" value={candles > 0 ? String(candles) : "waiting"} />
      <HealthStat label="Trades" value={trades} />
    </div>
  );
}

function HealthStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs lg:block">
      <span className="text-[#8b95a8]">{label}</span>
      <span className="font-medium tabular-nums text-[#eef1f8] lg:mt-0.5 lg:block">{value}</span>
    </div>
  );
}

function OrderbookRows({
  side,
  levels,
  onPick,
}: {
  side: "bid" | "ask";
  levels: PhoenixBookLevel[];
  onPick: (price: string, side: "buy" | "sell") => void;
}) {
  const rows = (side === "ask" ? levels.slice(0, 8).reverse() : levels.slice(0, 8));
  const max = Math.max(1, ...rows.map((r) => Number(r.sz)).filter((n) => Number.isFinite(n)));
  const color = side === "ask" ? "#f87171" : "#34d399";
  const orderSide = phoenixOrderbookClickSide(side);
  if (rows.length === 0) {
    return <div className="py-4 text-center text-xs text-[#6f7d9a]">No {side} levels</div>;
  }
  return (
    <div className="grid gap-0.5">
      {rows.map((row, index) => {
        const sz = Number(row.sz);
        const width = Number.isFinite(sz) ? Math.min(100, (sz / max) * 100) : 0;
        return (
          <button
            key={`${side}-${row.px}-${index}`}
            type="button"
            onClick={() => onPick(row.px, orderSide)}
            className="relative flex items-center justify-between px-1 py-0.5 text-xs tabular-nums hover:bg-[#0f1a2c]"
            title={side === "ask" ? `Buy at ask ${row.px}` : `Sell at bid ${row.px}`}
          >
            <span
              aria-hidden
              className="absolute inset-y-0 right-0"
              style={{ width: `${width}%`, backgroundColor: color, opacity: 0.12 }}
            />
            <span className="relative z-10" style={{ color }}>
              {formatPhoenixPrice(Number(row.px))}
            </span>
            <span className="relative z-10 text-[#8b95a8]">{trimSize(row.sz)}</span>
          </button>
        );
      })}
    </div>
  );
}

function TradeTape({ trades }: { trades: PhoenixRecentTrade[] }) {
  return (
      <div className="rounded-md border border-[#1b2a41] bg-[linear-gradient(180deg,#080d15,#05080e)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
      <div className="mb-2 flex items-center justify-between text-xs text-[#6f7d9a]">
        <span>Trades</span>
        <span>size · price</span>
      </div>
      {trades.length === 0 ? (
        <div className="py-3 text-center text-xs text-[#6f7d9a]">Waiting for prints…</div>
      ) : (
        <div className="grid max-h-40 gap-0.5 overflow-hidden">
          {trades.slice(0, 12).map((trade, index) => (
            <div
              key={`${trade.time}-${index}`}
              className="flex items-center justify-between text-xs tabular-nums"
              style={{ color: trade.side === "buy" ? "#6ee7b7" : "#fca5a5" }}
            >
              <span>{trimSize(trade.sz)}</span>
              <span>{formatPhoenixPrice(Number(trade.px))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Chips<T extends string>({
  label,
  value,
  options,
  align = "left",
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  align?: "left" | "right";
  onChange: (value: T) => void;
}) {
  return (
    <div className={align === "right" ? "grid gap-1.5 lg:justify-items-end" : "grid gap-1.5"}>
      <span className="text-xs text-[#8b95a8]">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map(([optionValue, optionLabel]) => {
          const selected = optionValue === value;
          return (
            <button
              key={optionValue}
              type="button"
              onClick={() => onChange(optionValue)}
              className={
                selected
                  ? "h-8 min-w-14 border border-[#a8d8ff] bg-[#a8d8ff] px-3 text-sm font-medium text-[#08090d]"
                  : "h-8 min-w-14 border border-[#1e2a3a] bg-[#05070b] px-3 text-sm text-[#aab5c8] hover:border-[#3da8ff]/50"
              }
            >
              {optionLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[#162337] bg-[#08090d] px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
      <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#6f7d9a]">{label}</div>
      <div className="text-sm tabular-nums text-[#eef1f8]">{value}</div>
    </div>
  );
}

function StatusLine({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-[#8b95a8]">{label}</span>
      <span className={tone === "good" ? "tabular-nums text-emerald-200" : "tabular-nums text-amber-200"}>{value}</span>
    </div>
  );
}

function connectionCopy(
  status: PhoenixLiveMarketStatus,
  snapshot: PhoenixMarketSnapshot | null,
): { label: string; tone: "good" | "warn" | "bad" } {
  if (status === "live" && !snapshot?.stale) return { label: "live", tone: "good" };
  if (status === "connecting") return { label: "connecting", tone: "warn" };
  if (status === "reconnecting") return { label: "reconnecting", tone: "warn" };
  if (status === "fallback_polling") return { label: "polling", tone: "warn" };
  if (status === "stale") return { label: "stale", tone: "warn" };
  if (status === "blocked") return { label: "feed blocked", tone: "bad" };
  return { label: status, tone: "warn" };
}

function marketSourceLabel(status: PhoenixLiveMarketStatus, snapshot: PhoenixMarketSnapshot | null): string {
  if (status === "live" && snapshot?.source === "websocket" && !snapshot.stale) return "websocket live";
  if (status === "fallback_polling" || snapshot?.source === "http") return "REST fallback";
  if (status === "reconnecting") return "reconnecting";
  if (status === "stale" || snapshot?.stale) return "stale feed";
  if (status === "blocked") return "feed blocked";
  return "connecting";
}

function healthTone(
  status: PhoenixLiveMarketStatus,
  snapshot: PhoenixMarketSnapshot | null,
  nowMs: number,
): "good" | "warn" | "bad" {
  if (!snapshot || status === "blocked") return "bad";
  if (snapshot.stale || status === "stale") return "warn";
  const age = ageMs(snapshot.fetched_at, nowMs);
  if (age == null) return "warn";
  if (status === "live" && snapshot.source === "websocket" && age <= 2_000) return "good";
  if (age <= 8_000) return "warn";
  return "bad";
}

function ageLabel(value: string | null | undefined, nowMs: number): string {
  const age = ageMs(value, nowMs);
  if (age == null) return "waiting";
  if (age < 1_000) return "now";
  if (age < 60_000) return `${Math.floor(age / 1_000)}s`;
  return `${Math.floor(age / 60_000)}m`;
}

function ageMs(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, nowMs - parsed);
}

function numberOrNull(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmt(value: string | null | undefined): string {
  const n = numberOrNull(value);
  return n == null ? "—" : formatPhoenixPrice(n);
}

function fmtSigned(value: string | null | undefined): string {
  const n = numberOrNull(value);
  if (n == null) return "—";
  const pct = (n * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `${n >= 0 ? "+" : ""}${pct}%`;
}

function trimSize(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return Number(n.toFixed(4)).toString();
}
