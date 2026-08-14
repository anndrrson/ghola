import type { GholaMarketFrame } from "./ghola-market-chart";
import type { MarketFeedHealthGrade, MarketFeedTelemetry } from "./market-feed-telemetry";
import { deriveTerminalMarketMetrics } from "./trading-terminal-metrics";

export const TERMINAL_MARKET_WATCHLIST_VERSION = 1 as const;
export const TERMINAL_MARKET_WATCHLIST_LEGACY_STORAGE_KEY = "ghola.terminal-market-watchlist.v1";
export const TERMINAL_MARKET_WATCHLIST_STORAGE_PREFIX = "ghola.terminal-market-watchlist.v2:";
export const TERMINAL_MARKET_WATCHLIST_GUEST_SCOPE = "device_guest";
export const TERMINAL_MARKET_WATCHLIST_STORAGE_KEY =
  `${TERMINAL_MARKET_WATCHLIST_STORAGE_PREFIX}${TERMINAL_MARKET_WATCHLIST_GUEST_SCOPE}`;
export const TERMINAL_MARKET_WATCHLIST_MAX_AGE_MS = 30_000;
export const TERMINAL_MARKET_WATCHLIST_INSTRUMENTS = ["BTC", "ETH", "SOL", "HYPE"] as const;
const PERSISTENCE_SCOPE_PATTERN = /^(?:device_guest|subject_[a-f0-9]{32})$/u;

export function terminalMarketWatchlistStorageKey(
  persistenceScope: string | null | undefined,
): string | null {
  return typeof persistenceScope === "string" && PERSISTENCE_SCOPE_PATTERN.test(persistenceScope)
    ? `${TERMINAL_MARKET_WATCHLIST_STORAGE_PREFIX}${persistenceScope}`
    : null;
}

export type TerminalWatchlistInstrument = (typeof TERMINAL_MARKET_WATCHLIST_INSTRUMENTS)[number];
export type TerminalWatchlistVenue = "hyperliquid" | "phoenix" | "coinbase";
export type TerminalWatchlistSortField = "move" | "spread" | "volatility" | "age";
export type TerminalWatchlistSortDirection = "asc" | "desc";

export interface TerminalWatchlistEntry {
  instrument: TerminalWatchlistInstrument;
  venue: TerminalWatchlistVenue;
}

export interface TerminalWatchlistPreferences {
  version: typeof TERMINAL_MARKET_WATCHLIST_VERSION;
  entries: TerminalWatchlistEntry[];
  sort: {
    field: TerminalWatchlistSortField;
    direction: TerminalWatchlistSortDirection;
  };
}

export type TerminalWatchlistPreferencesInspection =
  | { status: "absent"; preferences: null; raw: null }
  | { status: "ready"; preferences: TerminalWatchlistPreferences; raw: string }
  | { status: "blocked"; preferences: null; raw: string };

export interface TerminalWatchlistSource {
  frame: GholaMarketFrame;
  status: "connecting" | "live" | "reconnecting" | "fallback_polling" | "stale" | "blocked";
  stale: boolean;
  provenance: "public_live" | "synthetic";
  healthGrade: MarketFeedHealthGrade | null;
  transport?: "websocket" | "polling" | null;
  componentAgesMs?: MarketFeedTelemetry["componentAgesMs"];
  telemetryCapturedAtMs: number;
}

export interface TerminalWatchlistRow extends TerminalWatchlistEntry {
  availability: "live" | "stale" | "not_loaded" | "synthetic_blocked";
  price: number | null;
  spreadBps: number | null;
  changePct: number | null;
  realizedVolatilityBps: number | null;
  moveRank: number | null;
  healthGrade: MarketFeedHealthGrade | null;
  transport: "websocket" | "polling" | null;
  ageMs: number | null;
  fetchedAt: string | null;
}

const VENUES_BY_INSTRUMENT: Record<TerminalWatchlistInstrument, readonly TerminalWatchlistVenue[]> = {
  BTC: ["hyperliquid", "coinbase"],
  ETH: ["hyperliquid", "coinbase"],
  SOL: ["hyperliquid", "phoenix", "coinbase"],
  HYPE: ["hyperliquid"],
};

