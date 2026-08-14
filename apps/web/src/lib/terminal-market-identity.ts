import type { GholaMarketFrame } from "./ghola-market-chart";

export type TerminalMarketVenue = "hyperliquid" | "phoenix" | "coinbase";

export function terminalFrameMatchesSelection(
  frame: GholaMarketFrame | null,
  selection: { venue: TerminalMarketVenue; market: string; interval: string },
): frame is GholaMarketFrame {
  if (!frame || frame.venue !== selection.venue || frame.interval !== selection.interval) return false;
  return normalizeInstrument(frame.product) === normalizeInstrument(selection.market);
}

function normalizeInstrument(value: string) {
  return value.trim().toUpperCase().replace(/-(USD|PERP)$/u, "");
}
