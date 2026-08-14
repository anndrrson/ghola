import { PAPER_TRADING_HISTORY_CAP, type PaperFill, type PaperTradingState } from "./paper-trading-engine";

export interface TerminalClosedTrade {
  product: string;
  venueId: string;
  network: string;
  side: "long" | "short";
  openedAt: string;
  closedAt: string;
  quantityBase: number;
  entryPrice: number;
  exitPrice: number;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  returnPct: number;
  durationMs: number;
}

export interface TerminalPerformanceMetrics {
  sampleStatus: "validated" | "retained_window" | "invalid";
  sourceFillCount: number;
  closedTrades: TerminalClosedTrade[];
  totalNetPnlUsd: number;
  winRatePct: number | null;
  profitFactor: number | null;
  expectancyUsd: number | null;
  averageWinUsd: number | null;
  averageLossUsd: number | null;
  payoffRatio: number | null;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  averageDurationMs: number | null;
  longestLosingStreak: number;
}

export function deriveTerminalPerformance(
  fills: PaperFill[],
  options: { startingEquityUsd?: number; historyAtCapacity?: boolean } = {},
): TerminalPerformanceMetrics {
  const startingEquity = options.startingEquityUsd === undefined ? 10_000 : positive(options.startingEquityUsd);
  if (
    startingEquity == null
    || new Set(fills.map((fill) => fill.fill_id)).size !== fills.length
    || fills.some((fill) => !validFill(fill))
  ) return emptyPerformance("invalid", fills.length);
  const sorted = fills.slice().sort((a, b) => (
    Date.parse(a.filled_at) - Date.parse(b.filled_at) || a.fill_id.localeCompare(b.fill_id)
  ));
  const books = new Map<string, {
    quantity: number;
    averageEntryPrice: number | null;
    entryFeesRemainingUsd: number;
    openedAt: string | null;
  }>();
  const closedTrades: TerminalClosedTrade[] = [];

  for (const fill of sorted) {
    const key = `${fill.venue_id}:${fill.network}:${fill.product}`;
    const book = books.get(key) ?? {
      quantity: 0,
      averageEntryPrice: null,
      entryFeesRemainingUsd: 0,
      openedAt: null,
    };
    const fillQuantity = fill.side === "buy" ? fill.base_size : -fill.base_size;
    const oldQuantity = book.quantity;
    const opposite = oldQuantity !== 0 && Math.sign(oldQuantity) !== Math.sign(fillQuantity);
    const closedSize = opposite ? Math.min(Math.abs(oldQuantity), fill.base_size) : 0;
    const averageEntryPrice = book.averageEntryPrice ?? fill.fill_price;
    const reconstructedRealizedGross = closedSize > 0
      ? closedSize * (fill.fill_price - averageEntryPrice) * Math.sign(oldQuantity)
      : 0;
    if (!arithmeticMatches(reconstructedRealizedGross, fill.realized_pnl_gross_usd, 1e-8)) {
      return emptyPerformance("invalid", fills.length);
    }

    const feePerBase = fill.fee_usd / fill.base_size;
    const entryFeeAllocated = closedSize > 0 && Math.abs(oldQuantity) > 0
      ? book.entryFeesRemainingUsd * closedSize / Math.abs(oldQuantity)
      : 0;
    if (closedSize > 0) {
      const fees = entryFeeAllocated + feePerBase * closedSize;
      const entryNotional = averageEntryPrice * closedSize;
      const openedAt = book.openedAt ?? fill.filled_at;
      const openedAtMs = Date.parse(openedAt);
      const closedAtMs = Date.parse(fill.filled_at);
      closedTrades.push({
        product: fill.product,
        venueId: fill.venue_id,
        network: fill.network,
        side: oldQuantity > 0 ? "long" : "short",
        openedAt,
        closedAt: fill.filled_at,
        quantityBase: closedSize,
        entryPrice: averageEntryPrice,
        exitPrice: fill.fill_price,
        grossPnlUsd: reconstructedRealizedGross,
        feesUsd: fees,
        netPnlUsd: reconstructedRealizedGross - fees,
        returnPct: entryNotional > 0 ? ((reconstructedRealizedGross - fees) / entryNotional) * 100 : 0,
        durationMs: Math.max(0, closedAtMs - openedAtMs),
      });
    }

    const nextQuantity = oldQuantity + fillQuantity;
    const remainingFillSize = fill.base_size - closedSize;
    if (Math.abs(nextQuantity) <= Number.EPSILON) {
      books.set(key, { quantity: 0, averageEntryPrice: null, entryFeesRemainingUsd: 0, openedAt: null });
    } else if (oldQuantity === 0 || Math.sign(oldQuantity) === Math.sign(fillQuantity)) {
      const oldNotional = Math.abs(oldQuantity) * (book.averageEntryPrice ?? fill.fill_price);
      books.set(key, {
        quantity: nextQuantity,
        averageEntryPrice: (oldNotional + fill.base_size * fill.fill_price) / Math.abs(nextQuantity),
        entryFeesRemainingUsd: book.entryFeesRemainingUsd + fill.fee_usd,
        openedAt: book.openedAt ?? fill.filled_at,
      });
    } else if (Math.sign(nextQuantity) === Math.sign(oldQuantity)) {
      books.set(key, {
        quantity: nextQuantity,
        averageEntryPrice: book.averageEntryPrice,
        entryFeesRemainingUsd: Math.max(0, book.entryFeesRemainingUsd - entryFeeAllocated),
        openedAt: book.openedAt,
      });
    } else {
      books.set(key, {
        quantity: nextQuantity,
        averageEntryPrice: fill.fill_price,
        entryFeesRemainingUsd: feePerBase * remainingFillSize,
        openedAt: fill.filled_at,
      });
    }
  }

  const pnl = closedTrades.map((trade) => trade.netPnlUsd);
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  const grossProfit = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  let equity = startingEquity;
  let peak = startingEquity;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  let currentLosingStreak = 0;
  let longestLosingStreak = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    const drawdown = peak - equity;
    maxDrawdownUsd = Math.max(maxDrawdownUsd, drawdown);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? drawdown / peak * 100 : 0);
    currentLosingStreak = value < 0 ? currentLosingStreak + 1 : 0;
    longestLosingStreak = Math.max(longestLosingStreak, currentLosingStreak);
  }

  return {
    sampleStatus: options.historyAtCapacity ? "retained_window" : "validated",
    sourceFillCount: fills.length,
    closedTrades,
    totalNetPnlUsd: sum(pnl),
    winRatePct: pnl.length ? wins.length / pnl.length * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : null,
    expectancyUsd: average(pnl),
    averageWinUsd: average(wins),
    averageLossUsd: average(losses),
    payoffRatio: wins.length && losses.length ? average(wins)! / Math.abs(average(losses)!) : null,
    maxDrawdownUsd,
    maxDrawdownPct,
    averageDurationMs: average(closedTrades.map((trade) => trade.durationMs)),
    longestLosingStreak,
  };
}

