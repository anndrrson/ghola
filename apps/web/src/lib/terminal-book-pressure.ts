import type { GholaChartBookLevel, GholaMarketFrame } from "./ghola-market-chart";

export const TERMINAL_BOOK_PRESSURE_CAPACITY = 90;
export const TERMINAL_BOOK_PRESSURE_LEVEL_LIMIT = 10;
export const TERMINAL_BOOK_PRESSURE_MIN_WINDOW_MS = 5_000;
export const TERMINAL_BOOK_PRESSURE_MAX_WINDOW_MS = 30_000;
export const TERMINAL_BOOK_PRESSURE_MAX_AGE_MS = 30_000;
export const TERMINAL_BOOK_PRESSURE_FUTURE_SKEW_MS = 30_000;

export type TerminalBookPressureBlocker =
  | "frame_unavailable"
  | "synthetic_frame"
  | "stale_frame"
  | "market_identity_mismatch"
  | "network_invalid"
  | "book_age_invalid"
  | "book_clock_missing"
  | "book_clock_future"
  | "book_clock_expired"
  | "book_empty"
  | "book_level_invalid"
  | "book_crossed"
  | "book_clock_regression"
  | "book_clock_collision"
  | "insufficient_history";

export type TerminalBookPressureClassification =
  | "bid_strengthening"
  | "ask_strengthening"
  | "balanced";

export type TerminalSpreadRegime = "tight" | "normal" | "wide";

export interface TerminalBookPressureInput {
  frame: GholaMarketFrame | null;
  selectedVenue: string;
  selectedProduct: string;
  selectedInterval: string;
  network: string;
  bookAgeMs: number | null | undefined;
  controllerStale?: boolean;
  synthetic?: boolean;
  nowMs: number;
}

export interface TerminalBookPressureSample {
  sourceTimeMs: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  totalDepthUsd: number;
  spreadBps: number;
  imbalancePct: number;
  microprice: number;
  micropriceEdgeBps: number;
  bookFingerprint: string;
}

export interface TerminalBookPressureState {
  identityKey: string | null;
  samples: TerminalBookPressureSample[];
}

export interface TerminalBookPressureDeltas {
  bidDepthPct: number;
  askDepthPct: number;
  totalDepthPct: number;
  imbalancePctPoints: number;
  micropriceEdgeBps: number;
  spreadPercentile: number | null;
  spreadRegime: TerminalSpreadRegime | null;
}

export interface TerminalBookPressureTape {
  status: "ready" | "unavailable";
  blocker: TerminalBookPressureBlocker | null;
  identityKey: string | null;
  historyCount: number;
  updateCount: number;
  horizonSeconds: number | null;
  latest: TerminalBookPressureSample | null;
  deltas: TerminalBookPressureDeltas | null;
  classification: TerminalBookPressureClassification | null;
}

export interface TerminalBookPressureAdvance {
  state: TerminalBookPressureState;
  tape: TerminalBookPressureTape;
}

type NormalizedLevel = { price: number; size: number };

export function initialTerminalBookPressureState(): TerminalBookPressureState {
  return { identityKey: null, samples: [] };
}

export function advanceTerminalBookPressureTape(
  previous: TerminalBookPressureState,
  input: TerminalBookPressureInput,
): TerminalBookPressureAdvance {
  const identityKey = selectionIdentity(input);
  if (!identityKey) {
    const state = initialTerminalBookPressureState();
    return unavailable(state, "network_invalid");
  }
  const state = previous.identityKey === identityKey
    ? previous
    : { identityKey, samples: [] };
  const captured = captureSample(input);
  if (captured.blocker) return unavailable(state, captured.blocker);

  const sample = captured.sample;
  const latest = state.samples.at(-1);
  if (latest && sample.sourceTimeMs < latest.sourceTimeMs) {
    return unavailable(state, "book_clock_regression");
  }
  if (latest?.sourceTimeMs === sample.sourceTimeMs) {
    if (latest.bookFingerprint !== sample.bookFingerprint) {
      return unavailable(state, "book_clock_collision");
    }
    return { state, tape: deriveTape(state) };
  }

  const nextState = {
    identityKey,
    samples: [...state.samples, sample].slice(-TERMINAL_BOOK_PRESSURE_CAPACITY),
  };
  return { state: nextState, tape: deriveTape(nextState) };
}

