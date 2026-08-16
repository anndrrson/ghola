"use client";

import { memo } from "react";

export type TerminalMarketToolbarVenueId = "hyperliquid" | "phoenix" | "coinbase";
export type TerminalMarketToolbarInterval = "1m" | "5m" | "15m" | "1h";

export interface TerminalMarketToolbarVenue {
  id: TerminalMarketToolbarVenueId;
  label: string;
  markets: readonly string[];
}

export interface TerminalMarketToolbarProps {
  venues: readonly TerminalMarketToolbarVenue[];
  venueId: TerminalMarketToolbarVenueId;
  market: string;
  network: "mainnet" | "testnet";
  interval: TerminalMarketToolbarInterval;
  onSelectVenue: (venue: TerminalMarketToolbarVenueId) => void;
  onSelectMarket: (market: string) => void;
  onSelectInterval: (interval: TerminalMarketToolbarInterval) => void;
}

const INTERVALS: TerminalMarketToolbarInterval[] = ["1m", "5m", "15m", "1h"];

export const TerminalMarketToolbar = memo(function TerminalMarketToolbar({
  venues,
  venueId,
  market,
  network,
  interval,
  onSelectVenue,
  onSelectMarket,
  onSelectInterval,
}: TerminalMarketToolbarProps) {
  const venue = venues.find((item) => item.id === venueId) ?? venues[0];
  return (
    <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-[#596476]">
          Market
          <select
            aria-label="Market"
            value={market}
            onChange={(event) => onSelectMarket(event.target.value)}
            className="h-7 min-w-32 rounded border border-[#222b38] bg-[#090d13] px-2 text-[10px] font-medium normal-case tracking-normal text-[#dce5f0] outline-none"
          >
            {(venue?.markets ?? []).map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-[#596476]">
          Venue
          <select aria-label="Venue" title={`${network} venue`} value={venueId} onChange={(event) => onSelectVenue(event.target.value as TerminalMarketToolbarVenueId)} className="h-7 min-w-40 rounded border border-[#28496d] bg-[#10213a] px-2 text-[10px] font-medium normal-case tracking-normal text-[#9bcfff] outline-none">
            {venues.map((item) => <option key={item.id} value={item.id}>{item.label}{item.id === "hyperliquid" ? " · BYO live" : " · live"}</option>)}
          </select>
        </label>
      <div>
        <p className="mb-1 text-right text-[8px] font-semibold uppercase tracking-[0.12em] text-[#596476]">Interval</p>
        <div className="flex items-center gap-1" role="group" aria-label="Chart interval">
        {INTERVALS.map((item, index) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === interval}
            aria-keyshortcuts={String(index + 1)}
            title={`Select ${item} chart · shortcut ${index + 1}`}
            onClick={() => onSelectInterval(item)}
            className={`h-7 min-w-8 rounded border px-2 text-[9px] tabular-nums ${item === interval ? "border-[#88bfff] bg-[#dbeaff] text-[#101722]" : "border-[#202a39] bg-[#0a0e15] text-[#718097]"}`}
          >
            {item}
          </button>
        ))}
        </div>
      </div>
    </div>
  );
}, terminalMarketToolbarPropsEqual);

export function terminalMarketToolbarPropsEqual(
  previous: TerminalMarketToolbarProps,
  next: TerminalMarketToolbarProps,
) {
  return previous.venues === next.venues
    && previous.venueId === next.venueId
    && previous.market === next.market
    && previous.network === next.network
    && previous.interval === next.interval
    && previous.onSelectVenue === next.onSelectVenue
    && previous.onSelectMarket === next.onSelectMarket
    && previous.onSelectInterval === next.onSelectInterval;
}
