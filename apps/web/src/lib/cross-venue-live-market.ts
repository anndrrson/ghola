import type { GholaMarketFrame } from "./ghola-market-chart";
import type { MarketFeedTelemetry } from "./market-feed-telemetry";
import {
  createBoundedStatePublisher,
  type BoundedStatePublisher,
} from "./bounded-state-publisher";
import {
  createUnifiedLiveMarket,
  initialUnifiedLiveMarketState,
  type UnifiedLiveMarketController,
  type UnifiedLiveMarketOptions,
  type UnifiedLiveMarketState,
  type UnifiedMarketInterval,
  type UnifiedMarketVenue,
} from "./unified-live-market";
import { terminalComparisonVenues, type TerminalVenueId } from "./terminal-venue-comparison";

export type CrossVenueHealthStatus =
  | "connecting"
  | "live"
  | "polling"
  | "reconnecting"
  | "stale"
  | "blocked";

export interface CrossVenueHealth {
  venue: TerminalVenueId;
  status: CrossVenueHealthStatus;
  sourceStatus: UnifiedLiveMarketState["status"];
  stale: boolean;
  error: UnifiedLiveMarketState["error"];
  fetchedAt: string | null;
  sequence: number;
  telemetry: MarketFeedTelemetry;
}

export interface CrossVenueHealthSummary {
  health: CrossVenueHealth[];
  liveVenueCount: number;
  staleVenueCount: number;
}

export interface CrossVenueExecutableQuote {
  venue: TerminalVenueId;
  product: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  fetchedAt: string;
}

export interface CrossVenueLiveMarketState {
  market: string;
  interval: UnifiedMarketInterval;
  frames: GholaMarketFrame[];
  comparisonFrames: GholaMarketFrame[];
  quotes: CrossVenueExecutableQuote[];
  health: CrossVenueHealth[];
  bestBid: CrossVenueExecutableQuote | null;
  bestAsk: CrossVenueExecutableQuote | null;
  executableSpreadBps: number | null;
  liveVenueCount: number;
  staleVenueCount: number;
  loading: boolean;
  sequence: number;
}

export interface CrossVenueLiveMarketOptions {
  currentVenue: TerminalVenueId;
  market: string;
  interval: UnifiedMarketInterval;
  hyperliquidNetwork?: "mainnet" | "testnet";
  enabled?: boolean;
  onState: (state: CrossVenueLiveMarketState) => void;
  createMarket?: (options: UnifiedLiveMarketOptions) => UnifiedLiveMarketController;
  fetchImpl?: typeof fetch;
  fetchTimeoutMs?: number;
  isDocumentHidden?: () => boolean;
  now?: () => number;
  publishCadenceMs?: number;
}

export interface CrossVenueLiveMarketController {
  start: () => void;
  stop: () => void;
  getState: () => CrossVenueLiveMarketState;
}

const VENUE_ORDER: TerminalVenueId[] = ["hyperliquid", "phoenix", "coinbase"];

export function crossVenueMarketVenues(
  currentVenue: TerminalVenueId,
  market: string,
): TerminalVenueId[] {
  return terminalComparisonVenues(currentVenue, normalizeMarket(market));
}

export function summarizeCrossVenueHealth(
  currentVenue: TerminalVenueId,
  primaryState: UnifiedLiveMarketState,
  peerHealth: CrossVenueHealth[],
): CrossVenueHealthSummary {
  const health = [
    crossVenueHealthFromUnifiedState(currentVenue, primaryState),
    ...peerHealth.filter((item) => item.venue !== currentVenue),
  ].sort((left, right) => VENUE_ORDER.indexOf(left.venue) - VENUE_ORDER.indexOf(right.venue));
  return {
    health,
    liveVenueCount: health.filter(isLiveHealth).length,
    staleVenueCount: health.filter((item) => item.stale).length,
  };
}

export function initialCrossVenueLiveMarketState(input: {
  currentVenue: TerminalVenueId;
  market: string;
  interval: UnifiedMarketInterval;
}): CrossVenueLiveMarketState {
  const market = normalizeMarket(input.market);
  return aggregateCrossVenueState({
    currentVenue: input.currentVenue,
    market,
    interval: input.interval,
    sequence: 0,
    venueStates: new Map(
      crossVenueMarketVenues(input.currentVenue, market).map((venue) => [venue, initialUnifiedLiveMarketState()]),
    ),
  });
}

export function aggregateCrossVenueState(input: {
  currentVenue: TerminalVenueId;
  market: string;
  interval: UnifiedMarketInterval;
  sequence: number;
  venueStates: ReadonlyMap<TerminalVenueId, UnifiedLiveMarketState>;
}): CrossVenueLiveMarketState {
  const ordered = [...input.venueStates.entries()].sort(
    ([left], [right]) => VENUE_ORDER.indexOf(left) - VENUE_ORDER.indexOf(right),
  );
  const health = ordered.map(([venue, state]) => healthFromState(venue, state));
  const frames = ordered.flatMap(([, state]) => (
    state.frame && isUsableState(state) ? [state.frame] : []
  ));
  const comparisonFrames = ordered.flatMap(([venue, state]) => (
    venue !== input.currentVenue && state.frame && isUsableState(state)
      ? [state.frame]
      : []
  ));
  const quotes = ordered.flatMap(([venue, state]) => {
    const frame = state.frame;
    if (!frame || !isUsableState(state)) return [];
    const fetchedAt = frame.fetchedAt;
    if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) return [];
    const bid = positive(frame.bestBid);
    const ask = positive(frame.bestAsk);
    const mid = positive(frame.mid);
    if (bid != null && ask != null && bid >= ask) return [];
    if (bid == null && ask == null && mid == null) return [];
    return [{ venue, product: frame.product, bid, ask, mid, fetchedAt }];
  });
  const bestBid = quotes
    .filter((quote) => quote.bid != null)
    .sort((left, right) => (right.bid ?? 0) - (left.bid ?? 0))[0] ?? null;
  const bestAsk = quotes
    .filter((quote) => quote.ask != null)
    .sort((left, right) => (left.ask ?? Number.POSITIVE_INFINITY) - (right.ask ?? Number.POSITIVE_INFINITY))[0] ?? null;
  const executableSpreadBps = bestBid?.bid != null && bestAsk?.ask != null
    ? ((bestBid.bid - bestAsk.ask) / bestAsk.ask) * 10_000
    : null;
  return {
    market: input.market,
    interval: input.interval,
    frames,
    comparisonFrames,
    quotes,
    health,
    bestBid,
    bestAsk,
    executableSpreadBps,
    liveVenueCount: health.filter(isLiveHealth).length,
    staleVenueCount: health.filter((item) => item.stale).length,
    loading: health.some((item) => item.status === "connecting") && frames.length === 0,
    sequence: input.sequence,
  };
}

