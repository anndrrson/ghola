import type {
  GholaChartCandle,
  GholaChartTrade,
  GholaMarketFrame,
} from "./ghola-market-chart";
import type { MarketComponent, MarketComponentClocks } from "./market-component-clock";
import { normalizeMarketTimestamp } from "./market-component-clock";
import type { TerminalAlertMetric, TerminalAlertSnapshot } from "./terminal-alerts";
import { terminalFrameMatchesSelection, type TerminalMarketVenue } from "./terminal-market-identity";
import { deriveTerminalMarketMetrics } from "./trading-terminal-metrics";
import type { UnifiedLiveMarketStatus } from "./unified-live-market";

export const TERMINAL_CERTIFIED_SIGNAL_MAX_AGE_MS = 30_000;

export type TerminalCertifiedSignalComponent = "quote" | "book" | "trades" | "candles";

export type TerminalCertifiedSignalBlocker =
  | "frame_unavailable"
  | "synthetic_source"
  | "identity_mismatch"
  | "transport_unavailable"
  | "controller_stale"
  | "frame_stale"
  | "clock_missing"
  | "clock_invalid"
  | "clock_future"
  | "component_stale"
  | "quote_invalid"
  | "book_invalid"
  | "trades_empty"
  | "trades_invalid"
  | "trades_clock_mismatch"
  | "candles_empty"
  | "candles_invalid"
  | "candles_clock_mismatch";

export interface TerminalCertifiedSignalState {
  ready: boolean;
  blocker: TerminalCertifiedSignalBlocker | null;
  ageMs: number | null;
}

export interface TerminalCertifiedSignalSurface {
  status: "ready" | "degraded" | "paused";
  message: string;
}

export interface TerminalCertifiedIntelligence {
  sessionChangePct: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  atr: number | null;
  atrBps: number | null;
  realizedVolatilityBps: number | null;
  bookImbalancePct: number | null;
  microprice: number | null;
  micropriceEdgeBps: number | null;
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
  tradeVwap: number | null;
  buyFlowPct: number | null;
}

export interface TerminalCertifiedTape {
  trades: GholaChartTrade[];
  tradeVwap: number | null;
  buyFlowPct: number | null;
}

export interface TerminalCertifiedMarketSignals {
  snapshotInstrument: string | null;
  evaluationIdentityKey: string | null;
  referencePrice: number | null;
  bookFrame: GholaMarketFrame | null;
  alertSnapshot: TerminalAlertSnapshot;
  availableAlertMetrics: TerminalAlertMetric[];
  components: Record<TerminalCertifiedSignalComponent, TerminalCertifiedSignalState>;
  intelligence: TerminalCertifiedIntelligence;
  tape: TerminalCertifiedTape;
  surfaces: {
    intelligence: TerminalCertifiedSignalSurface;
    tape: TerminalCertifiedSignalSurface;
    alerts: TerminalCertifiedSignalSurface;
  };
}

export interface TerminalCertifiedMarketSignalInput {
  frame: GholaMarketFrame | null;
  source: "public_live" | "synthetic";
  selection: {
    venue: TerminalMarketVenue;
    network: string;
    market: string;
    interval: string;
  };
  status: UnifiedLiveMarketStatus;
  controllerStale: boolean;
  componentAgesMs: Partial<Record<MarketComponent, number>>;
  nowMs?: number;
  maxAgeMs?: number;
}

const INTELLIGENCE_KEYS = [
  "sessionChangePct",
  "sessionHigh",
  "sessionLow",
  "atr",
  "atrBps",
  "realizedVolatilityBps",
  "bookImbalancePct",
  "microprice",
  "micropriceEdgeBps",
  "bidDepthUsd",
  "askDepthUsd",
  "tradeVwap",
  "buyFlowPct",
] as const satisfies readonly (keyof TerminalCertifiedIntelligence)[];

export function terminalCertifiedIntelligenceViewEqual(
  left: TerminalCertifiedMarketSignals,
  right: TerminalCertifiedMarketSignals,
) {
  return left === right || (
    surfaceEqual(left.surfaces.intelligence, right.surfaces.intelligence)
    && INTELLIGENCE_KEYS.every((key) => Object.is(left.intelligence[key], right.intelligence[key]))
  );
}

