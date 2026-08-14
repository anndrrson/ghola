import {
  gholaFrameFromCoinbase,
  gholaFrameFromHyperliquid,
  gholaFrameFromPhoenix,
  type GholaMarketFrame,
} from "./ghola-market-chart";
import {
  createCoinbaseLiveMarketStream,
  type CoinbaseLiveMarketStatus,
} from "./coinbase-live-market";
import {
  createHyperliquidLiveMarketStream,
  type HyperliquidLiveMarketStatus,
} from "./hyperliquid-live-market";
import {
  createPhoenixLiveMarketStream,
  type PhoenixLiveMarketStatus,
} from "./phoenix-live-market";
import type {
  CoinbaseCandleInterval,
  CoinbaseMarketSnapshot,
  CoinbaseProductId,
} from "./coinbase-market-data";
import type {
  HyperliquidCandleInterval,
  HyperliquidMarketCoin,
  HyperliquidMarketSnapshot,
  HyperliquidNetwork,
} from "./hyperliquid-market-data";
import type {
  PhoenixCandleInterval,
  PhoenixMarketSnapshot,
  PhoenixMarketSymbol,
} from "./phoenix-market-data";
import {
  createMarketFeedTelemetryRecorder,
  initialMarketFeedTelemetry,
  type MarketFeedTelemetry,
  type MarketFeedTelemetryRecorder,
} from "./market-feed-telemetry";
import {
  MARKET_COMPONENTS,
  marketComponentClocks,
  marketComponentUpdates,
  normalizeMarketTimestamp,
  type MarketComponent,
  type MarketComponentClocks,
} from "./market-component-clock";

export type UnifiedMarketVenue = "hyperliquid" | "phoenix" | "coinbase";
export type UnifiedMarketInterval = "1m" | "5m" | "15m" | "1h";
export type UnifiedLiveMarketStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "fallback_polling"
  | "stale"
  | "blocked";
export type UnifiedMarketTransport = "websocket" | "polling" | null;
export type UnifiedMarketError = "invalid_snapshot" | "market_unavailable" | null;
export type UnifiedMarketSnapshotProvenance = "websocket" | "fallback";

export interface UnifiedMarketSelection {
  venue: UnifiedMarketVenue;
  market: string;
  interval: UnifiedMarketInterval;
  hyperliquidNetwork?: HyperliquidNetwork;
}

export interface UnifiedLiveMarketState {
  status: UnifiedLiveMarketStatus;
  transport: UnifiedMarketTransport;
  frame: GholaMarketFrame | null;
  loading: boolean;
  stale: boolean;
  error: UnifiedMarketError;
  sequence: number;
  lastUpdateAt: string | null;
  telemetry: MarketFeedTelemetry;
}

export type UnifiedMarketSnapshot =
  | HyperliquidMarketSnapshot
  | CoinbaseMarketSnapshot
  | PhoenixMarketSnapshot;

type AdapterStatus =
  | HyperliquidLiveMarketStatus
  | CoinbaseLiveMarketStatus
  | PhoenixLiveMarketStatus;

export interface UnifiedMarketAdapter {
  start: () => void;
  stop: () => void;
}

export interface UnifiedMarketAdapterContext {
  selection: UnifiedMarketSelection;
  getFallbackSnapshot: () => Promise<UnifiedMarketSnapshot>;
  onSnapshot: (
    snapshot: UnifiedMarketSnapshot,
    provenance?: UnifiedMarketSnapshotProvenance,
  ) => boolean;
  onStatus: (status: AdapterStatus) => void;
  isDocumentHidden: () => boolean;
  now: () => number;
}

export interface UnifiedLiveMarketOptions extends UnifiedMarketSelection {
  fetchImpl?: typeof fetch;
  onState: (state: UnifiedLiveMarketState) => void;
  createStream?: (context: UnifiedMarketAdapterContext) => UnifiedMarketAdapter;
  isDocumentHidden?: () => boolean;
  now?: () => number;
  fetchTimeoutMs?: number;
}

export interface UnifiedLiveMarketController {
  start: () => void;
  stop: () => void;
  getState: () => UnifiedLiveMarketState;
}

