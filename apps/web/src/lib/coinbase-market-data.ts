export type CoinbaseProductId = "BTC-USD" | "ETH-USD" | "SOL-USD";
export type CoinbaseCandleInterval = "1m" | "5m" | "15m" | "1h";
export type CoinbaseMarketSource = "http" | "websocket" | null;

export interface CoinbaseCandle {
  t: number;
  T: number | null;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number | null;
}

export interface CoinbaseBookLevel {
  px: string;
  sz: string;
  n: number | null;
}

export interface CoinbaseRecentTrade {
  trade_id: string | null;
  side: "buy" | "sell";
  px: string;
  sz: string;
  time: number;
}

export interface CoinbaseMarketSnapshot {
  version: 1;
  platform: "coinbase";
  product_id: CoinbaseProductId;
  base_currency_id: "BTC" | "ETH" | "SOL";
  quote_currency_id: "USD";
  interval: CoinbaseCandleInterval;
  fetched_at: string;
  source: CoinbaseMarketSource;
  source_timestamp: number | null;
  stale: boolean;
  price: string | null;
  mid: string | null;
  best_bid: string | null;
  best_ask: string | null;
  spread_bps: number | null;
  price_percentage_change_24h: string | null;
  volume_24h: string | null;
  approximate_quote_24h_volume: string | null;
  base_increment: string | null;
  quote_increment: string | null;
  quote_min_size: string | null;
  trading_disabled: boolean;
  product_type: string | null;
  candles: CoinbaseCandle[];
  bids: CoinbaseBookLevel[];
  asks: CoinbaseBookLevel[];
  recent_trades: CoinbaseRecentTrade[];
}

export interface CoinbaseMarketSnapshotInput {
  productId?: string | null;
  interval?: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
}

const COINBASE_API_URL = "https://api.coinbase.com/api/v3/brokerage/market";
const PRODUCT_ALLOWLIST = new Set<CoinbaseProductId>(["BTC-USD", "ETH-USD", "SOL-USD"]);
const INTERVAL_ALLOWLIST = new Set<CoinbaseCandleInterval>(["1m", "5m", "15m", "1h"]);
const INTERVAL_GRANULARITY: Record<CoinbaseCandleInterval, string> = {
  "1m": "ONE_MINUTE",
  "5m": "FIVE_MINUTE",
  "15m": "FIFTEEN_MINUTE",
  "1h": "ONE_HOUR",
};
const INTERVAL_SECONDS: Record<CoinbaseCandleInterval, number> = {
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
};

export const COINBASE_CANDLE_WINDOW = 240;
export const COINBASE_BOOK_LEVEL_WINDOW = 20;
export const COINBASE_RECENT_TRADE_WINDOW = 20;

const MARKET_CACHE_TTL_MS = 4_000;

type CacheRecord = {
  fetchedAtMs: number;
  snapshot: CoinbaseMarketSnapshot;
};

const snapshotCache = new Map<string, CacheRecord>();
const inflight = new Map<string, Promise<CoinbaseMarketSnapshot>>();

export function normalizeCoinbaseMarketInput(input: CoinbaseMarketSnapshotInput): {
  productId: CoinbaseProductId;
  interval: CoinbaseCandleInterval;
} {
  const rawProduct = String(input.productId || "BTC-USD").trim().toUpperCase();
  const productId = rawProduct.includes("-") ? rawProduct : `${rawProduct || "BTC"}-USD`;
  const interval = String(input.interval || "5m").trim();
  return {
    productId: PRODUCT_ALLOWLIST.has(productId as CoinbaseProductId)
      ? (productId as CoinbaseProductId)
      : "BTC-USD",
    interval: INTERVAL_ALLOWLIST.has(interval as CoinbaseCandleInterval)
      ? (interval as CoinbaseCandleInterval)
      : "5m",
  };
}

export function emptyCoinbaseMarketSnapshot(input: {
  productId: CoinbaseProductId;
  interval: CoinbaseCandleInterval;
  now?: Date;
  stale?: boolean;
}): CoinbaseMarketSnapshot {
  const base = coinbaseBaseCurrency(input.productId);
  return {
    version: 1,
    platform: "coinbase",
    product_id: input.productId,
    base_currency_id: base,
    quote_currency_id: "USD",
    interval: input.interval,
    fetched_at: (input.now ?? new Date()).toISOString(),
    source: null,
    source_timestamp: null,
    stale: input.stale ?? true,
    price: null,
    mid: null,
    best_bid: null,
    best_ask: null,
    spread_bps: null,
    price_percentage_change_24h: null,
    volume_24h: null,
    approximate_quote_24h_volume: null,
    base_increment: null,
    quote_increment: null,
    quote_min_size: null,
    trading_disabled: false,
    product_type: null,
    candles: [],
    bids: [],
    asks: [],
    recent_trades: [],
  };
}

