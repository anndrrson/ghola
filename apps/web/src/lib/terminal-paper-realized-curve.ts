import type { PaperFill, PaperPosition, PaperTradingAssumptions } from "./paper-trading-engine";

const EPSILON = 1e-8;

export interface TerminalPaperRealizedPoint {
  fillId: string;
  filledAt: string;
  netDeltaUsd: number;
  cumulativeNetUsd: number;
}

export interface TerminalPaperRealizedContribution {
  positionKey: string;
  venueId: string;
  network: string;
  product: string;
  grossRealizedUsd: number;
  feesUsd: number;
  netRealizedUsd: number;
  absoluteSharePct: number;
}

export interface TerminalPaperRealizedCurve {
  available: boolean;
  dataCorrupt: boolean;
  retainedFillCount: number;
  windowTruncated: boolean;
  openingNetUsd: number | null;
  currentNetUsd: number | null;
  currentRealizedEquityUsd: number | null;
  retainedChangeUsd: number | null;
  maxDrawdownUsd: number | null;
  maxDrawdownPct: number | null;
  currentDrawdownUsd: number | null;
  points: TerminalPaperRealizedPoint[];
  contributions: TerminalPaperRealizedContribution[];
}

/** Retained-fill realized path. Open P&L is deliberately excluded. */
export function deriveTerminalPaperRealizedCurve(input: {
  assumptions: Pick<PaperTradingAssumptions, "starting_equity_usd">;
  fills: PaperFill[];
  positions: PaperPosition[];
}): TerminalPaperRealizedCurve {
  const unavailable = (dataCorrupt: boolean): TerminalPaperRealizedCurve => ({
    available: false,
    dataCorrupt,
    retainedFillCount: input.fills.length,
    windowTruncated: false,
    openingNetUsd: null,
    currentNetUsd: null,
    currentRealizedEquityUsd: null,
    retainedChangeUsd: null,
    maxDrawdownUsd: null,
    maxDrawdownPct: null,
    currentDrawdownUsd: null,
    points: [],
    contributions: [],
  });
  const startingEquity = input.assumptions.starting_equity_usd;
  if (!positiveFinite(startingEquity)) return unavailable(true);

  let lifetimeGross = 0;
  let lifetimeFees = 0;
  const contributionRows: Omit<TerminalPaperRealizedContribution, "absoluteSharePct">[] = [];
  for (const position of input.positions) {
    if (!finite(position.realized_pnl_gross_usd) || !nonNegativeFinite(position.fees_paid_usd)) return unavailable(true);
    lifetimeGross += position.realized_pnl_gross_usd;
    lifetimeFees += position.fees_paid_usd;
    contributionRows.push({
      positionKey: position.position_key,
      venueId: position.venue_id,
      network: position.network,
      product: position.product,
      grossRealizedUsd: position.realized_pnl_gross_usd,
      feesUsd: position.fees_paid_usd,
      netRealizedUsd: position.realized_pnl_gross_usd - position.fees_paid_usd,
    });
  }
  if (!finite(lifetimeGross) || !finite(lifetimeFees)) return unavailable(true);

  const ordered = input.fills.map((fill) => ({ fill, sequence: fillSequence(fill.fill_id) }));
  if (ordered.some(({ sequence }) => sequence == null) || new Set(input.fills.map((fill) => fill.fill_id)).size !== input.fills.length) {
    return unavailable(true);
  }
  ordered.sort((left, right) => (left.sequence as number) - (right.sequence as number));
  let previousTime = Number.NEGATIVE_INFINITY;
  let retainedChange = 0;
  for (const { fill } of ordered) {
    const time = Date.parse(fill.filled_at);
    const expectedNotional = fill.fill_price * fill.base_size;
    const expectedFee = fill.notional_usd * fill.fee_bps / 10_000;
    if (
      !Number.isFinite(time)
      || time < previousTime
      || !positiveFinite(fill.base_size)
      || !positiveFinite(fill.fill_price)
      || !positiveFinite(fill.notional_usd)
      || !nonNegativeFinite(fill.fee_usd)
      || !finite(fill.realized_pnl_gross_usd)
      || !arithmeticMatches(fill.notional_usd, expectedNotional, 1e-8)
      || !arithmeticMatches(fill.fee_usd, expectedFee, 1e-10)
    ) return unavailable(true);
    previousTime = time;
    retainedChange += fill.realized_pnl_gross_usd - fill.fee_usd;
  }

  const currentNet = lifetimeGross - lifetimeFees;
  const openingNet = currentNet - retainedChange;
  if (![currentNet, openingNet, retainedChange].every(finite)) return unavailable(true);
  let cumulative = openingNet;
  let peakEquity = startingEquity + openingNet;
  let maxDrawdown = 0;
  const points: TerminalPaperRealizedPoint[] = [];
  for (const { fill } of ordered) {
    const netDeltaUsd = fill.realized_pnl_gross_usd - fill.fee_usd;
    cumulative += netDeltaUsd;
    const equity = startingEquity + cumulative;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
    points.push({ fillId: fill.fill_id, filledAt: fill.filled_at, netDeltaUsd, cumulativeNetUsd: cumulative });
  }
  const currentEquity = startingEquity + currentNet;
  const currentDrawdown = Math.max(0, peakEquity - currentEquity);
  const materialContributions = contributionRows.filter((row) => (
    Math.abs(row.grossRealizedUsd) > EPSILON || row.feesUsd > EPSILON
  ));
  const absoluteTotal = materialContributions.reduce((total, row) => total + Math.abs(row.netRealizedUsd), 0);
  const contributions = materialContributions
    .map((row): TerminalPaperRealizedContribution => ({
      ...row,
      absoluteSharePct: absoluteTotal > EPSILON ? Math.abs(row.netRealizedUsd) / absoluteTotal * 100 : 0,
    }))
    .sort((left, right) => Math.abs(right.netRealizedUsd) - Math.abs(left.netRealizedUsd)
      || left.positionKey.localeCompare(right.positionKey));
  return {
    available: true,
    dataCorrupt: false,
    retainedFillCount: input.fills.length,
    windowTruncated: Math.abs(openingNet) > EPSILON,
    openingNetUsd: openingNet,
    currentNetUsd: currentNet,
    currentRealizedEquityUsd: currentEquity,
    retainedChangeUsd: retainedChange,
    maxDrawdownUsd: maxDrawdown,
    maxDrawdownPct: peakEquity > 0 ? maxDrawdown / peakEquity * 100 : null,
    currentDrawdownUsd: currentDrawdown,
    points,
    contributions,
  };
}

function fillSequence(id: string) {
  const match = /^paper-fill-(\d{8})$/.exec(id);
  return match ? Number(match[1]) : null;
}

function finite(value: number) {
  return Number.isFinite(value);
}

function positiveFinite(value: number) {
  return finite(value) && value > 0;
}

function nonNegativeFinite(value: number) {
  return finite(value) && value >= 0;
}

function arithmeticMatches(actual: number, expected: number, absoluteTolerance: number) {
  return finite(actual) && finite(expected)
    && Math.abs(actual - expected) <= Math.max(absoluteTolerance, Math.abs(expected) * 1e-8);
}
