// Phoenix (perp-api.phoenix.trade) live SOL market data.
//
// Mirrors the shape and conventions of `hyperliquid-market-data.ts` so the chart,
// helpers, and panel feel identical to the Hyperliquid path. This module owns the
// immutable `PhoenixMarketSnapshot` contract plus a one-shot REST fetch used as the
// server-side fallback (`getPhoenixMarketSnapshot`). The live WebSocket fusion lives
// in `phoenix-live-market.ts`.
//
// Honest latency note: Solana settles in ~400ms slots. Real price discovery cannot
// be faster than slot/WS cadence; the "hyper speed" feel is a rendering illusion
// produced by interpolation in `PhoenixLiveChart`, not by sub-slot data here.

import { createPhoenixClient } from "@ellipsis-labs/rise";
import {
  CANONICAL_FUNDING_RATE_UNIT,
  type MarketFundingRateFields,
} from "./market-funding-rate";

export type PhoenixMarketSymbol = "SOL";
export type PhoenixCandleInterval = "1m" | "5m" | "15m" | "1h";
export type PhoenixMarketSource = "http" | "websocket" | "rpc" | null;

export interface PhoenixCandle {
  t: number;
  T: number | null;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number | null;
}

export interface PhoenixBookLevel {
  px: string;
  sz: string;
}

export interface PhoenixRecentTrade {
  side: "buy" | "sell";
  px: string;
  sz: string;
  time: number;
  slot: number | null;
}

export interface PhoenixMarketSnapshot extends MarketFundingRateFields {
  version: 1;
  platform: "phoenix";
  network: "mainnet";
  symbol: PhoenixMarketSymbol;
  interval: PhoenixCandleInterval;
  fetched_at: string;
  source: PhoenixMarketSource;
  source_timestamp: number | null;
  book_updated_at: string | null;
  market_updated_at: string | null;
  candles_updated_at: string | null;
  trades_updated_at: string | null;
  slot: number | null;
  stale: boolean;
  mid: string | null;
  mark_price: string | null;
  oracle_price: string | null;
  best_bid: string | null;
  best_ask: string | null;
  spread_bps: number | null;
  prev_day_price: string | null;
  day_notional_volume: string | null;
  open_interest: string | null;
  candles: PhoenixCandle[];
  bids: PhoenixBookLevel[];
  asks: PhoenixBookLevel[];
  recent_trades: PhoenixRecentTrade[];
}

export interface PhoenixMarketSnapshotInput {
  symbol?: string | null;
  interval?: string | null;
  apiUrl?: string | null;
  rpcUrl?: string | null;
  now?: Date;
  createClient?: typeof createPhoenixClient;
}

export const DEFAULT_PHOENIX_API_URL = "https://perp-api.phoenix.trade";

const MARKET_ALLOWLIST = new Set<PhoenixMarketSymbol>(["SOL"]);
const INTERVAL_ALLOWLIST = new Set<PhoenixCandleInterval>(["1m", "5m", "15m", "1h"]);
const INTERVAL_MS: Record<PhoenixCandleInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
};

export const PHOENIX_CANDLE_WINDOW = 240;
export const PHOENIX_BOOK_LEVEL_WINDOW = 20;
export const PHOENIX_RECENT_TRADE_WINDOW = 20;
const MARKET_CACHE_TTL_MS = 4_000;
const MARKET_FETCH_TIMEOUT_MS = 8_000;
const MAX_FUTURE_SKEW_MS = 30_000;

type CacheRecord = { fetchedAtMs: number; snapshot: PhoenixMarketSnapshot };

const snapshotCache = new Map<string, CacheRecord>();
const inflight = new Map<string, Promise<PhoenixMarketSnapshot>>();

export function phoenixApiUrl(override?: string | null): string {
  const value = (override || process.env.NEXT_PUBLIC_PHOENIX_API_URL || DEFAULT_PHOENIX_API_URL).trim();
  return value || DEFAULT_PHOENIX_API_URL;
}

export function phoenixRpcUrl(override?: string | null): string | undefined {
  const value = (override || process.env.NEXT_PUBLIC_PHOENIX_RPC_WS || "").trim();
  return value || undefined;
}

