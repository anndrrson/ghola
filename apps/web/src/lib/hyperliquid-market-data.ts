import {
  CANONICAL_FUNDING_RATE_UNIT,
  type MarketFundingRateFields,
} from "./market-funding-rate";

export type HyperliquidNetwork = "mainnet" | "testnet";
export type HyperliquidMarketCoin = "BTC" | "ETH" | "SOL" | "HYPE";
export type HyperliquidCandleInterval = "1m" | "5m" | "15m" | "1h";

export interface HyperliquidCandle {
  t: number;
  T: number | null;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number | null;
}

export interface HyperliquidBookLevel {
  px: string;
  sz: string;
  n: number | null;
}

export interface HyperliquidRecentTrade {
  side: "buy" | "sell";
  px: string;
  sz: string;
  time: number;
}

export interface HyperliquidMarketSnapshot extends MarketFundingRateFields {
  version: 1;
  platform: "hyperliquid";
  network: HyperliquidNetwork;
  coin: HyperliquidMarketCoin;
  interval: HyperliquidCandleInterval;
  fetched_at: string;
  source_timestamp: number | null;
  stale: boolean;
  mid: string | null;
  best_bid: string | null;
  best_ask: string | null;
  spread_bps: number | null;
  mark_price: string | null;
  oracle_price: string | null;
  prev_day_price: string | null;
  day_notional_volume: string | null;
  day_base_volume: string | null;
  open_interest: string | null;
  premium: string | null;
  max_leverage: number | null;
  candles: HyperliquidCandle[];
  bids: HyperliquidBookLevel[];
  asks: HyperliquidBookLevel[];
  recent_trades: HyperliquidRecentTrade[];
}

export interface HyperliquidMarketSnapshotInput {
  network?: string | null;
  coin?: string | null;
  interval?: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
}

const API_URLS: Record<HyperliquidNetwork, string> = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
};

const MARKET_ALLOWLIST = new Set<HyperliquidMarketCoin>(["BTC", "ETH", "SOL", "HYPE"]);
const INTERVAL_ALLOWLIST = new Set<HyperliquidCandleInterval>(["1m", "5m", "15m", "1h"]);
const INTERVAL_MS: Record<HyperliquidCandleInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
};
const CANDLE_WINDOW = 240;
const BOOK_LEVEL_WINDOW = 20;
const RECENT_TRADE_WINDOW = 20;
const MARKET_CACHE_TTL_MS = 4_000;
const MARKET_FETCH_TIMEOUT_MS = 8_000;
const MAX_SOURCE_AGE_MS = 2 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;

type CacheRecord = {
  fetchedAtMs: number;
  snapshot: HyperliquidMarketSnapshot;
};

const snapshotCache = new Map<string, CacheRecord>();
const inflight = new Map<string, Promise<HyperliquidMarketSnapshot>>();

export function normalizeHyperliquidMarketInput(
  input: HyperliquidMarketSnapshotInput,
): {
  network: HyperliquidNetwork;
  coin: HyperliquidMarketCoin;
  interval: HyperliquidCandleInterval;
} {
  const network = input.network === "testnet" ? "testnet" : "mainnet";
  const coin = String(input.coin || "BTC").trim().toUpperCase();
  const interval = String(input.interval || "5m").trim();
  return {
    network,
    coin: MARKET_ALLOWLIST.has(coin as HyperliquidMarketCoin)
      ? coin as HyperliquidMarketCoin
      : "BTC",
    interval: INTERVAL_ALLOWLIST.has(interval as HyperliquidCandleInterval)
      ? interval as HyperliquidCandleInterval
      : "5m",
  };
}