export function terminalCertifiedBookViewEqual(
  left: TerminalCertifiedMarketSignals,
  right: TerminalCertifiedMarketSignals,
) {
  if (left === right) return true;
  const leftFrame = left.bookFrame;
  const rightFrame = right.bookFrame;
  return (
    leftFrame === rightFrame
    || (
      leftFrame != null
      && rightFrame != null
      && leftFrame.bids === rightFrame.bids
      && leftFrame.asks === rightFrame.asks
      && leftFrame.mid === rightFrame.mid
      && leftFrame.bestBid === rightFrame.bestBid
      && leftFrame.bestAsk === rightFrame.bestAsk
      && Object.is(leftFrame.spreadBps, rightFrame.spreadBps)
    )
  )
    && Object.is(left.intelligence.bidDepthUsd, right.intelligence.bidDepthUsd)
    && Object.is(left.intelligence.askDepthUsd, right.intelligence.askDepthUsd)
    && Object.is(left.intelligence.microprice, right.intelligence.microprice)
    && Object.is(left.intelligence.bookImbalancePct, right.intelligence.bookImbalancePct);
}

export function terminalCertifiedTapeViewEqual(
  left: TerminalCertifiedMarketSignals,
  right: TerminalCertifiedMarketSignals,
) {
  if (left === right) return true;
  const leftState = left.components.trades;
  const rightState = right.components.trades;
  return leftState.ready === rightState.ready
    && leftState.blocker === rightState.blocker
    && Object.is(left.tape.tradeVwap, right.tape.tradeVwap)
    && Object.is(left.tape.buyFlowPct, right.tape.buyFlowPct)
    && tradesEqual(left.tape.trades, right.tape.trades);
}

type ClockInspection = {
  ageMs: number | null;
  timestampMs: number | null;
  blocker: Extract<
    TerminalCertifiedSignalBlocker,
    "clock_missing" | "clock_invalid" | "clock_future" | "component_stale"
  > | null;
};

type BaseInspection = {
  frame: GholaMarketFrame | null;
  blocker: Extract<
    TerminalCertifiedSignalBlocker,
    "frame_unavailable" | "synthetic_source" | "identity_mismatch"
  > | null;
};

const EMPTY_INTELLIGENCE: TerminalCertifiedIntelligence = Object.freeze({
  sessionChangePct: null,
  sessionHigh: null,
  sessionLow: null,
  atr: null,
  atrBps: null,
  realizedVolatilityBps: null,
  bookImbalancePct: null,
  microprice: null,
  micropriceEdgeBps: null,
  bidDepthUsd: null,
  askDepthUsd: null,
  tradeVwap: null,
  buyFlowPct: null,
});

const USABLE_TRANSPORTS = new Set<UnifiedLiveMarketStatus>(["live", "fallback_polling"]);