const FETCH_TIMEOUT_MS = 8_000;
const FUTURE_SKEW_MS = 30_000;
const FRESHNESS_CHECK_MS = 2_000;
export const UNIFIED_MARKET_COLLECTION_LIMITS = Object.freeze({
  candles: 240,
  bids: 20,
  asks: 20,
  recent_trades: 20,
} as const);
const INTERVAL_MS: Record<UnifiedMarketInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
};
const HYPERLIQUID_MARKETS = new Set(["BTC", "ETH", "SOL", "HYPE"]);
const COINBASE_MARKETS = new Set(["BTC", "ETH", "SOL"]);

export function initialUnifiedLiveMarketState(): UnifiedLiveMarketState {
  return {
    status: "connecting",
    transport: null,
    frame: null,
    loading: true,
    stale: true,
    error: null,
    sequence: 0,
    lastUpdateAt: null,
    telemetry: initialMarketFeedTelemetry(),
  };
}

export function unifiedMarketFreshnessMs(interval: UnifiedMarketInterval): number {
  return Math.min(120_000, Math.max(30_000, INTERVAL_MS[interval] / 10));
}

export function unifiedMarketSnapshotUrl(selection: UnifiedMarketSelection): string {
  const market = normalizeMarket(selection);
  const interval = selection.interval;
  if (selection.venue === "hyperliquid") {
    const network = selection.hyperliquidNetwork ?? "mainnet";
    return `/v1/private-account/hyperliquid/market-snapshot?coin=${encodeURIComponent(market)}&interval=${interval}&network=${network}`;
  }
  if (selection.venue === "phoenix") {
    return `/v1/private-account/phoenix/market-snapshot?symbol=${encodeURIComponent(market)}&interval=${interval}`;
  }
  return `/v1/private-account/coinbase/market-snapshot?product_id=${encodeURIComponent(`${market}-USD`)}&interval=${interval}`;
}

export function createUnifiedLiveMarket(
  options: UnifiedLiveMarketOptions,
): UnifiedLiveMarketController {
  return new BrowserUnifiedLiveMarket(options);
}

export interface InspectedUnifiedMarketSnapshot {
  frame: GholaMarketFrame;
  sourceTimestamp: number | null;
  componentTimestamps: MarketComponentClocks;
  updatedComponents: ReadonlySet<MarketComponent>;
  freshnessTimestamp: number | null;
  stale: boolean;
}

interface FallbackMetadata {
  requestId: number;
  snapshotRevisionAtStart: number;
}

class BrowserUnifiedLiveMarket implements UnifiedLiveMarketController {
  private active = false;
  private adapter: UnifiedMarketAdapter | null = null;
  private state = initialUnifiedLiveMarketState();
  private transportStatus: AdapterStatus = "connecting";
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;
  private fallbackRequestId = 0;
  private snapshotRevision = 0;
  private latestFreshnessTimestamp: number | null = null;
  private componentWatermarks: MarketComponentClocks = {};
  private fetchControllers = new Set<AbortController>();
  private fallbackMetadata = new WeakMap<object, FallbackMetadata>();
  private telemetry: MarketFeedTelemetryRecorder;

  constructor(private readonly options: UnifiedLiveMarketOptions) {
    this.telemetry = createMarketFeedTelemetryRecorder({
      freshnessMs: unifiedMarketFreshnessMs(options.interval),
      now: () => this.now(),
    });
    this.state = { ...this.state, telemetry: this.telemetry.snapshot() };
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.publish({
      ...initialUnifiedLiveMarketState(),
      telemetry: this.telemetry.snapshot({ status: "connecting", stale: true }),
    }, false);
    try {
      const context: UnifiedMarketAdapterContext = {
        selection: this.selection(),
        getFallbackSnapshot: () => this.getFallbackSnapshot(),
        onSnapshot: (snapshot, provenance) => this.handleSnapshot(snapshot, provenance),
        onStatus: (status) => this.handleStatus(status),
        isDocumentHidden: () => this.options.isDocumentHidden?.() ?? defaultDocumentHidden(),
        now: () => this.now(),
      };
      this.adapter = this.options.createStream?.(context) ?? createDefaultAdapter(context);
      this.adapter.start();
      this.freshnessTimer = setInterval(() => this.checkFreshness(), FRESHNESS_CHECK_MS);
    } catch {
      this.publish({
        ...this.state,
        status: "blocked",
        loading: false,
        stale: true,
        error: "market_unavailable",
      });
    }
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.fallbackRequestId += 1;
    if (this.freshnessTimer) clearInterval(this.freshnessTimer);
    this.freshnessTimer = null;
    for (const controller of this.fetchControllers) controller.abort();
    this.fetchControllers.clear();
    try {
      this.adapter?.stop();
    } finally {
      this.adapter = null;
    }
  }

