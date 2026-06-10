import {
  COINBASE_BOOK_LEVEL_WINDOW,
  COINBASE_CANDLE_WINDOW,
  COINBASE_RECENT_TRADE_WINDOW,
  emptyCoinbaseMarketSnapshot,
  normalizeCoinbaseCandles,
  normalizeCoinbaseTrades,
  normalizeSide,
  readRecord,
  safeDecimalString,
  safeSignedDecimalString,
  spreadBps,
  timeValue,
  type CoinbaseCandleInterval,
  type CoinbaseMarketSnapshot,
  type CoinbaseProductId,
  type CoinbaseRecentTrade,
} from "./coinbase-market-data";

export type CoinbaseLiveMarketStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "fallback_polling"
  | "stale"
  | "blocked";

type CoinbaseWebSocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

export type CoinbaseWebSocketConstructor = new (url: string) => CoinbaseWebSocketLike;

export interface CoinbaseLiveMarketStream {
  start: () => void;
  stop: () => void;
}

export interface CoinbaseLiveMarketStreamOptions {
  productId: CoinbaseProductId;
  interval: CoinbaseCandleInterval;
  initialSnapshot?: CoinbaseMarketSnapshot | null;
  webSocketCtor?: CoinbaseWebSocketConstructor | null;
  getFallbackSnapshot?: () => Promise<CoinbaseMarketSnapshot>;
  onSnapshot: (snapshot: CoinbaseMarketSnapshot) => void;
  onStatus: (status: CoinbaseLiveMarketStatus) => void;
  isDocumentHidden?: () => boolean;
  now?: () => number;
}

const WS_URL = "wss://advanced-trade-ws.coinbase.com";
const WEBSOCKET_OPEN = 1;
const STALE_AFTER_MS = 10_000;
const STALE_CHECK_MS = 3_000;
const FALLBACK_VISIBLE_MS = 4_000;
const FALLBACK_HIDDEN_MS = 15_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const WEBSOCKET_CANDLE_INTERVAL: CoinbaseCandleInterval = "5m";

type CoinbaseChannel = "heartbeats" | "ticker" | "level2" | "market_trades" | "candles";

export function createCoinbaseLiveMarketStream(
  options: CoinbaseLiveMarketStreamOptions,
): CoinbaseLiveMarketStream {
  return new BrowserCoinbaseLiveMarketStream(options);
}

export function coinbaseLiveMarketWebSocketUrl(): string {
  return WS_URL;
}

export function coinbaseLiveMarketSubscriptions(
  productId: CoinbaseProductId,
): Array<{ type: "subscribe"; channel: CoinbaseChannel; product_ids?: CoinbaseProductId[] }> {
  return [
    { type: "subscribe", channel: "heartbeats" },
    { type: "subscribe", channel: "ticker", product_ids: [productId] },
    { type: "subscribe", channel: "level2", product_ids: [productId] },
    { type: "subscribe", channel: "market_trades", product_ids: [productId] },
    { type: "subscribe", channel: "candles", product_ids: [productId] },
  ];
}

class BrowserCoinbaseLiveMarketStream implements CoinbaseLiveMarketStream {
  private active = false;
  private socket: CoinbaseWebSocketLike | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackInFlight = false;
  private reconnectAttempts = 0;
  private lastMessageAt = 0;
  private status: CoinbaseLiveMarketStatus = "connecting";
  private currentSnapshot: CoinbaseMarketSnapshot;

