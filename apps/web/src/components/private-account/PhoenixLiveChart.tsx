"use client";

// From-scratch Canvas 2D live chart for Phoenix SOL. NOT a TradingView skin.
//
// The draw loop runs every requestAnimationFrame and is fully decoupled from data
// arrival: the latest snapshot lives in a ref, and the displayed price eases toward
// the latest tick each frame (framerate-independent). Solana settles in ~400ms slots,
// so new information arrives at slot/WS cadence — the smoothness here is interpolation,
// not sub-slot data. Mirrors the canvas lifecycle of `pixel-field/PixelField.tsx`
// (DPR scaling, ResizeObserver, IntersectionObserver pause, reduced-motion fallback).

import { useEffect, useRef } from "react";
import {
  canvasYForPrice,
  formatPhoenixPrice,
  frameAlpha,
  interpolatePrice,
  priceAtCanvasY,
  type PhoenixChartMode,
} from "@/lib/phoenix-chart-helpers";
import type { PhoenixMarketSnapshot } from "@/lib/phoenix-market-data";

const COLORS = {
  bg: "#05070b",
  grid: "#152238",
  axis: "#6f7d9a",
  text: "#aab5c8",
  bull: "#6ee7b7",
  bear: "#fca5a5",
  accent: "#a8d8ff",
  bid: "#34d399",
  ask: "#f87171",
};

const RIGHT_GUTTER = 60;
const TOP_PAD = 12;
const BOTTOM_PAD = 14;
const MAX_PRICE_POINTS = 600;
const MAX_CANDLES = 90;

type PricePoint = { t: number; px: number };
type Bounds = { min: number; max: number };

export interface PhoenixLiveChartProps {
  snapshot: PhoenixMarketSnapshot | null;
  mode: PhoenixChartMode;
  onSelectPrice: (price: string, side: "buy" | "sell") => void;
  height?: number;
}

