"use client";

import { memo, startTransition, useEffect, useMemo, useState } from "react";
import {
  defaultTerminalWatchlistPreferences,
  deriveTerminalWatchlistRows,
  inspectTerminalWatchlistPreferences,
  mergeTerminalWatchlistSources,
  serializeTerminalWatchlistPreferences,
  setTerminalWatchlistSort,
  setTerminalWatchlistVenue,
  TERMINAL_MARKET_WATCHLIST_GUEST_SCOPE,
  TERMINAL_MARKET_WATCHLIST_MAX_AGE_MS,
  terminalMarketWatchlistStorageKey,
  terminalWatchlistSourcesEqual,
  terminalWatchlistSupportedVenues,
  type TerminalWatchlistInstrument,
  type TerminalWatchlistSource,
  type TerminalWatchlistSortField,
  type TerminalWatchlistVenue,
} from "@/lib/terminal-market-watchlist";
import { useTerminalMarketScanner } from "@/lib/use-terminal-market-scanner";
import type { UnifiedMarketInterval } from "@/lib/unified-live-market";

export interface TerminalMarketWatchlistProps {
  persistenceScope?: string | null;
  sources: TerminalWatchlistSource[];
  interval: UnifiedMarketInterval;
  hyperliquidNetwork: "mainnet" | "testnet";
  selectedInstrument: TerminalWatchlistInstrument;
  selectedVenue: TerminalWatchlistVenue;
  onSelect: (venue: TerminalWatchlistVenue, instrument: TerminalWatchlistInstrument) => void;
}

