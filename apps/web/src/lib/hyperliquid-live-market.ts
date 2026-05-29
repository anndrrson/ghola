import type { HyperliquidMarketSnapshot } from "./private-account-client";

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
  onSnapshot: (snapshot: HyperliquidMarketSnapshot) => void;
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

  if (channel === "allMids") return mergeAllMids(snapshot, data, now);
  if (channel === "bbo") return mergeBbo(snapshot, data, now);
  if (channel === "l2Book") return mergeBook(snapshot, data, now);
  if (channel === "trades") return mergeTrades(snapshot, data, now);
  if (channel === "candle") return mergeCandles(snapshot, data, now);
  if (channel === "activeAssetCtx") return mergeActiveAssetContext(snapshot, data, now);
  return snapshot;
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
        this.emitStatus("live");
        this.clearFallbackTimer();
        this.sendSubscriptions("subscribe");
        this.startHeartbeat();
        this.startStaleMonitor();
      };
      socket.onmessage = (event) => {
        if (!this.active || socket !== this.socket) return;
        this.lastMessageAt = this.now();
        if (this.status !== "live") {
          this.emitStatus("live");
          this.clearFallbackTimer();
        }
        const next = mergeHyperliquidLiveMarketMessage(this.currentSnapshot, event.data, new Date(this.now()));
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
      if (this.now() - this.lastMessageAt <= STALE_AFTER_MS) return;
      this.emitStatus("stale");
      this.startFallbackLoop();
      this.sendJson({ method: "ping" });
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
        this.currentSnapshot = snapshot;
        this.options.onSnapshot(snapshot);
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
        if (this.hasHealthySocket()) {
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
  const bids = bid ? replaceTopBookLevel(snapshot.bids, bid) : snapshot.bids;
  const asks = ask ? replaceTopBookLevel(snapshot.asks, ask) : snapshot.asks;
  const bestBid = bid?.px ?? snapshot.best_bid;
  const bestAsk = ask?.px ?? snapshot.best_ask;
  return touchSnapshot(snapshot, now, {
    source_timestamp: numberValue(row.time) ?? snapshot.source_timestamp,
    bids,
    asks,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps(bestBid, bestAsk),
  });
}

function mergeBook(
  snapshot: HyperliquidMarketSnapshot,
  data: unknown,
  now: Date,
): HyperliquidMarketSnapshot {
  if (!isObjectForCoin(data, snapshot.coin)) return snapshot;
  const row = data as Record<string, unknown>;
  const levels = row.levels;
  if (!Array.isArray(levels)) return snapshot;
  const bids = normalizeBookSide(levels[0]);
  const asks = normalizeBookSide(levels[1]);
  const bestBid = bids[0]?.px ?? snapshot.best_bid;
  const bestAsk = asks[0]?.px ?? snapshot.best_ask;
  return touchSnapshot(snapshot, now, {
    source_timestamp: numberValue(row.time) ?? snapshot.source_timestamp,
    bids,
    asks,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps(bestBid, bestAsk),
  });
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
  const recent_trades = [...incoming, ...snapshot.recent_trades].filter((trade) => {
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
): HyperliquidMarketSnapshot {
  if (!isObjectForCoin(data, snapshot.coin)) return snapshot;
  const ctx = (data as Record<string, unknown>).ctx;
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return snapshot;
  const row = ctx as Record<string, unknown>;
  const mid = safeDecimalString(row.midPx) ?? snapshot.mid;
  return touchSnapshot(snapshot, now, {
    mid,
    mark_price: safeDecimalString(row.markPx) ?? snapshot.mark_price,
    oracle_price: safeDecimalString(row.oraclePx) ?? snapshot.oracle_price,
    prev_day_price: safeDecimalString(row.prevDayPx) ?? snapshot.prev_day_price,
    day_notional_volume: safeDecimalString(row.dayNtlVlm) ?? snapshot.day_notional_volume,
    day_base_volume: safeDecimalString(row.dayBaseVlm) ?? snapshot.day_base_volume,
    open_interest: safeDecimalString(row.openInterest) ?? snapshot.open_interest,
    funding_rate: safeSignedDecimalString(row.funding) ?? snapshot.funding_rate,
    premium: safeSignedDecimalString(row.premium) ?? snapshot.premium,
  });
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

function replaceTopBookLevel(
  levels: HyperliquidMarketSnapshot["bids"],
  top: HyperliquidMarketSnapshot["bids"][number],
) {
  return [top, ...levels.filter((level) => level.px !== top.px)].slice(0, BOOK_LEVEL_WINDOW);
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
