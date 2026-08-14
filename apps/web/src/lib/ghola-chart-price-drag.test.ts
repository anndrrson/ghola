import { describe, expect, it } from "vitest";
import {
  gholaChartDragPriceAtY,
  gholaChartPriceDragCommit,
  gholaChartPriceDragAllowed,
  gholaChartPlanInputStep,
  gholaDraggablePriceOverlayAtY,
  type GholaChartPricePlot,
} from "./ghola-chart-price-drag";
import type { GholaChartOverlay } from "./ghola-market-chart";

const plot: GholaChartPricePlot = { top: 20, bottom: 220, min: 80, max: 120 };

describe("ghola chart price drag", () => {
  it("selects the nearest interactive price line and resolves a tie by overlay order", () => {
    const overlays: GholaChartOverlay[] = [
      draggable("entry", 100),
      draggable("stop", 100),
      { id: "static", kind: "price_line", label: "static", tone: "neutral", price: 100.5 },
      { id: "band", kind: "price_band", label: "band", tone: "bad", price: 99, priceEnd: 101 },
    ];

    expect(gholaDraggablePriceOverlayAtY(overlays, 120, plot, "candles", false)?.id).toBe("entry");
    expect(gholaDraggablePriceOverlayAtY(overlays, 118, plot, "candles", false)?.id).toBe("entry");
    expect(gholaDraggablePriceOverlayAtY(overlays, 10, plot, "candles", false)).toBeNull();
  });

  it("disables dragging outside live price modes", () => {
    const overlays = [draggable("entry", 100)];

    expect(gholaChartPriceDragAllowed("compare", false)).toBe(true);
    expect(gholaDraggablePriceOverlayAtY(overlays, 120, plot, "depth", false)).toBeNull();
    expect(gholaDraggablePriceOverlayAtY(overlays, 120, plot, "candles", true)).toBeNull();
  });

  it("maps and clamps pointer y to a valid plot price", () => {
    expect(gholaChartDragPriceAtY(120, plot)).toBe(100);
    expect(gholaChartDragPriceAtY(-10, plot)).toBe(120);
    expect(gholaChartDragPriceAtY(300, plot)).toBe(80);
    expect(gholaChartDragPriceAtY(20, { ...plot, max: plot.min })).toBeNull();
    expect(gholaChartDragPriceAtY(20, { ...plot, min: -20, max: -10 })).toBeNull();
  });

  it("revalidates ownership, mode, replay, overlay, and plot at commit", () => {
    const drag = { overlayId: "entry", pointerId: 7, startPointerY: 120, startPointerPrice: 100, price: 101.25 };
    const input = {
      drag,
      pointerId: 7,
      pointerY: 119,
      plot,
      mode: "candles" as const,
      replayActive: false,
      overlays: [draggable("entry", 100)],
      cancelled: false,
    };

    expect(gholaChartPriceDragCommit({ ...input, pointerId: 8 })).toBeNull();
    expect(gholaChartPriceDragCommit({ ...input, cancelled: true })).toBeNull();
    expect(gholaChartPriceDragCommit({ ...input, replayActive: true })).toBeNull();
    expect(gholaChartPriceDragCommit({ ...input, mode: "depth" })).toBeNull();
    expect(gholaChartPriceDragCommit({ ...input, overlays: [] })).toBeNull();
    expect(gholaChartPriceDragCommit({ ...input, plot: null })).toBeNull();
    expect(gholaChartPriceDragCommit(input)).toEqual({ overlayId: "entry", price: 100.2 });
  });

  it("does not commit a click or a scale change without physical movement", () => {
    const drag = { overlayId: "entry", pointerId: 7, startPointerY: 120, startPointerPrice: 100, price: 100 };
    const input = {
      drag,
      pointerId: 7,
      pointerY: 120,
      plot,
      mode: "candles" as const,
      replayActive: false,
      overlays: [draggable("entry", 100)],
      cancelled: false,
    };
    expect(gholaChartPriceDragCommit(input)).toBeNull();
    expect(gholaChartPriceDragCommit({
      ...input,
      plot: { ...plot, min: 90, max: 130 },
    })).toBeNull();
    expect(gholaChartPriceDragCommit({ ...input, pointerY: -10 })).toEqual({ overlayId: "entry", price: 120 });
  });

  it("uses the same visible plan tick as TradePage for BTC and HYPE", () => {
    const finePlot = { top: 0, bottom: 1_000, min: 999, max: 1_001 };
    const btc = {
      drag: { overlayId: "entry", pointerId: 7, startPointerY: 500, startPointerPrice: 1_000, price: 1_000 },
      pointerId: 7,
      pointerY: 540,
      plot: finePlot,
      mode: "candles" as const,
      replayActive: false,
      overlays: [draggable("entry", 1_000)],
      cancelled: false,
    };
    const hypePlot = { top: 0, bottom: 1_000, min: 9, max: 11 };
    const hype = {
      ...btc,
      drag: { overlayId: "entry", pointerId: 7, startPointerY: 500, startPointerPrice: 10, price: 10 },
      pointerY: 503,
      plot: hypePlot,
      overlays: [draggable("entry", 10)],
    };

    expect(gholaChartPlanInputStep(1_000)).toBe(0.1);
    expect(gholaChartPlanInputStep(999.99)).toBe(0.01);
    expect(gholaChartPlanInputStep(0)).toBeNull();
    expect(gholaChartPriceDragCommit(btc)).toBeNull();
    expect(gholaChartPriceDragCommit({ ...btc, pointerY: 560 })).toEqual({ overlayId: "entry", price: 999.88 });
    expect(gholaChartPriceDragCommit(hype)).toBeNull();
    expect(gholaChartPriceDragCommit({ ...hype, pointerY: 506 })).toEqual({ overlayId: "entry", price: 9.988 });
  });
});

function draggable(id: string, price: number): GholaChartOverlay {
  return {
    id,
    kind: "price_line",
    label: id,
    tone: "accent",
    price,
    interaction: { kind: "drag_price", ariaLabel: `Move ${id}` },
  };
}
