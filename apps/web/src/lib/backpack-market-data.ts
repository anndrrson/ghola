import {
  BACKPACK_API_URL,
  BACKPACK_SOL_PERP_SYMBOL,
} from "./backpack-exchange";

export type BackpackMarketSymbol = typeof BACKPACK_SOL_PERP_SYMBOL;
export type BackpackCandleInterval = "1m" | "5m" | "15m" | "1h";

export interface BackpackCandle {
  t: number;
  T: number | null;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number | null;
}

export interface BackpackBookLevel {
  px: string;
  sz: string;
  n: number | null;
}

export interface BackpackRecentTrade {
  trade_id: string | null;
  side: "buy" | "sell";
  px: string;
  sz: string;
  time: number;
}

export interface BackpackMarketSnapshot {
  version: 1;
  platform: "backpack";
  network: "mainnet";
  symbol: BackpackMarketSymbol;
  interval: BackpackCandleInterval;
  fetched_at: string;
  source_timestamp: number | null;
  stale: boolean;
  mid: string | null;
  best_bid: string | null;
  best_ask: string | null;
  spread_bps: number | null;
  mark_price: string | null;
  index_price: string | null;
  last_price: string | null;
  prev_day_price: string | null;
  price_change_percent_24h: string | null;
  day_notional_volume: string | null;
  day_base_volume: string | null;
  open_interest: string | null;
  funding_rate: string | null;
  next_funding_timestamp: number | null;
  candles: BackpackCandle[];
  bids: BackpackBookLevel[];
  asks: BackpackBookLevel[];
  recent_trades: BackpackRecentTrade[];
}

export interface BackpackMarketSnapshotInput {
  symbol?: string | null;
  interval?: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
}

const SYMBOL_ALLOWLIST = new Set<BackpackMarketSymbol>([BACKPACK_SOL_PERP_SYMBOL]);
const INTERVAL_ALLOWLIST = new Set<BackpackCandleInterval>(["1m", "5m", "15m", "1h"]);
const INTERVAL_SECONDS: Record<BackpackCandleInterval, number> = {
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
};

export const BACKPACK_CANDLE_WINDOW = 240;
export const BACKPACK_BOOK_LEVEL_WINDOW = 20;
export const BACKPACK_RECENT_TRADE_WINDOW = 20;

const MARKET_CACHE_TTL_MS = 4_000;

type CacheRecord = {
  fetchedAtMs: number;
  snapshot: BackpackMarketSnapshot;
};

const snapshotCache = new Map<string, CacheRecord>();
const inflight = new Map<string, Promise<BackpackMarketSnapshot>>();

export function normalizeBackpackMarketInput(input: BackpackMarketSnapshotInput): {
  symbol: BackpackMarketSymbol;
  interval: BackpackCandleInterval;
} {
  const rawSymbol = String(input.symbol || BACKPACK_SOL_PERP_SYMBOL).trim().toUpperCase();
  const interval = String(input.interval || "1m").trim();
  return {
    symbol: SYMBOL_ALLOWLIST.has(rawSymbol as BackpackMarketSymbol)
      ? rawSymbol as BackpackMarketSymbol
      : BACKPACK_SOL_PERP_SYMBOL,
    interval: INTERVAL_ALLOWLIST.has(interval as BackpackCandleInterval)
      ? interval as BackpackCandleInterval
      : "1m",
  };
}

