import type {
  PaperFill,
  PaperOrder,
  PaperOrderCancelReason,
  PaperTradingState,
} from "./paper-trading-engine";

const SIZE_EPSILON = 1e-12;

export type PaperCancellationBucket =
  | "user"
  | "liquidity"
  | "risk"
  | "oco"
  | "position"
  | "unclassified";

export interface PaperCancellationDriver {
  bucket: PaperCancellationBucket;
  label: string;
  count: number;
  sharePct: number;
}

export interface TerminalPaperExecutionAnalytics {
  entryOrderCount: number;
  terminalEntryCount: number;
  pendingEntryCount: number;
  replacedEntryCount: number;
  cancelledEntryCount: number;
  partiallyFilledEntryCount: number;
  entryNotionalCompletionPct: number | null;
  entryTouchedPct: number | null;
  entryFullyFilledPct: number | null;
  fillCount: number;
  fillNotionalUsd: number | null;
  feesUsd: number | null;
  effectiveFeeBps: number | null;
  executionAdjustmentUsd: number | null;
  executionAdjustmentBps: number | null;
  arrivalEligibleFillCount: number;
  arrivalSampleCount: number;
  arrivalDataComplete: boolean;
  arrivalDataCorrupt: boolean;
  waitDriftUsd: number | null;
  waitDriftBps: number | null;
  arrivalExecutionAdjustmentUsd: number | null;
  arrivalExecutionAdjustmentBps: number | null;
  arrivalSlippageUsd: number | null;
  arrivalSlippageBps: number | null;
  feeInclusiveShortfallUsd: number | null;
  feeInclusiveShortfallBps: number | null;
  medianSubmitToFillMs: number | null;
  p95SubmitToFillMs: number | null;
  cancellationDrivers: PaperCancellationDriver[];
  cancellationSampleCount: number;
  qualityDataComplete: boolean;
}

/**
 * Derives only metrics supported by persisted local PAPER records.
 * Positive values are adverse. Existing execution adjustment uses each fill's
 * execution-time reference; arrival metrics require an explicit order benchmark.
 */
