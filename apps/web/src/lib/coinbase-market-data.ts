export const COINBASE_PRODUCT_IDS = [
  "BTC-USD", "ETH-USD", "SOL-USD", "AVAX-USD", "LINK-USD", "DOGE-USD",
  "XRP-USD", "ADA-USD", "SUI-USD", "AAVE-USD", "LTC-USD", "BCH-USD",
] as const;
export type CoinbaseProductId = (typeof COINBASE_PRODUCT_IDS)[number];
export type CoinbaseBaseCurrency = CoinbaseProductId extends `${infer Base}-USD` ? Base : never;
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
  base_currency_id: CoinbaseBaseCurrency;
  quote_currency_id: "USD";
  interval: CoinbaseCandleInterval;
  /** Time the most recent trustworthy price-bearing source was received. */
  fetched_at: string;
  /** Time the HTTP/WebSocket processing attempt completed; never used as market-data age. */
  request_completed_at: string;
  source: CoinbaseMarketSource;
  source_timestamp: number | null;
  stale: boolean;
  last_error_at: string | null;
  last_trade_price: string | null;
  book_mid: string | null;
  last_trade_updated_at: number | null;
  book_updated_at: number | null;
  candle_updated_at: number | null;
  last_heartbeat_at: number | null;
  /** Compatibility alias for last_trade_price. */
  price: string | null;
  /** Compatibility alias for book_mid, falling back to last_trade_price. */
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
  cacheMode?: "swr" | "refresh";
}

const COINBASE_API_URL = "https://api.coinbase.com/api/v3/brokerage/market";
const PRODUCT_ALLOWLIST = new Set<CoinbaseProductId>(COINBASE_PRODUCT_IDS);
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
export const COINBASE_BOOK_STALE_MS = 10_000;
export const COINBASE_TRADE_STALE_MS = 15_000;

const MARKET_CACHE_TTL_MS = 4_000;
const MARKET_MAX_STALE_MS = 5 * 60_000;

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
    request_completed_at: (input.now ?? new Date()).toISOString(),
    source: null,
    source_timestamp: null,
    stale: input.stale ?? true,
    last_error_at: null,
    last_trade_price: null,
    book_mid: null,
    last_trade_updated_at: null,
    book_updated_at: null,
    candle_updated_at: null,
    last_heartbeat_at: null,
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

  if (cached && input.cacheMode !== "refresh" && nowMs - cached.fetchedAtMs <= MARKET_MAX_STALE_MS) {
    if (!active) {
      void refreshCoinbaseSnapshot({
        ...normalized,
        now,
        fetchImpl: input.fetchImpl ?? fetch,
        previous: cached.snapshot,
        key,
        cacheTimestamp: nowMs,
      });
    }
    return { ...cached.snapshot, stale: true };
  }
  if (active) return active;

  return refreshCoinbaseSnapshot({
    ...normalized,
    now,
    fetchImpl: input.fetchImpl ?? fetch,
    previous: cached?.snapshot ?? null,
    key,
    cacheTimestamp: nowMs,
  });
}

