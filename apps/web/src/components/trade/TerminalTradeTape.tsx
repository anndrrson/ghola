"use client";

import { memo } from "react";
import { TerminalTradeImpulse } from "./TerminalTradeImpulse";
import {
  terminalCertifiedSignalBlockerLabel,
  terminalCertifiedTapeViewEqual,
  type TerminalCertifiedMarketSignals,
} from "@/lib/terminal-certified-market-signals";
import { terminalTradeImpulseAgeBucket } from "@/lib/terminal-trade-impulse";

export const TerminalTradeTape = memo(function TerminalTradeTape({
  signals,
  onStagePrice,
  stagingDisabled = false,
}: {
  signals: TerminalCertifiedMarketSignals;
  onStagePrice: (price: number, evaluationIdentityKey: string) => void;
  stagingDisabled?: boolean;
}) {
  const state = signals.components.trades;
  if (!state.ready) {
    return (
      <div role="status" className="bg-rose-300/[0.02] px-4 py-4 text-[10px] leading-4 text-rose-200">
        Tape paused · {terminalCertifiedSignalBlockerLabel("trades", state.blocker)}. Synthetic and uncertified retained prints are hidden.
      </div>
    );
  }
  const identityKey = signals.evaluationIdentityKey;
  const trades = signals.tape.trades.slice(0, 10);
  return (
    <div className="px-3 py-3 font-mono text-[11px]">
      <TerminalTradeImpulse signals={signals} />
      {stagingDisabled ? (
        <p id="terminal-tape-staging-lock" role="status" className="mb-2 rounded border border-amber-300/25 bg-amber-300/[0.05] px-2 py-1.5 font-sans text-[9px] leading-3.5 text-amber-100">
          Price staging locked while the live request settles. Prints remain inspectable.
        </p>
      ) : null}
      <div className="mb-2 grid grid-cols-4 px-1 text-[9px] uppercase tracking-[0.12em] text-[#566278]">
        <span>Time</span><span className="text-right">Price</span><span className="text-right">Size</span><span className="text-right">Value</span>
      </div>
      {trades.length === 0 ? <p className="px-1 py-3 text-[#566278]">No recent prints.</p> : null}
      {trades.map((trade, index) => {
        const price = Number(trade.px);
        return (
          <button
            key={trade.id ?? `${trade.time}:${trade.side}:${trade.px}:${trade.sz}`}
            type="button"
            disabled={stagingDisabled || !identityKey || !Number.isFinite(price) || price <= 0}
            aria-describedby={stagingDisabled ? "terminal-tape-staging-lock" : undefined}
            onClick={() => {
              if (identityKey && Number.isFinite(price) && price > 0) onStagePrice(price, identityKey);
            }}
            aria-label={stagingDisabled
              ? `${trade.side}-initiated print ${formatPrice(price)}; price staging locked during live execution`
              : `Stage ${trade.side}-initiated print ${formatPrice(price)} as limit entry; no order submitted`}
            className="grid w-full grid-cols-4 rounded-sm px-1 py-1 text-left tabular-nums hover:bg-[#0f1a2c] focus-visible:outline focus-visible:outline-1 focus-visible:outline-sky-300 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ opacity: Math.max(0.4, 1 - index * 0.06) }}
          >
            <span className={trade.side === "buy" ? "text-emerald-300" : "text-rose-300"}>{formatTradeTime(trade.time)}</span>
            <span className={`text-right ${trade.side === "buy" ? "text-emerald-200" : "text-rose-200"}`}>{formatPrice(price)}</span>
            <span className="text-right text-[#8b95a8]">{Number(trade.sz).toFixed(4)}</span>
            <span className="text-right text-[#566278]">${formatCompactNumber(price * Number(trade.sz))}</span>
          </button>
        );
      })}
      <div className="mt-2 flex items-center justify-between border-t border-[#141d2e] px-1 pt-2 text-[9px] uppercase tracking-[0.12em] text-[#566278]">
        <span>VWAP <b className="font-normal text-[#c7d2e4]">{formatPrice(signals.tape.tradeVwap)}</b></span>
        <span>Buy flow <b className={metricSignedTone((signals.tape.buyFlowPct ?? 50) - 50)}>{signals.tape.buyFlowPct != null ? `${signals.tape.buyFlowPct.toFixed(0)}%` : "-"}</b></span>
      </div>
      <p className="mt-2 border-t border-[#141d2e] px-1 pt-2 font-sans text-[8px] leading-3 text-[#66738c]">
        Select a certified print to stage its price in the ticket. This clears stale preview bindings but never previews or submits.
      </p>
    </div>
  );
}, (previous, next) => previous.onStagePrice === next.onStagePrice
  && previous.stagingDisabled === next.stagingDisabled
  && terminalCertifiedTapeViewEqual(previous.signals, next.signals)
  && terminalTradeImpulseAgeBucket(previous.signals.components.trades.ageMs)
    === terminalTradeImpulseAgeBucket(next.signals.components.trades.ageMs));

function formatTradeTime(timestamp: number) {
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function formatPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000) return value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toFixed(6);
}

function formatCompactNumber(value: number) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)
    : "—";
}

function metricSignedTone(value: number | null | undefined) {
  return value == null || value === 0 ? "text-[#c7d2e4]" : value > 0 ? "text-emerald-300" : "text-rose-300";
}
