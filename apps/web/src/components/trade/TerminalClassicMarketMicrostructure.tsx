"use client";

import { memo } from "react";
import { frameMidNumber, type GholaMarketFrame } from "@/lib/ghola-market-chart";

export interface TerminalClassicMarketMicrostructureProps {
  frame: GholaMarketFrame | null;
  onSelectPrice: (price: number) => void;
}

export const TerminalClassicMarketMicrostructure = memo(function TerminalClassicMarketMicrostructure({
  frame,
  onSelectPrice,
}: TerminalClassicMarketMicrostructureProps) {
  return (
    <div className="min-w-0 bg-[#070a0f]">
      <div className="flex h-9 items-center justify-between border-b border-[#182234] px-3">
        <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#9aa8bc]">Order book</span>
        <span className="font-mono text-[8px] tabular-nums text-[#59667a]">
          {frame?.spreadBps != null ? `${frame.spreadBps.toFixed(2)} bps` : "spread —"}
        </span>
      </div>
      <BookSummary frame={frame} />
      <div className="border-y border-[#182234]">
        <BookTable frame={frame} onSelectPrice={onSelectPrice} />
      </div>
      <div className="flex h-9 items-center justify-between border-b border-[#182234] px-3">
        <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#9aa8bc]">Recent trades</span>
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.6)]" />
      </div>
      <TradeTape frame={frame} />
    </div>
  );
});

function BookSummary({ frame }: { frame: GholaMarketFrame | null }) {
  const bids = (frame?.bids ?? []).slice(0, 5);
  const asks = (frame?.asks ?? []).slice(0, 5);
  const bidTotal = bids.reduce((sum, level) => sum + (Number(level.sz) || 0), 0);
  const askTotal = asks.reduce((sum, level) => sum + (Number(level.sz) || 0), 0);
  const total = bidTotal + askTotal;
  const bidShare = total > 0 ? (bidTotal / total) * 100 : 50;
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between font-mono text-xs tabular-nums">
        <span className="text-emerald-300">{frame?.bestBid ? formatPrice(Number(frame.bestBid)) : "-"}</span>
        <span className="text-sm text-[#eef1f8]">{formatPrice(frameMidNumber(frame))}</span>
        <span className="text-rose-300">{frame?.bestAsk ? formatPrice(Number(frame.bestAsk)) : "-"}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-rose-400/25">
        <div className="h-full rounded-full bg-emerald-400/60 transition-[width] duration-75" style={{ width: `${bidShare}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-[#566278]">
        <span>bids {Math.round(bidShare)}%</span>
        <span>asks {Math.round(100 - bidShare)}%</span>
      </div>
    </div>
  );
}

function BookTable({ frame, onSelectPrice }: TerminalClassicMarketMicrostructureProps) {
  const asks = cumulativeBookLevels((frame?.asks ?? []).slice(0, 10)).reverse();
  const bids = cumulativeBookLevels((frame?.bids ?? []).slice(0, 10));
  const maxTotal = Math.max(1e-9, ...[...asks, ...bids].map((level) => level.total).filter(Number.isFinite));
  return (
    <div className="px-3 py-3 font-mono text-[10px]">
      <div className="grid grid-cols-3 pb-2 text-[8px] uppercase tracking-[0.12em] text-[#566278]">
        <span>Price</span><span className="text-right">Size</span><span className="text-right">Total</span>
      </div>
      {asks.map((level, index) => <BookRow key={`ask-${index}`} {...level} tone="ask" maxTotal={maxTotal} onSelectPrice={onSelectPrice} />)}
      <div className="my-2 rounded border border-[#1e2a3a] bg-[#111a28] px-2 py-1 text-center text-sm tabular-nums text-[#eef1f8]">
        {formatPrice(frameMidNumber(frame))}
      </div>
      {bids.map((level, index) => <BookRow key={`bid-${index}`} {...level} tone="bid" maxTotal={maxTotal} onSelectPrice={onSelectPrice} />)}
    </div>
  );
}

function cumulativeBookLevels(levels: GholaMarketFrame["bids"]) {
  let total = 0;
  return levels.map((level) => {
    total += Number(level.sz) || 0;
    return { ...level, total };
  });
}

function BookRow({ px, sz, total, tone, maxTotal, onSelectPrice }: {
  px: string;
  sz: string;
  total: number;
  tone: "bid" | "ask";
  maxTotal: number;
  onSelectPrice: (price: number) => void;
}) {
  const width = Math.min(100, Math.max(4, (total / maxTotal) * 100));
  const color = tone === "bid" ? "#34d399" : "#fb7185";
  const numericPrice = Number(px);
  const displayPrice = formatPrice(numericPrice);
  return (
    <button type="button" aria-label={`Stage ${tone} price ${displayPrice} as a limit order`} onClick={() => onSelectPrice(numericPrice)} className="relative grid w-full grid-cols-3 overflow-hidden rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-[#0f1a2c] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#5daeff]">
      <span aria-hidden className="absolute inset-y-0 right-0 opacity-15" style={{ width: `${width}%`, background: `linear-gradient(270deg, ${color}, transparent)` }} />
      <span className={`relative tabular-nums ${tone === "bid" ? "text-emerald-300" : "text-rose-300"}`}>{displayPrice}</span>
      <span className="relative text-right tabular-nums text-[#8b95a8]">{Number(sz).toFixed(4)}</span>
      <span className="relative text-right tabular-nums text-[#657187]">{total.toFixed(4)}</span>
    </button>
  );
}

function TradeTape({ frame }: { frame: GholaMarketFrame | null }) {
  return (
    <div className="px-4 py-3 font-mono text-xs">
      {(frame?.trades ?? []).slice(0, 10).map((trade, index) => (
        <div key={`${trade.time}-${index}`} className="grid grid-cols-3 py-1 tabular-nums" style={{ opacity: Math.max(0.4, 1 - index * 0.06) }}>
          <span className={trade.side === "buy" ? "text-emerald-300" : "text-rose-300"}>{trade.side}</span>
          <span className="text-right text-[#eef1f8]">{formatPrice(Number(trade.px))}</span>
          <span className="text-right text-[#8b95a8]">{Number(trade.sz).toFixed(4)}</span>
        </div>
      ))}
    </div>
  );
}

function formatPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: value >= 1_000 ? 1 : 2,
    maximumFractionDigits: value >= 1_000 ? 1 : 4,
  }).format(value);
}
