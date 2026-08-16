import type { GholaChartMode, GholaChartOverlay } from "./ghola-market-chart";

export interface GholaChartPricePlot {
  top: number;
  bottom: number;
  min: number;
  max: number;
}

export interface GholaChartPriceDrag {
  overlayId: string;
  pointerId: number;
  startPointerY: number;
  startPointerPrice: number;
  price: number;
}

export interface GholaChartPriceDragCommitInput {
  drag: GholaChartPriceDrag | null;
  pointerId: number;
  pointerY: number;
  plot: GholaChartPricePlot | null;
  mode: GholaChartMode;
  replayActive: boolean;
  overlays: GholaChartOverlay[];
  cancelled: boolean;
}

export function gholaChartPriceDragAllowed(mode: GholaChartMode, replayActive: boolean) {
  return !replayActive && (mode === "candles" || mode === "line" || mode === "compare");
}

export function gholaDraggablePriceOverlayAtY(
  overlays: GholaChartOverlay[],
  pointerY: number,
  plot: GholaChartPricePlot,
  mode: GholaChartMode,
  replayActive: boolean,
  hitRadius = 12,
) {
  if (!gholaChartPriceDragAllowed(mode, replayActive) || !validPlot(plot) || !Number.isFinite(pointerY)) {
    return null;
  }
  let closest: GholaChartOverlay | null = null;
  let closestDistance = Math.max(0, hitRadius);
  for (const overlay of overlays) {
    if (!draggablePriceOverlay(overlay)) continue;
    const distance = Math.abs(pointerY - priceToY(Number(overlay.price), plot));
    if (distance > closestDistance || (closest && distance === closestDistance)) continue;
    closest = overlay;
    closestDistance = distance;
  }
  return closest;
}

export function gholaChartDragPriceAtY(pointerY: number, plot: GholaChartPricePlot) {
  if (!Number.isFinite(pointerY) || !validPlot(plot)) return null;
  const y = Math.min(plot.bottom, Math.max(plot.top, pointerY));
  const ratio = (y - plot.top) / (plot.bottom - plot.top);
  const price = plot.max - ratio * (plot.max - plot.min);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function gholaChartPriceDragCommit(
  input: GholaChartPriceDragCommitInput,
) {
  const { drag, plot } = input;
  if (
    input.cancelled
    || !drag
    || drag.pointerId !== input.pointerId
    || !plot
    || !gholaChartPriceDragAllowed(input.mode, input.replayActive)
    || !input.overlays.some((overlay) => overlay.id === drag.overlayId && draggablePriceOverlay(overlay))
  ) return null;
  if (!Number.isFinite(input.pointerY) || Math.abs(input.pointerY - drag.startPointerY) < 1) return null;
  const price = gholaChartDragPriceAtY(input.pointerY, plot);
  const minimumStep = gholaChartPlanInputStep(drag.startPointerPrice);
  if (price == null || minimumStep == null) return null;
  const movement = Math.abs(price - drag.startPointerPrice);
  if (movement + minimumStep * 1e-9 < minimumStep) return null;
  return { overlayId: drag.overlayId, price };
}

export function gholaChartPlanInputStep(price: number) {
  if (!Number.isFinite(price) || price <= 0) return null;
  return price >= 1_000 ? 0.1 : 0.01;
}

function priceToY(price: number, plot: GholaChartPricePlot) {
  return plot.top + ((plot.max - price) / (plot.max - plot.min)) * (plot.bottom - plot.top);
}

function draggablePriceOverlay(overlay: GholaChartOverlay) {
  return overlay.kind === "price_line"
    && overlay.interaction?.kind === "drag_price"
    && Number.isFinite(overlay.price)
    && Number(overlay.price) > 0;
}

function validPlot(plot: GholaChartPricePlot) {
  return Number.isFinite(plot.top)
    && Number.isFinite(plot.bottom)
    && Number.isFinite(plot.min)
    && Number.isFinite(plot.max)
    && plot.bottom > plot.top
    && plot.max > plot.min;
}
