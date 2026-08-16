import {
  paperAccountSummary,
  paperPositionKey,
  paperRiskMetrics,
  restorePaperTradingMark,
  type MarkedPaperPosition,
  type PaperMarkFreshnessOptions,
  type PaperTradingState,
} from "./paper-trading-engine";
import type { GholaMarketFrame } from "./ghola-market-chart";
import { normalizeMarketTimestamp } from "./market-component-clock";
import { terminalFrameMatchesSelection } from "./terminal-market-identity";

export const PAPER_RISK_SHOCKS_PCT = [-5, -2, -1, 1, 2, 5] as const;

export type TerminalPaperVenueId = "hyperliquid" | "phoenix" | "coinbase";
export type TerminalPaperNetwork = "mainnet" | "testnet";

export interface TerminalPaperMarketTarget {
  readonly venueId: TerminalPaperVenueId;
  readonly network: TerminalPaperNetwork;
  readonly market: "BTC" | "ETH" | "SOL" | "HYPE";
  readonly product: `${string}-PERP` | `${string}-USD`;
}

export interface TerminalPaperMarkRefreshRequest {
  positionKey: string;
  target: TerminalPaperMarketTarget;
  previousMarkFetchedAt: string | null;
}

const TERMINAL_PAPER_MARK_TARGETS: readonly TerminalPaperMarketTarget[] = [
  ...(["mainnet", "testnet"] as const).flatMap((network) => (["BTC", "ETH", "SOL", "HYPE"] as const).map((market) => ({
    venueId: "hyperliquid" as const,
    network,
    market,
    product: `${market}-PERP` as const,
  }))),
  { venueId: "phoenix", network: "mainnet", market: "SOL", product: "SOL-PERP" },
  { venueId: "coinbase", network: "mainnet", market: "BTC", product: "BTC-USD" },
  { venueId: "coinbase", network: "mainnet", market: "ETH", product: "ETH-USD" },
  { venueId: "coinbase", network: "mainnet", market: "SOL", product: "SOL-USD" },
];

const TERMINAL_PAPER_TARGET_BY_KEY = new Map(
  TERMINAL_PAPER_MARK_TARGETS.map((target) => [
    paperPositionKey({ venue_id: target.venueId, network: target.network, product: target.product }),
    target,
  ]),
);

export interface TerminalPaperRiskPosition {
  positionKey: string;
  venueId: string;
  network: string;
  product: string;
  side: "long" | "short";
  quantityBase: number;
  averageEntryPrice: number | null;
  markPrice: number | null;
  markAgeMs: number | null;
  markStatus: MarkedPaperPosition["mark_status"];
  grossNotionalUsd: number | null;
  signedNotionalUsd: number | null;
  riskContributionPct: number | null;
  pnlUsd: number | null;
  markRefreshTarget: TerminalPaperMarketTarget | null;
}

/** Exact, allowlisted terminal destination for a persisted PAPER identity. */
export function resolveTerminalPaperMarketTarget(identity: {
  positionKey: string;
  venueId: string;
  network: string;
  product: string;
}): TerminalPaperMarketTarget | null {
  const exactKey = paperPositionKey({
    venue_id: identity.venueId,
    network: identity.network,
    product: identity.product,
  });
  if (identity.positionKey !== exactKey) return null;
  const target = TERMINAL_PAPER_TARGET_BY_KEY.get(exactKey);
  return target ? { ...target } : null;
}

export function createTerminalPaperMarkRefreshRequest(
  state: PaperTradingState,
  positionKey: string,
): TerminalPaperMarkRefreshRequest | null {
  const position = state.positions.find((item) => item.position_key === positionKey);
  if (!position || Math.abs(position.quantity_base) <= 1e-12) return null;
  const target = resolveTerminalPaperMarketTarget({
    positionKey: position.position_key,
    venueId: position.venue_id,
    network: position.network,
    product: position.product,
  });
  if (!target) return null;
  const mark = state.marks.find((item) => item.position_key === positionKey);
  return {
    positionKey,
    target,
    previousMarkFetchedAt: mark?.fetched_at ?? null,
  };
}

