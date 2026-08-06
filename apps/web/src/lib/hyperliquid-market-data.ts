export type HyperliquidNetwork = "mainnet" | "testnet";
export type HyperliquidMarketCoin = string;
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

export interface HyperliquidMarketChannelUpdatedAt {
  candle: number | null;
  trades: number | null;
  bbo: number | null;
  order_book: number | null;
  market_context: number | null;
  mid: number | null;
}

export interface HyperliquidMarketSnapshot {
  version: 1;
  platform: "hyperliquid";
  network: HyperliquidNetwork;
  coin: HyperliquidMarketCoin;
  interval: HyperliquidCandleInterval;
  fetched_at: string;
  source_timestamp: number | null;
  stale: boolean;
  channel_updated_at?: HyperliquidMarketChannelUpdatedAt;
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
  funding_rate: string | null;
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
  cacheMode?: "swr" | "refresh";
}

export interface HyperliquidMarketUniverseItem {
  coin: string;
  max_leverage: number | null;
  size_decimals: number | null;
}

const API_URLS: Record<HyperliquidNetwork, string> = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
};

const MARKET_NAME_RE = /^[A-Za-z0-9_:@.-]{1,48}$/;
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
const MARKET_MAX_STALE_MS = 5 * 60_000;

type CacheRecord = {
  fetchedAtMs: number;
  snapshot: HyperliquidMarketSnapshot;
};

const snapshotCache = new Map<string, CacheRecord>();
const inflight = new Map<string, Promise<HyperliquidMarketSnapshot>>();
const universeCache = new Map<HyperliquidNetwork, { fetchedAtMs: number; markets: HyperliquidMarketUniverseItem[] }>();

export function normalizeHyperliquidMarketInput(
  input: HyperliquidMarketSnapshotInput,
): {
  network: HyperliquidNetwork;
  coin: HyperliquidMarketCoin;
  interval: HyperliquidCandleInterval;
} {
  const network = input.network === "testnet" ? "testnet" : "mainnet";
  const requestedCoin = String(input.coin || "BTC").trim();
  const coin = MARKET_NAME_RE.test(requestedCoin) ? requestedCoin : "BTC";
  const interval = String(input.interval || "5m").trim();
  return {
    network,
    coin,
    interval: INTERVAL_ALLOWLIST.has(interval as HyperliquidCandleInterval)
      ? interval as HyperliquidCandleInterval
      : "5m",
  };
}

export async function getHyperliquidMarketUniverse(input: {
  network?: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
} = {}): Promise<HyperliquidMarketUniverseItem[]> {
  const network: HyperliquidNetwork = input.network === "testnet" ? "testnet" : "mainnet";
  const nowMs = (input.now ?? new Date()).getTime();
  const cached = universeCache.get(network);
  if (cached && nowMs - cached.fetchedAtMs < 60_000) {
    return cached.markets;
  }
  const raw = await postInfo(input.fetchImpl ?? fetch, API_URLS[network], { type: "meta" });
  const universe = raw && typeof raw === "object"
    ? (raw as Record<string, unknown>).universe
    : null;
  const markets = Array.isArray(universe)
    ? universe.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const coin = typeof row.name === "string" ? row.name.trim() : "";
        if (!MARKET_NAME_RE.test(coin) || row.isDelisted === true) return [];
        return [{
          coin,
          max_leverage: finiteNumber(row.maxLeverage),
          size_decimals: finiteNumber(row.szDecimals),
        }];
      })
    : [];
  if (markets.length === 0) throw new Error("hyperliquid_market_universe_empty");
  universeCache.set(network, { fetchedAtMs: nowMs, markets });
  return markets;
}