function captureSample(input: TerminalBookPressureInput): {
  sample: TerminalBookPressureSample;
  blocker: null;
} | {
  sample: null;
  blocker: Exclude<TerminalBookPressureBlocker, "insufficient_history">;
} {
  if (input.synthetic) return { sample: null, blocker: "synthetic_frame" };
  if (input.controllerStale) return { sample: null, blocker: "stale_frame" };
  const frame = input.frame;
  if (!frame) return { sample: null, blocker: "frame_unavailable" };
  if (frame.stale) return { sample: null, blocker: "stale_frame" };
  if (!frameIdentityMatches(frame, input)) {
    return { sample: null, blocker: "market_identity_mismatch" };
  }

  const nowMs = finitePositive(input.nowMs);
  const bookAgeMs = finiteNonNegative(input.bookAgeMs);
  if (nowMs == null || bookAgeMs == null) {
    return { sample: null, blocker: "book_age_invalid" };
  }
  const sourceTimeMs = finitePositive(frame.componentTimestamps?.book);
  if (sourceTimeMs == null) return { sample: null, blocker: "book_clock_missing" };
  if (sourceTimeMs > nowMs + TERMINAL_BOOK_PRESSURE_FUTURE_SKEW_MS) {
    return { sample: null, blocker: "book_clock_future" };
  }
  if (
    nowMs - sourceTimeMs > TERMINAL_BOOK_PRESSURE_MAX_AGE_MS
    || bookAgeMs > TERMINAL_BOOK_PRESSURE_MAX_AGE_MS
  ) {
    return { sample: null, blocker: "book_clock_expired" };
  }
  if (frame.bids.length === 0 || frame.asks.length === 0) {
    return { sample: null, blocker: "book_empty" };
  }

  const bids = normalizeLevels(frame.bids, "bid");
  const asks = normalizeLevels(frame.asks, "ask");
  if (!bids || !asks) return { sample: null, blocker: "book_level_invalid" };
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (!bestBid || !bestAsk) return { sample: null, blocker: "book_empty" };
  if (bestBid.price >= bestAsk.price) return { sample: null, blocker: "book_crossed" };

  const bidDepthUsd = notionalDepth(bids);
  const askDepthUsd = notionalDepth(asks);
  const totalDepthUsd = bidDepthUsd + askDepthUsd;
  const spread = bestAsk.price - bestBid.price;
  const mid = bestBid.price + spread / 2;
  const spreadBps = spread / mid * 10_000;
  const imbalancePct = (bidDepthUsd - askDepthUsd) / totalDepthUsd * 100;
  const topSize = bestBid.size + bestAsk.size;
  const microprice = (bestAsk.price * bestBid.size + bestBid.price * bestAsk.size) / topSize;
  const micropriceEdgeBps = (microprice - mid) / mid * 10_000;
  if (![bidDepthUsd, askDepthUsd, totalDepthUsd, spreadBps, imbalancePct, microprice, micropriceEdgeBps]
    .every(Number.isFinite) || bidDepthUsd <= 0 || askDepthUsd <= 0 || totalDepthUsd <= 0 || spreadBps <= 0 || topSize <= 0) {
    return { sample: null, blocker: "book_level_invalid" };
  }

  return {
    blocker: null,
    sample: {
      sourceTimeMs,
      bidDepthUsd,
      askDepthUsd,
      totalDepthUsd,
      spreadBps,
      imbalancePct,
      microprice,
      micropriceEdgeBps,
      bookFingerprint: fingerprint(bids, asks),
    },
  };
}

function deriveTape(state: TerminalBookPressureState): TerminalBookPressureTape {
  const latest = state.samples.at(-1);
  if (!latest) return unavailable(state, "insufficient_history").tape;
  let baseline: TerminalBookPressureSample | null = null;
  let baselineIndex = -1;
  for (let index = 0; index < state.samples.length - 1; index += 1) {
    const candidate = state.samples[index];
    if (!candidate) continue;
    const horizonMs = latest.sourceTimeMs - candidate.sourceTimeMs;
    if (
      horizonMs >= TERMINAL_BOOK_PRESSURE_MIN_WINDOW_MS
      && horizonMs <= TERMINAL_BOOK_PRESSURE_MAX_WINDOW_MS
    ) {
      baseline = candidate;
      baselineIndex = index;
      break;
    }
  }
  if (!baseline) return unavailable(state, "insufficient_history").tape;

  const deltas = {
    bidDepthPct: percentChange(latest.bidDepthUsd, baseline.bidDepthUsd),
    askDepthPct: percentChange(latest.askDepthUsd, baseline.askDepthUsd),
    totalDepthPct: percentChange(latest.totalDepthUsd, baseline.totalDepthUsd),
    imbalancePctPoints: latest.imbalancePct - baseline.imbalancePct,
    micropriceEdgeBps: latest.micropriceEdgeBps - baseline.micropriceEdgeBps,
    ...spreadContext(state.samples, latest),
  };
  return {
    status: "ready",
    blocker: null,
    identityKey: state.identityKey,
    historyCount: state.samples.length,
    updateCount: state.samples.length - 1 - baselineIndex,
    horizonSeconds: (latest.sourceTimeMs - baseline.sourceTimeMs) / 1_000,
    latest,
    deltas,
    classification: classify(deltas),
  };
}