  getState() {
    return this.state;
  }

  private selection(): UnifiedMarketSelection {
    return {
      venue: this.options.venue,
      market: normalizeMarket(this.options),
      interval: this.options.interval,
      hyperliquidNetwork: this.options.hyperliquidNetwork ?? "mainnet",
    };
  }

  private async getFallbackSnapshot(): Promise<UnifiedMarketSnapshot> {
    const requestId = ++this.fallbackRequestId;
    const snapshotRevisionAtStart = this.snapshotRevision;
    const controller = new AbortController();
    this.fetchControllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(250, this.options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS),
    );
    try {
      const response = await (this.options.fetchImpl ?? fetch)(unifiedMarketSnapshotUrl(this.selection()), {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`market_${response.status}`);
      const snapshot = await response.json() as unknown;
      if (!this.active || requestId !== this.fallbackRequestId) throw abortError();
      const inspected = inspectUnifiedMarketSnapshot(this.selection(), snapshot, this.now());
      if (!inspected) {
        this.recordReject(snapshotHasCandleGap(snapshot, this.options.interval)
          ? "validation_gap"
          : "invalid_snapshot");
        throw new Error("invalid_market_snapshot");
      }
      this.fallbackMetadata.set(snapshot as object, { requestId, snapshotRevisionAtStart });
      return snapshot as UnifiedMarketSnapshot;
    } finally {
      clearTimeout(timeout);
      this.fetchControllers.delete(controller);
    }
  }

  private handleSnapshot(
    snapshot: UnifiedMarketSnapshot,
    provenance?: UnifiedMarketSnapshotProvenance,
  ): boolean {
    if (!this.active) return false;
    const metadata = snapshot && typeof snapshot === "object"
      ? this.fallbackMetadata.get(snapshot as object)
      : undefined;
    const source = snapshotSource(snapshot);
    const isFallback = provenance === "fallback" || Boolean(metadata) || (
      provenance == null && source === "fallback"
    );
    const inspected = inspectUnifiedMarketSnapshot(this.selection(), snapshot, this.now());
    if (!inspected) {
      this.recordReject(snapshotHasCandleGap(snapshot, this.options.interval)
        ? "validation_gap"
        : "invalid_snapshot");
      if (!this.state.frame) {
        this.publish({
          ...this.state,
          status: "stale",
          loading: false,
          stale: true,
          error: "invalid_snapshot",
        });
      }
      return false;
    }
    if (
      metadata &&
      this.transportStatus === "live" &&
      this.snapshotRevision > metadata.snapshotRevisionAtStart
    ) {
      this.recordReject("sequence_regression");
      return false;
    }
    if (componentTimestampRegressed(
      inspected.componentTimestamps,
      this.componentWatermarks,
      isFallback
        ? authoritativePriceComponents(inspected.frame, inspected.componentTimestamps)
        : inspected.updatedComponents.size > 0
          ? inspected.updatedComponents
          : null,
    )) {
      this.recordReject("timestamp_regression");
      return false;
    }

    this.componentWatermarks = mergeComponentWatermarks(
      this.componentWatermarks,
      inspected.componentTimestamps,
    );
    this.latestFreshnessTimestamp = inspected.freshnessTimestamp;
    this.snapshotRevision += 1;
    const status: UnifiedLiveMarketStatus = inspected.stale
      ? "stale"
      : isFallback
        ? "fallback_polling"
        : this.transportStatus === "live"
          ? "live"
          : normalizeTransportStatus(this.transportStatus);
    const candidateFrame = inspected.stale && !inspected.frame.stale
      ? { ...inspected.frame, stale: true }
      : inspected.frame;
    const frame = stabilizeUnifiedMarketFrameCollections(
      this.state.frame,
      candidateFrame,
      inspected.updatedComponents,
    );
    this.telemetry.recordAccepted({
      sourceTimestamp: inspected.sourceTimestamp,
      dataTimestamp: inspected.freshnessTimestamp ?? Number.NaN,
      componentTimestamps: inspected.componentTimestamps,
    });
    this.publish({
      status,
      transport: status === "live" ? "websocket" : status === "fallback_polling" ? "polling" : null,
      frame,
      loading: false,
      stale: inspected.stale,
      error: inspected.stale ? "market_unavailable" : null,
      sequence: this.state.sequence,
      lastUpdateAt: frame.fetchedAt,
      telemetry: this.state.telemetry,
    });
    return !inspected.stale;
  }

