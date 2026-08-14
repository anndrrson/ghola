import type { GholaChartCandle, GholaChartTrade } from "./ghola-market-chart";

export interface GholaOrderFlowBucket {
  candleIndex: number;
  time: number;
  endTime: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  cumulativeDelta: number;
  tradeCount: number;
  tradesPerMinute: number;
  imbalancePct: number;
  coverage: "reported_trades";
}

export interface GholaAbsorptionCandidate {
  id: string;
  candleIndex: number;
  time: number;
  price: number;
  side: "buy" | "sell";
  delta: number;
  imbalancePct: number;
  priceChangePct: number;
  volumeRatio: number;
  label: string;
  detail: string;
}

export interface GholaOrderFlowAnalysis {
  buckets: GholaOrderFlowBucket[];
  candidates: GholaAbsorptionCandidate[];
  buyVolume: number;
  sellVolume: number;
  delta: number;
  cumulativeDelta: number;
  imbalancePct: number;
  tradesPerMinute: number | null;
  speedRatio: number | null;
  coverageStart: number | null;
  coverageEnd: number | null;
  reportedTrades: number;
  ignoredTrades: number;
}

export interface GholaOrderFlowOptions {
  speedWindowMs?: number;
  baselineWindowMs?: number;
  maxCandidates?: number;
  absorptionImbalancePct?: number;
  absorptionMaxPriceChangePct?: number;
  absorptionMinVolumeRatio?: number;
}

export function analyzeGholaOrderFlow(
  candles: GholaChartCandle[],
  trades: GholaChartTrade[],
  options: GholaOrderFlowOptions = {},
): GholaOrderFlowAnalysis {
  const intervals = candles.flatMap((candle, candleIndex) => {
    const start = timestampMs(candle.t);
    const end = timestampMs(candle.T ?? candle.t);
    return start > 0 && end >= start ? [{ candleIndex, start, end, candle }] : [];
  });
  const buckets: GholaOrderFlowBucket[] = intervals.map(({ candleIndex, start, end }) => ({
    candleIndex,
    time: start,
    endTime: end,
    buyVolume: 0,
    sellVolume: 0,
    delta: 0,
    cumulativeDelta: 0,
    tradeCount: 0,
    tradesPerMinute: 0,
    imbalancePct: 0,
    coverage: "reported_trades",
  }));
  const bucketByCandleIndex = new Map(buckets.map((bucket) => [bucket.candleIndex, bucket]));
  const sortedTrades = trades.flatMap((trade) => {
    const time = timestampMs(trade.time);
    const size = finitePositive(trade.sz);
    const price = finitePositive(trade.px);
    return time > 0 && size != null && price != null ? [{ ...trade, time, size, price }] : [];
  }).sort((a, b) => a.time - b.time);
  let ignoredTrades = trades.length - sortedTrades.length;
  let cursor = 0;
  const assignedTrades: typeof sortedTrades = [];
  for (const trade of sortedTrades) {
    while (cursor < intervals.length && trade.time > intervals[cursor].end) cursor += 1;
    const interval = intervals[cursor];
    if (!interval || trade.time < interval.start || trade.time > interval.end) {
      ignoredTrades += 1;
      continue;
    }
    const bucket = bucketByCandleIndex.get(interval.candleIndex);
    if (!bucket) {
      ignoredTrades += 1;
      continue;
    }
    if (trade.side === "buy") bucket.buyVolume += trade.size;
    else bucket.sellVolume += trade.size;
    bucket.tradeCount += 1;
    assignedTrades.push(trade);
  }
  let cumulativeDelta = 0;
  for (const bucket of buckets) {
    bucket.delta = bucket.buyVolume - bucket.sellVolume;
    cumulativeDelta += bucket.delta;
    bucket.cumulativeDelta = cumulativeDelta;
    const total = bucket.buyVolume + bucket.sellVolume;
    bucket.imbalancePct = total > 0 ? (bucket.delta / total) * 100 : 0;
    const minutes = Math.max(1 / 60, (bucket.endTime - bucket.time + 1) / 60_000);
    bucket.tradesPerMinute = bucket.tradeCount / minutes;
  }
  const buyVolume = buckets.reduce((total, bucket) => total + bucket.buyVolume, 0);
  const sellVolume = buckets.reduce((total, bucket) => total + bucket.sellVolume, 0);
  const delta = buyVolume - sellVolume;
  const total = buyVolume + sellVolume;
  const speed = calculateTapeSpeed(assignedTrades.map((trade) => trade.time), options);
  return {
    buckets,
    candidates: detectAbsorptionCandidates(candles, buckets, options),
    buyVolume,
    sellVolume,
    delta,
    cumulativeDelta,
    imbalancePct: total > 0 ? (delta / total) * 100 : 0,
    tradesPerMinute: speed.current,
    speedRatio: speed.ratio,
    coverageStart: assignedTrades[0]?.time ?? null,
    coverageEnd: assignedTrades.at(-1)?.time ?? null,
    reportedTrades: assignedTrades.length,
    ignoredTrades,
  };
}