export function deriveTerminalCertifiedMarketSignals(
  input: TerminalCertifiedMarketSignalInput,
): TerminalCertifiedMarketSignals {
  const nowMs = input.nowMs === undefined ? Date.now() : finitePositive(input.nowMs);
  const maxAgeMs = boundedMaxAge(input.maxAgeMs);
  const base = inspectBase(input);
  const exactQuoteClock = inspectClock(
    base.frame?.componentTimestamps,
    input.componentAgesMs,
    "quote",
    nowMs,
    Number.POSITIVE_INFINITY,
  );
  const exactBookClock = inspectClock(base.frame?.componentTimestamps, input.componentAgesMs, "book", nowMs, Number.POSITIVE_INFINITY);
  const exactTradesClock = inspectClock(base.frame?.componentTimestamps, input.componentAgesMs, "trades", nowMs, Number.POSITIVE_INFINITY);
  const exactCandlesClock = inspectClock(base.frame?.componentTimestamps, input.componentAgesMs, "candles", nowMs, Number.POSITIVE_INFINITY);
  const actionableBlocker = actionableBaseBlocker(input, base);

  const quote = certifyQuote(input, base, actionableBlocker, nowMs, maxAgeMs);
  const book = certifyBook(input, base, actionableBlocker, nowMs, maxAgeMs);
  const trades = certifyTrades(input, base, actionableBlocker, nowMs, maxAgeMs);
  const candles = certifyCandles(input, base, actionableBlocker, nowMs, maxAgeMs);

  const components = {
    quote: quote.state,
    book: book.state,
    trades: trades.state,
    candles: candles.state,
  };
  const certifiedMetrics = base.frame ? deriveTerminalMarketMetrics({
    ...base.frame,
    mid: book.frame?.mid ?? null,
    bestBid: book.frame?.bestBid ?? null,
    bestAsk: book.frame?.bestAsk ?? null,
    spreadBps: book.frame?.spreadBps ?? null,
    candles: candles.frame?.candles ?? [],
    bids: book.frame?.bids ?? [],
    asks: book.frame?.asks ?? [],
    trades: trades.frame?.trades ?? [],
  }, { nowMs: nowMs ?? undefined }) : null;
  const intelligence: TerminalCertifiedIntelligence = {
    ...EMPTY_INTELLIGENCE,
    sessionChangePct: candles.frame ? certifiedMetrics?.sessionChangePct ?? null : null,
    sessionHigh: candles.frame ? certifiedMetrics?.sessionHigh ?? null : null,
    sessionLow: candles.frame ? certifiedMetrics?.sessionLow ?? null : null,
    atr: candles.frame ? certifiedMetrics?.atr ?? null : null,
    atrBps: candles.frame ? certifiedMetrics?.atrBps ?? null : null,
    realizedVolatilityBps: candles.frame ? certifiedMetrics?.realizedVolatilityBps ?? null : null,
    bookImbalancePct: book.frame ? certifiedMetrics?.bookImbalancePct ?? null : null,
    microprice: book.frame ? certifiedMetrics?.microprice ?? null : null,
    micropriceEdgeBps: book.frame ? certifiedMetrics?.micropriceEdgeBps ?? null : null,
    bidDepthUsd: book.frame ? certifiedMetrics?.bidDepthUsd ?? null : null,
    askDepthUsd: book.frame ? certifiedMetrics?.askDepthUsd ?? null : null,
    tradeVwap: trades.frame ? certifiedMetrics?.tradeVwap ?? null : null,
    buyFlowPct: trades.frame ? certifiedMetrics?.buyFlowPct ?? null : null,
  };
  const marketAgeMs = base.frame && exactQuoteClock.blocker == null
    ? exactQuoteClock.ageMs
    : null;
  const alertSnapshot: TerminalAlertSnapshot = {
    price: quote.price,
    spread_bps: quote.spreadBps,
    book_imbalance_pct: intelligence.bookImbalancePct,
    microprice_edge_bps: intelligence.micropriceEdgeBps,
    realized_volatility_bps: intelligence.realizedVolatilityBps,
    market_age_ms: marketAgeMs,
    book_age_ms: alertableComponentAge(exactBookClock, book.state),
    trades_age_ms: alertableComponentAge(exactTradesClock, trades.state),
    candles_age_ms: alertableComponentAge(exactCandlesClock, candles.state),
  };
  const availableAlertMetrics = (Object.entries(alertSnapshot) as Array<[
    TerminalAlertMetric,
    number | null | undefined,
  ]>).flatMap(([metric, value]) => value != null && Number.isFinite(value) ? [metric] : []);

  return {
    snapshotInstrument: base.frame?.product ?? null,
    evaluationIdentityKey: base.frame ? terminalCertifiedEvaluationIdentity(base.frame) : null,
    referencePrice: quote.price,
    bookFrame: book.frame,
    alertSnapshot,
    availableAlertMetrics,
    components,
    intelligence,
    tape: {
      trades: trades.frame?.trades ?? [],
      tradeVwap: intelligence.tradeVwap,
      buyFlowPct: intelligence.buyFlowPct,
    },
    surfaces: {
      intelligence: surfaceState(components, ["candles", "book", "trades"]),
      tape: surfaceState(components, ["trades"]),
      alerts: alertSurfaceState(components, availableAlertMetrics, marketAgeMs),
    },
  };
}

