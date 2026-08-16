import type { MarketComponent, MarketComponentClocks } from "./market-component-clock";

export const MARKET_FEED_TELEMETRY_VERSION = 2 as const;

export type MarketFeedHealthGrade = "A" | "B" | "C" | "D" | "F";
export type MarketFeedTelemetryStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "fallback_polling"
  | "stale"
  | "blocked";
export type MarketFeedRejectReason =
  | "invalid_snapshot"
  | "sequence_regression"
  | "timestamp_regression"
  | "validation_gap";

export interface MarketFeedTelemetry {
  version: typeof MARKET_FEED_TELEMETRY_VERSION;
  windowMs: number;
  sampleCapacity: number;
  rollingSampleCount: number;
  rollingEventCount: number;
  acceptedUpdateCount: number;
  rejectedUpdateCount: number;
  sourceAgeMs: number | null;
  receiptLatencyMs: number | null;
  componentAgesMs: Partial<Record<MarketComponent, number>>;
  updateRateHz: number;
  reconnectCount: number;
  fallbackCount: number;
  staleCount: number;
  sequenceRegressionCount: number;
  timestampRegressionCount: number;
  gapRejectCount: number;
  lastReceiptAt: string | null;
  healthScore: number;
  healthGrade: MarketFeedHealthGrade;
}

export interface MarketFeedTelemetryRecorder {
  recordAccepted: (input: {
    sourceTimestamp: number | null;
    dataTimestamp: number;
    componentTimestamps?: MarketComponentClocks;
  }) => void;
  recordReject: (reason: MarketFeedRejectReason) => void;
  recordStatus: (status: MarketFeedTelemetryStatus) => void;
  snapshot: (input?: {
    status?: MarketFeedTelemetryStatus;
    stale?: boolean;
  }) => MarketFeedTelemetry;
}

export interface MarketFeedTelemetryRecorderOptions {
  freshnessMs: number;
  now?: () => number;
  windowMs?: number;
  sampleCapacity?: number;
}

type Sample = {
  receiptAt: number;
  sourceTimestamp: number | null;
  componentTimestamps: MarketComponentClocks;
};

type Event = {
  at: number;
  type: "reconnect" | "fallback" | "stale" | MarketFeedRejectReason;
};

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_SAMPLE_CAPACITY = 120;
const MAX_COUNT = 1_000_000_000;

export function initialMarketFeedTelemetry(input: {
  windowMs?: number;
  sampleCapacity?: number;
} = {}): MarketFeedTelemetry {
  return {
    version: MARKET_FEED_TELEMETRY_VERSION,
    windowMs: boundedInteger(input.windowMs, DEFAULT_WINDOW_MS, 10_000, 5 * 60_000),
    sampleCapacity: boundedInteger(input.sampleCapacity, DEFAULT_SAMPLE_CAPACITY, 10, 600),
    rollingSampleCount: 0,
    rollingEventCount: 0,
    acceptedUpdateCount: 0,
    rejectedUpdateCount: 0,
    sourceAgeMs: null,
    receiptLatencyMs: null,
    componentAgesMs: {},
    updateRateHz: 0,
    reconnectCount: 0,
    fallbackCount: 0,
    staleCount: 0,
    sequenceRegressionCount: 0,
    timestampRegressionCount: 0,
    gapRejectCount: 0,
    lastReceiptAt: null,
    healthScore: 0,
    healthGrade: "F",
  };
}

