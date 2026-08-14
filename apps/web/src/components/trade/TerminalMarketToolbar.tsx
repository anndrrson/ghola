"use client";

import { memo } from "react";
import { ChevronDown, Command } from "lucide-react";

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
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#182234] px-4 py-3 sm:px-6">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Trading venue">
          {venues.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={venueId === item.id}
              onClick={() => onSelectVenue(item.id)}
              className={`h-9 rounded-md px-3 text-sm font-medium ${venueId === item.id ? "trade-chip-on" : "trade-chip"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="relative">
          <span className="sr-only">Market</span>
          <select
            value={market}
            onChange={(event) => onSelectMarket(event.target.value)}
            className="trade-field h-9 appearance-none rounded-md pl-3 pr-8 text-sm font-semibold text-[#eef1f8] outline-none"
          >
            {(venue?.markets ?? []).map((item) => (
              <option key={item} value={item}>{productLabel(venueId, item)}</option>
            ))}
          </select>
          <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#6f7d9a]" />
        </label>
        {venueId === "hyperliquid" ? (
          <span className="rounded border border-[#1e2a3a] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[#6f7d9a]">
            {network}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1" role="group" aria-label="Chart interval">
        {INTERVALS.map((item, index) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === interval}
            aria-keyshortcuts={String(index + 1)}
            title={`Select ${item} chart · shortcut ${index + 1}`}
            onClick={() => onSelectInterval(item)}
            className={`h-8 w-12 rounded-md text-sm tabular-nums ${item === interval ? "trade-chip-on" : "trade-chip"}`}
          >
            {item}
          </button>
        ))}
        <span className="ml-2 hidden items-center gap-1.5 text-[10px] text-[#566278] 2xl:inline-flex">
          <Command className="h-3 w-3" aria-hidden /> B/S side · 1–4 interval · D book · J/X price · ⇧J/⇧X risk
        </span>
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

function productLabel(venue: TerminalMarketToolbarVenueId, market: string) {
  return venue === "coinbase" ? `${market}-USD` : `${market}-PERP`;
}
