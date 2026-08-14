import type { HyperliquidMarketSnapshot } from "./private-account-client";
import { inspectCanonicalFundingRate } from "./market-funding-rate";
import {
  advanceMarketComponent,
  advanceMarketComponents,
  attachMarketComponentClocks,
  carryMarketComponentClocks,
  hasAuthoritativeDepthUpdate,
  hasAuthoritativePricingUpdate,
  marketComponentClocks,
  normalizeMarketTimestamp,
  type MarketComponent,
} from "./market-component-clock";

export type HyperliquidLiveMarketStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "fallback_polling"
  | "stale"
  | "blocked";

type HyperliquidNetwork = HyperliquidMarketSnapshot["network"];
type HyperliquidMarketCoin = HyperliquidMarketSnapshot["coin"];
type HyperliquidCandleInterval = HyperliquidMarketSnapshot["interval"];

type HyperliquidWebSocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

export type HyperliquidWebSocketConstructor = new (url: string) => HyperliquidWebSocketLike;

type HyperliquidSubscription =
  | { type: "allMids" }
  | { type: "bbo"; coin: HyperliquidMarketCoin }
  | { type: "l2Book"; coin: HyperliquidMarketCoin }
  | { type: "trades"; coin: HyperliquidMarketCoin }
  | { type: "candle"; coin: HyperliquidMarketCoin; interval: HyperliquidCandleInterval }
  | { type: "activeAssetCtx"; coin: HyperliquidMarketCoin };

export interface HyperliquidLiveMarketStream {
  start: () => void;
  stop: () => void;
}

export interface HyperliquidLiveMarketStreamOptions {
  network: HyperliquidNetwork;
  coin: HyperliquidMarketCoin;
  interval: HyperliquidCandleInterval;
  initialSnapshot?: HyperliquidMarketSnapshot | null;
  webSocketCtor?: HyperliquidWebSocketConstructor | null;
  getFallbackSnapshot?: () => Promise<HyperliquidMarketSnapshot>;
  onSnapshot: (
    snapshot: HyperliquidMarketSnapshot,
    provenance?: "websocket" | "fallback",
  ) => unknown;
  onStatus: (status: HyperliquidLiveMarketStatus) => void;
  isDocumentHidden?: () => boolean;
  now?: () => number;
}

const WS_URLS: Record<HyperliquidNetwork, string> = {
  mainnet: "wss://api.hyperliquid.xyz/ws",
  testnet: "wss://api.hyperliquid-testnet.xyz/ws",
};

const WEBSOCKET_OPEN = 1;
const CANDLE_WINDOW = 240;
const BOOK_LEVEL_WINDOW = 20;
const RECENT_TRADE_WINDOW = 20;
const HEARTBEAT_MS = 30_000;
const STALE_AFTER_MS = 10_000;
const STALE_CHECK_MS = 3_000;
const FALLBACK_VISIBLE_MS = 4_000;
const FALLBACK_HIDDEN_MS = 15_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;

export function hyperliquidLiveMarketWebSocketUrl(network: HyperliquidNetwork): string {
  return WS_URLS[network];
}

export function hyperliquidLiveMarketSubscriptions(
  coin: HyperliquidMarketCoin,
  interval: HyperliquidCandleInterval,
): HyperliquidSubscription[] {
  return [
    { type: "allMids" },
    { type: "bbo", coin },
    { type: "l2Book", coin },
    { type: "trades", coin },
    { type: "candle", coin, interval },
    { type: "activeAssetCtx", coin },
  ];
}

export function createHyperliquidLiveMarketStream(
  options: HyperliquidLiveMarketStreamOptions,
): HyperliquidLiveMarketStream {
  return new BrowserHyperliquidLiveMarketStream(options);
}