  private handleStatus(status: AdapterStatus) {
    if (!this.active) return;
    this.transportStatus = status;
    if (status === "live") {
      if (this.state.frame && !this.state.stale && this.state.status !== "live") {
        this.publish({
          ...this.state,
          status: "live",
          transport: "websocket",
          loading: false,
          error: null,
        });
      }
      return;
    }
    if (status === "stale") {
      this.markStale();
      return;
    }
    const normalized = normalizeTransportStatus(status);
    if (!this.state.frame) {
      this.publish({
        ...this.state,
        status: normalized,
        loading: normalized !== "blocked",
        stale: true,
        error: normalized === "blocked" ? "market_unavailable" : this.state.error,
      });
      return;
    }
    this.publish({
      ...this.state,
      status: normalized,
      transport: normalized === "fallback_polling" ? "polling" : null,
      loading: false,
      error: normalized === "blocked" ? "market_unavailable" : this.state.error,
    });
  }

  private checkFreshness() {
    if (!this.active || !this.state.frame) return;
    const frame = gateStaleDepth(
      this.state.frame,
      this.componentWatermarks,
      this.now(),
      this.options.interval,
    );
    const fresh = (
      this.latestFreshnessTimestamp != null &&
      this.now() - this.latestFreshnessTimestamp <= unifiedMarketFreshnessMs(this.options.interval)
    );
    if (!this.state.stale && !fresh) {
      this.markStale(frame);
      return;
    }
    if (frame !== this.state.frame) {
      this.publish({ ...this.state, frame });
      return;
    }
    this.refreshTelemetry();
  }

  private markStale(retainedFrame = this.state.frame) {
    if (!this.state.frame) {
      this.publish({
        ...this.state,
        status: "stale",
        loading: false,
        stale: true,
        error: "market_unavailable",
      });
      return;
    }
    this.publish({
      ...this.state,
      status: "stale",
      transport: null,
      frame: retainedFrame?.stale ? retainedFrame : retainedFrame ? { ...retainedFrame, stale: true } : null,
      loading: false,
      stale: true,
      error: "market_unavailable",
    });
  }

  private publish(next: UnifiedLiveMarketState, incrementSequence = true) {
    if (!this.active && incrementSequence) return;
    this.telemetry.recordStatus(next.status);
    const withTelemetry = {
      ...next,
      telemetry: this.telemetry.snapshot({ status: next.status, stale: next.stale }),
    };
    this.state = incrementSequence
      ? { ...withTelemetry, sequence: this.state.sequence + 1 }
      : withTelemetry;
    this.options.onState(this.state);
  }

  private recordReject(reason: Parameters<MarketFeedTelemetryRecorder["recordReject"]>[0]) {
    this.telemetry.recordReject(reason);
    this.state = {
      ...this.state,
      telemetry: this.telemetry.snapshot({ status: this.state.status, stale: this.state.stale }),
    };
    this.options.onState(this.state);
  }