export function restoreTerminalPaperPositionMark(
  state: PaperTradingState,
  request: TerminalPaperMarkRefreshRequest,
  input: {
    frame: GholaMarketFrame | null;
    selectedVenueId: string;
    selectedNetwork: string;
    selectedProduct: string;
    marketDataLive: boolean;
    observedAt: string;
    maxAgeMs: number;
  },
): { state: PaperTradingState; refreshed: boolean } {
  const current = createTerminalPaperMarkRefreshRequest(state, request.positionKey);
  if (
    !current ||
    current.previousMarkFetchedAt !== request.previousMarkFetchedAt ||
    !samePaperTarget(current.target, request.target)
  ) return { state, refreshed: false };
  const frame = input.frame;
  if (
    !frame ||
    !input.marketDataLive ||
    frame.stale ||
    input.selectedVenueId !== request.target.venueId ||
    input.selectedNetwork !== request.target.network ||
    input.selectedProduct !== request.target.product ||
    frame.network !== request.target.network ||
    !paperFrameMatchesTarget(frame, request.target)
  ) {
    return { state, refreshed: false };
  }
  const fetchedAtMs = Date.parse(frame.fetchedAt ?? "");
  const quoteFetchedAtMs = normalizeMarketTimestamp(frame.componentTimestamps?.quote);
  const bookFetchedAtMs = normalizeMarketTimestamp(frame.componentTimestamps?.book);
  const quoteFetchedAt = componentTimestampIso(quoteFetchedAtMs);
  const bookFetchedAt = componentTimestampIso(bookFetchedAtMs);
  const observedAtMs = Date.parse(input.observedAt);
  const bestBid = positiveFinite(frame.bestBid);
  const bestAsk = positiveFinite(frame.bestAsk);
  if (
    !Number.isFinite(fetchedAtMs) ||
    quoteFetchedAtMs == null ||
    quoteFetchedAt == null ||
    !Number.isFinite(observedAtMs) ||
    !Number.isFinite(input.maxAgeMs) ||
    input.maxAgeMs <= 0 ||
    input.maxAgeMs > 300_000 ||
    quoteFetchedAtMs > observedAtMs ||
    observedAtMs - quoteFetchedAtMs > input.maxAgeMs ||
    bestBid == null ||
    bestAsk == null ||
    bestBid >= bestAsk
  ) {
    return { state, refreshed: false };
  }
  if (quoteFetchedAt === request.previousMarkFetchedAt) {
    return { state, refreshed: false };
  }
  const next = restorePaperTradingMark(state, {
    venue_id: request.target.venueId,
    network: request.target.network,
    product: request.target.product,
    market_state: "live",
    fetched_at: frame.fetchedAt as string,
    quote_fetched_at: quoteFetchedAt,
    book_fetched_at: bookFetchedAt,
    observed_at: input.observedAt,
    max_age_ms: input.maxAgeMs,
    best_bid: bestBid,
    best_ask: bestAsk,
    mark_price: (bestBid + bestAsk) / 2,
    bids: [],
    asks: [],
    trades: [],
  });
  return {
    state: next,
    refreshed: next !== state && terminalPaperMarkRefreshComplete(next, request, input.observedAt, input.maxAgeMs),
  };
}

export function terminalPaperMarkRefreshComplete(
  state: PaperTradingState,
  request: TerminalPaperMarkRefreshRequest,
  now: string,
  maxAgeMs: number,
) {
  const current = createTerminalPaperMarkRefreshRequest(state, request.positionKey);
  if (!current || !samePaperTarget(current.target, request.target)) return false;
  const mark = state.marks.find((item) => item.position_key === request.positionKey);
  if (!mark || mark.fetched_at === request.previousMarkFetchedAt) return false;
  const marked = paperAccountSummary(state, {}, { now, maxAgeMs }).marked_positions
    .find((position) => position.position_key === request.positionKey);
  return marked?.mark_status === "fresh" && marked.mark_fetched_at === mark.fetched_at;
}

export interface TerminalPaperRiskScenario {
  shockPct: (typeof PAPER_RISK_SHOCKS_PCT)[number];
  pnlChangeUsd: number;
  stressedEquityUsd: number | null;
  partial: boolean;
}

export interface TerminalPaperRiskDesk {
  asOf: string;
  markMaxAgeMs: number;
  portfolioFullyPriced: boolean;
  openPositionCount: number;
  pricedPositionCount: number;
  unpricedPositionCount: number;
  markCoveragePct: number | null;
  oldestFreshMarkAgeMs: number | null;
  grossNotionalUsd: number;
  netNotionalUsd: number;
  longNotionalUsd: number;
  shortNotionalUsd: number;
  netBiasPct: number | null;
  largestConcentrationPct: number | null;
  sessionLossUsd: number;
  sessionLossLimitUsd: number;
  sessionLossUtilizationPct: number;
  drawdownUsd: number;
  drawdownLimitUsd: number;
  drawdownUtilizationPct: number;
  riskControlStatus: PaperTradingState["risk_control"]["status"];
  positions: TerminalPaperRiskPosition[];
  scenarios: TerminalPaperRiskScenario[];
}