function unavailable(
  state: TerminalBookPressureState,
  blocker: TerminalBookPressureBlocker,
): TerminalBookPressureAdvance {
  const latestTime = state.samples.at(-1)?.sourceTimeMs;
  const recentCount = latestTime == null
    ? 0
    : state.samples.filter((sample) => latestTime - sample.sourceTimeMs <= TERMINAL_BOOK_PRESSURE_MAX_WINDOW_MS).length;
  return {
    state,
    tape: {
      status: "unavailable",
      blocker,
      identityKey: state.identityKey,
      historyCount: state.samples.length,
      updateCount: Math.max(0, recentCount - 1),
      horizonSeconds: null,
      latest: null,
      deltas: null,
      classification: null,
    },
  };
}

function normalizeLevels(
  levels: GholaChartBookLevel[],
  side: "bid" | "ask",
): NormalizedLevel[] | null {
  const byPrice = new Map<number, number>();
  for (const level of levels) {
    const price = finitePositive(level.px);
    const size = finitePositive(level.sz);
    if (price == null || size == null) return null;
    const nextSize = (byPrice.get(price) ?? 0) + size;
    if (!Number.isFinite(nextSize) || nextSize <= 0) return null;
    byPrice.set(price, nextSize);
  }
  const normalized = [...byPrice.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price)
    .slice(0, TERMINAL_BOOK_PRESSURE_LEVEL_LIMIT);
  return normalized.length > 0 ? normalized : null;
}

function notionalDepth(levels: NormalizedLevel[]) {
  let total = 0;
  for (const level of levels) total += level.price * level.size;
  return total;
}

function fingerprint(bids: NormalizedLevel[], asks: NormalizedLevel[]) {
  const encode = (levels: NormalizedLevel[]) => levels.map((level) => `${level.price}:${level.size}`).join(",");
  return `b:${encode(bids)}|a:${encode(asks)}`;
}

function selectionIdentity(input: TerminalBookPressureInput) {
  const venue = canonical(input.selectedVenue);
  const product = canonicalProduct(input.selectedProduct);
  const interval = canonical(input.selectedInterval);
  const network = canonical(input.network);
  return venue && product && interval && network
    ? `${venue}:${product}:${interval}:${network}`
    : null;
}

function frameIdentityMatches(frame: GholaMarketFrame, input: TerminalBookPressureInput) {
  const frameNetwork = frame.network == null ? "" : canonical(frame.network);
  return canonical(frame.venue) === canonical(input.selectedVenue)
    && canonicalProduct(frame.product) === canonicalProduct(input.selectedProduct)
    && canonical(frame.interval) === canonical(input.selectedInterval)
    && frameNetwork !== ""
    && frameNetwork === canonical(input.network);
}

function spreadContext(
  samples: TerminalBookPressureSample[],
  latest: TerminalBookPressureSample,
): Pick<TerminalBookPressureDeltas, "spreadPercentile" | "spreadRegime"> {
  const recent = samples.filter((sample) => (
    latest.sourceTimeMs - sample.sourceTimeMs <= TERMINAL_BOOK_PRESSURE_MAX_WINDOW_MS
  ));
  if (recent.length < 5) return { spreadPercentile: null, spreadRegime: null };
  let below = 0;
  let equal = 0;
  for (const sample of recent) {
    const tolerance = Math.max(1e-12, Math.abs(latest.spreadBps) * 1e-12);
    if (sample.spreadBps < latest.spreadBps - tolerance) below += 1;
    else if (Math.abs(sample.spreadBps - latest.spreadBps) <= tolerance) equal += 1;
  }
  const spreadPercentile = (below + equal / 2) / recent.length * 100;
  return {
    spreadPercentile,
    spreadRegime: spreadPercentile <= 25 ? "tight" : spreadPercentile >= 75 ? "wide" : "normal",
  };
}

function canonical(value: string) {
  return value.trim().toLowerCase();
}

function canonicalProduct(value: string) {
  return value.trim().toUpperCase().replace(/[-/](?:USD|USDC|PERP)$/u, "");
}

function finitePositive(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function percentChange(current: number, previous: number) {
  return (current - previous) / previous * 100;
}

function classify(deltas: TerminalBookPressureDeltas): TerminalBookPressureClassification {
  const depthTiltPct = deltas.bidDepthPct - deltas.askDepthPct;
  if (
    deltas.imbalancePctPoints >= 1
    && depthTiltPct >= 1
    && deltas.micropriceEdgeBps >= 0
  ) return "bid_strengthening";
  if (
    deltas.imbalancePctPoints <= -1
    && depthTiltPct <= -1
    && deltas.micropriceEdgeBps <= 0
  ) return "ask_strengthening";
  return "balanced";
}