function refreshCoinbaseSnapshot(input: {
  productId: CoinbaseProductId;
  interval: CoinbaseCandleInterval;
  now: Date;
  fetchImpl: typeof fetch;
  previous: CoinbaseMarketSnapshot | null;
  key: string;
  cacheTimestamp: number;
}) {
  const active = inflight.get(input.key);
  if (active) return active;
  const promise = fetchFreshCoinbaseMarketSnapshot(input)
    .then((snapshot) => {
      snapshotCache.set(input.key, { fetchedAtMs: input.cacheTimestamp, snapshot });
      return snapshot;
    })
    .finally(() => {
      inflight.delete(input.key);
    });
  inflight.set(input.key, promise);
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
  const [productResult, bookResult, candleResult, tradeResult] = await Promise.allSettled([
    fetchCoinbaseJson(input.fetchImpl, `/products/${input.productId}`),
    fetchCoinbaseJson(input.fetchImpl, `/product_book?product_id=${input.productId}&limit=${COINBASE_BOOK_LEVEL_WINDOW}`),
    fetchCoinbaseJson(
      input.fetchImpl,
      `/products/${input.productId}/candles?start=${start}&end=${end}&granularity=${INTERVAL_GRANULARITY[input.interval]}&limit=${COINBASE_CANDLE_WINDOW}`,
    ),
    fetchCoinbaseJson(input.fetchImpl, `/products/${input.productId}/ticker?limit=${COINBASE_RECENT_TRADE_WINDOW}`),
  ]);
  const value = (result: PromiseSettledResult<unknown>) => result.status === "fulfilled" ? result.value : null;
  const fresh = buildCoinbaseSnapshot({
    productId: input.productId,
    interval: input.interval,
    fetchedAt: input.now,
    source: "http",
    product: value(productResult),
    book: value(bookResult),
    candles: value(candleResult),
    trades: value(tradeResult),
  });
  const previous = input.previous;
  const productOk = productResult.status === "fulfilled";
  const bookOk = bookResult.status === "fulfilled";
  const candlesOk = candleResult.status === "fulfilled";
  const tradesOk = tradeResult.status === "fulfilled";
  const marketPriceOk = (bookOk && fresh.book_mid != null) || ((productOk || tradesOk) && fresh.last_trade_price != null);
  if (!previous) {
    return {
      ...fresh,
      stale: !marketPriceOk,
      last_error_at: [productOk, bookOk, candlesOk, tradesOk].every(Boolean) ? null : input.now.toISOString(),
    };
  }
  const lastTradePrice = (productOk || tradesOk) ? fresh.last_trade_price ?? previous.last_trade_price : previous.last_trade_price;
  const bookMid = bookOk ? fresh.book_mid : previous.book_mid;
  return {
    ...previous,
    ...fresh,
    fetched_at: marketPriceOk ? input.now.toISOString() : previous.fetched_at,
    request_completed_at: input.now.toISOString(),
    stale: !marketPriceOk,
    last_error_at: [productOk, bookOk, candlesOk, tradesOk].every(Boolean) ? null : input.now.toISOString(),
    last_trade_price: lastTradePrice,
    price: lastTradePrice,
    last_trade_updated_at: (productOk || tradesOk) && fresh.last_trade_price ? fresh.last_trade_updated_at : previous.last_trade_updated_at,
    book_mid: bookMid,
    mid: bookMid ?? lastTradePrice,
    book_updated_at: bookOk && fresh.book_mid ? fresh.book_updated_at : previous.book_updated_at,
    best_bid: bookOk ? fresh.best_bid : previous.best_bid,
    best_ask: bookOk ? fresh.best_ask : previous.best_ask,
    spread_bps: bookOk ? fresh.spread_bps : previous.spread_bps,
    bids: bookOk ? fresh.bids : previous.bids,
    asks: bookOk ? fresh.asks : previous.asks,
    candles: candlesOk ? fresh.candles : previous.candles,
    candle_updated_at: candlesOk && fresh.candles.length > 0 ? fresh.candle_updated_at : previous.candle_updated_at,
    recent_trades: tradesOk ? fresh.recent_trades : previous.recent_trades,
    price_percentage_change_24h: productOk ? fresh.price_percentage_change_24h : previous.price_percentage_change_24h,
    volume_24h: productOk ? fresh.volume_24h : previous.volume_24h,
    approximate_quote_24h_volume: productOk ? fresh.approximate_quote_24h_volume : previous.approximate_quote_24h_volume,
    base_increment: productOk ? fresh.base_increment : previous.base_increment,
    quote_increment: productOk ? fresh.quote_increment : previous.quote_increment,
    quote_min_size: productOk ? fresh.quote_min_size : previous.quote_min_size,
    trading_disabled: productOk ? fresh.trading_disabled : previous.trading_disabled,
    product_type: productOk ? fresh.product_type : previous.product_type,
  };
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
  const recentTrades = normalizeCoinbaseTrades(readRecord(input.trades)?.trades);
  const lastTradePrice = safeDecimalString(product?.price) ?? recentTrades[0]?.px ?? safeDecimalString(book?.last);
  const bookMid = validatedBookMid(bestBid, bestAsk);
  const bookTimestamp = timeValue(pricebook?.time);
  const lastTradeTimestamp = recentTrades[0]?.time ?? (lastTradePrice ? input.fetchedAt.getTime() : null);
  return {
    version: 1,
    platform: "coinbase",
    product_id: input.productId,
    base_currency_id: coinbaseBaseCurrency(input.productId),
    quote_currency_id: "USD",
    interval: input.interval,
    fetched_at: input.fetchedAt.toISOString(),
    request_completed_at: input.fetchedAt.toISOString(),
    source: input.source,
    source_timestamp: bookTimestamp ?? lastTradeTimestamp,
    stale: false,
    last_error_at: null,
    last_trade_price: lastTradePrice,
    book_mid: bookMid,
    last_trade_updated_at: lastTradeTimestamp,
    book_updated_at: bookMid ? bookTimestamp ?? input.fetchedAt.getTime() : null,
    candle_updated_at: normalizeCoinbaseCandles(readRecord(input.candles)?.candles).at(-1)?.t ?? null,
    last_heartbeat_at: null,
    price: lastTradePrice,
    mid: bookMid ?? lastTradePrice,
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
    recent_trades: recentTrades,
  };
}