/** Fresh-mark-only portfolio exposure and parallel linear price shocks. */
export function deriveTerminalPaperRiskDesk(
  state: PaperTradingState,
  markFreshness: PaperMarkFreshnessOptions = {},
): TerminalPaperRiskDesk {
  const summary = paperAccountSummary(state, {}, markFreshness);
  const metrics = paperRiskMetrics(state, markFreshness);
  const openPositions = summary.marked_positions.filter((position) => Math.abs(position.quantity_base) > 1e-12);
  const priced = openPositions.flatMap((position) => {
    if (position.mark_status !== "fresh" || position.market_value_usd == null || position.mark_price == null) return [];
    return [{
      position,
      grossNotionalUsd: position.market_value_usd,
      signedNotionalUsd: position.quantity_base * position.mark_price,
    }];
  });
  const grossNotionalUsd = sum(priced.map((item) => item.grossNotionalUsd));
  const netNotionalUsd = sum(priced.map((item) => item.signedNotionalUsd));
  const longNotionalUsd = sum(priced.filter((item) => item.signedNotionalUsd > 0).map((item) => item.grossNotionalUsd));
  const shortNotionalUsd = sum(priced.filter((item) => item.signedNotionalUsd < 0).map((item) => item.grossNotionalUsd));
  const pricedByKey = new Map(priced.map((item) => [item.position.position_key, item]));
  const positions = openPositions.map((position): TerminalPaperRiskPosition => {
    const pricedPosition = pricedByKey.get(position.position_key);
    return {
      positionKey: position.position_key,
      venueId: position.venue_id,
      network: position.network,
      product: position.product,
      side: position.quantity_base > 0 ? "long" : "short",
      quantityBase: Math.abs(position.quantity_base),
      averageEntryPrice: position.average_entry_price,
      markPrice: position.mark_price,
      markAgeMs: position.mark_age_ms,
      markStatus: position.mark_status,
      grossNotionalUsd: pricedPosition?.grossNotionalUsd ?? null,
      signedNotionalUsd: pricedPosition?.signedNotionalUsd ?? null,
      riskContributionPct: pricedPosition != null && grossNotionalUsd > 0
        ? pricedPosition.grossNotionalUsd / grossNotionalUsd * 100
        : null,
      pnlUsd: position.unrealized_pnl_usd == null
        ? null
        : position.realized_pnl_net_usd + position.unrealized_pnl_usd,
      markRefreshTarget: resolveTerminalPaperMarketTarget({
        positionKey: position.position_key,
        venueId: position.venue_id,
        network: position.network,
        product: position.product,
      }),
    };
  }).sort(compareRiskPositions);
  const freshAges = positions.flatMap((position) =>
    position.markStatus === "fresh" && position.markAgeMs != null ? [position.markAgeMs] : []);
  const partial = !summary.portfolio_fully_priced;
  const scenarios = PAPER_RISK_SHOCKS_PCT.map((shockPct): TerminalPaperRiskScenario => {
    const pnlChangeUsd = netNotionalUsd * shockPct / 100;
    return {
      shockPct,
      pnlChangeUsd,
      stressedEquityUsd: partial ? null : summary.equity_usd + pnlChangeUsd,
      partial,
    };
  });

  return {
    asOf: summary.marks_as_of,
    markMaxAgeMs: summary.mark_max_age_ms,
    portfolioFullyPriced: summary.portfolio_fully_priced,
    openPositionCount: summary.open_position_count,
    pricedPositionCount: priced.length,
    unpricedPositionCount: summary.unpriced_position_count,
    markCoveragePct: openPositions.length ? priced.length / openPositions.length * 100 : null,
    oldestFreshMarkAgeMs: freshAges.length ? Math.max(...freshAges) : null,
    grossNotionalUsd,
    netNotionalUsd,
    longNotionalUsd,
    shortNotionalUsd,
    netBiasPct: grossNotionalUsd > 0 ? netNotionalUsd / grossNotionalUsd * 100 : null,
    largestConcentrationPct: grossNotionalUsd > 0
      ? Math.max(...priced.map((position) => position.grossNotionalUsd)) / grossNotionalUsd * 100
      : null,
    sessionLossUsd: metrics.session_loss_usd,
    sessionLossLimitUsd: state.risk_policy.max_session_loss_usd,
    sessionLossUtilizationPct: utilization(metrics.session_loss_usd, state.risk_policy.max_session_loss_usd),
    drawdownUsd: metrics.drawdown_usd,
    drawdownLimitUsd: state.risk_policy.max_drawdown_usd,
    drawdownUtilizationPct: utilization(metrics.drawdown_usd, state.risk_policy.max_drawdown_usd),
    riskControlStatus: state.risk_control.status,
    positions,
    scenarios,
  };
}

function compareRiskPositions(left: TerminalPaperRiskPosition, right: TerminalPaperRiskPosition) {
  if (left.grossNotionalUsd == null && right.grossNotionalUsd != null) return 1;
  if (left.grossNotionalUsd != null && right.grossNotionalUsd == null) return -1;
  const notionalDifference = (right.grossNotionalUsd ?? 0) - (left.grossNotionalUsd ?? 0);
  return notionalDifference || left.positionKey.localeCompare(right.positionKey);
}

function utilization(value: number, limit: number) {
  return limit > 0 ? Math.max(0, value / limit * 100) : 100;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function positiveFinite(value: string | number | null | undefined) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function componentTimestampIso(value: number | null) {
  if (value == null) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function samePaperTarget(left: TerminalPaperMarketTarget, right: TerminalPaperMarketTarget) {
  return left.venueId === right.venueId &&
    left.network === right.network &&
    left.market === right.market &&
    left.product === right.product;
}

function paperFrameMatchesTarget(frame: GholaMarketFrame, target: TerminalPaperMarketTarget) {
  if (!terminalFrameMatchesSelection(frame, {
    venue: target.venueId,
    market: target.market,
    interval: frame.interval,
  })) return false;
  const frameProduct = frame.product.trim().toUpperCase();
  return target.venueId === "hyperliquid"
    ? frameProduct === target.market || frameProduct === target.product
    : frameProduct === target.product;
}