export function PhoenixLiveChart({ snapshot, mode, onSelectPrice, height = 320 }: PhoenixLiveChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapshotRef = useRef<PhoenixMarketSnapshot | null>(snapshot);
  const modeRef = useRef<PhoenixChartMode>(mode);
  const onSelectRef = useRef(onSelectPrice);
  const pricePointsRef = useRef<PricePoint[]>([]);
  const renderRef = useRef({ displayMid: Number.NaN, targetMid: Number.NaN, lastFrame: 0 });
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const pointerRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const boundsRef = useRef<Bounds>({ min: 0, max: 1 });
  const visibleRef = useRef(true);
  const reducedMotionRef = useRef(false);

  // Keep refs in sync with props without restarting the rAF loop.
  useEffect(() => {
    onSelectRef.current = onSelectPrice;
  }, [onSelectPrice]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    snapshotRef.current = snapshot;
    const mid = pickMid(snapshot);
    if (mid != null) {
      renderRef.current.targetMid = mid;
      if (Number.isNaN(renderRef.current.displayMid)) renderRef.current.displayMid = mid;
      const points = pricePointsRef.current;
      const last = points[points.length - 1];
      if (!last || last.px !== mid) {
        points.push({ t: Date.now(), px: mid });
        if (points.length > MAX_PRICE_POINTS) points.splice(0, points.length - MAX_PRICE_POINTS);
      }
    }
  }, [snapshot]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const rebuild = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { width, height: h, dpr };
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (now: number) => {
      const { width, height: h } = sizeRef.current;
      if (!width || !h) return;
      const state = renderRef.current;
      const dt = state.lastFrame ? now - state.lastFrame : 16;
      state.lastFrame = now;

      // Ease the displayed price toward the latest tick (the "hyper speed" glide).
      if (!reducedMotionRef.current && Number.isFinite(state.targetMid)) {
        state.displayMid = interpolatePrice(state.displayMid, state.targetMid, frameAlpha(dt, 90));
      } else if (Number.isFinite(state.targetMid)) {
        state.displayMid = state.targetMid;
      }

      const snap = snapshotRef.current;
      const plotLeft = 0;
      const plotRight = width - RIGHT_GUTTER;
      const plotTop = TOP_PAD;
      const plotBottom = h - BOTTOM_PAD;
      const plotW = Math.max(1, plotRight - plotLeft);
      const plotH = Math.max(1, plotBottom - plotTop);

      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, width, h);

      const activeMode = modeRef.current;
      const bounds =
        activeMode === "depth"
          ? depthPriceBounds(snap)
          : priceBounds(snap, pricePointsRef.current, state.displayMid);
      boundsRef.current = bounds;

      drawGrid(ctx, plotLeft, plotTop, plotW, plotH, RIGHT_GUTTER, bounds);

      if (activeMode === "depth") {
        drawDepth(ctx, snap, plotLeft, plotTop, plotW, plotH, bounds);
      } else if (activeMode === "candles" && (snap?.candles.length ?? 0) > 1) {
        drawCandles(ctx, snap, plotLeft, plotTop, plotW, plotH, bounds);
      } else {
        drawLine(ctx, pricePointsRef.current, state.displayMid, plotLeft, plotTop, plotW, plotH, bounds);
      }

      if (activeMode !== "depth") {
        drawBookLines(ctx, snap, plotLeft, plotTop, plotW, plotH, RIGHT_GUTTER, bounds);
        drawLastPrice(ctx, state.displayMid, snap, plotLeft, plotTop, plotW, plotH, RIGHT_GUTTER, bounds);
      }

      drawCrosshair(ctx, pointerRef.current, plotLeft, plotTop, plotW, plotH, RIGHT_GUTTER, bounds);
    };

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = reducedMotion.matches;

    let raf = 0;
    const tick = (now: number) => {
      if (visibleRef.current) draw(now);
      raf = requestAnimationFrame(tick);
    };

    const ro = new ResizeObserver(() => {
      rebuild();
      draw(performance.now());
    });
    ro.observe(canvas);

    const io = new IntersectionObserver(
      (entries) => {
        visibleRef.current = entries.some((entry) => entry.isIntersecting) && !document.hidden;
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    const onVisibility = () => {
      visibleRef.current = !document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onReducedMotion = () => {
      reducedMotionRef.current = reducedMotion.matches;
    };
    reducedMotion.addEventListener("change", onReducedMotion);

    rebuild();
    draw(performance.now());
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reducedMotion.removeEventListener("change", onReducedMotion);
    };
  }, []);

  const handlePointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    pointerRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top, active: true };
  };
  const handleLeave = () => {
    pointerRef.current = { ...pointerRef.current, active: false };
  };
  const handleClick = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const { height: h } = sizeRef.current;
    const plotTop = TOP_PAD;
    const plotH = Math.max(1, h - BOTTOM_PAD - plotTop);
    const bounds = boundsRef.current;
    const price = priceAtCanvasY(y, plotTop, plotH, bounds.min, bounds.max);
    if (!Number.isFinite(price) || price <= 0) return;
    const mid = renderRef.current.targetMid;
    // A resting buy limit sits below mid; a sell limit sits above.
    const side: "buy" | "sell" = Number.isFinite(mid) && price > mid ? "sell" : "buy";
    onSelectRef.current(formatPhoenixPrice(price), side);
  };

  return (
    <canvas
      ref={canvasRef}
      style={{ height, touchAction: "none" }}
      className="block w-full cursor-crosshair select-none"
      onPointerMove={handlePointer}
      onPointerLeave={handleLeave}
      onPointerDown={handleClick}
    />
  );
}

// ---- drawing helpers ----