export interface CoinbaseDisplayPrice {
  value: string | null;
  kind: "book_mid" | "last_trade" | "unavailable";
  age_ms: number | null;
  stale: boolean;
}

export function selectCoinbaseDisplayPrice(
  snapshot: CoinbaseMarketSnapshot | null | undefined,
  nowMs = Date.now(),
): CoinbaseDisplayPrice {
  if (!snapshot) return { value: null, kind: "unavailable", age_ms: null, stale: true };
  const bookAge = ageMs(snapshot.book_updated_at, nowMs);
  if (snapshot.book_mid && bookAge != null && bookAge <= COINBASE_BOOK_STALE_MS) {
    return { value: snapshot.book_mid, kind: "book_mid", age_ms: bookAge, stale: false };
  }
  const tradeAge = ageMs(snapshot.last_trade_updated_at, nowMs);
  if (snapshot.last_trade_price && tradeAge != null) {
    return {
      value: snapshot.last_trade_price,
      kind: "last_trade",
      age_ms: tradeAge,
      stale: tradeAge > COINBASE_TRADE_STALE_MS,
    };
  }
  return { value: null, kind: "unavailable", age_ms: null, stale: true };
}

function ageMs(timestamp: number | null, nowMs: number) {
  if (timestamp == null || !Number.isFinite(timestamp)) return null;
  return Math.max(0, nowMs - timestamp);
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
      return t && positiveDecimalString(o) && positiveDecimalString(h) && positiveDecimalString(l) && positiveDecimalString(c)
        ? { t, T: null, o, h, l, c, v, n: null }
        : null;
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

function positiveDecimalString(value: string | null): value is string {
  return value != null && Number(value) > 0;
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

export function coinbaseBaseCurrency(productId: CoinbaseProductId): CoinbaseBaseCurrency {
  return productId.slice(0, -4) as CoinbaseBaseCurrency;
}

export function spreadBps(bestBid: string | null, bestAsk: string | null): number | null {
  if (!bestBid || !bestAsk) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid > ask) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return Math.round(((ask - bid) / mid) * 10_000 * 100) / 100;
}

export function validatedBookMid(bestBid: string | null, bestAsk: string | null): string | null {
  if (!bestBid || !bestAsk) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid > ask) return null;
  const decimals = Math.max(decimalPlaces(bestBid), decimalPlaces(bestAsk));
  const scaledBid = decimalToScaledInteger(bestBid, decimals);
  const scaledAsk = decimalToScaledInteger(bestAsk, decimals);
  if (scaledBid == null || scaledAsk == null) return null;
  const sum = scaledBid + scaledAsk;
  const midpointDecimals = sum % BigInt(2) === BigInt(0) ? decimals : decimals + 1;
  const midpointScaled = sum % BigInt(2) === BigInt(0) ? sum / BigInt(2) : sum * BigInt(5);
  return scaledIntegerToDecimal(midpointScaled, midpointDecimals);
}

function decimalPlaces(value: string) {
  return value.includes(".") ? value.length - value.indexOf(".") - 1 : 0;
}

function decimalToScaledInteger(value: string, decimals: number) {
  const [whole, fraction = ""] = value.split(".");
  try {
    return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  } catch {
    return null;
  }
}

function scaledIntegerToDecimal(value: bigint, decimals: number) {
  if (decimals === 0) return value.toString();
  const raw = value.toString().padStart(decimals + 1, "0");
  const result = `${raw.slice(0, -decimals)}.${raw.slice(-decimals)}`.replace(/\.?0+$/, "");
  return result || "0";
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