export function deriveTerminalPaperExecutionAnalytics(
  state: Pick<PaperTradingState, "orders" | "fills">,
): TerminalPaperExecutionAnalytics {
  const entryOrders = state.orders.filter((order) => order.order_kind === "entry" && !order.reduce_only);
  const terminalEntries = entryOrders.filter((order) => order.status === "filled" || order.status === "cancelled");
  const terminalEntriesValid = terminalEntries.every(validOrderSizing);
  const requestedNotionalUsd = terminalEntriesValid ? sum(terminalEntries.map((order) => order.quote_notional_usd)) : 0;
  const completedNotionalUsd = terminalEntriesValid ? sum(terminalEntries.map((order) => (
    order.quote_notional_usd * Math.min(1, order.filled_base_size / order.base_size)
  ))) : 0;
  const canMeasureEntryOutcomes = terminalEntriesValid && requestedNotionalUsd > 0;
  const ordersById = new Map(state.orders.map((order) => [order.order_id, order]));
  const fillSamples = state.fills.map((fill) => executionSample(fill, ordersById.get(fill.order_id)));
  const qualityDataComplete = fillSamples.every((sample) => sample != null);
  const validSamples = qualityDataComplete ? fillSamples.filter((sample): sample is ExecutionSample => sample != null) : [];
  const fillNotionalUsd = qualityDataComplete && validSamples.length
    ? sum(validSamples.map((sample) => sample.notionalUsd))
    : null;
  const referenceNotionalUsd = qualityDataComplete && validSamples.length
    ? sum(validSamples.map((sample) => sample.referenceNotionalUsd))
    : null;
  const feesUsd = qualityDataComplete && validSamples.length
    ? sum(validSamples.map((sample) => sample.feeUsd))
    : null;
  const executionAdjustmentUsd = qualityDataComplete && validSamples.length
    ? sum(validSamples.map((sample) => sample.executionAdjustmentUsd))
    : null;
  const arrivalCandidates = state.fills.flatMap((fill) => {
    const order = ordersById.get(fill.order_id);
    return order?.order_kind === "entry" && !order.reduce_only ? [{ fill, order }] : [];
  });
  const arrivalResults = arrivalCandidates.map(({ fill, order }) => arrivalExecutionSample(fill, order));
  const arrivalDataCorrupt = arrivalResults.some((result) => result.status === "invalid");
  const validArrivalSamples = arrivalResults.flatMap((result) => result.status === "valid" ? [result.sample] : []);
  const arrivalDataComplete = !arrivalDataCorrupt && arrivalResults.every((result) => result.status === "valid");
  const arrivalSampleCount = validArrivalSamples.length;
  const arrivalSamples = arrivalDataCorrupt ? [] : validArrivalSamples;
  const arrivalReferenceNotionalUsd = arrivalSamples.length
    ? sum(arrivalSamples.map((sample) => sample.arrivalReferenceNotionalUsd))
    : null;
  const waitDriftUsd = arrivalSamples.length ? sum(arrivalSamples.map((sample) => sample.waitDriftUsd)) : null;
  const arrivalExecutionAdjustmentUsd = arrivalSamples.length
    ? sum(arrivalSamples.map((sample) => sample.executionAdjustmentUsd))
    : null;
  const arrivalSlippageUsd = arrivalSamples.length
    ? sum(arrivalSamples.map((sample) => sample.arrivalSlippageUsd))
    : null;
  const feeInclusiveShortfallUsd = arrivalSamples.length
    ? sum(arrivalSamples.map((sample) => sample.feeInclusiveShortfallUsd))
    : null;
  const elapsedSamples = validSamples.map((sample) => sample.submitToFillMs).sort((left, right) => left - right);
  const cancellationDrivers = cancellationMix(state.orders);

  return {
    entryOrderCount: entryOrders.length,
    terminalEntryCount: terminalEntries.length,
    pendingEntryCount: entryOrders.filter((order) => order.status === "pending").length,
    replacedEntryCount: entryOrders.filter((order) => order.status === "replaced").length,
    cancelledEntryCount: terminalEntries.filter((order) => order.status === "cancelled").length,
    partiallyFilledEntryCount: entryOrders.filter((order) => (
      order.filled_base_size > SIZE_EPSILON && order.filled_base_size < order.base_size - SIZE_EPSILON
    )).length,
    entryNotionalCompletionPct: canMeasureEntryOutcomes ? completedNotionalUsd / requestedNotionalUsd * 100 : null,
    entryTouchedPct: canMeasureEntryOutcomes
      ? terminalEntries.filter((order) => order.filled_base_size > SIZE_EPSILON).length / terminalEntries.length * 100
      : null,
    entryFullyFilledPct: canMeasureEntryOutcomes
      ? terminalEntries.filter((order) => order.status === "filled").length / terminalEntries.length * 100
      : null,
    fillCount: state.fills.length,
    fillNotionalUsd,
    feesUsd,
    effectiveFeeBps: fillNotionalUsd != null && fillNotionalUsd > 0 && feesUsd != null
      ? feesUsd / fillNotionalUsd * 10_000
      : null,
    executionAdjustmentUsd,
    executionAdjustmentBps: referenceNotionalUsd != null && referenceNotionalUsd > 0 && executionAdjustmentUsd != null
      ? executionAdjustmentUsd / referenceNotionalUsd * 10_000
      : null,
    arrivalEligibleFillCount: arrivalCandidates.length,
    arrivalSampleCount,
    arrivalDataComplete,
    arrivalDataCorrupt,
    waitDriftUsd,
    waitDriftBps: basisPoints(waitDriftUsd, arrivalReferenceNotionalUsd),
    arrivalExecutionAdjustmentUsd,
    arrivalExecutionAdjustmentBps: basisPoints(arrivalExecutionAdjustmentUsd, arrivalReferenceNotionalUsd),
    arrivalSlippageUsd,
    arrivalSlippageBps: basisPoints(arrivalSlippageUsd, arrivalReferenceNotionalUsd),
    feeInclusiveShortfallUsd,
    feeInclusiveShortfallBps: basisPoints(feeInclusiveShortfallUsd, arrivalReferenceNotionalUsd),
    medianSubmitToFillMs: elapsedSamples.length ? percentile(elapsedSamples, 0.5) : null,
    p95SubmitToFillMs: elapsedSamples.length ? percentile(elapsedSamples, 0.95) : null,
    cancellationDrivers,
    cancellationSampleCount: sum(cancellationDrivers.map((driver) => driver.count)),
    qualityDataComplete,
  };
}

interface ExecutionSample {
  notionalUsd: number;
  referenceNotionalUsd: number;
  feeUsd: number;
  executionAdjustmentUsd: number;
  submitToFillMs: number;
}

interface ArrivalExecutionSample {
  arrivalReferenceNotionalUsd: number;
  waitDriftUsd: number;
  executionAdjustmentUsd: number;
  arrivalSlippageUsd: number;
  feeInclusiveShortfallUsd: number;
}

type ArrivalExecutionResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; sample: ArrivalExecutionSample };