export function normalizePhoenixMarketInput(input: PhoenixMarketSnapshotInput): {
  symbol: PhoenixMarketSymbol;
  interval: PhoenixCandleInterval;
} {
  const symbol = String(input.symbol || "SOL").trim().toUpperCase();
  const interval = String(input.interval || "1m").trim();
  return {
    symbol: MARKET_ALLOWLIST.has(symbol as PhoenixMarketSymbol) ? (symbol as PhoenixMarketSymbol) : "SOL",
    interval: INTERVAL_ALLOWLIST.has(interval as PhoenixCandleInterval)
      ? (interval as PhoenixCandleInterval)
      : "1m",
  };
}

export function emptyPhoenixMarketSnapshot(input: {
  symbol: PhoenixMarketSymbol;
  interval: PhoenixCandleInterval;
  now?: Date;
  stale?: boolean;
}): PhoenixMarketSnapshot {
  return {
    version: 1,
    platform: "phoenix",
    network: "mainnet",
    symbol: input.symbol,
    interval: input.interval,
    fetched_at: (input.now ?? new Date()).toISOString(),
    source: null,
    source_timestamp: null,
    book_updated_at: null,
    market_updated_at: null,
    candles_updated_at: null,
    trades_updated_at: null,
    slot: null,
    stale: input.stale ?? true,
    mid: null,
    mark_price: null,
    oracle_price: null,
    best_bid: null,
    best_ask: null,
    spread_bps: null,
    prev_day_price: null,
    day_notional_volume: null,
    funding_rate: null,
    funding_rate_unit: null,
    funding_rate_source: null,
    funding_time_basis: null,
    funding_updated_at: null,
    open_interest: null,
    candles: [],
    bids: [],
    asks: [],
    recent_trades: [],
  };
}