export async function getHyperliquidMarketSnapshot(
  input: HyperliquidMarketSnapshotInput = {},
): Promise<HyperliquidMarketSnapshot> {
  const normalized = normalizeHyperliquidMarketInput(input);
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const key = `${normalized.network}:${normalized.coin}:${normalized.interval}`;
  const cached = snapshotCache.get(key);
  if (cached && nowMs - cached.fetchedAtMs <= MARKET_CACHE_TTL_MS) {
    return cached.snapshot;
  }
  const active = inflight.get(key);
  if (cached && input.cacheMode !== "refresh" && nowMs - cached.fetchedAtMs <= MARKET_MAX_STALE_MS) {
    if (!active) {
      void refreshHyperliquidSnapshot({
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

  return refreshHyperliquidSnapshot({
    ...normalized,
    now,
    fetchImpl: input.fetchImpl ?? fetch,
    previous: cached?.snapshot ?? null,
    key,
    cacheTimestamp: nowMs,
  });
}

function refreshHyperliquidSnapshot(input: {
  network: HyperliquidNetwork;
  coin: HyperliquidMarketCoin;
  interval: HyperliquidCandleInterval;
  now: Date;
  fetchImpl: typeof fetch;
  previous: HyperliquidMarketSnapshot | null;
  key: string;
  cacheTimestamp: number;
}) {
  const active = inflight.get(input.key);
  if (active) return active;
  const promise = fetchFreshHyperliquidMarketSnapshot(input).then((snapshot) => {
    snapshotCache.set(input.key, {
      fetchedAtMs: input.cacheTimestamp,
      snapshot,
    });
    return snapshot;
  }).finally(() => {
    inflight.delete(input.key);
  });
  inflight.set(input.key, promise);
  return promise;
}

export function resetHyperliquidMarketSnapshotCacheForTests() {
  snapshotCache.clear();
  inflight.clear();
  universeCache.clear();
}

async function fetchFreshHyperliquidMarketSnapshot(input: {
  network: HyperliquidNetwork;
  coin: HyperliquidMarketCoin;
  interval: HyperliquidCandleInterval;
  now: Date;
  fetchImpl: typeof fetch;
  previous: HyperliquidMarketSnapshot | null;
}): Promise<HyperliquidMarketSnapshot> {
  const baseUrl = API_URLS[input.network];
  const endTime = input.now.getTime();
  const startTime = endTime - INTERVAL_MS[input.interval] * CANDLE_WINDOW;
  try {
    // Candle history is the chart's critical bootstrap payload. Request it before
    // the optional market panels so a burst of lower-priority Info requests
    // cannot consume the venue budget and leave a freshly opened chart empty.
    const candles = await postInfo(input.fetchImpl, baseUrl, {
      type: "candleSnapshot",
      req: {
        coin: input.coin,
        interval: input.interval,
        startTime,
        endTime,
      },
    }).catch(() => null);
    const [mids, book, metaAndAssetCtxs, recentTrades] = await Promise.all([
      postInfo(input.fetchImpl, baseUrl, { type: "allMids" }).catch(() => null),
      postInfo(input.fetchImpl, baseUrl, { type: "l2Book", coin: input.coin }).catch(() => null),
      postInfo(input.fetchImpl, baseUrl, { type: "metaAndAssetCtxs" }).catch(() => null),
      postInfo(input.fetchImpl, baseUrl, { type: "recentTrades", coin: input.coin }).catch(() => null),
    ]);
    if ([mids, book, candles, metaAndAssetCtxs, recentTrades].every((value) => value == null)) {
      throw new Error("hyperliquid_market_snapshot_unavailable");
    }
    const snapshot = buildSnapshot({
      network: input.network,
      coin: input.coin,
      interval: input.interval,
      fetchedAt: input.now,
      mids,
      book,
      candles,
      metaAndAssetCtxs,
      recentTrades,
      stale: !Array.isArray(candles) || candles.length === 0,
    });
    if (snapshot.candles.length === 0 && input.previous?.candles.length) {
      return {
        ...snapshot,
        stale: true,
        candles: input.previous.candles,
        channel_updated_at: {
          ...snapshot.channel_updated_at!,
          candle: input.previous.channel_updated_at?.candle ?? null,
        },
      };
    }
    return snapshot;
  } catch {
    if (input.previous) {
      return {
        ...input.previous,
        fetched_at: input.now.toISOString(),
        stale: true,
      };
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
  const res = await fetchImpl(`${baseUrl}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`hyperliquid_info_${res.status}`);
  return res.json();
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildSnapshot(input: {
  network: HyperliquidNetwork;
  coin: HyperliquidMarketCoin;
  interval: HyperliquidCandleInterval;
  fetchedAt: Date;
  mids: unknown;
  book: unknown;
  candles: unknown;
  metaAndAssetCtxs: unknown;
  recentTrades: unknown;
  stale: boolean;
}): HyperliquidMarketSnapshot {
  const bids = normalizeBookSide(input.book, 0);
  const asks = normalizeBookSide(input.book, 1);
  const mid = normalizeMid(input.mids, input.coin);
  const bestBid = bids[0]?.px ?? null;
  const bestAsk = asks[0]?.px ?? null;
  const assetContext = normalizeAssetContext(input.metaAndAssetCtxs, input.coin);
  const fetchedAtMs = input.fetchedAt.getTime();
  const normalizedCandles = normalizeCandles(input.candles);
  const normalizedTrades = normalizeRecentTrades(input.recentTrades);
  return {
    version: 1,
    platform: "hyperliquid",
    network: input.network,
    coin: input.coin,
    interval: input.interval,
    fetched_at: input.fetchedAt.toISOString(),
    source_timestamp: normalizeSourceTimestamp(input.book),
    stale: input.stale,
    channel_updated_at: {
      candle: normalizedCandles.length > 0 ? fetchedAtMs : null,
      trades: normalizedTrades.length > 0 ? fetchedAtMs : null,
      bbo: null,
      order_book: bids.length > 0 || asks.length > 0 ? fetchedAtMs : null,
      market_context: input.metaAndAssetCtxs != null ? fetchedAtMs : null,
      mid: mid != null ? fetchedAtMs : null,
    },
    mid,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps(bestBid, bestAsk),
    ...assetContext,
    candles: normalizedCandles,
    bids,
    asks,
    recent_trades: normalizedTrades,
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
    channel_updated_at: {
      candle: null,
      trades: null,
      bbo: null,
      order_book: null,
      market_context: null,
      mid: null,
    },
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
  return side.slice(0, BOOK_LEVEL_WINDOW).map((level) => {
    if (!level || typeof level !== "object" || Array.isArray(level)) return null;
    const row = level as Record<string, unknown>;
    const px = safeDecimalString(row.px);
    const sz = safeDecimalString(row.sz);
    const n = numberValue(row.n);
    return px && sz ? { px, sz, n } : null;
  }).filter(Boolean) as HyperliquidBookLevel[];
}

function normalizeCandles(value: unknown): HyperliquidCandle[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-CANDLE_WINDOW).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const t = numberValue(row.t);
    const T = numberValue(row.T);
    const o = safeDecimalString(row.o);
    const h = safeDecimalString(row.h);
    const l = safeDecimalString(row.l);
    const c = safeDecimalString(row.c);
    const v = safeDecimalString(row.v) || "0";
    const n = numberValue(row.n);
    return t && o && h && l && c ? { t, T, o, h, l, c, v, n } : null;
  }).filter(Boolean) as HyperliquidCandle[];
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
  return value.slice(0, RECENT_TRADE_WINDOW).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const px = safeDecimalString(row.px);
    const sz = safeDecimalString(row.sz);
    const time = numberValue(row.time);
    const side = row.side === "B" ? "buy" : row.side === "A" ? "sell" : null;
    return px && sz && time && side ? { px, sz, time, side } : null;
  }).filter(Boolean) as HyperliquidRecentTrade[];
}

function normalizeSourceTimestamp(book: unknown) {
  if (!book || typeof book !== "object" || Array.isArray(book)) return null;
  return numberValue((book as Record<string, unknown>).time);
}

function safeDecimalString(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
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

function spreadBps(bestBid: string | null, bestAsk: string | null) {
  if (!bestBid || !bestAsk) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return Math.max(0, Math.round(((ask - bid) / mid) * 10_000 * 100) / 100);
}