  private refreshTelemetry() {
    this.state = {
      ...this.state,
      telemetry: this.telemetry.snapshot({ status: this.state.status, stale: this.state.stale }),
    };
    this.options.onState(this.state);
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}

/** Retains exact collection references across unrelated component updates. */
export function stabilizeUnifiedMarketFrameCollections(
  previous: GholaMarketFrame | null,
  next: GholaMarketFrame,
  updatedComponents?: ReadonlySet<MarketComponent>,
): GholaMarketFrame {
  if (
    !previous
    || previous.venue !== next.venue
    || previous.network !== next.network
    || previous.product !== next.product
    || previous.interval !== next.interval
  ) return next;
  const authoritativeUpdates = updatedComponents && updatedComponents.size > 0
    ? updatedComponents
    : null;
  const candles = authoritativeUpdates && !authoritativeUpdates.has("candles")
    ? previous.candles
    : sameCandles(previous.candles, next.candles) ? previous.candles : next.candles;
  const bids = authoritativeUpdates && !authoritativeUpdates.has("book")
    ? previous.bids
    : sameBook(previous.bids, next.bids) ? previous.bids : next.bids;
  const asks = authoritativeUpdates && !authoritativeUpdates.has("book")
    ? previous.asks
    : sameBook(previous.asks, next.asks) ? previous.asks : next.asks;
  const trades = authoritativeUpdates && !authoritativeUpdates.has("trades")
    ? previous.trades
    : sameTrades(previous.trades, next.trades) ? previous.trades : next.trades;
  const routeQuotes = sameRouteQuotes(previous.routeQuotes, next.routeQuotes) ? previous.routeQuotes : next.routeQuotes;
  if (candles === next.candles && bids === next.bids && asks === next.asks && trades === next.trades && routeQuotes === next.routeQuotes) return next;
  return { ...next, candles, bids, asks, trades, routeQuotes };
}

function sameCandles(left: GholaMarketFrame["candles"], right: GholaMarketFrame["candles"]) {
  return sameLength(left, right) && left.every((value, index) => {
    const other = right[index];
    return value.t === other.t && value.T === other.T && value.o === other.o && value.h === other.h && value.l === other.l && value.c === other.c && value.v === other.v && value.n === other.n;
  });
}

function sameBook(left: GholaMarketFrame["bids"], right: GholaMarketFrame["bids"]) {
  return sameLength(left, right) && left.every((value, index) => {
    const other = right[index];
    return value.px === other.px && value.sz === other.sz && value.n === other.n;
  });
}

function sameTrades(left: GholaMarketFrame["trades"], right: GholaMarketFrame["trades"]) {
  return sameLength(left, right) && left.every((value, index) => {
    const other = right[index];
    return value.id === other.id && value.side === other.side && value.px === other.px && value.sz === other.sz && value.time === other.time;
  });
}

function sameRouteQuotes(left: GholaMarketFrame["routeQuotes"], right: GholaMarketFrame["routeQuotes"]) {
  return sameLength(left, right) && left.every((value, index) => {
    const other = right[index];
    return value.t === other.t && value.inputAmount === other.inputAmount && value.outputAmount === other.outputAmount && value.price === other.price && value.priceImpactPct === other.priceImpactPct && value.slippageBps === other.slippageBps && sameStrings(value.routeSummary, other.routeSummary);
  });
}

function sameLength(left: readonly unknown[], right: readonly unknown[]) { return left.length === right.length; }
function sameStrings(left: readonly string[], right: readonly string[]) { return sameLength(left, right) && left.every((value, index) => value === right[index]); }

function createDefaultAdapter(context: UnifiedMarketAdapterContext): UnifiedMarketAdapter {
  const { selection } = context;
  if (selection.venue === "hyperliquid") {
    return createHyperliquidLiveMarketStream({
      network: selection.hyperliquidNetwork ?? "mainnet",
      coin: normalizeMarket(selection) as HyperliquidMarketCoin,
      interval: selection.interval as HyperliquidCandleInterval,
      getFallbackSnapshot: async () => context.getFallbackSnapshot() as Promise<HyperliquidMarketSnapshot>,
      onSnapshot: context.onSnapshot,
      onStatus: context.onStatus,
      isDocumentHidden: context.isDocumentHidden,
      now: context.now,
    });
  }
  if (selection.venue === "phoenix") {
    return createPhoenixLiveMarketStream({
      symbol: normalizeMarket(selection) as PhoenixMarketSymbol,
      interval: selection.interval as PhoenixCandleInterval,
      getFallbackSnapshot: async () => context.getFallbackSnapshot() as Promise<PhoenixMarketSnapshot>,
      onSnapshot: context.onSnapshot,
      onStatus: context.onStatus,
      isDocumentHidden: context.isDocumentHidden,
      now: context.now,
    });
  }
  return createCoinbaseLiveMarketStream({
    productId: `${normalizeMarket(selection)}-USD` as CoinbaseProductId,
    interval: selection.interval as CoinbaseCandleInterval,
    getFallbackSnapshot: async () => context.getFallbackSnapshot() as Promise<CoinbaseMarketSnapshot>,
    onSnapshot: context.onSnapshot,
    onStatus: context.onStatus,
    isDocumentHidden: context.isDocumentHidden,
    now: context.now,
  });
}

export function inspectUnifiedMarketSnapshot(
  selection: UnifiedMarketSelection,
  value: unknown,
  now: number,
): InspectedUnifiedMarketSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as UnifiedMarketSnapshot;
  if (!snapshotMatchesSelection(selection, snapshot)) return null;
  const fetchedAt = Date.parse(snapshot.fetched_at);
  if (!Number.isFinite(fetchedAt) || fetchedAt > now + FUTURE_SKEW_MS) return null;
  const sourceTimestamp = normalizeMarketTimestamp(snapshot.source_timestamp);
  if (snapshot.source_timestamp != null && sourceTimestamp == null) return null;
  if (sourceTimestamp != null && sourceTimestamp > now + FUTURE_SKEW_MS) return null;
  if (!validMarketShape(snapshot, now, selection.interval)) return null;
  const convertedFrame = snapshotToFrame(snapshot);
  if (!convertedFrame) return null;
  const componentTimestamps = marketComponentClocks(snapshot);
  if (Object.values(componentTimestamps).some((timestamp) => (
    timestamp == null || !Number.isFinite(timestamp) || timestamp > now + FUTURE_SKEW_MS
  ))) return null;
  const gatedFrame = gateStaleDepth(
    canonicalizeUnifiedDisplayedPrices(convertedFrame),
    componentTimestamps,
    now,
    selection.interval,
  );
  const frame: GholaMarketFrame = { ...gatedFrame, componentTimestamps };
  const hasDisplayedQuote = positive(frame.bestBid) || positive(frame.bestAsk);
  const freshnessTimestamp = hasDisplayedQuote
    ? componentTimestamps.quote ?? null
    : displayedPriceTimestamp(frame, componentTimestamps);
  return {
    frame,
    sourceTimestamp: freshnessTimestamp,
    componentTimestamps,
    updatedComponents: marketComponentUpdates(snapshot),
    freshnessTimestamp,
    stale: snapshot.stale || freshnessTimestamp == null ||
      now - freshnessTimestamp > unifiedMarketFreshnessMs(selection.interval),
  };
}

