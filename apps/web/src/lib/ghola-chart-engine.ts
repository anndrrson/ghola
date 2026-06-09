import {
  cumulativeDepth,
  decimateCandles,
  frameMidNumber,
  GholaChartStore,
  type GholaChartCandle,
  type GholaChartMode,
  type GholaChartOverlay,
  type GholaMarketFrame,
} from "./ghola-market-chart";

export interface GholaChartViewport {
  zoom: number;
  offset: number;
  followLatest: boolean;
  minPrice: number | null;
  maxPrice: number | null;
}

export interface GholaDepthPoint {
  px: number;
  sz: number;
  cumulative: number;
}

export interface GholaChartRange {
  min: number;
  max: number;
}

export interface GholaChartVisibleData {
  revision: number;
  mode: GholaChartMode;
  frame: GholaMarketFrame | null;
  compareFrames: GholaMarketFrame[];
  overlays: GholaChartOverlay[];
  candles: GholaChartCandle[];
  lineCandles: GholaChartCandle[];
  compareLineCandles: GholaChartCandle[][];
  bids: GholaDepthPoint[];
  asks: GholaDepthPoint[];
  routeQuotes: NonNullable<GholaMarketFrame["routeQuotes"]>;
  range: GholaChartRange;
  viewport: GholaChartViewport;
}

export interface GholaChartVisibleOptions {
  width: number;
  height: number;
  mode?: GholaChartMode;
  viewport?: GholaChartViewport;
}

export type GholaChartWorkerRequest =
  | { id?: number; type: "set-frame"; frame: GholaMarketFrame | null }
  | { id?: number; type: "set-compare"; frames: GholaMarketFrame[] }
  | { id?: number; type: "set-overlays"; overlays: GholaChartOverlay[] }
  | { id?: number; type: "set-mode"; mode: GholaChartMode }
  | { id?: number; type: "set-viewport"; viewport: GholaChartViewport }
  | { id: number; type: "visible-data"; width: number; height: number };

export type GholaChartWorkerResponse =
  | { id?: number; type: "ack"; revision: number }
  | { id: number; type: "visible-data"; data: GholaChartVisibleData }
  | { id?: number; type: "error"; message: string };

const MIN_ZOOM = 1;
const MAX_ZOOM = 80;

export class GholaChartEngineState {
  private store = new GholaChartStore();
  private compareFrames: GholaMarketFrame[] = [];
  private overlays: GholaChartOverlay[] = [];
  private mode: GholaChartMode = "candles";
  private viewport: GholaChartViewport = defaultGholaChartViewport();
  private revision = 0;

  ingestFrame(frame: GholaMarketFrame | null) {
    this.store.ingest(frame);
    this.revision += 1;
  }

  setCompareFrames(frames: GholaMarketFrame[]) {
    this.compareFrames = frames.slice(0, 6);
    this.revision += 1;
  }

  setOverlays(overlays: GholaChartOverlay[]) {
    this.overlays = overlays.slice(0, 24);
    this.revision += 1;
  }

  setMode(mode: GholaChartMode) {
    this.mode = mode;
    this.revision += 1;
  }

  setViewport(viewport: GholaChartViewport) {
    this.viewport = normalizeViewport(viewport);
    this.revision += 1;
  }

  getViewport() {
    return { ...this.viewport };
  }

  getRevision() {
    return this.revision;
  }

  frame() {
    return this.store.frame();
  }

  visibleData(options: GholaChartVisibleOptions): GholaChartVisibleData {
    const mode = options.mode ?? this.mode;
    const viewport = normalizeViewport(options.viewport ?? this.viewport);
    const width = Math.max(1, Math.floor(options.width));
    const activeFrame = windowFrame(this.store.frame(), mode, viewport, width);
    const activeCompare = this.compareFrames.map((frame) => windowFrame(frame, mode, viewport, width)).filter(Boolean) as GholaMarketFrame[];
    const candleBudget = Math.max(80, Math.floor(width / (mode === "candles" ? 3 : 2)));
    const candles = activeFrame ? decimateCandles(activeFrame.candles, candleBudget) : [];
    const lineCandles = activeFrame ? decimateCandles(activeFrame.candles, Math.max(120, Math.floor(width / 2))) : [];
    const compareLineCandles = activeCompare.map((compare) => decimateCandles(compare.candles, Math.max(120, Math.floor(width / 2))));
    const bids = activeFrame ? cumulativeDepth(activeFrame.bids, "bid") : [];
    const asks = activeFrame ? cumulativeDepth(activeFrame.asks, "ask") : [];
    return {
      revision: this.revision,
      mode,
      frame: activeFrame,
      compareFrames: activeCompare,
      overlays: this.overlays.slice(),
      candles,
      lineCandles,
      compareLineCandles,
      bids,
      asks,
      routeQuotes: activeFrame?.routeQuotes.slice() ?? [],
      range: chartValueRange(activeFrame, mode, this.overlays, activeCompare, viewport),
      viewport,
    };
  }
}