export async function getHyperliquidMarketSnapshot(
  input: HyperliquidMarketSnapshotInput = {},
): Promise<HyperliquidMarketSnapshot> {
  const normalized = normalizeHyperliquidMarketInput(input);
  const providedNow = input.now;
  const now = providedNow ?? new Date();
  const receiptClock = providedNow ? () => providedNow : () => new Date();
  const nowMs = now.getTime();
  const key = `${normalized.network}:${normalized.coin}:${normalized.interval}`;
  const cached = snapshotCache.get(key);
  if (cached && nowMs - cached.fetchedAtMs <= MARKET_CACHE_TTL_MS) {
    return cached.snapshot;
  }
  const active = inflight.get(key);
  if (active) return active;

  const promise = fetchFreshHyperliquidMarketSnapshot({
    ...normalized,
    now,
    receiptClock,
    fetchImpl: input.fetchImpl ?? fetch,
    previous: cached?.snapshot ?? null,
  }).then((snapshot) => {
    snapshotCache.set(key, {
      fetchedAtMs: nowMs,
      snapshot,
    });
    return snapshot;
  }).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

export function resetHyperliquidMarketSnapshotCacheForTests() {
  snapshotCache.clear();
  inflight.clear();
}

async function fetchFreshHyperliquidMarketSnapshot(input: {
  network: HyperliquidNetwork;
  coin: HyperliquidMarketCoin;
  interval: HyperliquidCandleInterval;
  now: Date;
  fetchImpl: typeof fetch;
  previous: HyperliquidMarketSnapshot | null;
  receiptClock: () => Date;
}): Promise<HyperliquidMarketSnapshot> {
  const baseUrl = API_URLS[input.network];
  const endTime = input.now.getTime();
  const startTime = endTime - INTERVAL_MS[input.interval] * CANDLE_WINDOW;
  try {
    const [mids, book, candles, metaAndAssetCtxs, recentTrades] = await Promise.all([
      postInfo(input.fetchImpl, baseUrl, { type: "allMids" }),
      postInfo(input.fetchImpl, baseUrl, { type: "l2Book", coin: input.coin }),
      postInfo(input.fetchImpl, baseUrl, {
        type: "candleSnapshot",
        req: {
          coin: input.coin,
          interval: input.interval,
          startTime,
          endTime,
        },
      }),
      postInfo(input.fetchImpl, baseUrl, { type: "metaAndAssetCtxs" }).catch(() => null),
      postInfo(input.fetchImpl, baseUrl, { type: "recentTrades", coin: input.coin }).catch(() => null),
    ]);
    const snapshot = buildSnapshot({
      network: input.network,
      coin: input.coin,
      interval: input.interval,
      fetchedAt: input.now,
      fundingReceivedAt: input.receiptClock(),
      mids,
      book,
      candles,
      metaAndAssetCtxs,
      recentTrades,
      stale: false,
    });
    return snapshot.stale && input.previous
      ? { ...input.previous, stale: true }
      : snapshot;
  } catch {
    if (input.previous) {
      return { ...input.previous, stale: true };
    }
    return emptySnapshot({
      network: input.network,
      coin: input.coin,
      interval: input.interval,
      fetchedAt: input.now,
      stale: true,
    });
  }
}

async function postInfo(fetchImpl: typeof fetch, baseUrl: string, body: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MARKET_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseUrl}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`hyperliquid_info_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function buildSnapshot(input: {
  network: HyperliquidNetwork;
  coin: HyperliquidMarketCoin;
  interval: HyperliquidCandleInterval;
  fetchedAt: Date;
  fundingReceivedAt: Date;
  mids: unknown;
  book: unknown;
  candles: unknown;
  metaAndAssetCtxs: unknown;
  recentTrades: unknown;
  stale: boolean;
}): HyperliquidMarketSnapshot {
  const bids = sortBookSide(normalizeBookSide(input.book, 0), "bid").slice(0, BOOK_LEVEL_WINDOW);
  const asks = sortBookSide(normalizeBookSide(input.book, 1), "ask").slice(0, BOOK_LEVEL_WINDOW);
  const mid = positiveDecimalString(normalizeMid(input.mids, input.coin));
  const bestBid = bids[0]?.px ?? null;
  const bestAsk = asks[0]?.px ?? null;
  const candles = normalizeCandles(input.candles)
    .filter((candle) => candle.t <= input.fetchedAt.getTime() + MAX_FUTURE_SKEW_MS);
  const sourceTimestamp = normalizeSourceTimestamp(input.book);
  const assetContext = normalizeAssetContext(input.metaAndAssetCtxs, input.coin);
  const fundingRate = assetContext.funding_rate;
  const validBook = isValidBook(bids, asks);
  const stale = input.stale
    || !mid
    || !validBook
    || !isFreshTimestamp(sourceTimestamp, input.fetchedAt.getTime(), MAX_SOURCE_AGE_MS)
    || !hasFreshCandles(candles, input.fetchedAt.getTime(), input.interval);
  return {
    version: 1,
    platform: "hyperliquid",
    network: input.network,
    coin: input.coin,
    interval: input.interval,
    fetched_at: input.fetchedAt.toISOString(),
    source_timestamp: sourceTimestamp,
    stale,
    mid,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps(bestBid, bestAsk),
    ...assetContext,
    funding_rate_unit: fundingRate == null ? null : CANONICAL_FUNDING_RATE_UNIT,
    funding_rate_source: fundingRate == null ? null : "hyperliquid_rest_asset_context_received",
    funding_time_basis: fundingRate == null ? null : "received_at",
    funding_updated_at: fundingRate == null ? null : input.fundingReceivedAt.toISOString(),
    candles,
    bids,
    asks,
    recent_trades: normalizeRecentTrades(input.recentTrades),
  };
}

function emptySnapshot(input: {
  network: HyperliquidNetwork;
  coin: HyperliquidMarketCoin;
  interval: HyperliquidCandleInterval;
  fetchedAt: Date;
  stale: boolean;
}): HyperliquidMarketSnapshot {
  return {
    version: 1,
    platform: "hyperliquid",
    network: input.network,
    coin: input.coin,
    interval: input.interval,
    fetched_at: input.fetchedAt.toISOString(),
    source_timestamp: null,
    stale: input.stale,
    mid: null,
    best_bid: null,
    best_ask: null,
    spread_bps: null,
    mark_price: null,
    oracle_price: null,
    prev_day_price: null,
    day_notional_volume: null,
    day_base_volume: null,
    open_interest: null,
    funding_rate: null,
    funding_rate_unit: null,
    funding_rate_source: null,
    funding_time_basis: null,
    funding_updated_at: null,
    premium: null,
    max_leverage: null,
    candles: [],
    bids: [],
    asks: [],
    recent_trades: [],
  };
}

function normalizeMid(mids: unknown, coin: HyperliquidMarketCoin) {
  if (!mids || typeof mids !== "object" || Array.isArray(mids)) return null;
  const value = (mids as Record<string, unknown>)[coin];
  return safeDecimalString(value);
}

function normalizeBookSide(book: unknown, sideIndex: 0 | 1): HyperliquidBookLevel[] {
  if (!book || typeof book !== "object" || Array.isArray(book)) return [];
  const levels = (book as Record<string, unknown>).levels;
  if (!Array.isArray(levels)) return [];
  const side = levels[sideIndex];
  if (!Array.isArray(side)) return [];
  return side.map((level) => {
    if (!level || typeof level !== "object" || Array.isArray(level)) return null;
    const row = level as Record<string, unknown>;
    const px = positiveDecimalString(row.px);
    const sz = positiveDecimalString(row.sz);
    const n = numberValue(row.n);
    return px && sz ? { px, sz, n } : null;
  }).filter(Boolean) as HyperliquidBookLevel[];
}

function normalizeCandles(value: unknown): HyperliquidCandle[] {
  if (!Array.isArray(value)) return [];
  const candles = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const t = numberValue(row.t);
    const T = numberValue(row.T);
    const o = positiveDecimalString(row.o);
    const h = positiveDecimalString(row.h);
    const l = positiveDecimalString(row.l);
    const c = positiveDecimalString(row.c);
    const v = safeDecimalString(row.v) || "0";
    const n = numberValue(row.n);
    if (!t || !o || !h || !l || !c || (T != null && T < t)) return null;
    return validOhlc(o, h, l, c) ? { t, T, o, h, l, c, v, n } : null;
  }).filter(Boolean) as HyperliquidCandle[];
  return dedupeCandles(candles).slice(-CANDLE_WINDOW);
}

function normalizeAssetContext(value: unknown, coin: HyperliquidMarketCoin) {
  const empty = {
    mark_price: null,
    oracle_price: null,
    prev_day_price: null,
    day_notional_volume: null,
    day_base_volume: null,
    open_interest: null,
    funding_rate: null,
    premium: null,
    max_leverage: null,
  };
  if (!Array.isArray(value) || value.length < 2) return empty;
  const [meta, contexts] = value;
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || !Array.isArray(contexts)) return empty;
  const universe = (meta as Record<string, unknown>).universe;
  if (!Array.isArray(universe)) return empty;
  const index = universe.findIndex((asset) => {
    return Boolean(asset && typeof asset === "object" && !Array.isArray(asset) && (asset as Record<string, unknown>).name === coin);
  });
  if (index < 0) return empty;
  const asset = universe[index];
  const context = contexts[index];
  if (!asset || typeof asset !== "object" || Array.isArray(asset) || !context || typeof context !== "object" || Array.isArray(context)) {
    return empty;
  }
  const row = context as Record<string, unknown>;
  const maxLeverage = (asset as Record<string, unknown>).maxLeverage;
  return {
    mark_price: safeDecimalString(row.markPx),
    oracle_price: safeDecimalString(row.oraclePx),
    prev_day_price: safeDecimalString(row.prevDayPx),
    day_notional_volume: safeDecimalString(row.dayNtlVlm),
    day_base_volume: safeDecimalString(row.dayBaseVlm),
    open_interest: safeDecimalString(row.openInterest),
    funding_rate: safeSignedDecimalString(row.funding),
    premium: safeSignedDecimalString(row.premium),
    max_leverage: typeof maxLeverage === "number" && Number.isFinite(maxLeverage) ? Math.floor(maxLeverage) : null,
  };
}

function normalizeRecentTrades(value: unknown): HyperliquidRecentTrade[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized = value.map((item): HyperliquidRecentTrade | null => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const px = positiveDecimalString(row.px);
    const sz = positiveDecimalString(row.sz);
    const time = numberValue(row.time);
    const side = row.side === "B" ? "buy" : row.side === "A" ? "sell" : null;
    return px && sz && time && side ? { px, sz, time, side } : null;
  }).filter((trade): trade is HyperliquidRecentTrade => trade != null);
  return normalized.sort(compareRecentTrades).filter((trade) => {
    const key = `${trade.time}:${trade.side}:${trade.px}:${trade.sz}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, RECENT_TRADE_WINDOW);
}