function pickMid(snapshot: PhoenixMarketSnapshot | null): number | null {
  if (!snapshot) return null;
  const candidates = [snapshot.mid, snapshot.mark_price];
  for (const value of candidates) {
    const n = value == null ? Number.NaN : Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const bid = snapshot.best_bid ? Number(snapshot.best_bid) : Number.NaN;
  const ask = snapshot.best_ask ? Number(snapshot.best_ask) : Number.NaN;
  if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
  return null;
}

function priceBounds(snapshot: PhoenixMarketSnapshot | null, points: PricePoint[], displayMid: number): Bounds {
  const values: number[] = [];
  if (snapshot) {
    for (const candle of snapshot.candles.slice(-MAX_CANDLES)) {
      const h = Number(candle.h);
      const l = Number(candle.l);
      if (Number.isFinite(h)) values.push(h);
      if (Number.isFinite(l)) values.push(l);
    }
    for (const value of [snapshot.best_bid, snapshot.best_ask]) {
      const n = value ? Number(value) : Number.NaN;
      if (Number.isFinite(n)) values.push(n);
    }
  }
  for (const point of points.slice(-MAX_PRICE_POINTS)) values.push(point.px);
  if (Number.isFinite(displayMid)) values.push(displayMid);
  if (values.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const pad = Math.abs(min) * 0.002 || 1;
    min -= pad;
    max += pad;
  } else {
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
  }
  return { min, max };
}

function depthPriceBounds(snapshot: PhoenixMarketSnapshot | null): Bounds {
  const prices: number[] = [];
  for (const level of snapshot?.bids ?? []) {
    const n = Number(level.px);
    if (Number.isFinite(n)) prices.push(n);
  }
  for (const level of snapshot?.asks ?? []) {
    const n = Number(level.px);
    if (Number.isFinite(n)) prices.push(n);
  }
  if (prices.length === 0) return { min: 0, max: 1 };
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  gutter: number,
  bounds: Bounds,
) {
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.axis;
  ctx.font = "11px ui-monospace, 'Geist Mono', monospace";
  ctx.textBaseline = "middle";
  const rows = 5;
  for (let i = 0; i <= rows; i += 1) {
    const y = top + (height * i) / rows;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(left, y + 0.5);
    ctx.lineTo(left + width, y + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
    const price = bounds.max - ((bounds.max - bounds.min) * i) / rows;
    ctx.fillText(formatPhoenixPrice(price), left + width + 6, y);
  }
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  points: PricePoint[],
  displayMid: number,
  left: number,
  top: number,
  width: number,
  height: number,
  bounds: Bounds,
) {
  const series = points.slice(-MAX_PRICE_POINTS);
  if (series.length < 2 && !Number.isFinite(displayMid)) return;
  const count = Math.max(series.length, 2);
  const xFor = (index: number) => left + (width * index) / (count - 1);
  const yFor = (price: number) => canvasYForPrice(price, top, height, bounds.min, bounds.max);

  // Gradient fill under the line.
  const lastY = Number.isFinite(displayMid) ? yFor(displayMid) : yFor(series[series.length - 1]?.px ?? bounds.min);
  ctx.beginPath();
  series.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.px);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  if (Number.isFinite(displayMid)) ctx.lineTo(left + width, lastY);
  const gradient = ctx.createLinearGradient(0, top, 0, top + height);
  gradient.addColorStop(0, "rgba(168,216,255,0.18)");
  gradient.addColorStop(1, "rgba(168,216,255,0)");
  ctx.lineTo(left + width, top + height);
  ctx.lineTo(left, top + height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // The line itself.
  ctx.beginPath();
  series.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.px);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  if (Number.isFinite(displayMid)) ctx.lineTo(left + width, lastY);
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Pulsing dot at the live price.
  if (Number.isFinite(displayMid)) {
    ctx.beginPath();
    ctx.arc(left + width, lastY, 3, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.accent;
    ctx.fill();
  }
}

function drawCandles(
  ctx: CanvasRenderingContext2D,
  snapshot: PhoenixMarketSnapshot | null,
  left: number,
  top: number,
  width: number,
  height: number,
  bounds: Bounds,
) {
  const candles = (snapshot?.candles ?? []).slice(-MAX_CANDLES);
  if (candles.length === 0) return;
  const slot = width / candles.length;
  const bodyW = Math.max(1, Math.min(10, slot * 0.62));
  const yFor = (price: number) => canvasYForPrice(price, top, height, bounds.min, bounds.max);
  candles.forEach((candle, index) => {
    const o = Number(candle.o);
    const h = Number(candle.h);
    const l = Number(candle.l);
    const c = Number(candle.c);
    if (![o, h, l, c].every(Number.isFinite)) return;
    const cx = left + slot * (index + 0.5);
    const up = c >= o;
    ctx.strokeStyle = up ? COLORS.bull : COLORS.bear;
    ctx.fillStyle = up ? COLORS.bull : COLORS.bear;
    // Wick
    ctx.beginPath();
    ctx.moveTo(cx, yFor(h));
    ctx.lineTo(cx, yFor(l));
    ctx.lineWidth = 1;
    ctx.stroke();
    // Body
    const yo = yFor(o);
    const yc = yFor(c);
    const bodyTop = Math.min(yo, yc);
    const bodyH = Math.max(1, Math.abs(yc - yo));
    ctx.fillRect(cx - bodyW / 2, bodyTop, bodyW, bodyH);
  });
}

function drawDepth(
  ctx: CanvasRenderingContext2D,
  snapshot: PhoenixMarketSnapshot | null,
  left: number,
  top: number,
  width: number,
  height: number,
  bounds: Bounds,
) {
  if (!snapshot || bounds.max <= bounds.min) return;
  const xFor = (price: number) => left + ((price - bounds.min) / (bounds.max - bounds.min)) * width;
  const bidPts = cumulative(snapshot.bids, "desc");
  const askPts = cumulative(snapshot.asks, "asc");
  const maxDepth = Math.max(1, ...bidPts.map((p) => p.cum), ...askPts.map((p) => p.cum));
  const yFor = (cum: number) => top + height - (cum / maxDepth) * height;

  const area = (pts: { px: number; cum: number }[], color: string, fill: string) => {
    if (pts.length === 0) return;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xFor(p.px);
      const y = yFor(p.cum);
      if (i === 0) ctx.moveTo(x, top + height);
      ctx.lineTo(x, y);
    });
    const lastX = xFor(pts[pts.length - 1].px);
    ctx.lineTo(lastX, top + height);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xFor(p.px);
      const y = yFor(p.cum);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };
  area(bidPts.slice().sort((a, b) => a.px - b.px), COLORS.bid, "rgba(52,211,153,0.16)");
  area(askPts, COLORS.ask, "rgba(248,113,113,0.16)");
}