export async function getCoinbaseMarketSnapshot(
  input: CoinbaseMarketSnapshotInput = {},
): Promise<CoinbaseMarketSnapshot> {
  const normalized = normalizeCoinbaseMarketInput(input);
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const key = `${normalized.productId}:${normalized.interval}`;
  const cached = snapshotCache.get(key);
  if (cached && nowMs - cached.fetchedAtMs <= MARKET_CACHE_TTL_MS) return cached.snapshot;
  const active = inflight.get(key);
  if (active) return active;

  const promise = fetchFreshCoinbaseMarketSnapshot({
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

export function resetCoinbaseMarketSnapshotCacheForTests() {
  snapshotCache.clear();
  inflight.clear();
}

async function fetchFreshCoinbaseMarketSnapshot(input: {
  productId: CoinbaseProductId;
  interval: CoinbaseCandleInterval;
  now: Date;
  fetchImpl: typeof fetch;
  previous: CoinbaseMarketSnapshot | null;
}): Promise<CoinbaseMarketSnapshot> {
  const end = Math.floor(input.now.getTime() / 1000);
  const start = end - INTERVAL_SECONDS[input.interval] * COINBASE_CANDLE_WINDOW;
  try {
    const [product, book, candles, trades] = await Promise.all([
      fetchCoinbaseJson(input.fetchImpl, `/products/${input.productId}`),
      fetchCoinbaseJson(input.fetchImpl, `/product_book?product_id=${input.productId}&limit=${COINBASE_BOOK_LEVEL_WINDOW}`),
      fetchCoinbaseJson(
        input.fetchImpl,
        `/products/${input.productId}/candles?start=${start}&end=${end}&granularity=${INTERVAL_GRANULARITY[input.interval]}&limit=${COINBASE_CANDLE_WINDOW}`,
      ),
      fetchCoinbaseJson(input.fetchImpl, `/products/${input.productId}/ticker?limit=${COINBASE_RECENT_TRADE_WINDOW}`).catch(() => null),
    ]);
    return buildCoinbaseSnapshot({
      productId: input.productId,
      interval: input.interval,
      fetchedAt: input.now,
      source: "http",
      product,
      book,
      candles,
      trades,
    });
  } catch {
    if (input.previous) {
      return { ...input.previous, fetched_at: input.now.toISOString(), stale: true };
    }
    return emptyCoinbaseMarketSnapshot({
      productId: input.productId,
      interval: input.interval,
      now: input.now,
      stale: true,
    });
  }
}

async function fetchCoinbaseJson(fetchImpl: typeof fetch, path: string) {
  const res = await fetchImpl(`${COINBASE_API_URL}${path}`, {
    headers: { "cache-control": "no-cache" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`coinbase_market_${res.status}`);
  return res.json();
}

function buildCoinbaseSnapshot(input: {
  productId: CoinbaseProductId;
  interval: CoinbaseCandleInterval;
  fetchedAt: Date;
  source: CoinbaseMarketSource;
  product: unknown;
  book: unknown;
  candles: unknown;
  trades: unknown;
}): CoinbaseMarketSnapshot {
  const product = readRecord(input.product);
  const book = readRecord(input.book);
  const pricebook = readRecord(book?.pricebook);
  const bids = normalizeCoinbaseBookLevels(pricebook?.bids);
  const asks = normalizeCoinbaseBookLevels(pricebook?.asks);
  const bestBid = bids[0]?.px ?? safeDecimalString(product?.best_bid_price);
  const bestAsk = asks[0]?.px ?? safeDecimalString(product?.best_ask_price);
  const price = safeDecimalString(product?.price) ?? safeDecimalString(book?.last);
  const mid =
    safeDecimalString(book?.mid_market) ??
    safeDecimalString(product?.mid_market_price) ??
    midFromBook(bestBid, bestAsk) ??
    price;
  return {
    version: 1,
    platform: "coinbase",
    product_id: input.productId,
    base_currency_id: coinbaseBaseCurrency(input.productId),
    quote_currency_id: "USD",
    interval: input.interval,
    fetched_at: input.fetchedAt.toISOString(),
    source: input.source,
    source_timestamp: timeValue(pricebook?.time) ?? input.fetchedAt.getTime(),
    stale: false,
    price,
    mid,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: safeNumber(book?.spread_bps) ?? spreadBps(bestBid, bestAsk),
    price_percentage_change_24h: safeSignedDecimalString(product?.price_percentage_change_24h),
    volume_24h: safeDecimalString(product?.volume_24h),
    approximate_quote_24h_volume: safeDecimalString(product?.approximate_quote_24h_volume),
    base_increment: safeDecimalString(product?.base_increment),
    quote_increment: safeDecimalString(product?.quote_increment),
    quote_min_size: safeDecimalString(product?.quote_min_size),
    trading_disabled: product?.trading_disabled === true,
    product_type: typeof product?.product_type === "string" ? product.product_type : null,
    candles: normalizeCoinbaseCandles(readRecord(input.candles)?.candles),
    bids,
    asks,
    recent_trades: normalizeCoinbaseTrades(readRecord(input.trades)?.trades),
  };
}

export function normalizeCoinbaseBookLevels(value: unknown): CoinbaseBookLevel[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, COINBASE_BOOK_LEVEL_WINDOW)
    .map((item) => {
      const row = readRecord(item);
      if (!row) return null;
      const px = safeDecimalString(row.price ?? row.px ?? row.price_level);
      const sz = safeDecimalString(row.size ?? row.sz ?? row.new_quantity);
      return px && sz ? { px, sz, n: null } : null;
    })
    .filter(Boolean) as CoinbaseBookLevel[];
}

export function normalizeCoinbaseCandles(value: unknown): CoinbaseCandle[] {
  if (!Array.isArray(value)) return [];
  const candles = value
    .map((item) => {
      const row = readRecord(item);
      if (!row) return null;
      const t = timeValue(row.start ?? row.time ?? row.t);
      const o = safeDecimalString(row.open ?? row.o);
      const h = safeDecimalString(row.high ?? row.h);
      const l = safeDecimalString(row.low ?? row.l);
      const c = safeDecimalString(row.close ?? row.c);
      const v = safeDecimalString(row.volume ?? row.v) ?? "0";
      return t && o && h && l && c ? { t, T: null, o, h, l, c, v, n: null } : null;
    })
    .filter(Boolean) as CoinbaseCandle[];
  return candles
    .sort((a, b) => a.t - b.t)
    .slice(-COINBASE_CANDLE_WINDOW);
}

export function normalizeCoinbaseTrades(value: unknown): CoinbaseRecentTrade[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, COINBASE_RECENT_TRADE_WINDOW)
    .map((item) => {
      const row = readRecord(item);
      if (!row) return null;
      const px = safeDecimalString(row.price ?? row.px);
      const sz = safeDecimalString(row.size ?? row.sz);
      const time = timeValue(row.time);
      const side = normalizeSide(row.side);
      const tradeId = typeof row.trade_id === "string" ? row.trade_id : null;
      return px && sz && time && side ? { trade_id: tradeId, side, px, sz, time } : null;
    })
    .filter(Boolean) as CoinbaseRecentTrade[];
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
  const trimmed = value.trim().replace(/%$/, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  return trimmed;
}

export function numberValue(value: unknown): number | null {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function timeValue(value: unknown): number | null {
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

export function normalizeSide(value: unknown): "buy" | "sell" | null {
  const side = String(value ?? "").trim().toLowerCase();
  if (side === "buy" || side === "bid" || side === "b") return "buy";
  if (side === "sell" || side === "ask" || side === "s") return "sell";
  return null;
}

export function coinbaseBaseCurrency(productId: CoinbaseProductId): "BTC" | "ETH" | "SOL" {
  if (productId.startsWith("ETH-")) return "ETH";
  if (productId.startsWith("SOL-")) return "SOL";
  return "BTC";
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

function midFromBook(bestBid: string | null, bestAsk: string | null): string | null {
  if (!bestBid || !bestAsk) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  return trimNumber((bid + ask) / 2);
}

function safeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function trimNumber(value: number): string {
  return Number(value).toString();
}