function compareRecentTrades(left: HyperliquidRecentTrade, right: HyperliquidRecentTrade) {
  return right.time - left.time
    || left.side.localeCompare(right.side)
    || left.px.localeCompare(right.px)
    || left.sz.localeCompare(right.sz);
}

function normalizeSourceTimestamp(book: unknown) {
  if (!book || typeof book !== "object" || Array.isArray(book)) return null;
  return numberValue((book as Record<string, unknown>).time);
}

function safeDecimalString(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

function safeSignedDecimalString(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function positiveDecimalString(value: unknown): string | null {
  const normalized = typeof value === "string" || typeof value === "number"
    ? safeDecimalString(value)
    : null;
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

function dedupeCandles(candles: HyperliquidCandle[]): HyperliquidCandle[] {
  const byTimestamp = new Map<number, HyperliquidCandle>();
  for (const candle of candles.sort((a, b) => a.t - b.t)) byTimestamp.set(candle.t, candle);
  return [...byTimestamp.values()];
}

function sortBookSide(
  levels: HyperliquidBookLevel[],
  side: "bid" | "ask",
): HyperliquidBookLevel[] {
  return levels.sort((a, b) => side === "bid" ? Number(b.px) - Number(a.px) : Number(a.px) - Number(b.px));
}

function isValidBook(bids: HyperliquidBookLevel[], asks: HyperliquidBookLevel[]): boolean {
  if (!bids.length || !asks.length) return false;
  return Number(bids[0].px) < Number(asks[0].px);
}

function isFreshTimestamp(timestamp: number | null, nowMs: number, maxAgeMs: number): boolean {
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) return false;
  const age = nowMs - timestamp;
  return age >= -MAX_FUTURE_SKEW_MS && age <= maxAgeMs;
}

function hasFreshCandles(
  candles: HyperliquidCandle[],
  nowMs: number,
  interval: HyperliquidCandleInterval,
): boolean {
  const latest = candles.at(-1)?.t ?? null;
  return isFreshTimestamp(latest, nowMs, Math.max(5 * 60_000, INTERVAL_MS[interval] * 3));
}

function spreadBps(bestBid: string | null, bestAsk: string | null) {
  if (!bestBid || !bestAsk) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid >= ask) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return Math.round(((ask - bid) / mid) * 10_000 * 100) / 100;
}