function canonicalizeUnifiedDisplayedPrices(frame: GholaMarketFrame): GholaMarketFrame {
  const bestBid = positiveNumber(frame.bestBid);
  const bestAsk = positiveNumber(frame.bestAsk);
  const hasExecutableQuote = bestBid != null && bestAsk != null && bestBid < bestAsk;
  const midpoint = hasExecutableQuote ? (bestBid + bestAsk) / 2 : positiveNumber(frame.mid);
  return {
    ...frame,
    mid: midpoint == null ? null : String(midpoint),
    spreadBps: hasExecutableQuote && midpoint != null
      ? ((bestAsk - bestBid) / midpoint) * 10_000
      : finiteNonNegativeNumber(frame.spreadBps),
    markPrice: positiveNumber(frame.markPrice) == null ? null : frame.markPrice,
    oraclePrice: positiveNumber(frame.oraclePrice) == null ? null : frame.oraclePrice,
  };
}

function snapshotMatchesSelection(
  selection: UnifiedMarketSelection,
  snapshot: UnifiedMarketSnapshot,
): boolean {
  const market = normalizeMarket(selection);
  if (snapshot.version !== 1 || snapshot.interval !== selection.interval) return false;
  if (selection.venue === "hyperliquid") {
    return snapshot.platform === "hyperliquid" &&
      snapshot.coin === market &&
      snapshot.network === (selection.hyperliquidNetwork ?? "mainnet");
  }
  if (selection.venue === "phoenix") {
    return snapshot.platform === "phoenix" && snapshot.symbol === market;
  }
  return snapshot.platform === "coinbase" && snapshot.product_id === `${market}-USD`;
}