export async function getBackpackMarketSnapshot(
  input: BackpackMarketSnapshotInput = {},
): Promise<BackpackMarketSnapshot> {
  const normalized = normalizeBackpackMarketInput(input);
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const key = `${normalized.symbol}:${normalized.interval}`;
  const cached = snapshotCache.get(key);
  if (cached && nowMs - cached.fetchedAtMs <= MARKET_CACHE_TTL_MS) return cached.snapshot;
  const active = inflight.get(key);
  if (active) return active;

  const promise = fetchFreshBackpackMarketSnapshot({
    ...normalized,
    now,
    fetchImpl: input.fetchImpl ?? fetch,
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

export function resetBackpackMarketSnapshotCacheForTests() {
  snapshotCache.clear();
  inflight.clear();
}

export function emptyBackpackMarketSnapshot(input: {
  symbol: BackpackMarketSymbol;
  interval: BackpackCandleInterval;
  now?: Date;
  stale?: boolean;
}): BackpackMarketSnapshot {
  return {
    version: 1,
    platform: "backpack",
    network: "mainnet",
    symbol: input.symbol,
    interval: input.interval,
    fetched_at: (input.now ?? new Date()).toISOString(),
    source_timestamp: null,
    stale: input.stale ?? true,
    mid: null,
    best_bid: null,
    best_ask: null,
    spread_bps: null,
    mark_price: null,
    index_price: null,
    last_price: null,
    prev_day_price: null,
    price_change_percent_24h: null,
    day_notional_volume: null,
    day_base_volume: null,
    open_interest: null,
    funding_rate: null,
    next_funding_timestamp: null,
    candles: [],
    bids: [],
    asks: [],
    recent_trades: [],
  };
}

async function fetchFreshBackpackMarketSnapshot(input: {
  symbol: BackpackMarketSymbol;
  interval: BackpackCandleInterval;
  now: Date;
  fetchImpl: typeof fetch;
  previous: BackpackMarketSnapshot | null;
}): Promise<BackpackMarketSnapshot> {
  const end = Math.floor(input.now.getTime() / 1000);
  const start = end - INTERVAL_SECONDS[input.interval] * BACKPACK_CANDLE_WINDOW;
  try {
    const [depth, ticker, markPrices, openInterest, candles, trades] = await Promise.all([
      fetchBackpackJson(input.fetchImpl, `/api/v1/depth?symbol=${input.symbol}&limit=${BACKPACK_BOOK_LEVEL_WINDOW}`),
      fetchBackpackJson(input.fetchImpl, `/api/v1/ticker?symbol=${input.symbol}&interval=1d`).catch(() => null),
      fetchBackpackJson(input.fetchImpl, `/api/v1/markPrices?symbol=${input.symbol}&marketType=PERP`).catch(() => null),
      fetchBackpackJson(input.fetchImpl, `/api/v1/openInterest?symbol=${input.symbol}`).catch(() => null),
      fetchBackpackJson(
        input.fetchImpl,
        `/api/v1/klines?symbol=${input.symbol}&interval=${input.interval}&startTime=${start}&endTime=${end}`,
      ).catch(() => null),
      fetchBackpackJson(input.fetchImpl, `/api/v1/trades?symbol=${input.symbol}&limit=${BACKPACK_RECENT_TRADE_WINDOW}`).catch(() => null),
    ]);
    return buildBackpackSnapshot({
      symbol: input.symbol,
      interval: input.interval,
      fetchedAt: input.now,
      depth,
      ticker,
      markPrices,
      openInterest,
      candles,
      trades,
    });
  } catch {
    if (input.previous) return { ...input.previous, fetched_at: input.now.toISOString(), stale: true };
    return emptyBackpackMarketSnapshot({
      symbol: input.symbol,
      interval: input.interval,
      now: input.now,
      stale: true,
    });
  }
}

async function fetchBackpackJson(fetchImpl: typeof fetch, path: string) {
  const res = await fetchImpl(`${BACKPACK_API_URL}${path}`, {
    headers: { "cache-control": "no-cache" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`backpack_market_${res.status}`);
  return res.json();
}

function buildBackpackSnapshot(input: {
  symbol: BackpackMarketSymbol;
  interval: BackpackCandleInterval;
  fetchedAt: Date;
  depth: unknown;
  ticker: unknown;
  markPrices: unknown;
  openInterest: unknown;
  candles: unknown;
  trades: unknown;
}): BackpackMarketSnapshot {
  const depth = readRecord(input.depth);
  const ticker = readRecord(input.ticker);
  const mark = matchingRecord(input.markPrices, input.symbol);
  const oi = matchingRecord(input.openInterest, input.symbol);
  const bids = normalizeBackpackBookSide(depth?.bids);
  const asks = normalizeBackpackBookSide(depth?.asks);
  const bestBid = bids[0]?.px ?? null;
  const bestAsk = asks[0]?.px ?? null;
  const mid = midFromBook(bestBid, bestAsk) ?? safeDecimalString(mark?.markPrice) ?? safeDecimalString(ticker?.lastPrice);
  return {
    version: 1,
    platform: "backpack",
    network: "mainnet",
    symbol: input.symbol,
    interval: input.interval,
    fetched_at: input.fetchedAt.toISOString(),
    source_timestamp: timeValue(depth?.timestamp) ?? input.fetchedAt.getTime(),
    stale: false,
    mid,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps(bestBid, bestAsk),
    mark_price: safeDecimalString(mark?.markPrice),
    index_price: safeDecimalString(mark?.indexPrice),
    last_price: safeDecimalString(ticker?.lastPrice),
    prev_day_price: safeDecimalString(ticker?.firstPrice),
    price_change_percent_24h: safeSignedDecimalString(ticker?.priceChangePercent),
    day_notional_volume: safeDecimalString(ticker?.quoteVolume),
    day_base_volume: safeDecimalString(ticker?.volume),
    open_interest: safeDecimalString(oi?.openInterest),
    funding_rate: safeSignedDecimalString(mark?.fundingRate),
    next_funding_timestamp: numberValue(mark?.nextFundingTimestamp),
    candles: normalizeBackpackCandles(input.candles),
    bids,
    asks,
    recent_trades: normalizeBackpackTrades(input.trades),
  };
}

export function normalizeBackpackBookSide(value: unknown): BackpackBookLevel[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, BACKPACK_BOOK_LEVEL_WINDOW)
    .map((item) => {
      if (!Array.isArray(item)) return null;
      const px = safeDecimalString(item[0]);
      const sz = safeDecimalString(item[1]);
      return px && sz ? { px, sz, n: null } : null;
    })
    .filter(Boolean) as BackpackBookLevel[];
}

export function normalizeBackpackCandles(value: unknown): BackpackCandle[] {
  if (!Array.isArray(value)) return [];
  const candles = value
    .map((item) => {
      const row = readRecord(item);
      if (!row) return null;
      const t = timeValue(row.start ?? row.t);
      const end = timeValue(row.end ?? row.T);
      const o = safeDecimalString(row.open ?? row.o);
      const h = safeDecimalString(row.high ?? row.h);
      const l = safeDecimalString(row.low ?? row.l);
      const c = safeDecimalString(row.close ?? row.c);
      const v = safeDecimalString(row.volume ?? row.v) ?? "0";
      const n = numberValue(row.trades ?? row.n);
      return t && o && h && l && c ? { t, T: end, o, h, l, c, v, n } : null;
    })
    .filter(Boolean) as BackpackCandle[];
  return candles.sort((a, b) => a.t - b.t).slice(-BACKPACK_CANDLE_WINDOW);
}

export function normalizeBackpackTrades(value: unknown): BackpackRecentTrade[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, BACKPACK_RECENT_TRADE_WINDOW)
    .map((item) => {
      const row = readRecord(item);
      if (!row) return null;
      const px = safeDecimalString(row.price);
      const sz = safeDecimalString(row.quantity);
      const time = timeValue(row.timestamp);
      const side = row.isBuyerMaker === true ? "sell" : "buy";
      const tradeId = row.id === undefined || row.id === null ? null : String(row.id);
      return px && sz && time ? { trade_id: tradeId, side, px, sz, time } : null;
    })
    .filter(Boolean) as BackpackRecentTrade[];
}

function matchingRecord(value: unknown, symbol: string): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return value
      .map(readRecord)
      .find((item) => item?.symbol === symbol) ?? null;
  }
  const record = readRecord(value);
  return record?.symbol === symbol ? record : record;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeDecimalString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return trimNumber(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

function safeSignedDecimalString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return trimNumber(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/%$/, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
  return null;
}

function timeValue(value: unknown): number | null {
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

function spreadBps(bestBid: string | null, bestAsk: string | null): number | null {
  if (!bestBid || !bestAsk) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return Math.max(0, Math.round(((ask - bid) / mid) * 10_000 * 100) / 100);
}

function midFromBook(bestBid: string | null, bestAsk: string | null): string | null {
  if (!bestBid || !bestAsk) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  return trimNumber((bid + ask) / 2);
}

function trimNumber(value: number): string {
  return Number(value).toString();
}