export function terminalCertifiedSignalBlockerLabel(
  component: TerminalCertifiedSignalComponent,
  blocker: TerminalCertifiedSignalBlocker | null,
): string {
  if (blocker === "frame_unavailable") return "public frame unavailable";
  if (blocker === "synthetic_source") return "synthetic fallback excluded";
  if (blocker === "identity_mismatch") return "market identity mismatch";
  if (blocker === "transport_unavailable") return "public transport unavailable";
  if (blocker === "controller_stale" || blocker === "frame_stale") return "public feed stale";
  if (blocker === "clock_missing") return `${component} clock missing`;
  if (blocker === "clock_invalid") return `${component} clock invalid`;
  if (blocker === "clock_future") return `${component} clock is in the future`;
  if (blocker === "component_stale") return `${component} component stale`;
  if (blocker === "quote_invalid") return "quote malformed or crossed";
  if (blocker === "book_invalid") return "book malformed, unsorted, or crossed";
  if (blocker === "trades_empty") return "no recent public prints";
  if (blocker === "trades_invalid") return "public prints malformed";
  if (blocker === "trades_clock_mismatch") return "print clock does not match payload";
  if (blocker === "candles_empty") return "candle history unavailable";
  if (blocker === "candles_invalid") return "candle history malformed";
  if (blocker === "candles_clock_mismatch") return "candle clock does not match payload";
  return "certification pending";
}

function inspectBase(input: TerminalCertifiedMarketSignalInput): BaseInspection {
  if (input.source !== "public_live") return { frame: null, blocker: "synthetic_source" };
  if (!input.frame) return { frame: null, blocker: "frame_unavailable" };
  const frameNetwork = canonicalIdentityPart(input.frame.network);
  const selectedNetwork = canonicalIdentityPart(input.selection.network);
  if (
    !terminalFrameMatchesSelection(input.frame, input.selection) ||
    !frameNetwork ||
    !selectedNetwork ||
    frameNetwork !== selectedNetwork
  ) {
    return { frame: null, blocker: "identity_mismatch" };
  }
  return { frame: input.frame, blocker: null };
}

function actionableBaseBlocker(
  input: TerminalCertifiedMarketSignalInput,
  base: BaseInspection,
): TerminalCertifiedSignalBlocker | null {
  if (base.blocker) return base.blocker;
  if (input.controllerStale) return "controller_stale";
  if (base.frame?.stale) return "frame_stale";
  if (!USABLE_TRANSPORTS.has(input.status)) return "transport_unavailable";
  return null;
}

function certifyQuote(
  input: TerminalCertifiedMarketSignalInput,
  base: BaseInspection,
  baseBlocker: TerminalCertifiedSignalBlocker | null,
  nowMs: number | null,
  maxAgeMs: number,
) {
  if (baseBlocker || !base.frame) {
    return { state: paused(baseBlocker ?? "frame_unavailable"), price: null, spreadBps: null };
  }
  const clock = inspectClock(
    base.frame.componentTimestamps,
    input.componentAgesMs,
    "quote",
    nowMs,
    maxAgeMs,
  );
  if (clock.blocker) return { state: paused(clock.blocker, clock.ageMs), price: null, spreadBps: null };
  const bid = finitePositive(base.frame.bestBid);
  const ask = finitePositive(base.frame.bestAsk);
  if (bid == null || ask == null || bid >= ask) {
    return { state: paused("quote_invalid", clock.ageMs), price: null, spreadBps: null };
  }
  const price = bid + (ask - bid) / 2;
  return {
    state: ready(clock.ageMs),
    price,
    spreadBps: ((ask - bid) / price) * 10_000,
  };
}

function certifyBook(
  input: TerminalCertifiedMarketSignalInput,
  base: BaseInspection,
  baseBlocker: TerminalCertifiedSignalBlocker | null,
  nowMs: number | null,
  maxAgeMs: number,
) {
  if (baseBlocker || !base.frame) return { state: paused(baseBlocker ?? "frame_unavailable"), frame: null };
  const clock = inspectClock(
    base.frame.componentTimestamps,
    input.componentAgesMs,
    "book",
    nowMs,
    maxAgeMs,
  );
  if (clock.blocker) return { state: paused(clock.blocker, clock.ageMs), frame: null };
  const book = inspectBook(base.frame);
  if (!book) return { state: paused("book_invalid", clock.ageMs), frame: null };
  return {
    state: ready(clock.ageMs),
    frame: {
      ...sectionFrame(base.frame, { candles: [], trades: [] }),
      mid: String(book.midpoint),
      bestBid: String(book.bestBid),
      bestAsk: String(book.bestAsk),
      spreadBps: book.spreadBps,
    },
  };
}

