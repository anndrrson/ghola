// Phoenix live SOL market stream — the dual-feed fusion.
//
// The `@ellipsis-labs/rise` SDK already fuses the perp-api.phoenix.trade WebSocket
// (live deltas) with a Solana RPC bootstrap/fallback. We run it in the browser
// (symmetric with `hyperliquid-live-market.ts`, which connects its WS directly) and
// consume its async-iterable adapters, merging each update into one immutable
// `PhoenixMarketSnapshot`. A REST `getFallbackSnapshot` covers CORS/connection
// failures so the chart never blank-screens.
//
// Lifecycle/scaffolding (reconnect backoff, stale monitor, visible/hidden fallback
// cadence, immutable-snapshot reducer) mirrors `BrowserHyperliquidLiveMarketStream`.

import { createPhoenixClient } from "@ellipsis-labs/rise";
import {
  PHOENIX_BOOK_LEVEL_WINDOW,
  PHOENIX_CANDLE_WINDOW,
  PHOENIX_RECENT_TRADE_WINDOW,
  emptyPhoenixMarketSnapshot,
  normalizeMarketFills,
  numberValue,
  phoenixApiUrl,
  phoenixRpcUrl,
  readRecord,
  safeDecimalString,
  safeSignedDecimalString,
  spreadBps,
  type PhoenixCandle,
  type PhoenixCandleInterval,
  type PhoenixMarketSnapshot,
  type PhoenixMarketSymbol,
  type PhoenixRecentTrade,
} from "./phoenix-market-data";

export type PhoenixLiveMarketStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "fallback_polling"
  | "stale"
  | "blocked";

export interface PhoenixLiveMarketStream {
  start: () => void;
  stop: () => void;
}

export interface PhoenixLiveMarketStreamOptions {
  symbol: PhoenixMarketSymbol;
  interval: PhoenixCandleInterval;
  apiUrl?: string;
  rpcWsUrl?: string;
  initialSnapshot?: PhoenixMarketSnapshot | null;
  getFallbackSnapshot?: () => Promise<PhoenixMarketSnapshot>;
  onSnapshot: (snapshot: PhoenixMarketSnapshot) => void;
  onStatus: (status: PhoenixLiveMarketStatus) => void;
  isDocumentHidden?: () => boolean;
  now?: () => number;
  createClient?: typeof createPhoenixClient;
}

const STALE_AFTER_MS = 10_000;
const STALE_CHECK_MS = 3_000;
const FALLBACK_VISIBLE_MS = 4_000;
const FALLBACK_HIDDEN_MS = 15_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const TRADES_POLL_MS = 2_500;
const EXCHANGE_READY_TIMEOUT_MS = 6_000;

export function createPhoenixLiveMarketStream(
  options: PhoenixLiveMarketStreamOptions,
): PhoenixLiveMarketStream {
  return new BrowserPhoenixLiveMarketStream(options);
}

class BrowserPhoenixLiveMarketStream implements PhoenixLiveMarketStream {
  private active = false;
  private client: ReturnType<typeof createPhoenixClient> | null = null;
  private abort: AbortController | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private tradesTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackInFlight = false;
  private reconnectAttempts = 0;
  private reconnecting = false;
  private lastMessageAt = 0;
  private status: PhoenixLiveMarketStatus = "connecting";
  private currentSnapshot: PhoenixMarketSnapshot;

  constructor(private readonly options: PhoenixLiveMarketStreamOptions) {
    this.currentSnapshot =
      options.initialSnapshot ??
      emptyPhoenixMarketSnapshot({ symbol: options.symbol, interval: options.interval });
    this.lastMessageAt = this.now();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.emitStatus("connecting");
    this.fetchFallbackSnapshot();
    this.openClient();
  }

  stop() {
    this.active = false;
    this.clearTimers();
    this.teardownClient();
  }