function cumulative(levels: { px: string; sz: string }[], order: "asc" | "desc") {
  const sorted = levels
    .map((l) => ({ px: Number(l.px), sz: Number(l.sz) }))
    .filter((l) => Number.isFinite(l.px) && Number.isFinite(l.sz))
    .sort((a, b) => (order === "asc" ? a.px - b.px : b.px - a.px));
  let cum = 0;
  return sorted.map((l) => {
    cum += l.sz;
    return { px: l.px, cum };
  });
}

function drawBookLines(
  ctx: CanvasRenderingContext2D,
  snapshot: PhoenixMarketSnapshot | null,
  left: number,
  top: number,
  width: number,
  height: number,
  _gutter: number,
  bounds: Bounds,
) {
  if (!snapshot) return;
  const yFor = (price: number) => canvasYForPrice(price, top, height, bounds.min, bounds.max);
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  const draw = (value: string | null, color: string) => {
    if (!value) return;
    const price = Number(value);
    if (!Number.isFinite(price)) return;
    const y = yFor(price);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(left, y + 0.5);
    ctx.lineTo(left + width, y + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  draw(snapshot.best_bid, COLORS.bid);
  draw(snapshot.best_ask, COLORS.ask);
  ctx.setLineDash([]);
}

function drawLastPrice(
  ctx: CanvasRenderingContext2D,
  displayMid: number,
  _snapshot: PhoenixMarketSnapshot | null,
  left: number,
  top: number,
  width: number,
  height: number,
  gutter: number,
  bounds: Bounds,
) {
  if (!Number.isFinite(displayMid)) return;
  const y = canvasYForPrice(displayMid, top, height, bounds.min, bounds.max);
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(left + width, y - 9, gutter, 18);
  ctx.fillStyle = "#05070b";
  ctx.font = "bold 11px ui-monospace, 'Geist Mono', monospace";
  ctx.textBaseline = "middle";
  ctx.fillText(formatPhoenixPrice(displayMid), left + width + 6, y);
}

function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  pointer: { x: number; y: number; active: boolean },
  left: number,
  top: number,
  width: number,
  height: number,
  gutter: number,
  bounds: Bounds,
) {
  if (!pointer.active) return;
  if (pointer.x < left || pointer.x > left + width || pointer.y < top || pointer.y > top + height) return;
  ctx.save();
  ctx.strokeStyle = "rgba(170,181,200,0.4)";
  ctx.setLineDash([2, 2]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, pointer.y + 0.5);
  ctx.lineTo(left + width, pointer.y + 0.5);
  ctx.moveTo(pointer.x + 0.5, top);
  ctx.lineTo(pointer.x + 0.5, top + height);
  ctx.stroke();
  ctx.setLineDash([]);
  const price = priceAtCanvasY(pointer.y, top, height, bounds.min, bounds.max);
  ctx.fillStyle = "#1b2740";
  ctx.fillRect(left + width, pointer.y - 9, gutter, 18);
  ctx.fillStyle = COLORS.text;
  ctx.font = "11px ui-monospace, 'Geist Mono', monospace";
  ctx.textBaseline = "middle";
  ctx.fillText(formatPhoenixPrice(price), left + width + 6, pointer.y);
  ctx.restore();
}
