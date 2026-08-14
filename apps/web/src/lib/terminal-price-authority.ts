import { frameMidNumber, type GholaMarketFrame } from "./ghola-market-chart";
import type { TerminalLiveMarketContext } from "./terminal-live-market-context";

export interface TerminalPriceAuthority {
  chartMid: number | null;
  certifiedMid: number | null;
  displayMid: number | null;
  automaticEntryPrice: number | null;
  source: "certified_bbo" | "chart_only" | "unavailable";
}

/**
 * Chart continuity may use retained/synthetic data. Every price exposed as
 * current or used for automatic ticket staging must come from certified BBO.
 */
export function deriveTerminalPriceAuthority(input: {
  chartFrame: GholaMarketFrame | null;
  liveMarketContext: TerminalLiveMarketContext;
}): TerminalPriceAuthority {
  const chartMid = positive(frameMidNumber(input.chartFrame));
  const certifiedMid = input.liveMarketContext.allowed
    ? positive(input.liveMarketContext.referencePrice)
    : null;
  return {
    chartMid,
    certifiedMid,
    displayMid: certifiedMid,
    automaticEntryPrice: certifiedMid,
    source: certifiedMid != null ? "certified_bbo" : chartMid != null ? "chart_only" : "unavailable",
  };
}

function positive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