function detectAbsorptionCandidates(
  candles: GholaChartCandle[],
  buckets: GholaOrderFlowBucket[],
  options: GholaOrderFlowOptions,
) {
  const imbalanceThreshold = bounded(options.absorptionImbalancePct, 65, 50, 99);
  const priceThreshold = bounded(options.absorptionMaxPriceChangePct, 0.12, 0.01, 2);
  const volumeThreshold = bounded(options.absorptionMinVolumeRatio, 1.5, 1, 10);
  const maxCandidates = Math.round(bounded(options.maxCandidates, 12, 1, 32));
  const candidates: GholaAbsorptionCandidate[] = [];
  const activeVolumes = buckets.map((bucket) => bucket.buyVolume + bucket.sellVolume).filter((volume) => volume > 0);
  if (activeVolumes.length < 3) return candidates;
  const baseline = median(activeVolumes);
  if (baseline <= 0) return candidates;
  for (const bucket of buckets) {
    const candle = candles[bucket.candleIndex];
    const open = finitePositive(candle?.o);
    const close = finitePositive(candle?.c);
    const total = bucket.buyVolume + bucket.sellVolume;
    if (!candle || open == null || close == null || total <= 0) continue;
    const priceChangePct = ((close - open) / open) * 100;
    const volumeRatio = total / baseline;
    const limitedProgress = Math.abs(priceChangePct) <= priceThreshold;
    if (!limitedProgress || volumeRatio < volumeThreshold || Math.abs(bucket.imbalancePct) < imbalanceThreshold) continue;
    const side = bucket.delta > 0 ? "buy" as const : "sell" as const;
    candidates.push({
      id: `absorption:${candle.t}:${side}`,
      candleIndex: bucket.candleIndex,
      time: candle.t,
      price: close,
      side,
      delta: bucket.delta,
      imbalancePct: bucket.imbalancePct,
      priceChangePct,
      volumeRatio,
      label: side === "buy" ? "Buy absorption?" : "Sell absorption?",
      detail: `${side === "buy" ? "Buy" : "Sell"} trade imbalance with high reported volume and limited candle progress; candidate, not confirmed intent`,
    });
  }
  return candidates.slice(-maxCandidates);
}

function calculateTapeSpeed(times: number[], options: GholaOrderFlowOptions) {
  if (times.length < 2) return { current: null, ratio: null };
  const end = times.at(-1) ?? 0;
  const speedWindow = bounded(options.speedWindowMs, 60_000, 5_000, 15 * 60_000);
  const baselineWindow = bounded(options.baselineWindowMs, 5 * 60_000, speedWindow * 2, 60 * 60_000);
  const currentStart = end - speedWindow;
  const baselineStart = end - baselineWindow;
  const currentCount = times.filter((time) => time > currentStart && time <= end).length;
  const baselineCount = times.filter((time) => time > baselineStart && time <= currentStart).length;
  const current = currentCount / (speedWindow / 60_000);
  const baselineDuration = baselineWindow - speedWindow;
  const baseline = baselineCount / (baselineDuration / 60_000);
  return { current, ratio: baseline > 0 ? current / baseline : null };
}

function finitePositive(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function timestampMs(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) < 100_000_000_000) return value * 1_000;
  if (Math.abs(value) > 100_000_000_000_000) return value / 1_000;
  return value;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number) {
  const normalized = value != null && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, normalized));
}

function median(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