export function defaultGholaChartViewport(): GholaChartViewport {
  return {
    zoom: 1,
    offset: 0,
    followLatest: true,
    minPrice: null,
    maxPrice: null,
  };
}

export function resetGholaChartViewport(): GholaChartViewport {
  return defaultGholaChartViewport();
}

export function zoomGholaViewport(viewport: GholaChartViewport, factor: number, anchorX: number, width: number): GholaChartViewport {
  const normalized = normalizeViewport(viewport);
  const zoom = clamp(normalized.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  if (zoom === normalized.zoom) return normalized;
  const anchor = clamp(anchorX / Math.max(1, width), 0, 1);
  const zoomRatio = zoom / normalized.zoom;
  const anchoredOffset = normalized.offset * zoomRatio + (zoomRatio - 1) * (1 - anchor) * 16;
  return normalizeViewport({
    ...normalized,
    zoom,
    offset: zoom <= MIN_ZOOM ? 0 : anchoredOffset,
    followLatest: zoom <= MIN_ZOOM,
  });
}

export function panGholaViewport(viewport: GholaChartViewport, deltaX: number, width: number, sampleCount: number): GholaChartViewport {
  const normalized = normalizeViewport(viewport);
  if (normalized.zoom <= MIN_ZOOM || sampleCount <= 1) return normalized;
  const visibleSamples = Math.max(8, Math.ceil(sampleCount / normalized.zoom));
  const samplesPerPx = visibleSamples / Math.max(1, width);
  const maxOffset = Math.max(0, sampleCount - visibleSamples);
  return normalizeViewport({
    ...normalized,
    offset: clamp(normalized.offset + deltaX * samplesPerPx, 0, maxOffset),
    followLatest: false,
  });
}

export function chartPointCount(frame: GholaMarketFrame | null, mode: GholaChartMode) {
  if (!frame) return 0;
  if (mode === "route" || mode === "slippage" || mode === "quote") return frame.routeQuotes.length;
  return frame.candles.length;
}

export function nearestGholaCandle(candles: GholaChartCandle[], x: number, left: number, plotW: number) {
  if (candles.length === 0) return null;
  const fraction = clamp((x - left) / Math.max(1, plotW), 0, 1);
  const index = clamp(Math.round(fraction * (candles.length - 1)), 0, candles.length - 1);
  return candles[index] ?? null;
}

export function nearestGholaRouteQuote(quotes: GholaMarketFrame["routeQuotes"], x: number, left: number, plotW: number) {
  if (quotes.length === 0) return null;
  const fraction = clamp((x - left) / Math.max(1, plotW), 0, 1);
  const index = clamp(Math.round(fraction * (quotes.length - 1)), 0, quotes.length - 1);
  return quotes[index] ?? null;
}

export function handleGholaChartWorkerRequest(engine: GholaChartEngineState, request: GholaChartWorkerRequest): GholaChartWorkerResponse {
  try {
    if (request.type === "set-frame") {
      engine.ingestFrame(request.frame);
      return { id: request.id, type: "ack", revision: engine.getRevision() };
    }
    if (request.type === "set-compare") {
      engine.setCompareFrames(request.frames);
      return { id: request.id, type: "ack", revision: engine.getRevision() };
    }
    if (request.type === "set-overlays") {
      engine.setOverlays(request.overlays);
      return { id: request.id, type: "ack", revision: engine.getRevision() };
    }
    if (request.type === "set-mode") {
      engine.setMode(request.mode);
      return { id: request.id, type: "ack", revision: engine.getRevision() };
    }
    if (request.type === "set-viewport") {
      engine.setViewport(request.viewport);
      return { id: request.id, type: "ack", revision: engine.getRevision() };
    }
    return {
      id: request.id,
      type: "visible-data",
      data: engine.visibleData({ width: request.width, height: request.height }),
    };
  } catch (error) {
    return {
      id: request.id,
      type: "error",
      message: error instanceof Error ? error.message : "ghola_chart_worker_error",
    };
  }
}

function normalizeViewport(viewport: GholaChartViewport): GholaChartViewport {
  return {
    zoom: clamp(Number.isFinite(viewport.zoom) ? viewport.zoom : 1, MIN_ZOOM, MAX_ZOOM),
    offset: Math.max(0, Number.isFinite(viewport.offset) ? viewport.offset : 0),
    followLatest: viewport.followLatest,
    minPrice: finitePositiveOrNull(viewport.minPrice),
    maxPrice: finitePositiveOrNull(viewport.maxPrice),
  };
}

function windowFrame(frame: GholaMarketFrame | null, mode: GholaChartMode, viewport: GholaChartViewport, width: number): GholaMarketFrame | null {
  if (!frame) return null;
  if (mode === "depth") return frame;
  if (mode === "route" || mode === "slippage" || mode === "quote") {
    return {
      ...frame,
      routeQuotes: windowSamples(frame.routeQuotes, viewport, width),
    };
  }
  return {
    ...frame,
    candles: windowSamples(frame.candles, viewport, width),
  };
}

function windowSamples<T>(samples: T[], viewport: GholaChartViewport, width: number): T[] {
  if (samples.length === 0 || viewport.zoom <= MIN_ZOOM) return samples.slice();
  const visibleCount = clamp(Math.ceil(samples.length / viewport.zoom), Math.min(samples.length, Math.max(8, Math.floor(width / 18))), samples.length);
  const maxStart = Math.max(0, samples.length - visibleCount);
  const offset = clamp(Math.round(viewport.offset), 0, maxStart);
  const start = viewport.followLatest ? maxStart : Math.max(0, maxStart - offset);
  return samples.slice(start, start + visibleCount);
}

function chartValueRange(
  frame: GholaMarketFrame | null,
  mode: GholaChartMode,
  overlays: GholaChartOverlay[],
  compareFrames: GholaMarketFrame[],
  viewport: GholaChartViewport,
): GholaChartRange {
  if (viewport.minPrice != null && viewport.maxPrice != null && viewport.maxPrice > viewport.minPrice) {
    return { min: viewport.minPrice, max: viewport.maxPrice };
  }
  const values: number[] = [];
  const collect = (active: GholaMarketFrame | null) => {
    if (!active) return;
    if (mode === "depth") {
      for (const level of [...active.bids, ...active.asks]) {
        const px = Number(level.px);
        if (Number.isFinite(px)) values.push(px);
      }
      return;
    }
    if (mode === "route" || mode === "slippage" || mode === "quote") {
      for (const quote of active.routeQuotes) {
        const px = Number(quote.price);
        if (Number.isFinite(px)) values.push(px);
      }
      const mid = frameMidNumber(active);
      if (mid != null) values.push(mid);
      return;
    }
    for (const candle of active.candles) {
      const high = Number(candle.h);
      const low = Number(candle.l);
      if (Number.isFinite(high)) values.push(high);
      if (Number.isFinite(low)) values.push(low);
    }
    for (const value of [active.mid, active.bestBid, active.bestAsk, active.markPrice, active.oraclePrice]) {
      const number = Number(value);
      if (Number.isFinite(number)) values.push(number);
    }
  };
  collect(frame);
  for (const compare of compareFrames) collect(compare);
  for (const overlay of overlays) {
    for (const value of [overlay.price, overlay.priceEnd]) {
      if (Number.isFinite(value)) values.push(Number(value));
    }
  }
  if (values.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max <= min) {
    const pad = Math.abs(max) * 0.001 || 1;
    min -= pad;
    max += pad;
  } else {
    const pad = Math.max((max - min) * 0.1, Math.abs(max) * 0.0002);
    min -= pad;
    max += pad;
  }
  return { min, max };
}

function finitePositiveOrNull(value: number | null) {
  if (value == null) return null;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}