function executionSample(fill: PaperFill, order: PaperOrder | undefined): ExecutionSample | null {
  if (
    !order
    || fill.side !== order.side
    || !positiveFinite(fill.base_size)
    || !positiveFinite(fill.reference_price)
    || !positiveFinite(fill.fill_price)
    || !positiveFinite(fill.notional_usd)
    || !nonNegativeFinite(fill.fee_usd)
  ) return null;
  const expectedNotional = fill.fill_price * fill.base_size;
  const expectedFee = fill.notional_usd * fill.fee_bps / 10_000;
  if (
    !paperArithmeticMatches(fill.notional_usd, expectedNotional, 1e-8)
    || !paperArithmeticMatches(fill.fee_usd, expectedFee, 1e-10)
  ) return null;
  const submittedAt = Date.parse(order.submitted_at);
  const filledAt = Date.parse(fill.filled_at);
  if (!Number.isFinite(submittedAt) || !Number.isFinite(filledAt) || filledAt < submittedAt) return null;
  const adversePriceDelta = fill.side === "buy"
    ? fill.fill_price - fill.reference_price
    : fill.reference_price - fill.fill_price;
  const executionAdjustmentUsd = adversePriceDelta * fill.base_size;
  if (!Number.isFinite(executionAdjustmentUsd)) return null;
  return {
    notionalUsd: fill.notional_usd,
    referenceNotionalUsd: fill.reference_price * fill.base_size,
    feeUsd: fill.fee_usd,
    executionAdjustmentUsd,
    submitToFillMs: filledAt - submittedAt,
  };
}

function paperArithmeticMatches(actual: number, expected: number, absoluteTolerance: number) {
  return Number.isFinite(actual) && Number.isFinite(expected) &&
    Math.abs(actual - expected) <= Math.max(absoluteTolerance, Math.abs(expected) * 1e-8);
}

function arrivalExecutionSample(fill: PaperFill, order: PaperOrder): ArrivalExecutionResult {
  const execution = executionSample(fill, order);
  const arrivalReference = order.arrival_reference_price;
  if (!execution) return { status: "invalid" };
  if (arrivalReference == null) return { status: "missing" };
  if (!positiveFinite(arrivalReference)) return { status: "invalid" };
  const direction = fill.side === "buy" ? 1 : -1;
  const arrivalReferenceNotionalUsd = arrivalReference * fill.base_size;
  const waitDriftUsd = direction * (fill.reference_price - arrivalReference) * fill.base_size;
  const arrivalSlippageUsd = direction * (fill.fill_price - arrivalReference) * fill.base_size;
  const feeInclusiveShortfallUsd = arrivalSlippageUsd + fill.fee_usd;
  const decompositionError = Math.abs(arrivalSlippageUsd - (waitDriftUsd + execution.executionAdjustmentUsd));
  const decompositionTolerance = Math.max(1e-10, arrivalReferenceNotionalUsd * 1e-10);
  if (
    !positiveFinite(arrivalReferenceNotionalUsd)
    || !Number.isFinite(waitDriftUsd)
    || !Number.isFinite(arrivalSlippageUsd)
    || !Number.isFinite(feeInclusiveShortfallUsd)
    || decompositionError > decompositionTolerance
  ) return { status: "invalid" };
  return {
    status: "valid",
    sample: {
      arrivalReferenceNotionalUsd,
      waitDriftUsd,
      executionAdjustmentUsd: execution.executionAdjustmentUsd,
      arrivalSlippageUsd,
      feeInclusiveShortfallUsd,
    },
  };
}

function cancellationMix(orders: PaperOrder[]) {
  const cancelled = orders.filter((order) => order.status === "cancelled");
  if (!cancelled.length) return [];
  const counts = new Map<PaperCancellationBucket, number>();
  for (const order of cancelled) {
    const bucket = cancellationBucket(order.cancel_reason);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const order: PaperCancellationBucket[] = ["user", "liquidity", "risk", "oco", "position", "unclassified"];
  return order.flatMap((bucket): PaperCancellationDriver[] => {
    const count = counts.get(bucket) ?? 0;
    return count ? [{ bucket, label: cancellationLabel(bucket), count, sharePct: count / cancelled.length * 100 }] : [];
  });
}

function cancellationBucket(reason: PaperOrderCancelReason): PaperCancellationBucket {
  if (reason === "user_cancelled" || reason === "cancel_all") return "user";
  if (reason === "ioc_not_marketable" || reason === "ioc_remainder_cancelled" || reason === "fok_not_fillable") return "liquidity";
  if (reason === "risk_control") return "risk";
  if (reason === "oco_sibling") return "oco";
  if (reason === "position_unavailable") return "position";
  return "unclassified";
}

function cancellationLabel(bucket: PaperCancellationBucket) {
  if (bucket === "user") return "User / cancel-all";
  if (bucket === "liquidity") return "IOC / FOK liquidity";
  if (bucket === "risk") return "Risk control";
  if (bucket === "oco") return "OCO sibling";
  if (bucket === "position") return "Position unavailable";
  return "Unclassified";
}

function validOrderSizing(order: PaperOrder) {
  return positiveFinite(order.base_size)
    && positiveFinite(order.quote_notional_usd)
    && nonNegativeFinite(order.filled_base_size)
    && order.filled_base_size <= order.base_size + SIZE_EPSILON;
}

function percentile(sorted: number[], probability: number) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function positiveFinite(value: number) {
  return Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function basisPoints(value: number | null, notional: number | null) {
  return value != null && notional != null && notional > 0 ? value / notional * 10_000 : null;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