export function defaultTerminalWatchlistPreferences(): TerminalWatchlistPreferences {
  return {
    version: TERMINAL_MARKET_WATCHLIST_VERSION,
    entries: [
      { instrument: "BTC", venue: "hyperliquid" },
      { instrument: "ETH", venue: "hyperliquid" },
      { instrument: "SOL", venue: "hyperliquid" },
      { instrument: "HYPE", venue: "hyperliquid" },
    ],
    sort: { field: "move", direction: "desc" },
  };
}

export function terminalWatchlistSupportedVenues(
  instrument: TerminalWatchlistInstrument,
): readonly TerminalWatchlistVenue[] {
  return VENUES_BY_INSTRUMENT[instrument];
}

export function setTerminalWatchlistVenue(
  preferences: TerminalWatchlistPreferences,
  instrument: TerminalWatchlistInstrument,
  venue: TerminalWatchlistVenue,
): TerminalWatchlistPreferences {
  if (!VENUES_BY_INSTRUMENT[instrument].includes(venue)) return preferences;
  return {
    ...preferences,
    entries: preferences.entries.map((entry) => (
      entry.instrument === instrument ? { ...entry, venue } : entry
    )),
  };
}

export function setTerminalWatchlistSort(
  preferences: TerminalWatchlistPreferences,
  field: TerminalWatchlistSortField,
): TerminalWatchlistPreferences {
  const direction = preferences.sort.field === field
    ? preferences.sort.direction === "asc" ? "desc" : "asc"
    : field === "spread" || field === "age" ? "asc" : "desc";
  return { ...preferences, sort: { field, direction } };
}

export function parseTerminalWatchlistPreferences(
  value: string | null | undefined,
): TerminalWatchlistPreferences | null {
  if (!value) return null;
  try {
    return validatePreferences(JSON.parse(value));
  } catch {
    return null;
  }
}

export function inspectTerminalWatchlistPreferences(
  value: string | null | undefined,
): TerminalWatchlistPreferencesInspection {
  if (value == null) return { status: "absent", preferences: null, raw: null };
  try {
    const preferences = validatePreferences(JSON.parse(value));
    return preferences
      ? { status: "ready", preferences, raw: value }
      : { status: "blocked", preferences: null, raw: value };
  } catch {
    return { status: "blocked", preferences: null, raw: value };
  }
}

export function serializeTerminalWatchlistPreferences(value: TerminalWatchlistPreferences): string {
  const valid = validatePreferences(value);
  if (!valid) throw new Error("terminal_market_watchlist_invalid");
  return JSON.stringify(valid);
}