  constructor(private readonly options: CoinbaseLiveMarketStreamOptions) {
    this.currentSnapshot =
      options.initialSnapshot ??
      emptyCoinbaseMarketSnapshot({
        productId: options.productId,
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
        // Best effort; the stream is inactive already.
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
      const socket = new WebSocketCtor(coinbaseLiveMarketWebSocketUrl());
      this.socket = socket;
      socket.onopen = () => {
        if (!this.active || socket !== this.socket) return;
        this.reconnectAttempts = 0;
        this.lastMessageAt = this.now();
        this.emitStatus("live");
        if (this.shouldContinueFallbackPolling()) this.startFallbackLoop();
        else this.clearFallbackTimer();
        this.sendSubscriptions("subscribe");
        this.startStaleMonitor();
      };
      socket.onmessage = (event) => {
        if (!this.active || socket !== this.socket) return;
        this.lastMessageAt = this.now();
        if (this.status !== "live") {
          this.emitStatus("live");
          if (this.shouldContinueFallbackPolling()) this.startFallbackLoop();
          else this.clearFallbackTimer();
        }
        const next = mergeCoinbaseLiveMarketMessage(
          this.currentSnapshot,
          event.data,
          this.options.interval,
          new Date(this.now()),
        );
        if (next !== this.currentSnapshot) {
          this.currentSnapshot = next;
          this.options.onSnapshot(next);
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

  private sendSubscriptions(type: "subscribe" | "unsubscribe") {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) return;
    for (const subscription of coinbaseLiveMarketSubscriptions(this.options.productId)) {
      this.sendJson({ ...subscription, type });
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

  private startStaleMonitor() {
    this.stopStaleMonitor();
    this.staleTimer = setInterval(() => {
      if (!this.active || !this.socket || this.socket.readyState !== WEBSOCKET_OPEN) return;
      if (this.now() - this.lastMessageAt <= STALE_AFTER_MS) return;
      this.emitStatus("stale");
      this.startFallbackLoop();
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
    this.options
      .getFallbackSnapshot()
      .then((snapshot) => {
        if (!this.active) return;
        const merged = this.hasHealthySocket()
          ? mergeCoinbaseFallbackSnapshot(this.currentSnapshot, snapshot)
          : snapshot.recent_trades.length === 0 && this.currentSnapshot.recent_trades.length > 0
            ? { ...snapshot, recent_trades: this.currentSnapshot.recent_trades }
            : snapshot;
        this.currentSnapshot = merged;
        this.options.onSnapshot(merged);
      })
      .catch(() => {
        if (!this.active) return;
        const stale = { ...this.currentSnapshot, fetched_at: new Date(this.now()).toISOString(), stale: true };
        this.currentSnapshot = stale;
        this.options.onSnapshot(stale);
      })
      .finally(() => {
        this.fallbackInFlight = false;
        if (!this.active) return;
        if (this.hasHealthySocket() && !this.shouldContinueFallbackPolling()) {
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

  private shouldContinueFallbackPolling() {
    return this.options.interval !== WEBSOCKET_CANDLE_INTERVAL;
  }

  private fallbackDelay() {
    return this.options.isDocumentHidden?.() ? FALLBACK_HIDDEN_MS : FALLBACK_VISIBLE_MS;
  }

  private emitStatus(status: CoinbaseLiveMarketStatus) {
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
    this.stopStaleMonitor();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearFallbackTimer();
  }
}

export function mergeCoinbaseLiveMarketMessage(
  snapshot: CoinbaseMarketSnapshot,
  rawMessage: unknown,
  interval: CoinbaseCandleInterval = snapshot.interval,
  now: Date = new Date(),
): CoinbaseMarketSnapshot {
  const message = parseWebSocketMessage(rawMessage);
  if (!message) return snapshot;
  const channel = typeof message.channel === "string" ? message.channel : "";
  if (channel === "ticker" || channel === "ticker_batch") return mergeCoinbaseTicker(snapshot, message, now);
  if (channel === "l2_data" || channel === "level2") return mergeCoinbaseLevel2(snapshot, message, now);
  if (channel === "market_trades") return mergeCoinbaseMarketTrades(snapshot, message, now);
  if (channel === "candles") return mergeCoinbaseCandles(snapshot, message, interval, now);
  if (channel === "heartbeats") return touch(snapshot, now, {});
  return snapshot;
}

export function mergeCoinbaseTicker(
  snapshot: CoinbaseMarketSnapshot,
  message: Record<string, unknown>,
  now: Date,
): CoinbaseMarketSnapshot {
  let patch: Partial<CoinbaseMarketSnapshot> | null = null;
  for (const event of eventRows(message)) {
    const tickers = readRecord(event)?.tickers;
    if (!Array.isArray(tickers)) continue;
    for (const ticker of tickers) {
      const row = readRecord(ticker);
      if (!row || row.product_id !== snapshot.product_id) continue;
      const bestBid = safeDecimalString(row.best_bid) ?? snapshot.best_bid;
      const bestAsk = safeDecimalString(row.best_ask) ?? snapshot.best_ask;
      patch = {
        price: safeDecimalString(row.price) ?? snapshot.price,
        mid: safeDecimalString(row.price) ?? snapshot.mid,
        best_bid: bestBid,
        best_ask: bestAsk,
        spread_bps: spreadBps(bestBid, bestAsk),
        price_percentage_change_24h: safeSignedDecimalString(row.price_percent_chg_24_h) ?? snapshot.price_percentage_change_24h,
        volume_24h: safeDecimalString(row.volume_24_h) ?? snapshot.volume_24h,
      };
    }
  }
  return patch ? touch(snapshot, now, patch) : snapshot;
}

export function mergeCoinbaseLevel2(
  snapshot: CoinbaseMarketSnapshot,
  message: Record<string, unknown>,
  now: Date,
): CoinbaseMarketSnapshot {
  let nextBids = snapshot.bids;
  let nextAsks = snapshot.asks;
  let changed = false;
  for (const event of eventRows(message)) {
    const row = readRecord(event);
    if (!row || row.product_id !== snapshot.product_id) continue;
    const updates = row.updates;
    if (!Array.isArray(updates)) continue;
    const snapshotEvent = row.type === "snapshot";
    if (snapshotEvent) {
      nextBids = [];
      nextAsks = [];
    }
    for (const update of updates) {
      const level = normalizeLevel2Update(update);
      if (!level) continue;
      if (level.side === "bid") nextBids = applyBookLevel(nextBids, level);
      if (level.side === "ask") nextAsks = applyBookLevel(nextAsks, level);
      changed = true;
    }
  }
  if (!changed) return snapshot;
  const bestBid = nextBids[0]?.px ?? null;
  const bestAsk = nextAsks[0]?.px ?? null;
  return touch(snapshot, now, {
    bids: nextBids,
    asks: nextAsks,
    best_bid: bestBid,
    best_ask: bestAsk,
    mid: midFromBook(bestBid, bestAsk) ?? snapshot.mid,
    spread_bps: spreadBps(bestBid, bestAsk) ?? snapshot.spread_bps,
    source_timestamp: timeValue(message.timestamp) ?? snapshot.source_timestamp,
  });
}

export function mergeCoinbaseFallbackSnapshot(
  preferred: CoinbaseMarketSnapshot,
  fallback: CoinbaseMarketSnapshot,
): CoinbaseMarketSnapshot {
  const preferredLive = preferred.source === "websocket" && !preferred.stale;
  return {
    ...fallback,
    price: preferredLive ? preferred.price ?? fallback.price : fallback.price ?? preferred.price,
    mid: preferredLive ? preferred.mid ?? fallback.mid : fallback.mid ?? preferred.mid,
    best_bid: preferredLive ? preferred.best_bid ?? fallback.best_bid : fallback.best_bid ?? preferred.best_bid,
    best_ask: preferredLive ? preferred.best_ask ?? fallback.best_ask : fallback.best_ask ?? preferred.best_ask,
    spread_bps: preferredLive ? preferred.spread_bps ?? fallback.spread_bps : fallback.spread_bps ?? preferred.spread_bps,
    bids: preferredLive && preferred.bids.length > 0 ? preferred.bids : fallback.bids.length > 0 ? fallback.bids : preferred.bids,
    asks: preferredLive && preferred.asks.length > 0 ? preferred.asks : fallback.asks.length > 0 ? fallback.asks : preferred.asks,
    recent_trades: preferredLive && preferred.recent_trades.length > 0
      ? dedupeTrades([...preferred.recent_trades, ...fallback.recent_trades])
      : fallback.recent_trades.length > 0
        ? fallback.recent_trades
        : preferred.recent_trades,
    candles: fallback.candles.length > 0 ? fallback.candles : preferred.candles,
    source: preferredLive ? "websocket" : fallback.source ?? preferred.source,
    source_timestamp: preferredLive
      ? preferred.source_timestamp ?? fallback.source_timestamp
      : fallback.source_timestamp ?? preferred.source_timestamp,
    stale: preferredLive ? false : fallback.stale && preferred.stale,
  };
}

export function mergeCoinbaseMarketTrades(
  snapshot: CoinbaseMarketSnapshot,
  message: Record<string, unknown>,
  now: Date,
): CoinbaseMarketSnapshot {
  const incoming: CoinbaseRecentTrade[] = [];
  for (const event of eventRows(message)) {
    const trades = readRecord(event)?.trades;
    if (!Array.isArray(trades)) continue;
    incoming.push(...normalizeCoinbaseTrades(trades).filter((trade) => {
      const row = trades.find((item) => {
        const record = readRecord(item);
        return record?.trade_id === trade.trade_id || record?.time === new Date(trade.time).toISOString();
      });
      return !row || readRecord(row)?.product_id === snapshot.product_id;
    }));
  }
  if (incoming.length === 0) return snapshot;
  const recent_trades = dedupeTrades([...incoming, ...snapshot.recent_trades]);
  const latest = incoming[0];
  return touch(snapshot, now, {
    recent_trades,
    price: latest?.px ?? snapshot.price,
    mid: snapshot.mid ?? latest?.px ?? null,
    source_timestamp: latest?.time ?? snapshot.source_timestamp,
  });
}

export function mergeCoinbaseCandles(
  snapshot: CoinbaseMarketSnapshot,
  message: Record<string, unknown>,
  interval: CoinbaseCandleInterval,
  now: Date,
): CoinbaseMarketSnapshot {
  if (interval !== WEBSOCKET_CANDLE_INTERVAL) return snapshot;
  const incoming = [];
  for (const event of eventRows(message)) {
    const candles = readRecord(event)?.candles;
    if (!Array.isArray(candles)) continue;
    incoming.push(...normalizeCoinbaseCandles(candles).filter((candle) => {
      const raw = candles.find((item) => timeValue(readRecord(item)?.start) === candle.t);
      return !raw || readRecord(raw)?.product_id === snapshot.product_id;
    }));
  }
  if (incoming.length === 0) return snapshot;
  const byTime = new Map(snapshot.candles.map((candle) => [candle.t, candle]));
  for (const candle of incoming) byTime.set(candle.t, candle);
  const candles = Array.from(byTime.values())
    .sort((a, b) => a.t - b.t)
    .slice(-COINBASE_CANDLE_WINDOW);
  return touch(snapshot, now, { candles });
}

function parseWebSocketMessage(rawMessage: unknown): Record<string, unknown> | null {
  const value = typeof MessageEvent !== "undefined" && rawMessage instanceof MessageEvent
    ? rawMessage.data
    : rawMessage;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return readRecord(parsed);
    } catch {
      return null;
    }
  }
  return readRecord(value);
}

function eventRows(message: Record<string, unknown>) {
  return Array.isArray(message.events) ? message.events : [];
}

function normalizeLevel2Update(value: unknown): { side: "bid" | "ask"; px: string; sz: string } | null {
  const row = readRecord(value);
  if (!row) return null;
  const px = safeDecimalString(row.price_level);
  const sz = safeDecimalString(row.new_quantity) ?? "0";
  const side = normalizeSide(row.side);
  if (!px || !side) return null;
  return { side: side === "buy" ? "bid" : "ask", px, sz };
}

function applyBookLevel(
  levels: CoinbaseMarketSnapshot["bids"],
  level: { side: "bid" | "ask"; px: string; sz: string },
): CoinbaseMarketSnapshot["bids"] {
  const size = Number(level.sz);
  const next = levels.filter((item) => item.px !== level.px);
  if (Number.isFinite(size) && size > 0) next.push({ px: level.px, sz: level.sz, n: null });
  next.sort((a, b) => {
    const left = Number(a.px);
    const right = Number(b.px);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
    return level.side === "bid" ? right - left : left - right;
  });
  return next.slice(0, COINBASE_BOOK_LEVEL_WINDOW);
}

function dedupeTrades(trades: CoinbaseRecentTrade[]) {
  const seen = new Set<string>();
  return trades
    .filter((trade) => {
      const key = trade.trade_id || `${trade.time}:${trade.side}:${trade.px}:${trade.sz}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, COINBASE_RECENT_TRADE_WINDOW);
}

function touch(
  snapshot: CoinbaseMarketSnapshot,
  now: Date,
  patch: Partial<CoinbaseMarketSnapshot>,
): CoinbaseMarketSnapshot {
  return {
    ...snapshot,
    ...patch,
    fetched_at: now.toISOString(),
    source: "websocket",
    stale: false,
  };
}

function midFromBook(bestBid: string | null, bestAsk: string | null): string | null {
  if (!bestBid || !bestAsk) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  return String((bid + ask) / 2);
}
