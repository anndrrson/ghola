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
import {
  advanceMarketComponent,
  advanceMarketComponents,
  attachMarketComponentClocks,
  carryMarketComponentClocks,
  hasAuthoritativePricingUpdate,
  marketComponentClocks,
  normalizeMarketTimestamp,
} from "./market-component-clock";
import { inspectCanonicalFundingRate } from "./market-funding-rate";

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
  onSnapshot: (
    snapshot: PhoenixMarketSnapshot,
    provenance?: "websocket" | "fallback",
  ) => unknown;
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
  private liveRevision = 0;
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
    if (typeof streams.marketStats === "function") {
      loops.push(this.consume(
        signal,
        () => streams.marketStats(symbol, signal),
        (snapshot, update) => mergePhoenixMarketStats(snapshot, update, new Date(this.now())),
      ));
    }
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
        this.applyPatch((snapshot) => apply(snapshot, update));
      }
    } catch {
      if (this.active && !signal.aborted) this.handleStreamError();
    }
  }

  private applyPatch(
    reducer: (snapshot: PhoenixMarketSnapshot) => PhoenixMarketSnapshot,
  ) {
    const next = reducer(this.currentSnapshot);
    if (next !== this.currentSnapshot) {
      if (this.options.onSnapshot(next, "websocket") === false) {
        this.startFallbackLoop();
        return;
      }
      if (hasAuthoritativePricingUpdate(next)) {
        this.liveRevision += 1;
        this.markMessage();
      }
      this.currentSnapshot = next;
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
    const liveRevisionAtStart = this.liveRevision;
    this.fallbackInFlight = true;
    if (this.status !== "connecting" && this.status !== "live") this.emitStatus("fallback_polling");
    this.options
      .getFallbackSnapshot()
      .then((snapshot) => {
        if (!this.active) return;
        if (this.liveRevision > liveRevisionAtStart && this.hasHealthyClient()) return;
        // Preserve any live tape we already have if the REST snapshot lacks it.
        const withTape =
          snapshot.recent_trades.length === 0 && this.currentSnapshot.recent_trades.length > 0
            ? attachMarketComponentClocks({
                ...snapshot,
                recent_trades: this.currentSnapshot.recent_trades,
                trades_updated_at: this.currentSnapshot.trades_updated_at,
              }, {
                ...marketComponentClocks(snapshot),
                trades: marketComponentClocks(this.currentSnapshot).trades,
              }, true)
            : snapshot;
        const merged = mergePhoenixFallbackFunding(this.currentSnapshot, withTape);
        if (this.options.onSnapshot(merged, "fallback") !== false) this.currentSnapshot = merged;
      })
      .catch(() => {
        if (!this.active) return;
        if (this.liveRevision > liveRevisionAtStart && this.hasHealthyClient()) return;
        const stale = carryMarketComponentClocks(
          this.currentSnapshot,
          { ...this.currentSnapshot, stale: true },
        );
        if (this.options.onSnapshot(stale, "fallback") !== false) this.currentSnapshot = stale;
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
  if (!Array.isArray(row.bids) || !Array.isArray(row.asks)) return snapshot;
  const timestamp = normalizeMarketTimestamp(row.ts ?? row.timestamp);
  if (timestamp == null) return snapshot;
  const clocks = marketComponentClocks(snapshot);
  if (
    (clocks.book != null && timestamp < clocks.book) ||
    (clocks.quote != null && timestamp < clocks.quote)
  ) return snapshot;
  const bids = bookTuplesToLevels(row.bids);
  const asks = bookTuplesToLevels(row.asks);
  const bestBid = bids[0]?.px ?? null;
  const bestAsk = asks[0]?.px ?? null;
  return advanceMarketComponents(snapshot, touch(snapshot, now, {
    bids,
    asks,
    best_bid: bestBid,
    best_ask: bestAsk,
    mid: midpoint(bestBid, bestAsk),
    spread_bps: spreadBps(bestBid, bestAsk),
    slot: numberValue(row.slot) ?? snapshot.slot,
    source_timestamp: maximumTimestamp(
      normalizeMarketTimestamp(snapshot.source_timestamp),
      timestamp,
    ),
    book_updated_at: new Date(timestamp).toISOString(),
  }), { book: timestamp, quote: timestamp });
}

export function mergePhoenixMarket(
  snapshot: PhoenixMarketSnapshot,
  update: unknown,
  now: Date,
): PhoenixMarketSnapshot {
  const row = readRecord(update);
  if (!row) return snapshot;
  const incomingMid = safeDecimalString(row.midPx);
  const mark = safeDecimalString(row.markPx);
  const oracle = safeDecimalString(row.oraclePx);
  const previous = safeDecimalString(row.prevDayPx);
  const volume = safeDecimalString(row.dayNtlVlm);
  const openInterest = safeDecimalString(row.openInterest);
  if (!incomingMid && !mark && !oracle && !previous && !volume && !openInterest) return snapshot;
  const timestamp = normalizeMarketTimestamp(row.ts ?? row.timestamp);
  if (timestamp == null) return snapshot;
  const clocks = marketComponentClocks(snapshot);
  const marketTimestampFresh = clocks.market == null || timestamp >= clocks.market;
  const marketIsFresh = Boolean(incomingMid) && marketTimestampFresh;
  const markIsFresh = Boolean(mark) && (clocks.mark == null || timestamp >= clocks.mark);
  const hasAncillary = Boolean(oracle || previous || volume || openInterest);
  const ancillaryIsFresh = hasAncillary && marketTimestampFresh;
  if (!marketIsFresh && !markIsFresh && !ancillaryIsFresh) return snapshot;

  const patch: Partial<PhoenixMarketSnapshot> = {
    source_timestamp: maximumTimestamp(
      normalizeMarketTimestamp(snapshot.source_timestamp),
      timestamp,
    ),
  };
  if (marketIsFresh) {
    Object.assign(patch, {
      mid: incomingMid,
      market_updated_at: new Date(timestamp).toISOString(),
    });
  }
  if (ancillaryIsFresh) Object.assign(patch, {
    oracle_price: oracle ?? snapshot.oracle_price,
    prev_day_price: previous ?? snapshot.prev_day_price,
    day_notional_volume: volume ?? snapshot.day_notional_volume,
    open_interest: openInterest ?? snapshot.open_interest,
  });
  if (markIsFresh) {
    patch.mark_price = mark;
    if (snapshot.mid == null && !marketIsFresh) patch.mid = mark;
  }
  return advanceMarketComponents(snapshot, touch(snapshot, now, patch), {
    ...(marketIsFresh ? { market: timestamp } : {}),
    ...(markIsFresh ? { mark: timestamp } : {}),
  });
}

export function mergePhoenixMarketStats(
  snapshot: PhoenixMarketSnapshot,
  update: unknown,
  now: Date,
): PhoenixMarketSnapshot {
  const row = readRecord(update);
  const stats = readRecord(row?.stats);
  if (!row || !stats) return snapshot;
  const rate = safeSignedDecimalString(stats.currentFundingRate);
  const timestamp = normalizePhoenixStatsTimestamp(stats.timestamp);
  if (rate == null || timestamp == null) return snapshot;
  const prior = fundingRevisionMs(snapshot);
  if (prior != null && timestamp < prior) return snapshot;
  return carryMarketComponentClocks(snapshot, {
    ...snapshot,
    fetched_at: now.toISOString(),
    source: "websocket",
    funding_rate: rate,
    funding_rate_unit: "decimal_fraction",
    funding_rate_source: "phoenix_ws_market_stats",
    funding_time_basis: "venue_event_time",
    funding_updated_at: new Date(timestamp).toISOString(),
  });
}

export function mergePhoenixFallbackFunding(
  preferred: PhoenixMarketSnapshot,
  fallback: PhoenixMarketSnapshot,
): PhoenixMarketSnapshot {
  const preferredRevision = fundingRevisionMs(preferred);
  const fallbackRevision = fundingRevisionMs(fallback);
  if (preferredRevision == null || (fallbackRevision != null && fallbackRevision > preferredRevision)) {
    return fallback;
  }
  return carryMarketComponentClocks(fallback, {
    ...fallback,
    funding_rate: preferred.funding_rate,
    funding_rate_unit: preferred.funding_rate_unit,
    funding_rate_source: preferred.funding_rate_source,
    funding_time_basis: preferred.funding_time_basis,
    funding_updated_at: preferred.funding_updated_at,
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
  const timestamp = normalizeMarketTimestamp(row.ts ?? row.timestamp);
  if (timestamp == null) return snapshot;
  const markClock = marketComponentClocks(snapshot).mark;
  if (markClock != null && timestamp < markClock) return snapshot;
  return advanceMarketComponent(snapshot, touch(snapshot, now, {
    mark_price: mark,
    mid: snapshot.mid ?? mark,
    slot: numberValue(row.slot) ?? snapshot.slot,
    source_timestamp: maximumTimestamp(
      normalizeMarketTimestamp(snapshot.source_timestamp),
      timestamp,
    ),
  }), "mark", timestamp);
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
  const timestamp = normalizeMarketTimestamp(candle.t);
  const latestTimestamp = maximumTimestamp(
    normalizeMarketTimestamp(snapshot.candles_updated_at),
    timestamp,
  );
  return advanceMarketComponent(snapshot, touch(snapshot, now, {
    candles,
    candles_updated_at: latestTimestamp == null ? null : new Date(latestTimestamp).toISOString(),
  }), "candles", timestamp);
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
  const timestamp = trades.reduce<number | null>((latest, trade) => (
    latest == null || trade.time > latest ? trade.time : latest
  ), null);
  const latestTimestamp = recent_trades.reduce<number | null>((latest, trade) => (
    latest == null || trade.time > latest ? trade.time : latest
  ), null);
  return advanceMarketComponent(snapshot, touch(snapshot, now, {
    recent_trades,
    trades_updated_at: latestTimestamp == null ? snapshot.trades_updated_at : new Date(latestTimestamp).toISOString(),
  }), "trades", timestamp);
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

function maximumTimestamp(...values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value));
  return valid.length > 0 ? Math.max(...valid) : null;
}

function normalizePhoenixStatsTimestamp(value: unknown): number | null {
  if (typeof value === "bigint") {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? normalizeMarketTimestamp(numeric) : null;
  }
  return normalizeMarketTimestamp(value);
}

function fundingRevisionMs(snapshot: PhoenixMarketSnapshot): number | null {
  return inspectCanonicalFundingRate({
    rate: snapshot.funding_rate,
    unit: snapshot.funding_rate_unit,
    source: snapshot.funding_rate_source,
    timeBasis: snapshot.funding_time_basis,
    updatedAt: snapshot.funding_updated_at,
    venue: "phoenix",
  })?.updatedAtMs ?? null;
}

function midpoint(bestBid: string | null, bestAsk: string | null): string | null {
  if (!bestBid || !bestAsk) return null;
  const bidFraction = bestBid.split(".")[1]?.length ?? 0;
  const askFraction = bestAsk.split(".")[1]?.length ?? 0;
  let scale = Math.max(bidFraction, askFraction);
  const bid = scaledDecimal(bestBid, scale);
  const ask = scaledDecimal(bestAsk, scale);
  if (bid == null || ask == null || bid <= BigInt(0) || bid >= ask) return null;
  const sum = bid + ask;
  const midpointValue = sum % BigInt(2) === BigInt(0)
    ? sum / BigInt(2)
    : sum * BigInt(5);
  if (sum % BigInt(2) !== BigInt(0)) scale += 1;
  return formatScaledDecimal(midpointValue, scale);
}

function scaledDecimal(value: string, scale: number): bigint | null {
  const [whole, fraction = ""] = value.split(".");
  if (!/^\d+$/u.test(whole) || !/^\d*$/u.test(fraction) || fraction.length > scale) return null;
  return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
}

function formatScaledDecimal(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();
  const digits = value.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole;
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