export function deriveTerminalWatchlistRows(input: {
  preferences: TerminalWatchlistPreferences;
  sources: TerminalWatchlistSource[];
  nowMs?: number;
  maxAgeMs?: number;
}): TerminalWatchlistRow[] {
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = boundedAge(input.maxAgeMs);
  const sources = newestSourcesByPair(input.sources);

  const rows: TerminalWatchlistRow[] = input.preferences.entries.map((entry) => {
    const source = sources.get(sourceKey(entry.venue, entry.instrument));
    if (!source) return emptyRow(entry, "not_loaded");
    if (source.provenance !== "public_live") return emptyRow(entry, "synthetic_blocked");

    const fetchedAtMs = source.frame.fetchedAt ? Date.parse(source.frame.fetchedAt) : Number.NaN;
    const rawAgeMs = nowMs - fetchedAtMs;
    const ageMs = Number.isFinite(rawAgeMs) && rawAgeMs >= -30_000
      ? Math.max(0, rawAgeMs)
      : null;
    const quoteAgeMs = effectiveComponentAge(source, "quote", nowMs);
    const transportLive = source.status === "live" || source.status === "fallback_polling";
    const live = transportLive && !source.stale && !source.frame.stale && ageMs != null && ageMs <= maxAgeMs &&
      quoteAgeMs != null && quoteAgeMs <= maxAgeMs;
    if (!live) {
      return {
        ...emptyRow(entry, "stale"),
        healthGrade: source.healthGrade,
        transport: source.transport ?? transportFromStatus(source.status),
        ageMs: quoteAgeMs ?? ageMs,
        fetchedAt: source.frame.fetchedAt,
      };
    }

    const bid = positive(source.frame.bestBid);
    const ask = positive(source.frame.bestAsk);
    if (bid == null || ask == null || bid >= ask) {
      return {
        ...emptyRow(entry, "stale"),
        healthGrade: source.healthGrade,
        transport: source.transport ?? transportFromStatus(source.status),
        ageMs,
        fetchedAt: source.frame.fetchedAt,
      };
    }
    const mid = (bid + ask) / 2;
    const spreadBps = ((ask - bid) / mid) * 10_000;
    const candleAgeMs = effectiveComponentAge(source, "candles", nowMs);
    const candleMetrics = candleAgeMs != null && candleAgeMs <= terminalWatchlistCandleMaxAgeMs(source.frame.interval)
      ? deriveTerminalMarketMetrics({
        ...source.frame,
        candles: source.frame.candles.slice(-12),
      }, { nowMs })
      : null;

    return {
      ...entry,
      availability: "live",
      price: mid,
      spreadBps: finiteOrNull(spreadBps),
      changePct: candleMetrics?.sessionChangePct ?? null,
      realizedVolatilityBps: candleMetrics?.realizedVolatilityBps ?? null,
      moveRank: null,
      healthGrade: source.healthGrade,
      transport: source.transport ?? transportFromStatus(source.status),
      ageMs: quoteAgeMs,
      fetchedAt: source.frame.fetchedAt,
    };
  });
  const ranked = rows
    .filter((row) => row.availability === "live" && row.changePct != null)
    .toSorted((left, right) => (
      Math.abs(right.changePct ?? 0) - Math.abs(left.changePct ?? 0)
      || (left.spreadBps ?? Number.POSITIVE_INFINITY) - (right.spreadBps ?? Number.POSITIVE_INFINITY)
      || left.instrument.localeCompare(right.instrument)
    ));
  const ranks = new Map(ranked.map((row, index) => [`${row.venue}:${row.instrument}`, index + 1]));
  return sortTerminalWatchlistRows(rows.map((row) => ({
    ...row,
    moveRank: ranks.get(`${row.venue}:${row.instrument}`) ?? null,
  })), input.preferences.sort);
}

export function sortTerminalWatchlistRows(
  rows: TerminalWatchlistRow[],
  sort: TerminalWatchlistPreferences["sort"],
): TerminalWatchlistRow[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  return rows.toSorted((left, right) => {
    if (left.availability !== right.availability) {
      return left.availability === "live" ? -1 : right.availability === "live" ? 1 : 0;
    }
    const leftValue = watchlistSortValue(left, sort.field);
    const rightValue = watchlistSortValue(right, sort.field);
    if (leftValue == null || rightValue == null) {
      if (leftValue == null && rightValue != null) return 1;
      if (leftValue != null && rightValue == null) return -1;
    } else if (leftValue !== rightValue) {
      return (leftValue - rightValue) * direction;
    }
    return (left.moveRank ?? Number.POSITIVE_INFINITY) - (right.moveRank ?? Number.POSITIVE_INFINITY)
      || left.instrument.localeCompare(right.instrument);
  });
}

/** Allows one delayed closed bar plus provider lag without relaxing quote freshness. */
export function terminalWatchlistCandleMaxAgeMs(interval: string): number {
  const intervalMs = interval === "1m"
    ? 60_000
    : interval === "5m"
      ? 300_000
      : interval === "15m"
        ? 900_000
        : interval === "1h"
          ? 3_600_000
          : 0;
  return intervalMs > 0 ? Math.max(300_000, intervalMs * 3) : TERMINAL_MARKET_WATCHLIST_MAX_AGE_MS;
}

export function mergeTerminalWatchlistSources(
  previous: TerminalWatchlistSource[],
  incoming: TerminalWatchlistSource[],
): TerminalWatchlistSource[] {
  const merged = newestSourcesByPair([...previous, ...incoming]);
  const next = [...merged.values()]
    .sort((left, right) => sourceTime(right) - sourceTime(left))
    .slice(0, 8);
  return sameSourceReferences(previous, next) ? previous : next;
}