export function derivePaperStatePerformance(state: PaperTradingState): TerminalPerformanceMetrics {
  return deriveTerminalPerformance(state.fills, {
    startingEquityUsd: state.assumptions.starting_equity_usd,
    historyAtCapacity: state.fills.length >= PAPER_TRADING_HISTORY_CAP,
  });
}

function validFill(fill: PaperFill) {
  if (!Boolean(fill) || typeof fill.fill_id !== "string" || !fill.fill_id) return false;
  if (
    (fill.side !== "buy" && fill.side !== "sell")
    || positive(fill.base_size) == null
    || positive(fill.fill_price) == null
    || positive(fill.notional_usd) == null
    || !Number.isFinite(fill.fee_usd)
    || fill.fee_usd < 0
    || !Number.isFinite(fill.fee_bps)
    || fill.fee_bps < 0
    || !Number.isFinite(fill.realized_pnl_gross_usd)
    || !Number.isFinite(Date.parse(fill.filled_at))
  ) return false;
  return arithmeticMatches(fill.notional_usd, fill.fill_price * fill.base_size, 1e-8)
    && arithmeticMatches(fill.fee_usd, fill.notional_usd * fill.fee_bps / 10_000, 1e-10);
}

function emptyPerformance(
  sampleStatus: "invalid",
  sourceFillCount: number,
): TerminalPerformanceMetrics {
  return {
    sampleStatus,
    sourceFillCount,
    closedTrades: [],
    totalNetPnlUsd: 0,
    winRatePct: null,
    profitFactor: null,
    expectancyUsd: null,
    averageWinUsd: null,
    averageLossUsd: null,
    payoffRatio: null,
    maxDrawdownUsd: 0,
    maxDrawdownPct: 0,
    averageDurationMs: null,
    longestLosingStreak: 0,
  };
}

function arithmeticMatches(actual: number, expected: number, absoluteTolerance: number) {
  return Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= Math.max(absoluteTolerance, Math.abs(expected) * 1e-8);
}

function average(values: number[]): number | null {
  return values.length ? sum(values) / values.length : null;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