function validMarketShape(
  snapshot: UnifiedMarketSnapshot,
  now: number,
  interval: UnifiedMarketInterval,
): boolean {
  if (!Array.isArray(snapshot.candles) || !Array.isArray(snapshot.bids) || !Array.isArray(snapshot.asks) || !Array.isArray(snapshot.recent_trades)) {
    return false;
  }
  if (!marketCollectionsWithinLimits(snapshot)) return false;
  const mid = snapshot.mid;
  const mark = snapshot.platform === "coinbase" ? snapshot.price : snapshot.mark_price;
  const bid = snapshot.best_bid;
  const ask = snapshot.best_ask;
  if (mid != null && !positive(mid)) return false;
  if (mark != null && !positive(mark)) return false;
  if (bid != null && !positive(bid)) return false;
  if (ask != null && !positive(ask)) return false;
  if (positive(bid) && positive(ask) && Number(bid) >= Number(ask)) return false;
  if (!snapshot.bids.every((level) => positive(level.px) && positive(level.sz))) return false;
  if (!snapshot.asks.every((level) => positive(level.px) && positive(level.sz))) return false;
  if (!snapshot.candles.every((candle) => validCandle(candle, now))) return false;
  if (candleSequenceHasGap(snapshot.candles, interval)) return false;
  if (!snapshot.recent_trades.every((trade) => (
    (trade.side === "buy" || trade.side === "sell") &&
    positive(trade.px) &&
    positive(trade.sz) &&
    Number.isFinite(trade.time) &&
    trade.time > 0 &&
    trade.time <= now + FUTURE_SKEW_MS
  ))) return false;
  return Boolean(positive(mid) || positive(mark) || positive(bid) || positive(ask) || snapshot.candles.length > 0);
}

function snapshotHasCandleGap(value: unknown, interval: UnifiedMarketInterval): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candles = (value as { candles?: unknown }).candles;
  return Array.isArray(candles) &&
    candles.length <= UNIFIED_MARKET_COLLECTION_LIMITS.candles &&
    candleSequenceHasGap(candles, interval);
}

function marketCollectionsWithinLimits(snapshot: UnifiedMarketSnapshot): boolean {
  return snapshot.candles.length <= UNIFIED_MARKET_COLLECTION_LIMITS.candles &&
    snapshot.bids.length <= UNIFIED_MARKET_COLLECTION_LIMITS.bids &&
    snapshot.asks.length <= UNIFIED_MARKET_COLLECTION_LIMITS.asks &&
    snapshot.recent_trades.length <= UNIFIED_MARKET_COLLECTION_LIMITS.recent_trades;
}

function candleSequenceHasGap(
  candles: Array<{ t?: unknown }>,
  interval: UnifiedMarketInterval,
): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  const maximumGap = INTERVAL_MS[interval] * 3;
  for (const candle of candles) {
    const timestamp = Number(candle?.t);
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp <= previous || (Number.isFinite(previous) && timestamp - previous > maximumGap)) {
      return true;
    }
    previous = timestamp;
  }
  return false;
}

function validCandle(
  candle: UnifiedMarketSnapshot["candles"][number],
  now: number,
): boolean {
  if (!Number.isFinite(candle.t) || candle.t <= 0 || candle.t > now + FUTURE_SKEW_MS) return false;
  if (candle.T != null && (!Number.isFinite(candle.T) || candle.T < candle.t)) return false;
  if (![candle.o, candle.h, candle.l, candle.c].every(positive)) return false;
  const open = Number(candle.o);
  const high = Number(candle.h);
  const low = Number(candle.l);
  const close = Number(candle.c);
  const volume = Number(candle.v);
  return high >= Math.max(open, close) && low <= Math.min(open, close) && high >= low && Number.isFinite(volume) && volume >= 0;
}