/** Ignores aggregate receipts and components the passive scanner never reads. */
export function terminalWatchlistSourcesEqual(
  left: TerminalWatchlistSource[],
  right: TerminalWatchlistSource[],
): boolean {
  if (left === right) return true;
  const leftByPair = newestSourcesByPair(left);
  const rightByPair = newestSourcesByPair(right);
  if (leftByPair.size !== rightByPair.size) return false;
  for (const [key, leftSource] of leftByPair) {
    const rightSource = rightByPair.get(key);
    if (!rightSource || !watchlistSourceEqual(leftSource, rightSource)) return false;
  }
  return true;
}

function validatePreferences(value: unknown): TerminalWatchlistPreferences | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== TERMINAL_MARKET_WATCHLIST_VERSION || !Array.isArray(record.entries)) return null;
  if (record.entries.length !== TERMINAL_MARKET_WATCHLIST_INSTRUMENTS.length) return null;

  const entries: TerminalWatchlistEntry[] = [];
  for (const valueEntry of record.entries) {
    if (!valueEntry || typeof valueEntry !== "object" || Array.isArray(valueEntry)) return null;
    const row = valueEntry as Record<string, unknown>;
    const instrument = TERMINAL_MARKET_WATCHLIST_INSTRUMENTS.find((item) => item === row.instrument);
    const venue = ("hyperliquid" === row.venue || "phoenix" === row.venue || "coinbase" === row.venue)
      ? row.venue
      : null;
    if (!instrument || !venue || !VENUES_BY_INSTRUMENT[instrument].includes(venue)) return null;
    entries.push({ instrument, venue });
  }
  if (new Set(entries.map((entry) => entry.instrument)).size !== TERMINAL_MARKET_WATCHLIST_INSTRUMENTS.length) return null;
  if (!TERMINAL_MARKET_WATCHLIST_INSTRUMENTS.every((instrument) => entries.some((entry) => entry.instrument === instrument))) return null;
  const sortRecord = record.sort && typeof record.sort === "object" && !Array.isArray(record.sort)
    ? record.sort as Record<string, unknown>
    : null;
  const sortField = sortRecord?.field === "move" || sortRecord?.field === "spread" || sortRecord?.field === "volatility" || sortRecord?.field === "age"
    ? sortRecord.field
    : record.sort == null ? "move" : null;
  const sortDirection = sortRecord?.direction === "asc" || sortRecord?.direction === "desc"
    ? sortRecord.direction
    : record.sort == null ? "desc" : null;
  if (!sortField || !sortDirection) return null;
  return { version: TERMINAL_MARKET_WATCHLIST_VERSION, entries, sort: { field: sortField, direction: sortDirection } };
}

function watchlistSortValue(row: TerminalWatchlistRow, field: TerminalWatchlistSortField) {
  if (field === "move") return row.changePct == null ? null : Math.abs(row.changePct);
  if (field === "spread") return row.spreadBps;
  if (field === "volatility") return row.realizedVolatilityBps;
  return row.ageMs;
}

function newestSourcesByPair(sources: TerminalWatchlistSource[]) {
  const result = new Map<string, TerminalWatchlistSource>();
  for (const source of sources) {
    const instrument = normalizeInstrument(source.frame.product);
    if (!instrument || !isSupportedVenue(source.frame.venue) || !VENUES_BY_INSTRUMENT[instrument].includes(source.frame.venue)) continue;
    const key = sourceKey(source.frame.venue, instrument);
    const current = result.get(key);
    if (!current) {
      result.set(key, source);
    } else if (!watchlistSourceEqual(current, source) && sourceTime(source) >= sourceTime(current)) {
      result.set(key, source);
    }
  }
  return result;
}

