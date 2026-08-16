import type { GholaChartCandle } from "./ghola-market-chart";

export interface GholaVolumeProfileBin {
  low: number;
  high: number;
  price: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  inValueArea: boolean;
}

export interface GholaVolumeProfile {
  bins: GholaVolumeProfileBin[];
  pocIndex: number;
  pocPrice: number;
  valueAreaLow: number;
  valueAreaHigh: number;
  valueAreaPct: number;
  valueAreaVolume: number;
  totalVolume: number;
  minPrice: number;
  maxPrice: number;
}

export function buildGholaVolumeProfile(
  candles: GholaChartCandle[],
  requestedBins = 24,
  requestedValueAreaPct = 0.7,
): GholaVolumeProfile | null {
  const samples = candles.flatMap((candle) => {
    const open = finiteNumber(candle.o);
    const high = finiteNumber(candle.h);
    const low = finiteNumber(candle.l);
    const close = finiteNumber(candle.c);
    const volume = finiteNumber(candle.v);
    if (open == null || high == null || low == null || close == null || volume == null || volume <= 0) return [];
    return [{ open, high: Math.max(high, low), low: Math.min(high, low), close, volume }];
  });
  if (samples.length === 0) return null;
  let minPrice = Math.min(...samples.map((sample) => sample.low));
  let maxPrice = Math.max(...samples.map((sample) => sample.high));
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) return null;
  if (maxPrice <= minPrice) {
    const padding = Math.abs(maxPrice) * 0.0001 || 1;
    minPrice -= padding;
    maxPrice += padding;
  }
  const binCount = Math.min(80, Math.max(1, Math.round(Number.isFinite(requestedBins) ? requestedBins : 24)));
  const valueAreaPct = Math.min(1, Math.max(0.01, Number.isFinite(requestedValueAreaPct) ? requestedValueAreaPct : 0.7));
  const binSize = (maxPrice - minPrice) / binCount;
  const bins: GholaVolumeProfileBin[] = Array.from({ length: binCount }, (_, index) => ({
    low: minPrice + index * binSize,
    high: index === binCount - 1 ? maxPrice : minPrice + (index + 1) * binSize,
    price: minPrice + (index + 0.5) * binSize,
    volume: 0,
    buyVolume: 0,
    sellVolume: 0,
    inValueArea: false,
  }));

  for (const sample of samples) {
    const up = sample.close >= sample.open;
    if (sample.high <= sample.low) {
      allocateVolume(bins[binIndex(sample.close, minPrice, binSize, binCount)], sample.volume, up);
      continue;
    }
    const first = binIndex(sample.low, minPrice, binSize, binCount);
    const last = binIndex(sample.high, minPrice, binSize, binCount);
    const overlaps: Array<{ index: number; weight: number }> = [];
    let overlapTotal = 0;
    for (let index = first; index <= last; index += 1) {
      const bin = bins[index];
      const overlap = Math.max(0, Math.min(sample.high, bin.high) - Math.max(sample.low, bin.low));
      if (overlap <= 0) continue;
      overlaps.push({ index, weight: overlap });
      overlapTotal += overlap;
    }
    if (overlapTotal <= 0) {
      allocateVolume(bins[binIndex(sample.close, minPrice, binSize, binCount)], sample.volume, up);
      continue;
    }
    for (const overlap of overlaps) {
      allocateVolume(bins[overlap.index], sample.volume * (overlap.weight / overlapTotal), up);
    }
  }

  const totalVolume = bins.reduce((total, bin) => total + bin.volume, 0);
  if (totalVolume <= 0) return null;
  let pocIndex = 0;
  for (let index = 1; index < bins.length; index += 1) {
    if (bins[index].volume > bins[pocIndex].volume) pocIndex = index;
  }
  const target = totalVolume * valueAreaPct;
  let valueAreaVolume = bins[pocIndex].volume;
  let valueAreaLowIndex = pocIndex;
  let valueAreaHighIndex = pocIndex;
  while (valueAreaVolume < target && (valueAreaLowIndex > 0 || valueAreaHighIndex < bins.length - 1)) {
    const lowerVolume = valueAreaLowIndex > 0 ? bins[valueAreaLowIndex - 1].volume : -1;
    const upperVolume = valueAreaHighIndex < bins.length - 1 ? bins[valueAreaHighIndex + 1].volume : -1;
    if (upperVolume > lowerVolume) {
      valueAreaHighIndex += 1;
      valueAreaVolume += bins[valueAreaHighIndex].volume;
    } else {
      valueAreaLowIndex -= 1;
      valueAreaVolume += bins[valueAreaLowIndex].volume;
    }
  }
  for (let index = valueAreaLowIndex; index <= valueAreaHighIndex; index += 1) bins[index].inValueArea = true;
  return {
    bins,
    pocIndex,
    pocPrice: bins[pocIndex].price,
    valueAreaLow: bins[valueAreaLowIndex].low,
    valueAreaHigh: bins[valueAreaHighIndex].high,
    valueAreaPct,
    valueAreaVolume,
    totalVolume,
    minPrice,
    maxPrice,
  };
}

function allocateVolume(bin: GholaVolumeProfileBin, volume: number, up: boolean) {
  bin.volume += volume;
  if (up) bin.buyVolume += volume;
  else bin.sellVolume += volume;
}

function binIndex(price: number, min: number, size: number, count: number) {
  return Math.min(count - 1, Math.max(0, Math.floor((price - min) / Math.max(Number.EPSILON, size))));
}

function finiteNumber(value: unknown) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
