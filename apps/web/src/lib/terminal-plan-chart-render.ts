import type {
  GholaChartCandle,
  GholaChartOverlay,
} from "./ghola-market-chart";

export interface TerminalPlanChartRenderInputs {
  candles: readonly GholaChartCandle[] | null | undefined;
  product: string | null | undefined;
  interval: string | null | undefined;
  overlays: readonly GholaChartOverlay[];
  side: "buy" | "sell";
  entryPrice: number | null;
  invalidationPrice: number | null;
  invalidationSuggested: boolean;
  interactionAllowed: boolean;
  onEntryDrag: unknown;
  onInvalidationDrag: unknown;
}

/** Exact hot-render bailout; mutable market collections are never deep-compared. */
export function terminalPlanChartRenderInputsEqual(
  left: TerminalPlanChartRenderInputs,
  right: TerminalPlanChartRenderInputs,
) {
  return left.candles === right.candles
    && left.product === right.product
    && left.interval === right.interval
    && left.overlays === right.overlays
    && left.side === right.side
    && left.entryPrice === right.entryPrice
    && left.invalidationPrice === right.invalidationPrice
    && left.invalidationSuggested === right.invalidationSuggested
    && left.interactionAllowed === right.interactionAllowed
    && left.onEntryDrag === right.onEntryDrag
    && left.onInvalidationDrag === right.onInvalidationDrag;
}