function watchlistSourceEqual(left: TerminalWatchlistSource, right: TerminalWatchlistSource) {
  return left.status === right.status
    && left.stale === right.stale
    && left.provenance === right.provenance
    && left.healthGrade === right.healthGrade
    && (left.transport ?? null) === (right.transport ?? null)
    && left.frame.venue === right.frame.venue
    && (left.frame.network ?? null) === (right.frame.network ?? null)
    && left.frame.product === right.frame.product
    && left.frame.interval === right.frame.interval
    && left.frame.stale === right.frame.stale
    && left.frame.bestBid === right.frame.bestBid
    && left.frame.bestAsk === right.frame.bestAsk
    && componentSourceTime(left, "quote") === componentSourceTime(right, "quote")
    && componentSourceTime(left, "candles") === componentSourceTime(right, "candles")
    && recentCandlesEqual(left.frame.candles, right.frame.candles);
}

function componentSourceTime(
  source: TerminalWatchlistSource,
  component: "quote" | "candles",
) {
  const exact = source.frame.componentTimestamps?.[component];
  if (Number.isFinite(exact)) return Number(exact);
  const capturedAt = Number(source.telemetryCapturedAtMs);
  const age = finiteNonNegative(source.componentAgesMs?.[component]);
  return Number.isFinite(capturedAt) && age != null ? capturedAt - age : null;
}

function recentCandlesEqual(
  left: GholaMarketFrame["candles"],
  right: GholaMarketFrame["candles"],
) {
  const leftRecent = left.slice(-12);
  const rightRecent = right.slice(-12);
  return leftRecent.length === rightRecent.length && leftRecent.every((candle, index) => {
    const other = rightRecent[index];
    return candle.t === other.t
      && candle.T === other.T
      && candle.o === other.o
      && candle.h === other.h
      && candle.l === other.l
      && candle.c === other.c
      && candle.v === other.v
      && candle.n === other.n;
  });
}

function sameSourceReferences(
  left: TerminalWatchlistSource[],
  right: TerminalWatchlistSource[],
) {
  return left.length === right.length && left.every((source, index) => source === right[index]);
}

function emptyRow(
  entry: TerminalWatchlistEntry,
  availability: TerminalWatchlistRow["availability"],
): TerminalWatchlistRow {
  return {
    ...entry,
    availability,
    price: null,
    spreadBps: null,
    changePct: null,
    realizedVolatilityBps: null,
    moveRank: null,
    healthGrade: null,
    transport: null,
    ageMs: null,
    fetchedAt: null,
  };
}

function transportFromStatus(status: TerminalWatchlistSource["status"]) {
  if (status === "fallback_polling") return "polling" as const;
  if (status === "live") return "websocket" as const;
  return null;
}

function normalizeInstrument(value: string): TerminalWatchlistInstrument | null {
  const normalized = value.trim().toUpperCase().replace(/-(USD|PERP)$/u, "");
  return TERMINAL_MARKET_WATCHLIST_INSTRUMENTS.find((instrument) => instrument === normalized) ?? null;
}

function isSupportedVenue(value: GholaMarketFrame["venue"]): value is TerminalWatchlistVenue {
  return value === "hyperliquid" || value === "phoenix" || value === "coinbase";
}

function sourceKey(venue: TerminalWatchlistVenue, instrument: TerminalWatchlistInstrument) {
  return `${venue}:${instrument}`;
}

function sourceTime(source: TerminalWatchlistSource) {
  const timestamp = source.frame.fetchedAt ? Date.parse(source.frame.fetchedAt) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function boundedAge(value: number | undefined) {
  if (!Number.isFinite(value)) return TERMINAL_MARKET_WATCHLIST_MAX_AGE_MS;
  return Math.min(TERMINAL_MARKET_WATCHLIST_MAX_AGE_MS, Math.max(1_000, Number(value)));
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNonNegative(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function effectiveComponentAge(
  source: TerminalWatchlistSource,
  component: "quote" | "candles",
  nowMs: number,
) {
  const capturedAgeMs = finiteNonNegative(source.componentAgesMs?.[component]);
  const capturedAtMs = Number(source.telemetryCapturedAtMs);
  if (capturedAgeMs == null || !Number.isFinite(capturedAtMs)) return null;
  const elapsedMs = nowMs - capturedAtMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < -30_000) return null;
  return capturedAgeMs + Math.max(0, elapsedMs);
}

function finiteOrNull(value: number | null | undefined) {
  return value != null && Number.isFinite(value) ? value : null;
}