export function createMarketFeedTelemetryRecorder(
  options: MarketFeedTelemetryRecorderOptions,
): MarketFeedTelemetryRecorder {
  const now = options.now ?? Date.now;
  const windowMs = boundedInteger(options.windowMs, DEFAULT_WINDOW_MS, 10_000, 5 * 60_000);
  const sampleCapacity = boundedInteger(options.sampleCapacity, DEFAULT_SAMPLE_CAPACITY, 10, 600);
  const freshnessMs = boundedInteger(options.freshnessMs, 30_000, 1_000, 60 * 60_000);
  const samples: Sample[] = [];
  const events: Event[] = [];
  let status: MarketFeedTelemetryStatus = "connecting";
  let acceptedUpdateCount = 0;
  let rejectedUpdateCount = 0;
  let reconnectCount = 0;
  let fallbackCount = 0;
  let staleCount = 0;
  let sequenceRegressionCount = 0;
  let timestampRegressionCount = 0;
  let gapRejectCount = 0;

  function prune(at: number) {
    const cutoff = at - windowMs;
    while (samples[0]?.receiptAt < cutoff) samples.shift();
    while (events[0]?.at < cutoff) events.shift();
    if (samples.length > sampleCapacity) samples.splice(0, samples.length - sampleCapacity);
    if (events.length > sampleCapacity) events.splice(0, events.length - sampleCapacity);
  }

  function pushEvent(type: Event["type"], at = now()) {
    events.push({ at, type });
    prune(at);
  }

  return {
    recordAccepted(input) {
      const receiptAt = now();
      samples.push({
        receiptAt,
        sourceTimestamp: finiteTimestamp(input.sourceTimestamp ?? input.dataTimestamp),
        componentTimestamps: { ...input.componentTimestamps },
      });
      acceptedUpdateCount = increment(acceptedUpdateCount);
      prune(receiptAt);
    },
    recordReject(reason) {
      rejectedUpdateCount = increment(rejectedUpdateCount);
      if (reason === "sequence_regression") sequenceRegressionCount = increment(sequenceRegressionCount);
      if (reason === "timestamp_regression") timestampRegressionCount = increment(timestampRegressionCount);
      if (reason === "validation_gap") gapRejectCount = increment(gapRejectCount);
      pushEvent(reason);
    },
    recordStatus(nextStatus) {
      if (nextStatus === status) return;
      status = nextStatus;
      if (nextStatus === "reconnecting") {
        reconnectCount = increment(reconnectCount);
        pushEvent("reconnect");
      }
      if (nextStatus === "fallback_polling") {
        fallbackCount = increment(fallbackCount);
        pushEvent("fallback");
      }
      if (nextStatus === "stale") {
        staleCount = increment(staleCount);
        pushEvent("stale");
      }
    },
    snapshot(input = {}) {
      const at = now();
      prune(at);
      const currentStatus = input.status ?? status;
      const latest = samples.at(-1) ?? null;
      const sourceAgeMs = latest?.sourceTimestamp == null
        ? null
        : nonNegative(at - latest.sourceTimestamp);
      const receiptLatencyMs = latest?.sourceTimestamp == null
        ? null
        : nonNegative(latest.receiptAt - latest.sourceTimestamp);
      const componentAgesMs = latest
        ? componentAges(latest.componentTimestamps, at)
        : {};
      const updateRateHz = rollingRateHz(samples);
      const healthScore = scoreHealth({
        status: currentStatus,
        stale: input.stale === true,
        sourceAgeMs,
        receiptLatencyMs,
        freshnessMs,
        events,
        hasSamples: samples.length > 0,
      });
      return {
        version: MARKET_FEED_TELEMETRY_VERSION,
        windowMs,
        sampleCapacity,
        rollingSampleCount: samples.length,
        rollingEventCount: events.length,
        acceptedUpdateCount,
        rejectedUpdateCount,
        sourceAgeMs,
        receiptLatencyMs,
        componentAgesMs,
        updateRateHz,
        reconnectCount,
        fallbackCount,
        staleCount,
        sequenceRegressionCount,
        timestampRegressionCount,
        gapRejectCount,
        lastReceiptAt: latest ? new Date(latest.receiptAt).toISOString() : null,
        healthScore,
        healthGrade: gradeForScore(healthScore),
      };
    },
  };
}

function scoreHealth(input: {
  status: MarketFeedTelemetryStatus;
  stale: boolean;
  sourceAgeMs: number | null;
  receiptLatencyMs: number | null;
  freshnessMs: number;
  events: Event[];
  hasSamples: boolean;
}): number {
  if (!input.hasSamples) return 0;
  let score = 100;
  if (input.status === "connecting") score -= 20;
  if (input.status === "reconnecting") score -= 25;
  if (input.status === "fallback_polling") score -= 10;
  if (input.status === "blocked") score -= 60;
  if (input.sourceAgeMs != null) {
    const ratio = input.sourceAgeMs / input.freshnessMs;
    if (ratio > 1) score -= 35;
    else if (ratio > 0.5) score -= 15;
    else if (ratio > 0.25) score -= 5;
  }
  if (input.receiptLatencyMs != null) {
    if (input.receiptLatencyMs > 10_000) score -= 30;
    else if (input.receiptLatencyMs > 3_000) score -= 15;
    else if (input.receiptLatencyMs > 1_000) score -= 5;
  }
  for (const event of input.events) {
    if (event.type === "reconnect") score -= 6;
    else if (event.type === "fallback") score -= 4;
    else if (event.type === "stale") score -= 12;
    else score -= 10;
  }
  if (input.stale || input.status === "stale") score = Math.min(score, 35);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function rollingRateHz(samples: Sample[]): number {
  if (samples.length < 2) return 0;
  const elapsed = samples.at(-1)!.receiptAt - samples[0].receiptAt;
  if (elapsed <= 0) return 0;
  return Number((((samples.length - 1) * 1_000) / elapsed).toFixed(3));
}

function gradeForScore(score: number): MarketFeedHealthGrade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

function finiteTimestamp(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function componentAges(
  timestamps: MarketComponentClocks,
  at: number,
): Partial<Record<MarketComponent, number>> {
  const ages: Partial<Record<MarketComponent, number>> = {};
  for (const [component, timestamp] of Object.entries(timestamps) as Array<[MarketComponent, number]>) {
    if (Number.isFinite(timestamp) && timestamp > 0) ages[component] = nonNegative(at - timestamp);
  }
  return ages;
}

function nonNegative(value: number): number {
  return Math.max(0, Math.round(value));
}

function increment(value: number): number {
  return Math.min(MAX_COUNT, value + 1);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value!)));
}