export function emptyHyperliquidLiveMarketSnapshot(input: {
  network: HyperliquidNetwork;
  coin: HyperliquidMarketCoin;
  interval: HyperliquidCandleInterval;
  now?: Date;
}): HyperliquidMarketSnapshot {
  return {
    version: 1,
    platform: "hyperliquid",
    network: input.network,
    coin: input.coin,
    interval: input.interval,
    fetched_at: (input.now ?? new Date()).toISOString(),
    source_timestamp: null,
    stale: true,
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

export function mergeHyperliquidLiveMarketMessage(
  snapshot: HyperliquidMarketSnapshot,
  rawMessage: unknown,
  now: Date = new Date(),
): HyperliquidMarketSnapshot {
  const message = parseWebSocketMessage(rawMessage);
  if (!message) return snapshot;
  const channel = typeof message.channel === "string" ? message.channel : "";
  const data = message.data;

  if (channel === "allMids") {
    return mergeTimestampedComponent(
      snapshot,
      "market",
      messageTimestamp(message, data),
      () => mergeAllMids(snapshot, data, now),
    );
  }
  if (channel === "bbo") {
    return mergeTimestampedComponent(
      snapshot,
      "quote",
      messageTimestamp(message, data),
      () => mergeBbo(snapshot, data, now),
    );
  }
  if (channel === "l2Book") {
    return mergeBook(snapshot, data, now, messageTimestamp(message, data));
  }
  if (channel === "trades") {
    return mergeTimestampedComponent(
      snapshot,
      "trades",
      latestAcceptedTradeTimestamp(data, snapshot.coin),
      () => mergeTrades(snapshot, data, now),
    );
  }
  if (channel === "candle") {
    return mergeTimestampedComponent(
      snapshot,
      "candles",
      latestAcceptedCandleTimestamp(data, snapshot.coin, snapshot.interval),
      () => mergeCandles(snapshot, data, now),
    );
  }
  if (channel === "activeAssetCtx") {
    return mergeActiveAssetContext(snapshot, data, now, messageTimestamp(message, data));
  }
  return snapshot;
}

export function mergeHyperliquidFallbackSnapshot(
  preferred: HyperliquidMarketSnapshot,
  fallback: HyperliquidMarketSnapshot,
): HyperliquidMarketSnapshot {
  const preferredClocks = marketComponentClocks(preferred);
  const fallbackClocks = marketComponentClocks(fallback);
  const usePreferredQuote = preferSnapshotComponent(
    preferredClocks.quote,
    fallbackClocks.quote,
    preferred.best_bid != null || preferred.best_ask != null,
  );
  const usePreferredBook = preferSnapshotComponent(
    preferredClocks.book,
    fallbackClocks.book,
    preferred.bids.length > 0 || preferred.asks.length > 0,
  );
  const usePreferredMarket = preferSnapshotComponent(
    preferredClocks.market,
    fallbackClocks.market,
    preferred.mid != null,
  );
  const usePreferredMark = preferSnapshotComponent(
    preferredClocks.mark,
    fallbackClocks.mark,
    preferred.mark_price != null,
  );
  const usePreferredCandles = preferSnapshotComponent(
    preferredClocks.candles,
    fallbackClocks.candles,
    preferred.candles.length > 0,
  );
  const usePreferredTrades = preferSnapshotComponent(
    preferredClocks.trades,
    fallbackClocks.trades,
    preferred.recent_trades.length > 0,
  );
  const usePreferredFunding = preferSnapshotComponent(
    fundingRevisionMs(preferred),
    fundingRevisionMs(fallback),
    fundingRevisionMs(preferred) != null,
  );
  const fallbackQuoteAuthoritative = fallbackClocks.quote != null;
  const fallbackBookAuthoritative = fallbackClocks.book != null;
  const fallbackMarketAuthoritative = fallbackClocks.market != null;
  const fallbackMarkAuthoritative = fallbackClocks.mark != null;
  const fallbackCandlesAuthoritative = fallbackClocks.candles != null;
  const fallbackTradesAuthoritative = fallbackClocks.trades != null;
  const mergedCandles = fallbackCandlesAuthoritative && !usePreferredCandles && fallback.candles.length === 0
    ? []
    : usePreferredCandles
      ? mergeHyperliquidCandleWindows(fallback.candles, preferred.candles)
      : mergeHyperliquidCandleWindows(preferred.candles, fallback.candles);
  const merged = {
    ...fallback,
    mid: usePreferredMarket
      ? preferred.mid
      : fallbackMarketAuthoritative ? fallback.mid : fallback.mid ?? preferred.mid,
    best_bid: usePreferredQuote
      ? preferred.best_bid
      : fallbackQuoteAuthoritative ? fallback.best_bid : fallback.best_bid ?? preferred.best_bid,
    best_ask: usePreferredQuote
      ? preferred.best_ask
      : fallbackQuoteAuthoritative ? fallback.best_ask : fallback.best_ask ?? preferred.best_ask,
    spread_bps: usePreferredQuote
      ? preferred.spread_bps
      : fallbackQuoteAuthoritative ? fallback.spread_bps : fallback.spread_bps ?? preferred.spread_bps,
    mark_price: usePreferredMark
      ? preferred.mark_price
      : fallbackMarkAuthoritative ? fallback.mark_price : fallback.mark_price ?? preferred.mark_price,
    oracle_price: usePreferredMarket
      ? preferred.oracle_price
      : fallbackMarketAuthoritative ? fallback.oracle_price : fallback.oracle_price ?? preferred.oracle_price,
    prev_day_price: usePreferredMarket
      ? preferred.prev_day_price
      : fallbackMarketAuthoritative ? fallback.prev_day_price : fallback.prev_day_price ?? preferred.prev_day_price,
    day_notional_volume: usePreferredMarket
      ? preferred.day_notional_volume
      : fallbackMarketAuthoritative
        ? fallback.day_notional_volume
        : fallback.day_notional_volume ?? preferred.day_notional_volume,
    day_base_volume: usePreferredMarket
      ? preferred.day_base_volume
      : fallbackMarketAuthoritative ? fallback.day_base_volume : fallback.day_base_volume ?? preferred.day_base_volume,
    open_interest: usePreferredMarket
      ? preferred.open_interest
      : fallbackMarketAuthoritative ? fallback.open_interest : fallback.open_interest ?? preferred.open_interest,
    funding_rate: usePreferredFunding ? preferred.funding_rate : fallback.funding_rate,
    funding_rate_unit: usePreferredFunding ? preferred.funding_rate_unit : fallback.funding_rate_unit,
    funding_rate_source: usePreferredFunding ? preferred.funding_rate_source : fallback.funding_rate_source,
    funding_time_basis: usePreferredFunding ? preferred.funding_time_basis : fallback.funding_time_basis,
    funding_updated_at: usePreferredFunding ? preferred.funding_updated_at : fallback.funding_updated_at,
    premium: usePreferredMarket
      ? preferred.premium
      : fallbackMarketAuthoritative ? fallback.premium : fallback.premium ?? preferred.premium,
    max_leverage: usePreferredMarket
      ? preferred.max_leverage
      : fallbackMarketAuthoritative ? fallback.max_leverage : fallback.max_leverage ?? preferred.max_leverage,
    bids: usePreferredBook
      ? preferred.bids
      : fallbackBookAuthoritative ? fallback.bids : fallback.bids.length > 0 ? fallback.bids : preferred.bids,
    asks: usePreferredBook
      ? preferred.asks
      : fallbackBookAuthoritative ? fallback.asks : fallback.asks.length > 0 ? fallback.asks : preferred.asks,
    candles: mergedCandles,
    recent_trades: usePreferredTrades
      ? preferred.recent_trades
      : fallbackTradesAuthoritative
        ? fallback.recent_trades
        : fallback.recent_trades.length > 0 ? fallback.recent_trades : preferred.recent_trades,
    source_timestamp: latestOptionalTimestamp(preferred.source_timestamp, fallback.source_timestamp),
    stale: preferred.stale && fallback.stale,
  };
  return attachMarketComponentClocks(merged, {
    quote: usePreferredQuote ? preferredClocks.quote : fallbackClocks.quote ?? preferredClocks.quote,
    book: usePreferredBook ? preferredClocks.book : fallbackClocks.book ?? preferredClocks.book,
    market: usePreferredMarket ? preferredClocks.market : fallbackClocks.market ?? preferredClocks.market,
    mark: usePreferredMark ? preferredClocks.mark : fallbackClocks.mark ?? preferredClocks.mark,
    candles: usePreferredCandles ? preferredClocks.candles : fallbackClocks.candles ?? preferredClocks.candles,
    trades: usePreferredTrades ? preferredClocks.trades : fallbackClocks.trades ?? preferredClocks.trades,
  }, true);
}

function mergeHyperliquidCandleWindows(
  older: HyperliquidMarketSnapshot["candles"],
  newer: HyperliquidMarketSnapshot["candles"],
) {
  const byOpenTime = new Map(older.map((candle) => [candle.t, candle]));
  for (const candle of newer) byOpenTime.set(candle.t, candle);
  return Array.from(byOpenTime.values()).sort((left, right) => left.t - right.t).slice(-CANDLE_WINDOW);
}

class BrowserHyperliquidLiveMarketStream implements HyperliquidLiveMarketStream {
  private active = false;
  private socket: HyperliquidWebSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackInFlight = false;
  private reconnectAttempts = 0;
  private lastMessageAt = 0;
  private lastBookMessageAt = 0;
  private status: HyperliquidLiveMarketStatus = "connecting";
  private currentSnapshot: HyperliquidMarketSnapshot;

  constructor(private readonly options: HyperliquidLiveMarketStreamOptions) {
    this.currentSnapshot = options.initialSnapshot ?? emptyHyperliquidLiveMarketSnapshot({
      network: options.network,
      coin: options.coin,
      interval: options.interval,
    });
    this.lastMessageAt = this.now();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.emitStatus("connecting");
    this.fetchFallbackSnapshot();
    this.openSocket();
  }

  stop() {
    this.active = false;
    this.clearTimers();
    if (this.socket) {
      this.sendSubscriptions("unsubscribe");
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      try {
        this.socket.close();
      } catch {
        // Closing is best-effort; the stream is already inactive.
      }
      this.socket = null;
    }
  }

  private openSocket() {
    if (!this.active) return;
    const WebSocketCtor = this.options.webSocketCtor ?? (typeof WebSocket === "undefined" ? null : WebSocket);
    if (!WebSocketCtor) {
      this.emitStatus("fallback_polling");
      this.startFallbackLoop();
      return;
    }

    try {
      const socket = new WebSocketCtor(hyperliquidLiveMarketWebSocketUrl(this.options.network));
      this.socket = socket;
      socket.onopen = () => {
        if (!this.active || socket !== this.socket) return;
        this.reconnectAttempts = 0;
        this.lastMessageAt = this.now();
        this.lastBookMessageAt = 0;
        this.sendSubscriptions("subscribe");
        this.startHeartbeat();
        this.startStaleMonitor();
      };
      socket.onmessage = (event) => {
        if (!this.active || socket !== this.socket) return;
        const next = mergeHyperliquidLiveMarketMessage(this.currentSnapshot, event.data, new Date(this.now()));
        if (next !== this.currentSnapshot) {
          if (this.options.onSnapshot(next, "websocket") === false) {
            this.startFallbackLoop();
            return;
          }
          this.currentSnapshot = next;
          if (hasAuthoritativeDepthUpdate(next)) this.lastBookMessageAt = this.now();
          if (hasAuthoritativePricingUpdate(next)) {
            this.lastMessageAt = this.now();
            if (this.status !== "live") this.emitStatus("live");
          }
          if (this.hasHealthySocket() && this.hasHealthyBookSocket()) {
            this.clearFallbackTimer();
          } else {
            this.startFallbackLoop();
          }
        }
      };
      socket.onerror = () => {
        if (!this.active || socket !== this.socket) return;
        this.emitStatus("reconnecting");
        this.startFallbackLoop();
      };
      socket.onclose = () => {
        if (!this.active || socket !== this.socket) return;
        this.socket = null;
        this.stopHeartbeat();
        this.stopStaleMonitor();
        this.emitStatus("reconnecting");
        this.startFallbackLoop();
        this.scheduleReconnect();
      };
    } catch {
      this.emitStatus("blocked");
      this.startFallbackLoop();
      this.scheduleReconnect();
    }
  }

  private sendSubscriptions(method: "subscribe" | "unsubscribe") {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) return;
    for (const subscription of hyperliquidLiveMarketSubscriptions(this.options.coin, this.options.interval)) {
      this.sendJson({ method, subscription });
    }
  }

  private sendJson(payload: Record<string, unknown>) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      this.emitStatus("reconnecting");
      this.startFallbackLoop();
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendJson({ method: "ping" });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private startStaleMonitor() {
    this.stopStaleMonitor();
    this.staleTimer = setInterval(() => {
      if (!this.active || !this.socket || this.socket.readyState !== WEBSOCKET_OPEN) return;
      const pricingHealthy = this.now() - this.lastMessageAt <= STALE_AFTER_MS;
      if (!pricingHealthy) {
        this.emitStatus("stale");
        this.sendJson({ method: "ping" });
      }
      if (!pricingHealthy || !this.hasHealthyBookSocket()) this.startFallbackLoop();
    }, STALE_CHECK_MS);
  }

  private stopStaleMonitor() {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
  }

  private scheduleReconnect() {
    if (!this.active || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private startFallbackLoop() {
    if (!this.active || this.fallbackTimer || this.fallbackInFlight) return;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      this.fetchFallbackSnapshot();
    }, 0);
  }

  private fetchFallbackSnapshot() {
    if (!this.active || this.fallbackInFlight || !this.options.getFallbackSnapshot) return;
    this.fallbackInFlight = true;
    if (this.status !== "connecting" && this.status !== "live") this.emitStatus("fallback_polling");
    this.options.getFallbackSnapshot()
      .then((snapshot) => {
        if (!this.active) return;
        const merged = this.hasHealthySocket()
          ? mergeHyperliquidFallbackSnapshot(this.currentSnapshot, snapshot)
          : snapshot;
        if (this.options.onSnapshot(merged, "fallback") !== false) this.currentSnapshot = merged;
      })
      .catch(() => {
        if (!this.active) return;
        if (this.hasHealthySocket()) return;
        const stale = carryMarketComponentClocks(
          this.currentSnapshot,
          { ...this.currentSnapshot, stale: true },
        );
        if (this.options.onSnapshot(stale, "fallback") !== false) this.currentSnapshot = stale;
      })
      .finally(() => {
        this.fallbackInFlight = false;
        if (!this.active) return;
        if (this.hasHealthySocket() && this.hasHealthyBookSocket()) {
          this.clearFallbackTimer();
          return;
        }
        this.fallbackTimer = setTimeout(() => {
          this.fallbackTimer = null;
          this.fetchFallbackSnapshot();
        }, this.fallbackDelay());
      });
  }

  private hasHealthySocket() {
    return Boolean(
      this.socket &&
      this.socket.readyState === WEBSOCKET_OPEN &&
      this.status === "live" &&
      this.now() - this.lastMessageAt <= STALE_AFTER_MS,
    );
  }

  private hasHealthyBookSocket() {
    return Boolean(
      this.socket &&
      this.socket.readyState === WEBSOCKET_OPEN &&
      this.lastBookMessageAt > 0 &&
      this.now() - this.lastBookMessageAt <= STALE_AFTER_MS,
    );
  }

  private fallbackDelay() {
    return this.options.isDocumentHidden?.() ? FALLBACK_HIDDEN_MS : FALLBACK_VISIBLE_MS;
  }

  private emitStatus(status: HyperliquidLiveMarketStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private clearFallbackTimer() {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private clearTimers() {
    this.stopHeartbeat();
    this.stopStaleMonitor();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearFallbackTimer();
  }
}

function mergeAllMids(
  snapshot: HyperliquidMarketSnapshot,
  data: unknown,
  now: Date,
): HyperliquidMarketSnapshot {
  if (!data || typeof data !== "object" || Array.isArray(data)) return snapshot;
  const mids = (data as Record<string, unknown>).mids;
  if (!mids || typeof mids !== "object" || Array.isArray(mids)) return snapshot;
  const mid = safeDecimalString((mids as Record<string, unknown>)[snapshot.coin]);
  if (!mid) return snapshot;
  return touchSnapshot(snapshot, now, { mid });
}

function mergeBbo(
  snapshot: HyperliquidMarketSnapshot,
  data: unknown,
  now: Date,
): HyperliquidMarketSnapshot {
  if (!isObjectForCoin(data, snapshot.coin)) return snapshot;
  const row = data as Record<string, unknown>;
  const bbo = row.bbo;
  if (!Array.isArray(bbo)) return snapshot;
  const bid = normalizeBookLevel(bbo[0]);
  const ask = normalizeBookLevel(bbo[1]);
  if (!bid || !ask) return snapshot;
  const bestBid = bid.px;
  const bestAsk = ask.px;
  return touchSnapshot(snapshot, now, {
    source_timestamp: numberValue(row.time) ?? snapshot.source_timestamp,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps(bestBid, bestAsk),
  });
}

function mergeBook(
  snapshot: HyperliquidMarketSnapshot,
  data: unknown,
  now: Date,
  sourceTimestamp: unknown,
): HyperliquidMarketSnapshot {
  if (!isObjectForCoin(data, snapshot.coin)) return snapshot;
  const row = data as Record<string, unknown>;
  const levels = row.levels;
  if (!Array.isArray(levels) || !Array.isArray(levels[0]) || !Array.isArray(levels[1])) {
    return snapshot;
  }
  const timestamp = normalizeMarketTimestamp(sourceTimestamp);
  if (timestamp == null) return snapshot;
  const bids = normalizeBookSide(levels[0]);
  const asks = normalizeBookSide(levels[1]);
  const bestBid = bids[0]?.px ?? null;
  const bestAsk = asks[0]?.px ?? null;
  const clocks = marketComponentClocks(snapshot);
  const updates: Partial<Record<MarketComponent, number>> = {};
  const patch: Partial<HyperliquidMarketSnapshot> = {};

  if (componentAcceptsTimestamp(clocks.book, timestamp)) {
    patch.bids = bids;
    patch.asks = asks;
    updates.book = timestamp;
  }
  if (componentAcceptsTimestamp(clocks.quote, timestamp)) {
    patch.best_bid = bestBid;
    patch.best_ask = bestAsk;
    patch.spread_bps = spreadBps(bestBid, bestAsk);
    updates.quote = timestamp;
  }
  if (componentAcceptsTimestamp(clocks.market, timestamp)) {
    patch.mid = midFromBook(bestBid, bestAsk);
    updates.market = timestamp;
  }
  if (Object.keys(updates).length === 0) return snapshot;

  const next = touchSnapshot(snapshot, now, {
    ...patch,
    source_timestamp: latestSourceTimestamp(snapshot.source_timestamp, timestamp),
  });
  return advanceMarketComponents(snapshot, next, updates);
}

function mergeTrades(
  snapshot: HyperliquidMarketSnapshot,
  data: unknown,
  now: Date,
): HyperliquidMarketSnapshot {
  const rows = Array.isArray(data) ? data : [];
  const incoming = rows.map((item) => normalizeRecentTrade(item, snapshot.coin)).filter(Boolean) as HyperliquidMarketSnapshot["recent_trades"];
  if (incoming.length === 0) return snapshot;
  const seen = new Set<string>();
  const recent_trades = [...incoming, ...snapshot.recent_trades].sort(compareRecentTrades).filter((trade) => {
    const key = `${trade.time}:${trade.side}:${trade.px}:${trade.sz}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, RECENT_TRADE_WINDOW);
  return touchSnapshot(snapshot, now, { recent_trades });
}

function mergeCandles(
  snapshot: HyperliquidMarketSnapshot,
  data: unknown,
  now: Date,
): HyperliquidMarketSnapshot {
  const rows = Array.isArray(data) ? data : [data];
  const incoming = rows.map((item) => normalizeCandle(item, snapshot.coin, snapshot.interval)).filter(Boolean) as HyperliquidMarketSnapshot["candles"];
  if (incoming.length === 0) return snapshot;
  const byOpenTime = new Map(snapshot.candles.map((candle) => [candle.t, candle]));
  for (const candle of incoming) byOpenTime.set(candle.t, candle);
  const candles = Array.from(byOpenTime.values()).sort((a, b) => a.t - b.t).slice(-CANDLE_WINDOW);
  return touchSnapshot(snapshot, now, { candles });
}

function mergeActiveAssetContext(
  snapshot: HyperliquidMarketSnapshot,
  data: unknown,
  now: Date,
  sourceTimestamp: unknown,
): HyperliquidMarketSnapshot {
  if (!isObjectForCoin(data, snapshot.coin)) return snapshot;
  const ctx = (data as Record<string, unknown>).ctx;
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return snapshot;
  const row = ctx as Record<string, unknown>;
  const mid = safeDecimalString(row.midPx);
  const markPrice = safeDecimalString(row.markPx);
  const oraclePrice = safeDecimalString(row.oraclePx);
  const prevDayPrice = safeDecimalString(row.prevDayPx);
  const dayNotionalVolume = safeDecimalString(row.dayNtlVlm);
  const dayBaseVolume = safeDecimalString(row.dayBaseVlm);
  const openInterest = safeDecimalString(row.openInterest);
  const fundingRate = safeSignedDecimalString(row.funding);
  const premium = safeSignedDecimalString(row.premium);
  if (
    !mid && !markPrice && !oraclePrice && !prevDayPrice && !dayNotionalVolume &&
    !dayBaseVolume && !openInterest && !fundingRate && !premium
  ) return snapshot;
  const receivedAt = now.getTime();
  const priorFundingAt = isoTimestampMs(snapshot.funding_updated_at);
  const fundingIsFresh = fundingRate != null && Number.isFinite(receivedAt) &&
    (priorFundingAt == null || receivedAt >= priorFundingAt);
  const timestamp = normalizeMarketTimestamp(sourceTimestamp);
  const clocks = marketComponentClocks(snapshot);
  const marketTimestampFresh = timestamp != null && componentAcceptsTimestamp(clocks.market, timestamp);
  const marketIsFresh = Boolean(mid) && marketTimestampFresh;
  const markIsFresh = timestamp != null && Boolean(markPrice) && componentAcceptsTimestamp(clocks.mark, timestamp);
  const hasAncillary = Boolean(
    oraclePrice || prevDayPrice || dayNotionalVolume || dayBaseVolume ||
    openInterest || premium,
  );
  const ancillaryIsFresh = hasAncillary && marketTimestampFresh;
  if (!marketIsFresh && !markIsFresh && !ancillaryIsFresh && !fundingIsFresh) return snapshot;

  const patch: Partial<HyperliquidMarketSnapshot> = {
    ...(marketIsFresh ? { mid } : {}),
    ...(markIsFresh ? { mark_price: markPrice } : {}),
    ...(ancillaryIsFresh ? {
      oracle_price: oraclePrice ?? snapshot.oracle_price,
      prev_day_price: prevDayPrice ?? snapshot.prev_day_price,
      day_notional_volume: dayNotionalVolume ?? snapshot.day_notional_volume,
      day_base_volume: dayBaseVolume ?? snapshot.day_base_volume,
      open_interest: openInterest ?? snapshot.open_interest,
      premium: premium ?? snapshot.premium,
    } : {}),
    ...(fundingIsFresh ? {
      funding_rate: fundingRate,
      funding_rate_unit: "decimal_fraction",
      funding_rate_source: "hyperliquid_ws_active_asset_context_received",
      funding_time_basis: "received_at",
      funding_updated_at: now.toISOString(),
    } : {}),
    ...(timestamp == null ? {} : {
      source_timestamp: latestSourceTimestamp(snapshot.source_timestamp, timestamp),
    }),
  };
  const next = marketIsFresh || markIsFresh || ancillaryIsFresh
    ? touchSnapshot(snapshot, now, patch)
    : carryMarketComponentClocks(snapshot, {
        ...snapshot,
        ...patch,
        fetched_at: now.toISOString(),
      });
  return advanceMarketComponents(snapshot, next, {
    ...(marketIsFresh ? { market: timestamp } : {}),
    ...(markIsFresh ? { mark: timestamp } : {}),
  });
}

function mergeTimestampedComponent(
  snapshot: HyperliquidMarketSnapshot,
  component: MarketComponent,
  sourceTimestamp: unknown,
  merge: () => HyperliquidMarketSnapshot,
): HyperliquidMarketSnapshot {
  const timestamp = normalizeMarketTimestamp(sourceTimestamp);
  if (timestamp == null) return snapshot;
  if (!componentAcceptsTimestamp(marketComponentClocks(snapshot)[component], timestamp)) {
    return snapshot;
  }
  const merged = merge();
  if (merged === snapshot) return snapshot;
  const next = {
    ...merged,
    source_timestamp: latestSourceTimestamp(snapshot.source_timestamp, timestamp),
  };
  return advanceMarketComponent(snapshot, next, component, timestamp);
}

function componentAcceptsTimestamp(current: number | undefined, incoming: number): boolean {
  return current == null || incoming >= current;
}

function preferSnapshotComponent(
  preferredTimestamp: number | null | undefined,
  fallbackTimestamp: number | null | undefined,
  hasPreferredValue: boolean,
): boolean {
  if (preferredTimestamp != null) {
    return fallbackTimestamp == null || preferredTimestamp >= fallbackTimestamp;
  }
  return fallbackTimestamp == null && hasPreferredValue;
}

function latestSourceTimestamp(current: unknown, incoming: number): number {
  const normalized = normalizeMarketTimestamp(current);
  return normalized == null ? incoming : Math.max(normalized, incoming);
}

function latestOptionalTimestamp(left: unknown, right: unknown): number | null {
  const normalizedLeft = normalizeMarketTimestamp(left);
  const normalizedRight = normalizeMarketTimestamp(right);
  if (normalizedLeft == null) return normalizedRight;
  if (normalizedRight == null) return normalizedLeft;
  return Math.max(normalizedLeft, normalizedRight);
}

function isoTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function fundingRevisionMs(snapshot: HyperliquidMarketSnapshot): number | null {
  return inspectCanonicalFundingRate({
    rate: snapshot.funding_rate,
    unit: snapshot.funding_rate_unit,
    source: snapshot.funding_rate_source,
    timeBasis: snapshot.funding_time_basis,
    updatedAt: snapshot.funding_updated_at,
    venue: "hyperliquid",
  })?.updatedAtMs ?? null;
}

function touchSnapshot(
  snapshot: HyperliquidMarketSnapshot,
  now: Date,
  patch: Partial<HyperliquidMarketSnapshot>,
): HyperliquidMarketSnapshot {
  return {
    ...snapshot,
    ...patch,
    fetched_at: now.toISOString(),
    stale: false,
  };
}

function messageTimestamp(message: Record<string, unknown>, data: unknown): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const row = data as Record<string, unknown>;
    return row.time ?? row.timestamp ?? row.ts ?? message.time ?? message.timestamp;
  }
  return message.time ?? message.timestamp;
}

function latestAcceptedTradeTimestamp(
  value: unknown,
  coin: HyperliquidMarketCoin,
): number | null {
  const rows = Array.isArray(value) ? value : [value];
  return latestTimestamp(rows.map((row) => normalizeRecentTrade(row, coin)?.time ?? null));
}

function latestAcceptedCandleTimestamp(
  value: unknown,
  coin: HyperliquidMarketCoin,
  interval: HyperliquidCandleInterval,
): number | null {
  const rows = Array.isArray(value) ? value : [value];
  return latestTimestamp(rows.map((row) => normalizeCandle(row, coin, interval)?.t ?? null));
}

function latestTimestamp(values: Array<number | null>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value != null && (latest == null || value > latest)) latest = value;
  }
  return latest;
}

function compareRecentTrades(
  left: HyperliquidMarketSnapshot["recent_trades"][number],
  right: HyperliquidMarketSnapshot["recent_trades"][number],
) {
  return right.time - left.time
    || left.side.localeCompare(right.side)
    || left.px.localeCompare(right.px)
    || left.sz.localeCompare(right.sz);
}

function parseWebSocketMessage(rawMessage: unknown): Record<string, unknown> | null {
  const value = typeof MessageEvent !== "undefined" && rawMessage instanceof MessageEvent
    ? rawMessage.data
    : rawMessage;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isObjectForCoin(value: unknown, coin: HyperliquidMarketCoin) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rowCoin = (value as Record<string, unknown>).coin;
  return rowCoin == null || rowCoin === coin;
}

function normalizeBookSide(value: unknown): HyperliquidMarketSnapshot["bids"] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, BOOK_LEVEL_WINDOW).map(normalizeBookLevel).filter(Boolean) as HyperliquidMarketSnapshot["bids"];
}

function normalizeBookLevel(value: unknown): HyperliquidMarketSnapshot["bids"][number] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const px = safeDecimalString(row.px);
  const sz = safeDecimalString(row.sz);
  const n = numberValue(row.n);
  return px && sz ? { px, sz, n } : null;
}

function normalizeRecentTrade(
  value: unknown,
  coin: HyperliquidMarketCoin,
): HyperliquidMarketSnapshot["recent_trades"][number] | null {
  if (!isObjectForCoin(value, coin)) return null;
  const row = value as Record<string, unknown>;
  const px = safeDecimalString(row.px);
  const sz = safeDecimalString(row.sz);
  const time = numberValue(row.time);
  const side = row.side === "B" || row.side === "buy" ? "buy" : row.side === "A" || row.side === "sell" ? "sell" : null;
  return px && sz && time && side ? { side, px, sz, time } : null;
}

function normalizeCandle(
  value: unknown,
  coin: HyperliquidMarketCoin,
  interval: HyperliquidCandleInterval,
): HyperliquidMarketSnapshot["candles"][number] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.s != null && row.s !== coin) return null;
  if (row.i != null && row.i !== interval) return null;
  const t = numberValue(row.t);
  const T = numberValue(row.T);
  const o = safeDecimalString(row.o);
  const h = safeDecimalString(row.h);
  const l = safeDecimalString(row.l);
  const c = safeDecimalString(row.c);
  const v = safeDecimalString(row.v) ?? "0";
  const n = numberValue(row.n);
  return t && o && h && l && c ? { t, T, o, h, l, c, v, n } : null;
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

function spreadBps(bestBid: string | null, bestAsk: string | null) {
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
  return String((bid + ask) / 2);
}