  private openClient() {
    if (!this.active) return;
    if (typeof WebSocket === "undefined" || typeof window === "undefined") {
      this.emitStatus("fallback_polling");
      this.startFallbackLoop();
      return;
    }
    const create = this.options.createClient ?? createPhoenixClient;
    let client: ReturnType<typeof createPhoenixClient>;
    try {
      client = create({
        apiUrl: phoenixApiUrl(this.options.apiUrl),
        rpcUrl: phoenixRpcUrl(this.options.rpcWsUrl),
        ws: {},
        exchangeMetadata: { stream: true },
      });
    } catch {
      this.emitStatus("blocked");
      this.startFallbackLoop();
      this.scheduleReconnect();
      return;
    }
    this.client = client;
    this.reconnecting = false;
    const abort = new AbortController();
    this.abort = abort;
    void this.runClient(client, abort.signal);
    this.startStaleMonitor();
    this.startTradesPoll();
  }

  private async runClient(client: ReturnType<typeof createPhoenixClient>, signal: AbortSignal) {
    // Best-effort metadata load so symbol -> market resolution works for candles/market.
    try {
      await withTimeout(client.exchange?.ready?.(), EXCHANGE_READY_TIMEOUT_MS, signal);
    } catch {
      // Adapters may still work; if not, the consumer loops fall back.
    }
    if (signal.aborted || !this.active) return;

    const streams = client.streams;
    if (!streams) {
      this.handleStreamError();
      return;
    }
    const { symbol, interval } = this.options;
    const loops: Array<Promise<void>> = [
      this.consume(signal, () => streams.l2Book(symbol, signal), (s, u) => mergePhoenixBook(s, u, new Date(this.now()))),
      this.consume(signal, () => streams.market(symbol, signal), (s, u) => mergePhoenixMarket(s, u, new Date(this.now()))),
      this.consume(signal, () => streams.markPrice(symbol, signal), (s, u) => mergePhoenixMarkPrice(s, u, new Date(this.now()))),
      this.consume(signal, () => streams.candles(symbol, interval, signal), (s, u) => mergePhoenixCandle(s, u, interval, new Date(this.now()))),
    ];
    await Promise.allSettled(loops);
    // All adapters ended while we are still meant to be live -> treat as a drop.
    if (this.active && !signal.aborted) this.handleStreamError();
  }

  private async consume(
    signal: AbortSignal,
    make: () => AsyncIterable<unknown>,
    apply: (snapshot: PhoenixMarketSnapshot, update: unknown) => PhoenixMarketSnapshot,
  ) {
    try {
      for await (const update of make()) {
        if (signal.aborted || !this.active) return;
        this.markMessage();
        this.applyPatch((snapshot) => apply(snapshot, update));
      }
    } catch {
      if (this.active && !signal.aborted) this.handleStreamError();
    }
  }

  private applyPatch(reducer: (snapshot: PhoenixMarketSnapshot) => PhoenixMarketSnapshot) {
    const next = reducer(this.currentSnapshot);
    if (next !== this.currentSnapshot) {
      this.currentSnapshot = next;
      this.options.onSnapshot(next);
    }
  }

  private markMessage() {
    this.lastMessageAt = this.now();
    this.reconnectAttempts = 0;
    if (this.status !== "live") {
      this.emitStatus("live");
      this.clearFallbackTimer();
    }
  }

  private handleStreamError() {
    if (!this.active || this.reconnecting) return;
    this.reconnecting = true;
    this.emitStatus("reconnecting");
    this.teardownClient();
    this.startFallbackLoop();
    this.scheduleReconnect();
  }

  private startStaleMonitor() {
    this.stopStaleMonitor();
    this.staleTimer = setInterval(() => {
      if (!this.active || !this.client) return;
      if (this.now() - this.lastMessageAt <= STALE_AFTER_MS) return;
      this.emitStatus("stale");
      this.startFallbackLoop();
    }, STALE_CHECK_MS);
  }

  private stopStaleMonitor() {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
  }