// One-shot HTTP snapshot used by the SSE-free REST fallback route. Uses the Rise
// HTTP client directly (no `exchange.ready()` / no WS) so it stays fast and cheap.
export async function getPhoenixMarketSnapshot(
  input: PhoenixMarketSnapshotInput = {},
): Promise<PhoenixMarketSnapshot> {
  const normalized = normalizePhoenixMarketInput(input);
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const key = `${normalized.symbol}:${normalized.interval}`;
  const cached = snapshotCache.get(key);
  if (cached && nowMs - cached.fetchedAtMs <= MARKET_CACHE_TTL_MS) return cached.snapshot;
  const active = inflight.get(key);
  if (active) return active;

  const promise = fetchFreshPhoenixMarketSnapshot({
    ...normalized,
    now,
    apiUrl: phoenixApiUrl(input.apiUrl),
    rpcUrl: phoenixRpcUrl(input.rpcUrl),
    createClient: input.createClient ?? createPhoenixClient,
    previous: cached?.snapshot ?? null,
  })
    .then((snapshot) => {
      snapshotCache.set(key, { fetchedAtMs: nowMs, snapshot });
      return snapshot;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

export function resetPhoenixMarketSnapshotCacheForTests() {
  snapshotCache.clear();
  inflight.clear();
}

async function fetchFreshPhoenixMarketSnapshot(input: {
  symbol: PhoenixMarketSymbol;
  interval: PhoenixCandleInterval;
  now: Date;
  apiUrl: string;
  rpcUrl: string | undefined;
  createClient: typeof createPhoenixClient;
  previous: PhoenixMarketSnapshot | null;
}): Promise<PhoenixMarketSnapshot> {
  const endTime = input.now.getTime();
  const startTime = endTime - INTERVAL_MS[input.interval] * PHOENIX_CANDLE_WINDOW;
  const client = input.createClient({
    apiUrl: input.apiUrl,
    rpcUrl: input.rpcUrl,
    ws: false,
    exchangeMetadata: { stream: false },
  });
  try {
    const api = client.api;
    const candleApi = api.candles();
    const candlesPromise = candleApi
      .getCandles(input.symbol, {
        timeframe: input.interval,
        startTime,
        endTime,
        limit: PHOENIX_CANDLE_WINDOW,
      })
      .then(async (candles) => {
        if (normalizeApiCandles(candles).length > 0) return candles;
        return await candleApi.getCandles(input.symbol, {
          timeframe: input.interval,
          limit: PHOENIX_CANDLE_WINDOW,
        });
      })
      .catch(() =>
        candleApi.getCandles(input.symbol, {
          timeframe: input.interval,
          limit: PHOENIX_CANDLE_WINDOW,
        }).catch(() => null),
      );
    const oneDayMs = 24 * 60 * 60_000;
    const [candles, book, market, fills, statsHistory, fundingHistory, volumeCandles] = await withTimeout(Promise.all([
      candlesPromise,
      api.orderbook().getOrderbook(input.symbol).catch(() => null),
      api.markets().getMarket(input.symbol).catch(() => null),
      api.trades().getMarketFills(input.symbol, { limit: PHOENIX_RECENT_TRADE_WINDOW }).catch(() => null),
      api.markets().getMarketStatsHistory(input.symbol, {
        timeframe: "1m",
        limit: 5,
      }).catch(() => null),
      api.funding().getFundingRateHistory(input.symbol, {
        startTime: endTime - oneDayMs,
        endTime,
        limit: 48,
      }).catch(() => null),
      candleApi.getCandles(input.symbol, {
        timeframe: "1h",
        limit: 24,
      }).catch(() => null),
    ]), MARKET_FETCH_TIMEOUT_MS);
    const snapshot = buildSnapshot({
      symbol: input.symbol,
      interval: input.interval,
      fetchedAt: input.now,
      source: "http",
      candles,
      book,
      market,
      fills,
      statsHistory,
      fundingHistory,
      volumeCandles,
    });
    return snapshot.stale && input.previous
      ? { ...input.previous, stale: true }
      : snapshot;
  } catch {
    if (input.previous) {
      return { ...input.previous, stale: true };
    }
    return emptyPhoenixMarketSnapshot({ symbol: input.symbol, interval: input.interval, now: input.now, stale: true });
  } finally {
    client.dispose?.();
  }
}

function buildSnapshot(input: {
  symbol: PhoenixMarketSymbol;
  interval: PhoenixCandleInterval;
  fetchedAt: Date;
  source: PhoenixMarketSource;
  candles: unknown;
  book: unknown;
  market: unknown;
  fills: unknown;
  statsHistory?: unknown;
  fundingHistory?: unknown;
  volumeCandles?: unknown;
}): PhoenixMarketSnapshot {
  const fetchedAt = input.fetchedAt.toISOString();
  const bookRecord = readRecord(input.book);
  const bids = sortBookSide(normalizeBookTuples(bookRecord?.bids), "bid").slice(0, PHOENIX_BOOK_LEVEL_WINDOW);
  const asks = sortBookSide(normalizeBookTuples(bookRecord?.asks), "ask").slice(0, PHOENIX_BOOK_LEVEL_WINDOW);
  const bestBid = bids[0]?.px ?? null;
  const bestAsk = asks[0]?.px ?? null;
  const bookMid = positiveDecimalString(bookRecord?.mid);
  const stats = normalizeMarketStats(input.market, input.statsHistory);
  const funding = normalizeFundingRate(input.fundingHistory, input.fetchedAt.getTime());
  const dayNotionalVolume =
    stats.day_notional_volume ??
    sumCandleQuoteVolume(input.volumeCandles) ??
    sumCandleQuoteVolume(input.candles);
  const candles = normalizeApiCandles(input.candles)
    .filter((candle) => candle.t <= input.fetchedAt.getTime() + MAX_FUTURE_SKEW_MS);
  const recentTrades = normalizeMarketFills(input.fills);
  const validBook = isValidBook(bids, asks);
  const mid = bookMid ?? midFromBook(bestBid, bestAsk) ?? stats.mark_price;
  const bookTimestamp = recordTimestamp(bookRecord);
  const marketTimestamp = maxTimestamp(
    recordTimestamp(readRecord(input.market)),
    latestHistoryTimestamp(readRecord(input.statsHistory)?.stats),
  );
  const candleTimestamp = candles.at(-1)?.t ?? null;
  const tradesTimestamp = latestTradeTimestamp(recentTrades);
  const sourceTimestamp = maxTimestamp(bookTimestamp, marketTimestamp, candleTimestamp, tradesTimestamp);
  const hasBook = bids.length > 0 || asks.length > 0;
  const hasMarket =
    Boolean(stats.mark_price || stats.oracle_price || stats.open_interest || funding?.rate || dayNotionalVolume);
  const hasData = hasBook || hasMarket || candles.length > 0 || recentTrades.length > 0;
  const stale = !mid
    || !validBook
    || !isFreshTimestamp(
      sourceTimestamp,
      input.fetchedAt.getTime(),
      Math.max(5 * 60_000, INTERVAL_MS[input.interval] * 3),
    )
    || !hasFreshCandles(candles, input.fetchedAt.getTime(), input.interval);
  return {
    version: 1,
    platform: "phoenix",
    network: "mainnet",
    symbol: input.symbol,
    interval: input.interval,
    fetched_at: fetchedAt,
    source: hasData ? input.source : null,
    source_timestamp: sourceTimestamp,
    book_updated_at: hasBook ? isoTimestamp(bookTimestamp) : null,
    market_updated_at: hasMarket ? isoTimestamp(marketTimestamp) : null,
    candles_updated_at: candles.length > 0 ? isoTimestamp(candleTimestamp) : null,
    trades_updated_at: recentTrades.length > 0 ? isoTimestamp(tradesTimestamp) : null,
    slot: numberValue(bookRecord?.slot),
    stale,
    mid,
    mark_price: stats.mark_price,
    oracle_price: stats.oracle_price,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps(bestBid, bestAsk),
    prev_day_price: stats.prev_day_price,
    day_notional_volume: dayNotionalVolume,
    funding_rate: funding?.rate ?? null,
    funding_rate_unit: funding ? CANONICAL_FUNDING_RATE_UNIT : null,
    funding_rate_source: funding ? "phoenix_rest_funding_history" : null,
    funding_time_basis: funding ? "venue_event_time" : null,
    funding_updated_at: funding?.updatedAt ?? null,
    open_interest: stats.open_interest,
    candles,
    bids,
    asks,
    recent_trades: recentTrades,
  };
}

// ---- normalizers (defensive: the REST shapes are best-effort) ----

export function normalizeBookTuples(value: unknown): PhoenixBookLevel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((level) => {
      if (Array.isArray(level)) {
        const px = positiveDecimalString(level[0]);
        const sz = positiveDecimalString(level[1]);
        return px && sz ? { px, sz } : null;
      }
      const row = readRecord(level);
      if (!row) return null;
      const px = positiveDecimalString(row.px ?? row.price);
      const sz = positiveDecimalString(row.sz ?? row.size);
      return px && sz ? { px, sz } : null;
    })
    .filter(Boolean) as PhoenixBookLevel[];
}

export function normalizeApiCandles(value: unknown): PhoenixCandle[] {
  if (!Array.isArray(value)) return [];
  const candles = value
    .map((item) => {
      const row = readRecord(item);
      if (!row) return null;
      const t = timeValue(row.time ?? row.t);
      const o = positiveDecimalString(row.open ?? row.o);
      const h = positiveDecimalString(row.high ?? row.h);
      const l = positiveDecimalString(row.low ?? row.l);
      const c = positiveDecimalString(row.close ?? row.c);
      const v = safeDecimalString(row.volume ?? row.v) ?? "0";
      const n = numberValue(row.tradeCount ?? row.n);
      if (!t || !o || !h || !l || !c || !validOhlc(o, h, l, c)) return null;
      return { t, T: null, o, h, l, c, v, n };
    })
    .filter(Boolean) as PhoenixCandle[];
  return dedupeCandles(candles).slice(-PHOENIX_CANDLE_WINDOW);
}

export function normalizeMarketFills(value: unknown): PhoenixRecentTrade[] {
  const rows = Array.isArray(value) ? value : readRecord(value)?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .slice(0, PHOENIX_RECENT_TRADE_WINDOW)
    .map((item) => {
      const row = readRecord(item);
      if (!row) return null;
      const px = positiveDecimalString(row.price ?? row.px);
      const time = timeValue(row.timestamp ?? row.time);
      // Phoenix fills carry a SIGNED base quantity (negative = sell); size must be
      // its magnitude and the sign drives the side.
      const rawBase = row.baseQty ?? row.sz ?? row.size ?? row.baseAmount;
      const baseNum = typeof rawBase === "number" ? rawBase : Number(String(rawBase ?? ""));
      const sz = Number.isFinite(baseNum) ? positiveDecimalString(Math.abs(baseNum)) : null;
      if (!px || !sz || !time) return null;
      return { side: inferFillSide(row, baseNum), px, sz, time, slot: numberValue(row.slot) };
    })
    .filter(Boolean) as PhoenixRecentTrade[];
}

function inferFillSide(row: Record<string, unknown>, baseNum: number): "buy" | "sell" {
  if (Number.isFinite(baseNum) && baseNum !== 0) return baseNum < 0 ? "sell" : "buy";
  const raw = String(row.side ?? row.instructionType ?? "").toLowerCase();
  if (/sell|ask|short/.test(raw)) return "sell";
  return "buy";
}

function normalizeMarketStats(value: unknown, statsHistory?: unknown): {
  mark_price: string | null;
  oracle_price: string | null;
  prev_day_price: string | null;
  day_notional_volume: string | null;
  open_interest: string | null;
} {
  const row = readRecord(value);
  const latestStats = latestHistoryRow(readRecord(statsHistory)?.stats);
  if (!row) {
    return {
      mark_price: safeDecimalString(latestStats?.mark_price ?? latestStats?.markPrice),
      oracle_price: safeDecimalString(latestStats?.spot_price ?? latestStats?.spotPrice),
      prev_day_price: null,
      day_notional_volume: null,
      open_interest: safeDecimalString(latestStats?.open_interest ?? latestStats?.openInterest),
    };
  }
  const markPrice = readRecord(row.markPrice);
  const spotPrice = readRecord(row.spotPrice);
  return {
    mark_price: safeDecimalString(row.markPx ?? markPrice?.price ?? row.markPrice ?? latestStats?.mark_price),
    oracle_price: safeDecimalString(row.oraclePx ?? spotPrice?.price ?? row.oraclePrice ?? latestStats?.spot_price),
    prev_day_price: safeDecimalString(row.prevDayPx ?? row.prevDayMarkPrice),
    day_notional_volume: safeDecimalString(row.dayNtlVlm ?? row.dayVolumeUsd),
    open_interest: safeDecimalString(readRecord(row.openInterest)?.amount ?? row.openInterest ?? latestStats?.open_interest),
  };
}

function latestHistoryRow(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  let latest: Record<string, unknown> | null = null;
  let latestTime = -Infinity;
  for (const item of value) {
    const row = readRecord(item);
    if (!row) continue;
    const time = timeValue(row.timestamp ?? row.time ?? row.t);
    if (time == null) continue;
    if (time >= latestTime) {
      latest = row;
      latestTime = time;
    }
  }
  return latest;
}

function normalizeFundingRate(
  value: unknown,
  nowMs: number,
): { rate: string; updatedAt: string } | null {
  const rows = readRecord(value)?.rates ?? readRecord(value)?.points ?? value;
  if (!Array.isArray(rows)) return null;
  let latest: { rate: string; timestamp: number } | null = null;
  for (const item of rows) {
    const row = readRecord(item);
    if (!row || !("fundingRatePercentage" in row)) continue;
    const timestamp = timeValue(row.timestamp ?? row.time ?? row.t);
    const rate = percentagePointsToFraction(row.fundingRatePercentage);
    if (
      timestamp == null ||
      timestamp <= 0 ||
      timestamp > nowMs + MAX_FUTURE_SKEW_MS ||
      rate == null
    ) continue;
    if (!latest || timestamp >= latest.timestamp) latest = { rate, timestamp };
  }
  return latest
    ? { rate: latest.rate, updatedAt: new Date(latest.timestamp).toISOString() }
    : null;
}

function percentagePointsToFraction(value: unknown): string | null {
  const normalized = safeSignedDecimalString(value);
  if (normalized == null) return null;
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fractional = ""] = unsigned.split(".");
  const digits = `${whole}${fractional}`;
  const decimalIndex = whole.length - 2;
  const scaled = decimalIndex > 0
    ? `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`
    : `0.${"0".repeat(Math.abs(decimalIndex))}${digits}`;
  const trimmed = scaled
    .replace(/(\.\d*?[1-9])0+$/u, "$1")
    .replace(/\.0+$/u, "")
    .replace(/^0+(?=\d)/u, "");
  const canonical = trimmed === "" || /^0(?:\.0*)?$/u.test(trimmed) ? "0" : trimmed;
  return negative && canonical !== "0" ? `-${canonical}` : canonical;
}

function sumCandleQuoteVolume(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  let total = 0;
  for (const item of value) {
    const row = readRecord(item);
    if (!row) continue;
    const raw = row.volumeQuote ?? row.quoteVolume ?? row.volumeUsd ?? row.notionalVolume;
    const next = typeof raw === "number" ? raw : Number(String(raw ?? ""));
    if (Number.isFinite(next) && next >= 0) total += next;
  }
  return total > 0 ? trimNumber(total) : null;
}

function timeValue(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function midFromBook(bestBid: string | null, bestAsk: string | null): string | null {
  if (!bestBid || !bestAsk) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || bid >= ask) return null;
  return String((bid + ask) / 2);
}

export function spreadBps(bestBid: string | null, bestAsk: string | null): number | null {
  if (!bestBid || !bestAsk) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid >= ask) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return Math.round(((ask - bid) / mid) * 10_000 * 100) / 100;
}

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function safeDecimalString(value: unknown): string | null {
  if (typeof value === "bigint") return value >= BigInt(0) ? value.toString() : null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return trimNumber(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

export function safeSignedDecimalString(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return trimNumber(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

export function numberValue(value: unknown): number | null {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("phoenix_market_timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function positiveDecimalString(value: unknown): string | null {
  const normalized = safeDecimalString(value);
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? normalized : null;
}

function validOhlc(open: string, high: string, low: string, close: string): boolean {
  const [o, h, l, c] = [open, high, low, close].map(Number);
  return [o, h, l, c].every((value) => Number.isFinite(value) && value > 0)
    && h >= Math.max(o, l, c)
    && l <= Math.min(o, h, c);
}

function dedupeCandles(candles: PhoenixCandle[]): PhoenixCandle[] {
  const byTimestamp = new Map<number, PhoenixCandle>();
  for (const candle of candles.sort((a, b) => a.t - b.t)) byTimestamp.set(candle.t, candle);
  return [...byTimestamp.values()];
}

function sortBookSide(levels: PhoenixBookLevel[], side: "bid" | "ask"): PhoenixBookLevel[] {
  return levels.sort((a, b) => side === "bid" ? Number(b.px) - Number(a.px) : Number(a.px) - Number(b.px));
}

function isValidBook(bids: PhoenixBookLevel[], asks: PhoenixBookLevel[]): boolean {
  if (!bids.length || !asks.length) return false;
  return Number(bids[0].px) < Number(asks[0].px);
}

function recordTimestamp(record: Record<string, unknown> | null): number | null {
  if (!record) return null;
  return timeValue(
    record.timestamp
      ?? record.time
      ?? record.updatedAt
      ?? record.updated_at
      ?? record.lastUpdatedAt,
  );
}

function latestHistoryTimestamp(value: unknown): number | null {
  const row = latestHistoryRow(value);
  return timeValue(row?.timestamp ?? row?.time ?? row?.t);
}

function latestTradeTimestamp(trades: PhoenixRecentTrade[]): number | null {
  return trades.reduce<number | null>((latest, trade) => latest == null || trade.time > latest ? trade.time : latest, null);
}

function maxTimestamp(...timestamps: Array<number | null | undefined>): number | null {
  const valid = timestamps.filter((timestamp): timestamp is number => (
    typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
  ));
  return valid.length > 0 ? Math.max(...valid) : null;
}

function isoTimestamp(timestamp: number | null): string | null {
  return timestamp == null || !Number.isFinite(timestamp) ? null : new Date(timestamp).toISOString();
}

function isFreshTimestamp(timestamp: number | null, nowMs: number, maxAgeMs: number): boolean {
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) return false;
  const age = nowMs - timestamp;
  return age >= -MAX_FUTURE_SKEW_MS && age <= maxAgeMs;
}

function hasFreshCandles(
  candles: PhoenixCandle[],
  nowMs: number,
  interval: PhoenixCandleInterval,
): boolean {
  const latest = candles.at(-1)?.t ?? null;
  return isFreshTimestamp(latest, nowMs, Math.max(5 * 60_000, INTERVAL_MS[interval] * 3));
}

function trimNumber(value: number): string {
  // Avoid scientific notation and trailing zeros for clean price labels.
  return Number(value).toString();
}
