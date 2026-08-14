import type { GholaChartCandle, GholaMarketFrame } from "./ghola-market-chart";

export interface GholaChartRangeMeasurement {
  anchorIndex: number;
  targetIndex: number;
  bars: number;
  startTime: number;
  endTime: number;
  elapsedMs: number;
  startPrice: number;
  endPrice: number;
  absoluteChange: number;
  changePct: number;
  high: number;
  low: number;
  rangePct: number;
  volume: number;
}

export interface GholaChartSessionMarker {
  index: number;
  time: number;
  label: string;
}

export function measureGholaCandleRange(
  candles: GholaChartCandle[],
  anchorIndex: number,
  targetIndex: number,
): GholaChartRangeMeasurement | null {
  if (candles.length === 0) return null;
  const anchor = clampIndex(anchorIndex, candles.length);
  const target = clampIndex(targetIndex, candles.length);
  const startPrice = finiteNumber(candles[anchor]?.c);
  const endPrice = finiteNumber(candles[target]?.c);
  if (startPrice == null || endPrice == null || startPrice === 0) return null;
  const lower = Math.min(anchor, target);
  const upper = Math.max(anchor, target);
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let volume = 0;
  for (let index = lower; index <= upper; index += 1) {
    const candle = candles[index];
    const candleHigh = finiteNumber(candle?.h);
    const candleLow = finiteNumber(candle?.l);
    const candleVolume = finiteNumber(candle?.v);
    if (candleHigh != null) high = Math.max(high, candleHigh);
    if (candleLow != null) low = Math.min(low, candleLow);
    if (candleVolume != null && candleVolume > 0) volume += candleVolume;
  }
  if (!Number.isFinite(high)) high = Math.max(startPrice, endPrice);
  if (!Number.isFinite(low)) low = Math.min(startPrice, endPrice);
  const absoluteChange = endPrice - startPrice;
  return {
    anchorIndex: anchor,
    targetIndex: target,
    bars: Math.abs(target - anchor),
    startTime: candles[anchor].t,
    endTime: candles[target].t,
    elapsedMs: Math.abs(timestampMs(candles[target].t) - timestampMs(candles[anchor].t)),
    startPrice,
    endPrice,
    absoluteChange,
    changePct: (absoluteChange / Math.abs(startPrice)) * 100,
    high,
    low,
    rangePct: low === 0 ? 0 : ((high - low) / Math.abs(low)) * 100,
    volume,
  };
}

export function defaultGholaReplayCursor(length: number) {
  const maximum = Math.max(0, Math.floor(length) - 2);
  return Math.min(maximum, Math.max(0, 19, Math.floor(length * 0.7) - 1));
}

export function captureGholaReplaySource(frame: GholaMarketFrame): GholaMarketFrame {
  return {
    ...frame,
    candles: frame.candles.map((candle) => ({ ...candle })),
    bids: frame.bids.map((level) => ({ ...level })),
    asks: frame.asks.map((level) => ({ ...level })),
    trades: frame.trades.map((trade) => ({ ...trade })),
    routeQuotes: frame.routeQuotes.map((quote) => ({
      ...quote,
      routeSummary: [...quote.routeSummary],
    })),
  };
}

export function gholaReplayFrame(frame: GholaMarketFrame, cursor: number): GholaMarketFrame {
  if (frame.candles.length === 0) return frame;
  const index = clampIndex(cursor, frame.candles.length);
  const candles = frame.candles.slice(0, index + 1);
  const last = candles.at(-1);
  if (!last) return frame;
  const cutoff = timestampMs(last.T ?? last.t);
  return {
    ...frame,
    fetchedAt: isoTimestamp(last.T ?? last.t),
    mid: last.c,
    bestBid: null,
    bestAsk: null,
    spreadBps: null,
    markPrice: last.c,
    oraclePrice: null,
    fundingRate: null,
    openInterest: null,
    dayVolume: null,
    candles,
    bids: [],
    asks: [],
    trades: frame.trades.filter((trade) => timestampMs(trade.time) <= cutoff),
    routeQuotes: frame.routeQuotes.filter((quote) => timestampMs(quote.t) <= cutoff),
  };
}

export function gholaChartSessionMarkers(candles: GholaChartCandle[], sessionHourUtc = 0): GholaChartSessionMarker[] {
  if (candles.length < 2) return [];
  const hour = Math.min(23, Math.max(0, Math.floor(sessionHourUtc)));
  const offset = hour * 60 * 60 * 1_000;
  const day = 24 * 60 * 60 * 1_000;
  const markers: GholaChartSessionMarker[] = [];
  let previousSession = Math.floor((timestampMs(candles[0].t) - offset) / day);
  for (let index = 1; index < candles.length; index += 1) {
    const session = Math.floor((timestampMs(candles[index].t) - offset) / day);
    if (session === previousSession) continue;
    markers.push({
      index,
      time: session * day + offset,
      label: `${String(hour).padStart(2, "0")}:00Z`,
    });
    previousSession = session;
  }
  return markers;
}

function clampIndex(value: number, length: number) {
  if (length <= 1) return 0;
  const normalized = Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(length - 1, Math.max(0, normalized));
}

function finiteNumber(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) < 100_000_000_000) return value * 1_000;
  if (Math.abs(value) > 100_000_000_000_000) return value / 1_000;
  return value;
}

function isoTimestamp(value: number) {
  const milliseconds = timestampMs(value);
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}
