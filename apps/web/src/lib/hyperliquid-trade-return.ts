export type GholaHyperliquidMarket = "BTC" | "ETH" | "SOL" | "HYPE";

export function hyperliquidMarketFromTradeReturn(
  returnTo: string | null | undefined,
): GholaHyperliquidMarket | null {
  if (!returnTo) return null;
  try {
    const target = new URL(returnTo, "https://ghola.local");
    if (target.origin !== "https://ghola.local" || target.pathname !== "/trade") return null;
    if (target.searchParams.get("venue") !== "hyperliquid") return null;
    const market = target.searchParams.get("market")?.trim().toUpperCase().replace(/-PERP$/, "");
    return market === "BTC" || market === "ETH" || market === "SOL" || market === "HYPE"
      ? market
      : null;
  } catch {
    return null;
  }
}

export function liveHyperliquidReferencePrice(snapshot: {
  mark_price?: string | null;
  mid?: string | null;
} | null | undefined): number | null {
  const reference = Number(snapshot?.mark_price || snapshot?.mid || "");
  return Number.isFinite(reference) && reference > 0 ? reference : null;
}