  // The perp-api WS has no public trade channel; poll REST market fills for the tape.
  private startTradesPoll() {
    this.stopTradesPoll();
    const poll = async () => {
      this.tradesTimer = null;
      if (!this.active || !this.client) return;
      try {
        const fills = await this.client.api
          .trades()
          .getMarketFills(this.options.symbol, { limit: PHOENIX_RECENT_TRADE_WINDOW });
        if (!this.active) return;
        const trades = normalizeMarketFills(fills);
        if (trades.length > 0) {
          this.applyPatch((snapshot) => mergePhoenixTrades(snapshot, trades, new Date(this.now())));
        }
      } catch {
        // Tape is best-effort; ignore and retry on the next tick.
      } finally {
        if (this.active && this.client) this.tradesTimer = setTimeout(poll, TRADES_POLL_MS);
      }
    };
    this.tradesTimer = setTimeout(poll, 0);
  }

  private stopTradesPoll() {
    if (this.tradesTimer) clearTimeout(this.tradesTimer);
    this.tradesTimer = null;
  }

  private scheduleReconnect() {
    if (!this.active || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openClient();
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
        // Preserve any live tape we already have if the REST snapshot lacks it.
        const merged =
          snapshot.recent_trades.length === 0 && this.currentSnapshot.recent_trades.length > 0
            ? {
                ...snapshot,
                recent_trades: this.currentSnapshot.recent_trades,
                trades_updated_at: this.currentSnapshot.trades_updated_at,
              }
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
        if (this.hasHealthyClient()) {
          this.clearFallbackTimer();
          return;
        }
        this.fallbackTimer = setTimeout(() => {
          this.fallbackTimer = null;
          this.fetchFallbackSnapshot();
        }, this.fallbackDelay());
      });
  }

  private hasHealthyClient() {
    return Boolean(this.client && this.status === "live" && this.now() - this.lastMessageAt <= STALE_AFTER_MS);
  }

  private fallbackDelay() {
    return this.options.isDocumentHidden?.() ? FALLBACK_HIDDEN_MS : FALLBACK_VISIBLE_MS;
  }

  private teardownClient() {
    this.stopStaleMonitor();
    this.stopTradesPoll();
    if (this.abort) {
      try {
        this.abort.abort();
      } catch {
        // best-effort
      }
      this.abort = null;
    }
    if (this.client) {
      try {
        this.client.dispose?.();
      } catch {
        // best-effort
      }
      this.client = null;
    }
  }

  private emitStatus(status: PhoenixLiveMarketStatus) {
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
    this.stopTradesPoll();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearFallbackTimer();
  }
}

// ---- merge reducers (pure, exported for tests) ----

export function mergePhoenixBook(
  snapshot: PhoenixMarketSnapshot,
  update: unknown,
  now: Date,
): PhoenixMarketSnapshot {
  const row = readRecord(update);
  if (!row) return snapshot;
  const bids = bookTuplesToLevels(row.bids);
  const asks = bookTuplesToLevels(row.asks);
  if (bids.length === 0 && asks.length === 0) return snapshot;
  const bestBid = bids[0]?.px ?? snapshot.best_bid;
  const bestAsk = asks[0]?.px ?? snapshot.best_ask;
  return touch(snapshot, now, {
    bids: bids.length > 0 ? bids : snapshot.bids,
    asks: asks.length > 0 ? asks : snapshot.asks,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps(bestBid, bestAsk),
    slot: numberValue(row.slot) ?? snapshot.slot,
    source_timestamp: numberValue(row.ts) ?? snapshot.source_timestamp,
    book_updated_at: now.toISOString(),
  });
}