export function createCrossVenueLiveMarket(
  options: CrossVenueLiveMarketOptions,
): CrossVenueLiveMarketController {
  return new BrowserCrossVenueLiveMarket(options);
}

class BrowserCrossVenueLiveMarket implements CrossVenueLiveMarketController {
  private active = false;
  private generation = 0;
  private children = new Map<TerminalVenueId, UnifiedLiveMarketController>();
  private venueStates = new Map<TerminalVenueId, UnifiedLiveMarketState>();
  private state: CrossVenueLiveMarketState;
  private publisher: BoundedStatePublisher<number>;

  constructor(private readonly options: CrossVenueLiveMarketOptions) {
    this.state = initialCrossVenueLiveMarketState(options);
    this.publisher = createBoundedStatePublisher({
      cadenceMs: options.publishCadenceMs ?? 100,
      now: options.now,
      onPublish: () => this.publishNow(),
    });
  }

  start() {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    if (this.options.enabled === false) {
      this.publisher.push(this.generation, { critical: true });
      return;
    }
    const market = normalizeMarket(this.options.market);
    for (const venue of crossVenueMarketVenues(this.options.currentVenue, market)) {
      this.venueStates.set(venue, initialUnifiedLiveMarketState());
      const create = this.options.createMarket ?? createUnifiedLiveMarket;
      const child = create({
        venue: venue as UnifiedMarketVenue,
        market,
        interval: this.options.interval,
        hyperliquidNetwork: this.options.hyperliquidNetwork ?? "mainnet",
        fetchImpl: this.options.fetchImpl,
        fetchTimeoutMs: this.options.fetchTimeoutMs,
        isDocumentHidden: this.options.isDocumentHidden,
        now: this.options.now,
        onState: (state) => this.handleVenueState(generation, venue, state),
      });
      this.children.set(venue, child);
      child.start();
    }
    this.publisher.push(generation, { critical: true });
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.publisher.cancelPending();
    for (const child of this.children.values()) child.stop();
    this.children.clear();
    this.venueStates.clear();
  }

  getState() {
    return this.state;
  }

  private handleVenueState(
    generation: number,
    venue: TerminalVenueId,
    state: UnifiedLiveMarketState,
  ) {
    if (!this.active || generation !== this.generation || !this.children.has(venue)) return;
    const current = this.venueStates.get(venue);
    if (current && state.sequence < current.sequence) return;
    this.venueStates.set(venue, state);
    this.publisher.push(generation, {
      critical: current == null || isCriticalVenueTransition(current, state),
    });
  }

  private publishNow() {
    if (!this.active) return;
    this.state = aggregateCrossVenueState({
      currentVenue: this.options.currentVenue,
      market: normalizeMarket(this.options.market),
      interval: this.options.interval,
      sequence: this.state.sequence + 1,
      venueStates: this.venueStates,
    });
    this.options.onState(this.state);
  }
}

function isCriticalVenueTransition(
  previous: UnifiedLiveMarketState,
  next: UnifiedLiveMarketState,
) {
  return previous.status !== next.status ||
    previous.stale !== next.stale ||
    previous.error !== next.error ||
    previous.loading !== next.loading ||
    previous.transport !== next.transport;
}

export function crossVenueHealthFromUnifiedState(
  venue: TerminalVenueId,
  state: UnifiedLiveMarketState,
): CrossVenueHealth {
  const status: CrossVenueHealthStatus = state.status === "fallback_polling"
    ? "polling"
    : state.status;
  return {
    venue,
    status,
    sourceStatus: state.status,
    stale: state.status === "stale" || state.stale || Boolean(state.frame?.stale),
    error: state.error,
    fetchedAt: state.frame?.fetchedAt ?? state.lastUpdateAt,
    sequence: state.sequence,
    telemetry: state.telemetry,
  };
}

function healthFromState(
  venue: TerminalVenueId,
  state: UnifiedLiveMarketState,
): CrossVenueHealth {
  return crossVenueHealthFromUnifiedState(venue, state);
}

function isLiveHealth(item: CrossVenueHealth) {
  return (item.status === "live" || item.status === "polling") &&
    !item.stale && !item.error;
}

function isUsableState(state: UnifiedLiveMarketState) {
  return (state.status === "live" || state.status === "fallback_polling") &&
    !state.stale && !state.frame?.stale && !state.error;
}

function normalizeMarket(value: string) {
  return value.trim().toUpperCase().replace(/-(USD|PERP)$/u, "");
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