function certifyTrades(
  input: TerminalCertifiedMarketSignalInput,
  base: BaseInspection,
  baseBlocker: TerminalCertifiedSignalBlocker | null,
  nowMs: number | null,
  maxAgeMs: number,
) {
  if (baseBlocker || !base.frame) return { state: paused(baseBlocker ?? "frame_unavailable"), frame: null };
  const clock = inspectClock(
    base.frame.componentTimestamps,
    input.componentAgesMs,
    "trades",
    nowMs,
    maxAgeMs,
  );
  if (clock.blocker) return { state: paused(clock.blocker, clock.ageMs), frame: null };
  if (base.frame.trades.length === 0) return { state: paused("trades_empty", clock.ageMs), frame: null };
  const normalized = normalizeTrades(base.frame.trades, nowMs);
  if (!normalized) return { state: paused("trades_invalid", clock.ageMs), frame: null };
  if (normalized[0]?.time !== clock.timestampMs) {
    return { state: paused("trades_clock_mismatch", clock.ageMs), frame: null };
  }
  return {
    state: ready(clock.ageMs),
    frame: sectionFrame(base.frame, { candles: [], bids: [], asks: [], trades: normalized }),
  };
}

function certifyCandles(
  input: TerminalCertifiedMarketSignalInput,
  base: BaseInspection,
  baseBlocker: TerminalCertifiedSignalBlocker | null,
  nowMs: number | null,
  maxAgeMs: number,
) {
  if (baseBlocker || !base.frame) return { state: paused(baseBlocker ?? "frame_unavailable"), frame: null };
  const intervalMs = intervalMilliseconds(input.selection.interval);
  if (intervalMs == null) return { state: paused("candles_invalid"), frame: null };
  const clock = inspectClock(
    base.frame.componentTimestamps,
    input.componentAgesMs,
    "candles",
    nowMs,
    intervalMs + maxAgeMs,
  );
  if (clock.blocker) return { state: paused(clock.blocker, clock.ageMs), frame: null };
  if (base.frame.candles.length === 0) return { state: paused("candles_empty", clock.ageMs), frame: null };
  if (!validCandles(base.frame.candles, nowMs, intervalMs)) {
    return { state: paused("candles_invalid", clock.ageMs), frame: null };
  }
  const latestTimestamp = normalizeMarketTimestamp(base.frame.candles.at(-1)?.t);
  if (latestTimestamp !== clock.timestampMs) {
    return { state: paused("candles_clock_mismatch", clock.ageMs), frame: null };
  }
  return {
    state: ready(clock.ageMs),
    frame: sectionFrame(base.frame, { bids: [], asks: [], trades: [] }),
  };
}

function inspectClock(
  clocks: MarketComponentClocks | undefined,
  componentAgesMs: Partial<Record<MarketComponent, number>>,
  component: MarketComponent,
  nowMs: number | null,
  maxAgeMs: number,
): ClockInspection {
  const rawTimestamp = clocks?.[component];
  const timestampMs = normalizeMarketTimestamp(rawTimestamp);
  const reportedAgeMs = finiteNonNegative(componentAgesMs[component]);
  if (rawTimestamp == null || reportedAgeMs == null) {
    return { ageMs: null, timestampMs: null, blocker: "clock_missing" };
  }
  if (timestampMs == null || nowMs == null) {
    return { ageMs: null, timestampMs: null, blocker: "clock_invalid" };
  }
  if (timestampMs > nowMs) {
    return { ageMs: null, timestampMs, blocker: "clock_future" };
  }
  const ageMs = Math.max(reportedAgeMs, nowMs - timestampMs);
  if (ageMs > maxAgeMs) return { ageMs, timestampMs, blocker: "component_stale" };
  return { ageMs, timestampMs, blocker: null };
}