export function mergePhoenixMarket(
  snapshot: PhoenixMarketSnapshot,
  update: unknown,
  now: Date,
): PhoenixMarketSnapshot {
  const row = readRecord(update);
  if (!row) return snapshot;
  const mid = safeDecimalString(row.midPx) ?? safeDecimalString(row.markPx) ?? snapshot.mid;
  return touch(snapshot, now, {
    mid,
    mark_price: safeDecimalString(row.markPx) ?? snapshot.mark_price,
    oracle_price: safeDecimalString(row.oraclePx) ?? snapshot.oracle_price,
    prev_day_price: safeDecimalString(row.prevDayPx) ?? snapshot.prev_day_price,
    day_notional_volume: safeDecimalString(row.dayNtlVlm) ?? snapshot.day_notional_volume,
    funding_rate: safeSignedDecimalString(row.funding) ?? snapshot.funding_rate,
    open_interest: safeDecimalString(row.openInterest) ?? snapshot.open_interest,
    market_updated_at: now.toISOString(),
  });
}

export function mergePhoenixMarkPrice(
  snapshot: PhoenixMarketSnapshot,
  update: unknown,
  now: Date,
): PhoenixMarketSnapshot {
  const row = readRecord(update);
  if (!row) return snapshot;
  const mark = safeDecimalString(row.markPrice);
  if (!mark) return snapshot;
  return touch(snapshot, now, {
    mark_price: mark,
    mid: snapshot.mid ?? mark,
    slot: numberValue(row.slot) ?? snapshot.slot,
    market_updated_at: now.toISOString(),
  });
}

export function mergePhoenixCandle(
  snapshot: PhoenixMarketSnapshot,
  update: unknown,
  interval: PhoenixCandleInterval,
  now: Date,
): PhoenixMarketSnapshot {
  const row = readRecord(update);
  if (!row) return snapshot;
  if (row.timeframe != null && String(row.timeframe) !== interval) return snapshot;
  const candle = normalizeWsCandle(row.candle ?? row);
  if (!candle) return snapshot;
  const byTime = new Map(snapshot.candles.map((c) => [c.t, c]));
  byTime.set(candle.t, candle);
  const candles = Array.from(byTime.values())
    .sort((a, b) => a.t - b.t)
    .slice(-PHOENIX_CANDLE_WINDOW);
  return touch(snapshot, now, { candles, candles_updated_at: now.toISOString() });
}

export function mergePhoenixTrades(
  snapshot: PhoenixMarketSnapshot,
  trades: PhoenixRecentTrade[],
  now: Date,
): PhoenixMarketSnapshot {
  if (trades.length === 0) return snapshot;
  const seen = new Set<string>();
  const recent_trades = [...trades, ...snapshot.recent_trades]
    .filter((trade) => {
      const key = `${trade.time}:${trade.side}:${trade.px}:${trade.sz}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, PHOENIX_RECENT_TRADE_WINDOW);
  return touch(snapshot, now, { recent_trades, trades_updated_at: now.toISOString() });
}

function touch(
  snapshot: PhoenixMarketSnapshot,
  now: Date,
  patch: Partial<PhoenixMarketSnapshot>,
): PhoenixMarketSnapshot {
  return {
    ...snapshot,
    ...patch,
    fetched_at: now.toISOString(),
    source: "websocket",
    stale: false,
  };
}

function bookTuplesToLevels(value: unknown): PhoenixMarketSnapshot["bids"] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, PHOENIX_BOOK_LEVEL_WINDOW)
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
    .filter(Boolean) as PhoenixMarketSnapshot["bids"];
}

function normalizeWsCandle(value: unknown): PhoenixCandle | null {
  const row = readRecord(value);
  if (!row) return null;
  const t = numberValue(row.time ?? row.t);
  const o = safeDecimalString(row.open ?? row.o);
  const h = safeDecimalString(row.high ?? row.h);
  const l = safeDecimalString(row.low ?? row.l);
  const c = safeDecimalString(row.close ?? row.c);
  const v = safeDecimalString(row.volume ?? row.v) ?? "0";
  const n = numberValue(row.tradeCount ?? row.n);
  return t && o && h && l && c ? { t, T: null, o, h, l, c, v, n } : null;
}

async function withTimeout<T>(
  promise: Promise<T> | undefined,
  ms: number,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (!promise) return undefined;
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then((value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
  });
}
