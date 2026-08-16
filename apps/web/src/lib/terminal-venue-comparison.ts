import type { GholaMarketFrame } from "./ghola-market-chart";
import {
  terminalFrameMatchesSelection,
  type TerminalMarketVenue,
} from "./terminal-market-identity";
import type {
  TerminalRouteNetwork,
  TerminalRouteProductClass,
} from "./terminal-route-decision";

export type TerminalVenueId = "hyperliquid" | "phoenix" | "coinbase";

export interface TerminalVenueComparison {
  venue: TerminalMarketVenue;
  network: TerminalRouteNetwork;
  product: string;
  mid: number;
  bestBid: number | null;
  bestAsk: number | null;
  basisBps: number;
  fetchedAt: string;
}

export interface TerminalExecutableVenueQuote {
  venue: TerminalMarketVenue;
  network: TerminalRouteNetwork;
  product: string;
  price: number;
  fetchedAt: string;
}

export interface TerminalVenueBasisOptions {
  market: string;
  interval: string;
  requiredProductClass: TerminalRouteProductClass;
  requiredNetwork: TerminalRouteNetwork;
  nowMs: number;
  maxAgeMs: number;
}

export interface TerminalVenueBasis {
  status: "unavailable" | "single" | "live";
  quotes: TerminalVenueComparison[];
  bestBuy: TerminalVenueComparison | null;
  bestSell: TerminalVenueComparison | null;
  spanBps: number | null;
  bestExecutableBuy: TerminalExecutableVenueQuote | null;
  bestExecutableSell: TerminalExecutableVenueQuote | null;
  executableSpreadBps: number | null;
}

export function terminalComparisonVenues(
  currentVenue: TerminalVenueId,
  market: string,
): TerminalVenueId[] {
  const normalized = market.trim().toUpperCase();
  const venues: TerminalVenueId[] = normalized === "SOL"
    ? ["hyperliquid", "phoenix", "coinbase"]
    : normalized === "BTC" || normalized === "ETH"
      ? ["hyperliquid", "coinbase"]
      : normalized === "HYPE"
        ? ["hyperliquid"]
        : [];
  return venues.filter((venue) => venue !== currentVenue);
}

export function deriveTerminalVenueBasis(
  primary: GholaMarketFrame | null,
  comparisons: readonly GholaMarketFrame[],
  options: TerminalVenueBasisOptions,
): TerminalVenueBasis {
  const { nowMs, maxAgeMs } = options;
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return unavailableBasis();
  }
  const frames = primary ? [primary, ...comparisons] : comparisons;
  const valid = frames.flatMap((frame) => {
    const venue = supportedVenue(frame.venue);
    const network = normalizedNetwork(frame.network);
    const bestBid = positive(frame.bestBid);
    const bestAsk = positive(frame.bestAsk);
    const quoteObservedAtMs = frame.componentTimestamps?.quote;
    const quoteAgeMs = quoteObservedAtMs == null ? Number.NaN : nowMs - quoteObservedAtMs;
    if (
      !venue
      || frame.stale
      || !terminalFrameMatchesSelection(frame, { venue, market: options.market, interval: options.interval })
      || frameProductClass(frame) !== options.requiredProductClass
      || network !== options.requiredNetwork
      || bestBid == null
      || bestAsk == null
      || bestBid >= bestAsk
      || !Number.isFinite(quoteObservedAtMs)
      || quoteObservedAtMs == null
      || quoteObservedAtMs <= 0
      || quoteAgeMs < -5_000
      || quoteAgeMs > maxAgeMs
    ) return [];
    return [{
      frame,
      venue,
      network,
      mid: (bestBid + bestAsk) / 2,
      bestBid,
      bestAsk,
      fetchedAt: new Date(quoteObservedAtMs).toISOString(),
    }];
  });
  if (!valid.length) return unavailableBasis();

  const benchmark = valid[0].mid;
  const quotes = valid
    .map(({ frame, venue, network, mid, bestBid, bestAsk, fetchedAt }) => ({
      venue,
      network,
      product: frame.product,
      mid,
      bestBid,
      bestAsk,
      basisBps: ((mid - benchmark) / benchmark) * 10_000,
      fetchedAt,
    }))
    .sort((a, b) => a.mid - b.mid);
  const bestBuy = quotes.at(0) ?? null;
  const bestSell = quotes.at(-1) ?? null;
  const spanBps = bestBuy && bestSell ? ((bestSell.mid - bestBuy.mid) / bestBuy.mid) * 10_000 : null;
  const bestExecutableBuy = quotes
    .filter((quote) => quote.bestAsk != null)
    .sort((left, right) => (left.bestAsk ?? Number.POSITIVE_INFINITY) - (right.bestAsk ?? Number.POSITIVE_INFINITY))
    .map((quote) => ({ venue: quote.venue, network: quote.network, product: quote.product, price: quote.bestAsk as number, fetchedAt: quote.fetchedAt }))[0] ?? null;
  const bestExecutableSell = quotes
    .filter((quote) => quote.bestBid != null)
    .sort((left, right) => (right.bestBid ?? 0) - (left.bestBid ?? 0))
    .map((quote) => ({ venue: quote.venue, network: quote.network, product: quote.product, price: quote.bestBid as number, fetchedAt: quote.fetchedAt }))[0] ?? null;
  const executableSpreadBps = bestExecutableBuy && bestExecutableSell
    ? ((bestExecutableSell.price - bestExecutableBuy.price) / bestExecutableBuy.price) * 10_000
    : null;
  return {
    status: quotes.length > 1 ? "live" : "single",
    quotes,
    bestBuy,
    bestSell,
    spanBps,
    bestExecutableBuy,
    bestExecutableSell,
    executableSpreadBps,
  };
}

function unavailableBasis(): TerminalVenueBasis {
  return {
    status: "unavailable",
    quotes: [],
    bestBuy: null,
    bestSell: null,
    spanBps: null,
    bestExecutableBuy: null,
    bestExecutableSell: null,
    executableSpreadBps: null,
  };
}

function supportedVenue(value: GholaMarketFrame["venue"]): TerminalMarketVenue | null {
  return value === "hyperliquid" || value === "phoenix" || value === "coinbase" ? value : null;
}

function normalizedNetwork(value: GholaMarketFrame["network"]): TerminalRouteNetwork | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "mainnet" || normalized === "testnet" ? normalized : null;
}

function frameProductClass(frame: GholaMarketFrame): TerminalRouteProductClass | null {
  const normalized = frame.product.trim().toUpperCase();
  if (normalized.endsWith("-PERP")) return "perpetual";
  if (normalized.endsWith("-USD")) return "spot";
  if (frame.venue === "hyperliquid" && /^(BTC|ETH|SOL|HYPE)$/u.test(normalized)) return "perpetual";
  return null;
}

function positive(value: string | number | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