function inspectBook(frame: GholaMarketFrame): {
  bestBid: number;
  bestAsk: number;
  midpoint: number;
  spreadBps: number;
} | null {
  const bids = normalizeBookSide(frame.bids, "bid");
  const asks = normalizeBookSide(frame.asks, "ask");
  if (!bids || !asks || bids[0]! >= asks[0]!) return null;
  const displayedBid = frame.bestBid == null ? bids[0] : finitePositive(frame.bestBid);
  const displayedAsk = frame.bestAsk == null ? asks[0] : finitePositive(frame.bestAsk);
  if (displayedBid !== bids[0] || displayedAsk !== asks[0]) return null;
  const midpoint = bids[0]! + (asks[0]! - bids[0]!) / 2;
  return {
    bestBid: bids[0]!,
    bestAsk: asks[0]!,
    midpoint,
    spreadBps: ((asks[0]! - bids[0]!) / midpoint) * 10_000,
  };
}

function normalizeBookSide(
  levels: GholaMarketFrame["bids"],
  side: "bid" | "ask",
): number[] | null {
  if (levels.length === 0) return null;
  const prices: number[] = [];
  for (const level of levels) {
    const price = finitePositive(level.px);
    const size = finitePositive(level.sz);
    if (price == null || size == null) return null;
    const previous = prices.at(-1);
    if (previous != null && (side === "bid" ? price >= previous : price <= previous)) return null;
    prices.push(price);
  }
  return prices;
}

function normalizeTrades(trades: GholaChartTrade[], nowMs: number | null): GholaChartTrade[] | null {
  if (nowMs == null) return null;
  const byIdentity = new Map<string, { fingerprint: string; trade: GholaChartTrade }>();
  for (const trade of trades) {
    const price = finitePositive(trade.px);
    const size = finitePositive(trade.sz);
    const time = normalizeMarketTimestamp(trade.time);
    if ((trade.side !== "buy" && trade.side !== "sell") || price == null || size == null || time == null || time > nowMs) {
      return null;
    }
    const id = typeof trade.id === "string" && trade.id.trim() ? trade.id.trim() : null;
    const fingerprint = `${time}:${trade.side}:${price}:${size}`;
    const identity = id ? `id:${id}` : `tuple:${fingerprint}`;
    const current = byIdentity.get(identity);
    if (current && current.fingerprint !== fingerprint) return null;
    if (!current) {
      byIdentity.set(identity, {
        fingerprint,
        trade: { ...(id ? { id } : {}), side: trade.side, px: String(price), sz: String(size), time },
      });
    }
  }
  return [...byIdentity.values()]
    .map((item) => item.trade)
    .sort((left, right) => right.time - left.time || tradeIdentity(left).localeCompare(tradeIdentity(right)));
}

function validCandles(candles: GholaChartCandle[], nowMs: number | null, intervalMs: number): boolean {
  if (nowMs == null) return false;
  let previous: number | null = null;
  for (const candle of candles) {
    const timestamp = normalizeMarketTimestamp(candle.t);
    const closeTimestamp = candle.T == null ? null : normalizeMarketTimestamp(candle.T);
    const open = finitePositive(candle.o);
    const high = finitePositive(candle.h);
    const low = finitePositive(candle.l);
    const close = finitePositive(candle.c);
    const volume = finiteNonNegative(candle.v);
    if (
      timestamp == null || timestamp > nowMs ||
      (candle.T != null && closeTimestamp == null) ||
      (closeTimestamp != null && closeTimestamp < timestamp) ||
      open == null || high == null || low == null || close == null || volume == null ||
      high < Math.max(open, close) || low > Math.min(open, close) || high < low ||
      (previous != null && (timestamp <= previous || timestamp - previous > intervalMs * 3))
    ) return false;
    previous = timestamp;
  }
  return true;
}

function sectionFrame(
  frame: GholaMarketFrame,
  overrides: Partial<Pick<GholaMarketFrame, "candles" | "bids" | "asks" | "trades">>,
): GholaMarketFrame {
  return { ...frame, ...overrides };
}

