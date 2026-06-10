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

export interface PhoenixMarketSnapshot {
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
  funding_rate: string | null;
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
    const [candles, book, market, fills, statsHistory, fundingHistory, volumeCandles] = await Promise.all([
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
    ]);
    return buildSnapshot({
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
  } catch {
    if (input.previous) {
      return { ...input.previous, fetched_at: input.now.toISOString(), stale: true };
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
  const bids = normalizeBookTuples(readRecord(input.book)?.bids).slice(0, PHOENIX_BOOK_LEVEL_WINDOW);
  const asks = normalizeBookTuples(readRecord(input.book)?.asks).slice(0, PHOENIX_BOOK_LEVEL_WINDOW);
  const bestBid = bids[0]?.px ?? null;
  const bestAsk = asks[0]?.px ?? null;
  const bookMid = safeDecimalString(readRecord(input.book)?.mid);
  const stats = normalizeMarketStats(input.market, input.statsHistory);
  const fundingRate = normalizeFundingRate(input.fundingHistory) ?? stats.funding_rate;
  const dayNotionalVolume =
    stats.day_notional_volume ??
    sumCandleQuoteVolume(input.volumeCandles) ??
    sumCandleQuoteVolume(input.candles);
  const candles = normalizeApiCandles(input.candles);
  const recentTrades = normalizeMarketFills(input.fills);
  const hasBook = bids.length > 0 || asks.length > 0;
  const hasMarket =
    Boolean(stats.mark_price || stats.oracle_price || stats.open_interest || fundingRate || dayNotionalVolume);
  return {
    version: 1,
    platform: "phoenix",
    network: "mainnet",
    symbol: input.symbol,
    interval: input.interval,
    fetched_at: fetchedAt,
    source: input.source,
    source_timestamp: input.fetchedAt.getTime(),
    book_updated_at: hasBook ? fetchedAt : null,
    market_updated_at: hasMarket ? fetchedAt : null,
    candles_updated_at: candles.length > 0 ? fetchedAt : null,
    trades_updated_at: recentTrades.length > 0 ? fetchedAt : null,
    slot: numberValue(readRecord(input.book)?.slot),
    stale: false,
    mid: bookMid ?? midFromBook(bestBid, bestAsk) ?? stats.mark_price,
    mark_price: stats.mark_price,
    oracle_price: stats.oracle_price,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps(bestBid, bestAsk),
    prev_day_price: stats.prev_day_price,
    day_notional_volume: dayNotionalVolume,
    funding_rate: fundingRate,
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
        const px = safeDecimalString(level[0]);
        const sz = safeDecimalString(level[1]);
        return px && sz ? { px, sz } : null;
      }
      const row = readRecord(level);
      if (!row) return null;
      const px = safeDecimalString(row.px ?? row.price);
      const sz = safeDecimalString(row.sz ?? row.size);
      return px && sz ? { px, sz } : null;
    })
    .filter(Boolean) as PhoenixBookLevel[];
}

export function normalizeApiCandles(value: unknown): PhoenixCandle[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-PHOENIX_CANDLE_WINDOW)
    .map((item) => {
      const row = readRecord(item);
      if (!row) return null;
      const t = numberValue(row.time ?? row.t);
      const o = safeDecimalString(row.open ?? row.o);
      const h = safeDecimalString(row.high ?? row.h);
      const l = safeDecimalString(row.low ?? row.l);
      const c = safeDecimalString(row.close ?? row.c);
      const v = safeDecimalString(row.volume ?? row.v) ?? "0";
      const n = numberValue(row.tradeCount ?? row.n);
      return t && o && h && l && c ? { t, T: null, o, h, l, c, v, n } : null;
    })
    .filter(Boolean) as PhoenixCandle[];
}

export function normalizeMarketFills(value: unknown): PhoenixRecentTrade[] {
  const rows = Array.isArray(value) ? value : readRecord(value)?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .slice(0, PHOENIX_RECENT_TRADE_WINDOW)
    .map((item) => {
      const row = readRecord(item);
      if (!row) return null;
      const px = safeDecimalString(row.price ?? row.px);
      const time = numberValue(row.timestamp ?? row.time);
      // Phoenix fills carry a SIGNED base quantity (negative = sell); size must be
      // its magnitude and the sign drives the side.
      const rawBase = row.baseQty ?? row.sz ?? row.size ?? row.baseAmount;
      const baseNum = typeof rawBase === "number" ? rawBase : Number(String(rawBase ?? ""));
      const sz = Number.isFinite(baseNum) ? safeDecimalString(Math.abs(baseNum)) : null;
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
  funding_rate: string | null;
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
      funding_rate: null,
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
    funding_rate: safeSignedDecimalString(row.funding ?? row.currentFundingRatePercentage ?? row.currentFundingRate),
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

function normalizeFundingRate(value: unknown): string | null {
  const latest = latestHistoryRow(readRecord(value)?.rates ?? readRecord(value)?.points ?? value);
  return safeSignedDecimalString(latest?.fundingRatePercentage ?? latest?.fundingRate ?? latest?.rate);
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
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      const parsed = Number(value);
      return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function midFromBook(bestBid: string | null, bestAsk: string | null): string | null {
  if (!bestBid || !bestAsk) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return String((bid + ask) / 2);
}

export function spreadBps(bestBid: string | null, bestAsk: string | null): number | null {
  if (!bestBid || !bestAsk) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return Math.max(0, Math.round(((ask - bid) / mid) * 10_000 * 100) / 100);
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

function trimNumber(value: number): string {
  // Avoid scientific notation and trailing zeros for clean price labels.
  return Number(value).toString();
}