function snapshotToFrame(snapshot: UnifiedMarketSnapshot): GholaMarketFrame | null {
  if (snapshot.platform === "hyperliquid") return gholaFrameFromHyperliquid(snapshot);
  if (snapshot.platform === "phoenix") return gholaFrameFromPhoenix(snapshot);
  return gholaFrameFromCoinbase(snapshot);
}

function gateStaleDepth(
  frame: GholaMarketFrame,
  clocks: MarketComponentClocks,
  now: number,
  interval: UnifiedMarketInterval,
): GholaMarketFrame {
  const bookTimestamp = clocks.book;
  const bookFresh = bookTimestamp != null &&
    now - bookTimestamp <= unifiedMarketFreshnessMs(interval);
  if (bookFresh || (frame.bids.length === 0 && frame.asks.length === 0)) return frame;
  return { ...frame, bids: [], asks: [] };
}

function snapshotSource(snapshot: UnifiedMarketSnapshot): "websocket" | "fallback" | "unknown" {
  if (snapshot.platform === "hyperliquid") return "unknown";
  if (snapshot.source === "websocket") return "websocket";
  if (snapshot.source === "http" || snapshot.source === "rpc") return "fallback";
  return "unknown";
}

function normalizeTransportStatus(status: AdapterStatus): UnifiedLiveMarketStatus {
  return status;
}

function normalizeMarket(selection: UnifiedMarketSelection): string {
  const market = selection.market.trim().toUpperCase().replace(/-(USD|PERP)$/u, "");
  if (selection.venue === "hyperliquid" && HYPERLIQUID_MARKETS.has(market)) return market;
  if (selection.venue === "phoenix" && market === "SOL") return market;
  if (selection.venue === "coinbase" && COINBASE_MARKETS.has(market)) return market;
  throw new Error("unsupported_market_selection");
}

function componentTimestampRegressed(
  incoming: MarketComponentClocks,
  accepted: MarketComponentClocks,
  checked: ReadonlySet<MarketComponent> | null,
): boolean {
  const components = checked == null ? MARKET_COMPONENTS : [...checked];
  return components.some((component) => (
    incoming[component] != null &&
    accepted[component] != null &&
    incoming[component]! < accepted[component]!
  ));
}

function mergeComponentWatermarks(
  accepted: MarketComponentClocks,
  incoming: MarketComponentClocks,
): MarketComponentClocks {
  const merged = { ...accepted };
  for (const component of MARKET_COMPONENTS) {
    const timestamp = incoming[component];
    if (timestamp != null) {
      merged[component] = Math.max(timestamp, accepted[component] ?? timestamp);
    }
  }
  return merged;
}

function displayedPriceTimestamp(
  frame: GholaMarketFrame,
  clocks: MarketComponentClocks,
): number | null {
  if (positive(frame.mid)) {
    if (frame.mid === frame.markPrice && clocks.mark != null) {
      return maximumTimestamp(clocks.market, clocks.mark);
    }
    if (clocks.market != null) return clocks.market;
    return null;
  }
  if (positive(frame.markPrice)) return clocks.mark ?? clocks.market ?? null;
  return null;
}

function authoritativePriceComponents(
  frame: GholaMarketFrame,
  clocks: MarketComponentClocks,
): ReadonlySet<MarketComponent> {
  if (positive(frame.bestBid) || positive(frame.bestAsk)) {
    return new Set<MarketComponent>(
      (["book", "quote"] as const).filter((component) => clocks[component] != null),
    );
  }
  if (positive(frame.mid)) {
    if (clocks.market != null) return new Set(["market"]);
    if (clocks.mark != null && frame.mid === frame.markPrice) return new Set(["mark"]);
  }
  if (positive(frame.markPrice)) {
    if (clocks.mark != null) return new Set(["mark"]);
    if (clocks.market != null) return new Set(["market"]);
  }
  return new Set();
}

function maximumTimestamp(...values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value): value is number => Number.isFinite(value));
  return valid.length > 0 ? Math.max(...valid) : null;
}

function positive(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function positiveNumber(value: unknown): number | null {
  return positive(value) ? Number(value) : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function defaultDocumentHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("Aborted", "AbortError");
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
