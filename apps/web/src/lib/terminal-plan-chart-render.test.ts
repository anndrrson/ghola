import { describe, expect, it, vi } from "vitest";
import type { GholaChartCandle, GholaChartOverlay } from "./ghola-market-chart";
import {
  terminalPlanChartRenderInputsEqual,
  type TerminalPlanChartRenderInputs,
} from "./terminal-plan-chart-render";

describe("terminal plan chart render boundary", () => {
  it("bails out when only an unrelated market-frame wrapper changes", () => {
    const value = inputs();
    expect(terminalPlanChartRenderInputsEqual(value, { ...value })).toBe(true);
  });

  it.each([
    ["candles", (value: TerminalPlanChartRenderInputs) => ({ ...value, candles: [candle()] })],
    ["overlays", (value: TerminalPlanChartRenderInputs) => ({ ...value, overlays: [{ ...overlay() }] })],
    ["entry price", (value: TerminalPlanChartRenderInputs) => ({ ...value, entryPrice: 101 })],
    ["invalidation", (value: TerminalPlanChartRenderInputs) => ({ ...value, invalidationPrice: 94 })],
    ["interaction", (value: TerminalPlanChartRenderInputs) => ({ ...value, interactionAllowed: false })],
    ["handler", (value: TerminalPlanChartRenderInputs) => ({ ...value, onEntryDrag: vi.fn() })],
  ] satisfies Array<[string, (value: TerminalPlanChartRenderInputs) => TerminalPlanChartRenderInputs]>)
  ("renders when %s changes", (_label, change) => {
    const value = inputs();
    expect(terminalPlanChartRenderInputsEqual(value, change(value))).toBe(false);
  });
});

function inputs(): TerminalPlanChartRenderInputs {
  return {
    candles: [candle()],
    product: "BTC-PERP",
    interval: "5m",
    overlays: [overlay()],
    side: "buy",
    entryPrice: 100,
    invalidationPrice: 95,
    invalidationSuggested: false,
    interactionAllowed: true,
    onEntryDrag: vi.fn(),
    onInvalidationDrag: vi.fn(),
  };
}

function candle(): GholaChartCandle {
  return { t: 1, T: 2, o: "99", h: "101", l: "98", c: "100", v: "1", n: 1 };
}

function overlay(): GholaChartOverlay {
  return { id: "entry", kind: "price_line", label: "Entry", tone: "accent", price: 100 };
}