function TerminalMarketWatchlistView({
  persistenceScope = TERMINAL_MARKET_WATCHLIST_GUEST_SCOPE,
  sources,
  interval,
  hyperliquidNetwork,
  selectedInstrument,
  selectedVenue,
  onSelect,
}: TerminalMarketWatchlistProps) {
  const storageKey = terminalMarketWatchlistStorageKey(persistenceScope);
  const [preferences, setPreferences] = useState(defaultTerminalWatchlistPreferences);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [preferenceStorageBlocked, setPreferenceStorageBlocked] = useState(false);
  const [cachedSources, setCachedSources] = useState<TerminalWatchlistSource[]>([]);
  const [nowMs, setNowMs] = useState(0);
  const scannerTargets = useMemo(() => preferencesReady ? preferences.entries.flatMap((entry) => (
    entry.instrument === selectedInstrument && entry.venue === selectedVenue
      ? []
      : [{
          venue: entry.venue,
          instrument: entry.instrument,
          interval,
          network: entry.venue === "hyperliquid" ? hyperliquidNetwork : "mainnet" as const,
        }]
  )) : [], [hyperliquidNetwork, interval, preferences, preferencesReady, selectedInstrument, selectedVenue]);
  const scannerSources = useTerminalMarketScanner(scannerTargets);

  useEffect(() => {
    let saved: ReturnType<typeof defaultTerminalWatchlistPreferences> | null = null;
    let blocked = false;
    try {
      if (storageKey) {
        const inspection = inspectTerminalWatchlistPreferences(window.localStorage.getItem(storageKey));
        saved = inspection.preferences;
        blocked = inspection.status === "blocked";
      }
    } catch {
      blocked = true;
    }
    const timerId = window.setTimeout(() => {
      if (saved) setPreferences(saved);
      setPreferenceStorageBlocked(blocked);
      setPreferencesReady(true);
    }, 0);
    return () => window.clearTimeout(timerId);
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    const activeKey = storageKey;
    function reconcilePreferences(event: StorageEvent) {
      if (event.key !== activeKey) return;
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return;
      } catch {
        setPreferenceStorageBlocked(true);
        return;
      }
      const inspection = inspectTerminalWatchlistPreferences(event.newValue);
      if (inspection.status === "blocked") {
        setPreferenceStorageBlocked(true);
        return;
      }
      setPreferences(inspection.preferences ?? defaultTerminalWatchlistPreferences());
      setPreferenceStorageBlocked(false);
    }
    window.addEventListener("storage", reconcilePreferences);
    return () => window.removeEventListener("storage", reconcilePreferences);
  }, [storageKey]);

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      setCachedSources((current) => mergeTerminalWatchlistSources(current, sources));
    }, 0);
    return () => window.clearTimeout(timerId);
  }, [sources]);

  useEffect(() => {
    const updateClock = () => {
      if (!document.hidden) startTransition(() => setNowMs(Date.now()));
    };
    updateClock();
    const timer = window.setInterval(updateClock, 5_000);
    document.addEventListener("visibilitychange", updateClock);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", updateClock);
    };
  }, []);

  const availableSources = useMemo(
    () => mergeTerminalWatchlistSources(cachedSources, [...sources, ...scannerSources]),
    [cachedSources, scannerSources, sources],
  );
  const rows = useMemo(() => deriveTerminalWatchlistRows({
    preferences,
    sources: availableSources,
    nowMs,
    maxAgeMs: TERMINAL_MARKET_WATCHLIST_MAX_AGE_MS,
  }), [availableSources, nowMs, preferences]);
  const liveCount = rows.filter((row) => row.availability === "live").length;

  function changeVenue(instrument: TerminalWatchlistInstrument, venue: TerminalWatchlistVenue) {
    if (preferenceStorageBlocked) return;
    const next = setTerminalWatchlistVenue(preferences, instrument, venue);
    if (persistPreferences(next)) setPreferences(next);
  }

  function changeSort(field: TerminalWatchlistSortField) {
    if (preferenceStorageBlocked) return;
    const next = setTerminalWatchlistSort(preferences, field);
    if (persistPreferences(next)) setPreferences(next);
  }

  function persistPreferences(next: typeof preferences) {
    if (!storageKey) return true;
    if (preferenceStorageBlocked) return false;
    try {
      window.localStorage.setItem(
        storageKey,
        serializeTerminalWatchlistPreferences(next),
      );
      return true;
    } catch {
      setPreferenceStorageBlocked(true);
      return false;
    }
  }

  function resetBlockedPreferences() {
    if (
      !preferenceStorageBlocked
      || !storageKey
      || !window.confirm("Reset unreadable scanner preferences? Existing saved preferences cannot be recovered after this.")
    ) return;
    const defaults = defaultTerminalWatchlistPreferences();
    try {
      window.localStorage.setItem(storageKey, serializeTerminalWatchlistPreferences(defaults));
      setPreferences(defaults);
      setPreferenceStorageBlocked(false);
    } catch {
      // Keep the preserved value locked when storage remains unavailable.
    }
  }

  return (
    <section
      id="terminal-market-scanner"
      tabIndex={-1}
      className="border-y border-[#182234] bg-[#070a10]/70 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#5aa7ff]"
      aria-labelledby="terminal-market-watchlist-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 sm:px-6">
        <div>
          <h2 id="terminal-market-watchlist-title" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#dce6f4]">
            Passive market scanner
          </h2>
          <p className="mt-0.5 text-[9px] text-[#66738c]">
            Selected stream + rotating snapshots · rank = |12-bar move|, then spread · one request at a time
          </p>
        </div>
        <span className="rounded border border-[#1e2a3a] px-2 py-1 font-mono text-[9px] tabular-nums text-[#8390a8]">
          {liveCount}/4 fresh
        </span>
      </div>
      {preferenceStorageBlocked ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-t border-rose-300/25 bg-rose-300/[0.04] px-4 py-2 text-[9px] leading-4 text-rose-200 sm:px-6">
          <span>Saved scanner preferences are unreadable or unavailable and preserved. Venue and sort changes are locked.</span>
          <button type="button" onClick={resetBlockedPreferences} className="term-chip h-7 shrink-0 px-2 text-[9px] uppercase">
            Reset scanner
          </button>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] table-fixed border-collapse text-left font-mono text-[10px] tabular-nums">
          <caption className="sr-only">BTC, ETH, SOL and HYPE manual market watchlist</caption>
          <thead className="border-y border-[#182234] bg-[#090d14] text-[9px] uppercase tracking-[0.08em] text-[#566278]">
            <tr>
              <th scope="col" className="w-[18%] px-4 py-1.5 sm:px-6">Instrument</th>
              <th scope="col" className="w-[17%] px-2 py-1.5">Venue</th>
              <th scope="col" className="px-2 py-1.5 text-right">Price</th>
              <SortableHeader field="spread" label="Spread" preferences={preferences} onSort={changeSort} disabled={preferenceStorageBlocked} />
              <SortableHeader field="move" label="12-bar Δ" preferences={preferences} onSort={changeSort} disabled={preferenceStorageBlocked} />
              <SortableHeader field="volatility" label="Realized σ" preferences={preferences} onSort={changeSort} disabled={preferenceStorageBlocked} />
              <th scope="col" className="w-[8%] px-2 py-1.5 text-right" title="Ranked by absolute 12-bar move; lower spread breaks ties.">Move rank</th>
              <SortableHeader field="age" label="Feed / age" preferences={preferences} onSort={changeSort} disabled={preferenceStorageBlocked} className="px-4 sm:px-6" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const selected = row.instrument === selectedInstrument && row.venue === selectedVenue;
              return (
                <tr key={row.instrument} className={`border-b border-[#111a29] last:border-b-0 ${selected ? "bg-[#0d1a2b]" : "hover:bg-[#0a101a]"}`}>
                  <th scope="row" className="px-4 py-2 sm:px-6">
                    <button
                      type="button"
                      aria-pressed={selected}
                      title={`Load ${row.instrument} on ${venueLabel(row.venue)}`}
                      onClick={() => onSelect(row.venue, row.instrument)}
                      className="rounded px-1 py-1 text-left font-semibold text-[#f2f6ff] outline-none transition-colors hover:text-[#7fbbff] focus-visible:ring-2 focus-visible:ring-[#5aa7ff]"
                    >
                      {row.instrument}
                    </button>
                  </th>
                  <td className="px-2 py-2">
                    <label>
                      <span className="sr-only">Preferred venue for {row.instrument}</span>
                      <select
                        value={row.venue}
                        disabled={preferenceStorageBlocked}
                        onChange={(event) => changeVenue(row.instrument, event.target.value as TerminalWatchlistVenue)}
                        className="h-7 max-w-full rounded border border-[#1e2a3a] bg-[#080c13] px-1 text-[9px] text-[#aeb9cb] outline-none focus-visible:ring-2 focus-visible:ring-[#5aa7ff]"
                      >
                        {terminalWatchlistSupportedVenues(row.instrument).map((venue) => (
                          <option key={venue} value={venue}>{venueLabel(venue)}</option>
                        ))}
                      </select>
                    </label>
                  </td>
                  <WatchValue value={formatPrice(row.price)} available={row.availability === "live"} />
                  <WatchValue value={formatBps(row.spreadBps)} available={row.availability === "live"} />
                  <WatchValue value={formatPercent(row.changePct)} available={row.availability === "live"} signed={row.changePct} />
                  <WatchValue value={formatBps(row.realizedVolatilityBps)} available={row.availability === "live"} />
                  <td className="px-2 py-2 text-right font-semibold text-[#aeb9cb]">
                    {row.moveRank == null ? "—" : `#${row.moveRank}`}
                  </td>
                  <td className="px-4 py-2 text-right sm:px-6">
                    <span className={feedTone(row.availability, row.healthGrade, row.transport)}>
                      {feedLabel(row.availability, row.healthGrade, row.transport)}
                    </span>
                    <span className="ml-1 text-[#566278]">{formatAge(row.ageMs)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export const TerminalMarketWatchlist = memo(
  TerminalMarketWatchlistView,
  (previous, next) => previous.persistenceScope === next.persistenceScope
    && previous.interval === next.interval
    && previous.hyperliquidNetwork === next.hyperliquidNetwork
    && previous.selectedInstrument === next.selectedInstrument
    && previous.selectedVenue === next.selectedVenue
    && previous.onSelect === next.onSelect
    && terminalWatchlistSourcesEqual(previous.sources, next.sources),
);

function SortableHeader({
  field,
  label,
  preferences,
  onSort,
  disabled = false,
  className = "px-2",
}: {
  field: TerminalWatchlistSortField;
  label: string;
  preferences: ReturnType<typeof defaultTerminalWatchlistPreferences>;
  onSort: (field: TerminalWatchlistSortField) => void;
  disabled?: boolean;
  className?: string;
}) {
  const active = preferences.sort.field === field;
  return (
    <th
      scope="col"
      aria-sort={active ? preferences.sort.direction === "asc" ? "ascending" : "descending" : "none"}
      className={`${className} py-1 text-right`}
    >
      <button
        type="button"
        aria-label={`Sort scanner by ${label}`}
        disabled={disabled}
        onClick={() => onSort(field)}
        className={`inline-flex min-h-7 items-center justify-end gap-1 rounded px-1 outline-none hover:text-[#dce6f4] focus-visible:ring-1 focus-visible:ring-sky-300 disabled:cursor-not-allowed disabled:opacity-40 ${active ? "text-sky-300" : "text-[#566278]"}`}
      >
        <span>{label}</span>
        <span aria-hidden>{active ? preferences.sort.direction === "asc" ? "↑" : "↓" : "↕"}</span>
      </button>
    </th>
  );
}

function WatchValue({
  value,
  available,
  signed,
}: {
  value: string;
  available: boolean;
  signed?: number | null;
}) {
  const tone = !available || signed == null
    ? "text-[#8794aa]"
    : signed > 0
      ? "text-emerald-300"
      : signed < 0
        ? "text-rose-300"
        : "text-[#c7d2e4]";
  return <td className={`px-2 py-2 text-right ${tone}`}>{available ? value : "—"}</td>;
}

function venueLabel(venue: TerminalWatchlistVenue) {
  if (venue === "hyperliquid") return "Hyperliquid";
  if (venue === "phoenix") return "Phoenix";
  return "Coinbase";
}

function formatPrice(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 1_000 ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatBps(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(2)} bp`;
}

function formatPercent(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatAge(value: number | null) {
  if (value == null) return "";
  if (value < 1_000) return "now";
  return `${Math.floor(value / 1_000)}s`;
}

function feedLabel(
  availability: "live" | "stale" | "not_loaded" | "synthetic_blocked",
  grade: string | null,
  transport: "websocket" | "polling" | null,
) {
  if (availability === "live") return grade ?? (transport === "polling" ? "poll" : "?");
  if (availability === "stale") return grade ? `${grade} stale` : "stale";
  if (availability === "synthetic_blocked") return "blocked";
  return "not loaded";
}

function feedTone(
  availability: "live" | "stale" | "not_loaded" | "synthetic_blocked",
  grade: string | null,
  transport: "websocket" | "polling" | null,
) {
  if (availability !== "live") return availability === "not_loaded" ? "text-[#66738c]" : "text-rose-300";
  if (transport === "polling" && grade == null) return "text-[#7fbbff]";
  if (grade === "A" || grade === "B") return "text-emerald-300";
  if (grade === "C") return "text-amber-300";
  return "text-rose-300";
}