function surfaceState(
  states: Record<TerminalCertifiedSignalComponent, TerminalCertifiedSignalState>,
  components: TerminalCertifiedSignalComponent[],
): TerminalCertifiedSignalSurface {
  const readyCount = components.filter((component) => states[component].ready).length;
  if (readyCount === components.length) return { status: "ready", message: "exact public component clocks certified" };
  const pausedComponents = [...new Set(components
    .filter((component) => !states[component].ready)
    .map((component) => terminalCertifiedSignalBlockerLabel(component, states[component].blocker)))];
  return {
    status: readyCount > 0 ? "degraded" : "paused",
    message: pausedComponents.join(" · "),
  };
}

function alertSurfaceState(
  states: Record<TerminalCertifiedSignalComponent, TerminalCertifiedSignalState>,
  metrics: TerminalAlertMetric[],
  marketAgeMs: number | null,
): TerminalCertifiedSignalSurface {
  if (metrics.length === 9) return { status: "ready", message: "nine exact public metrics monitoring" };
  if (metrics.length > 0) {
    const ageOnly = metrics.every((metric) => metric === "market_age_ms" || metric === "book_age_ms" || metric === "trades_age_ms" || metric === "candles_age_ms");
    return {
      status: "degraded",
      message: ageOnly
        ? "exact component-age alerts only; actionable signals paused"
        : `${metrics.length}/9 exact public metrics monitoring`,
    };
  }
  const quote = states.quote;
  return {
    status: "paused",
    message: marketAgeMs == null
      ? terminalCertifiedSignalBlockerLabel("quote", quote.blocker)
      : "no certifiable public alert metric",
  };
}

function paused(
  blocker: TerminalCertifiedSignalBlocker,
  ageMs: number | null = null,
): TerminalCertifiedSignalState {
  return { ready: false, blocker, ageMs };
}

function ready(ageMs: number | null): TerminalCertifiedSignalState {
  return { ready: true, blocker: null, ageMs };
}

function alertableComponentAge(
  clock: ClockInspection,
  state: TerminalCertifiedSignalState,
): number | null {
  if (clock.blocker != null || clock.ageMs == null) return null;
  return state.ready
    || state.blocker === "component_stale"
    || state.blocker === "controller_stale"
    || state.blocker === "frame_stale"
    ? clock.ageMs
    : null;
}

function boundedMaxAge(value: number | undefined): number {
  if (value === undefined) return TERMINAL_CERTIFIED_SIGNAL_MAX_AGE_MS;
  return Number.isFinite(value)
    ? Math.min(120_000, Math.max(1_000, Math.floor(value)))
    : TERMINAL_CERTIFIED_SIGNAL_MAX_AGE_MS;
}

function intervalMilliseconds(interval: string): number | null {
  if (interval === "1m") return 60_000;
  if (interval === "5m") return 300_000;
  if (interval === "15m") return 900_000;
  if (interval === "1h") return 3_600_000;
  return null;
}

function tradeIdentity(trade: GholaChartTrade): string {
  return trade.id ?? `${trade.time}:${trade.side}:${trade.px}:${trade.sz}`;
}

function surfaceEqual(left: TerminalCertifiedSignalSurface, right: TerminalCertifiedSignalSurface) {
  return left.status === right.status && left.message === right.message;
}

function tradesEqual(left: readonly GholaChartTrade[], right: readonly GholaChartTrade[]) {
  return left === right || (
    left.length === right.length
    && left.every((trade, index) => {
      const candidate = right[index];
      return candidate != null
        && trade.id === candidate.id
        && trade.side === candidate.side
        && trade.px === candidate.px
        && trade.sz === candidate.sz
        && trade.time === candidate.time;
    })
  );
}

function terminalCertifiedEvaluationIdentity(frame: GholaMarketFrame): string | null {
  const network = canonicalIdentityPart(frame.network);
  const product = canonicalIdentityPart(frame.product);
  const interval = canonicalIdentityPart(frame.interval);
  return network && product && interval
    ? `${frame.venue}:${network}:${product}:${interval}`
    : null;
}

function canonicalIdentityPart(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function finitePositive(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNonNegative(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
