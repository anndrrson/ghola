import { describe, expect, it } from "vitest";
import {
  advancePaperTrading,
  cancelPaperOrder,
  createPaperTradingState,
  placePaperOrder,
  replacePaperOrder,
  type PaperMarketObservation,
  type PaperOrderInput,
  type PaperTradingState,
} from "./paper-trading-engine";
import { deriveTerminalPaperExecutionAnalytics } from "./terminal-paper-execution-analytics";

const T0 = "2026-08-12T12:00:00.000Z";
const T1 = "2026-08-12T12:00:01.000Z";
const T2 = "2026-08-12T12:00:02.000Z";
const T3 = "2026-08-12T12:00:03.000Z";
const T4 = "2026-08-12T12:00:04.000Z";
const T5 = "2026-08-12T12:00:05.000Z";
const T6 = "2026-08-12T12:00:06.000Z";
const T7 = "2026-08-12T12:00:07.000Z";
const T8 = "2026-08-12T12:00:08.000Z";

describe("terminal PAPER execution analytics", () => {
  it("derives fill quality, completion, lifecycle, and cancellation mix from persisted samples", () => {
    const analytics = deriveTerminalPaperExecutionAnalytics(sampleState());

    expect(analytics).toMatchObject({
      entryOrderCount: 5,
      terminalEntryCount: 3,
      pendingEntryCount: 1,
      replacedEntryCount: 1,
      cancelledEntryCount: 2,
      partiallyFilledEntryCount: 1,
      fillCount: 2,
      cancellationSampleCount: 2,
      qualityDataComplete: true,
      arrivalEligibleFillCount: 2,
      arrivalSampleCount: 2,
      arrivalDataComplete: true,
      arrivalDataCorrupt: false,
    });
    expect(analytics.entryNotionalCompletionPct).toBeCloseTo(150 / 290 * 100);
    expect(analytics.entryTouchedPct).toBeCloseTo(200 / 3);
    expect(analytics.entryFullyFilledPct).toBeCloseTo(100 / 3);
    expect(analytics.fillNotionalUsd).toBeCloseTo(152.152);
    expect(analytics.feesUsd).toBeCloseTo(0.152152);
    expect(analytics.effectiveFeeBps).toBeCloseTo(10);
    expect(analytics.executionAdjustmentUsd).toBeCloseTo(0.152);
    expect(analytics.executionAdjustmentBps).toBeCloseTo(10);
    expect(analytics.waitDriftUsd).toBeCloseTo(2);
    expect(analytics.waitDriftBps).toBeCloseTo(2 / 150 * 10_000);
    expect(analytics.arrivalExecutionAdjustmentUsd).toBeCloseTo(0.152);
    expect(analytics.arrivalExecutionAdjustmentBps).toBeCloseTo(0.152 / 150 * 10_000);
    expect(analytics.arrivalSlippageUsd).toBeCloseTo(2.152);
    expect(analytics.arrivalSlippageBps).toBeCloseTo(2.152 / 150 * 10_000);
    expect(analytics.feeInclusiveShortfallUsd).toBeCloseTo(2.304152);
    expect(analytics.feeInclusiveShortfallBps).toBeCloseTo(2.304152 / 150 * 10_000);
    expect(analytics.medianSubmitToFillMs).toBe(1_000);
    expect(analytics.p95SubmitToFillMs).toBe(1_000);
    expect(analytics.cancellationDrivers).toEqual([
      { bucket: "user", label: "User / cancel-all", count: 1, sharePct: 50 },
      { bucket: "liquidity", label: "IOC / FOK liquidity", count: 1, sharePct: 50 },
    ]);
  });

  it("labels unsupported outcome and fill metrics unavailable without samples", () => {
    const analytics = deriveTerminalPaperExecutionAnalytics(createPaperTradingState({ now: T0 }));

    expect(analytics.entryNotionalCompletionPct).toBeNull();
    expect(analytics.entryTouchedPct).toBeNull();
    expect(analytics.entryFullyFilledPct).toBeNull();
    expect(analytics.fillNotionalUsd).toBeNull();
    expect(analytics.effectiveFeeBps).toBeNull();
    expect(analytics.executionAdjustmentBps).toBeNull();
    expect(analytics.arrivalSampleCount).toBe(0);
    expect(analytics.arrivalEligibleFillCount).toBe(0);
    expect(analytics.arrivalDataComplete).toBe(true);
    expect(analytics.arrivalDataCorrupt).toBe(false);
    expect(analytics.waitDriftBps).toBeNull();
    expect(analytics.arrivalSlippageBps).toBeNull();
    expect(analytics.feeInclusiveShortfallBps).toBeNull();
    expect(analytics.medianSubmitToFillMs).toBeNull();
    expect(analytics.cancellationDrivers).toEqual([]);
    expect(analytics.qualityDataComplete).toBe(true);
  });

  it("keeps reduce-only exits out of entry completion metrics", () => {
    const state = sampleState();
    const baseline = deriveTerminalPaperExecutionAnalytics(state);
    const terminalEntry = state.orders.find((order) => order.status === "filled");
    expect(terminalEntry).toBeDefined();
    const analytics = deriveTerminalPaperExecutionAnalytics({
      ...state,
      orders: terminalEntry ? [{
        ...terminalEntry,
        order_id: "paper_order_reduce_exit",
        reduce_only: true,
      }, ...state.orders] : state.orders,
    });

    expect(analytics.entryOrderCount).toBe(baseline.entryOrderCount);
    expect(analytics.terminalEntryCount).toBe(baseline.terminalEntryCount);
    expect(analytics.entryNotionalCompletionPct).toBe(baseline.entryNotionalCompletionPct);
  });

  it("does not let a corrupt reduce-only fill suppress valid entry arrival TCA", () => {
    const state = sampleState();
    const baseline = deriveTerminalPaperExecutionAnalytics(state);
    const sourceFill = state.fills[0]!;
    const sourceOrder = state.orders.find((order) => order.order_id === sourceFill.order_id)!;
    const reduceOnlyOrder = {
      ...sourceOrder,
      order_id: "paper_order_corrupt_reduce_only",
      reduce_only: true,
    };
    const corruptReduceOnlyFill = {
      ...sourceFill,
      fill_id: "paper_fill_corrupt_reduce_only",
      order_id: reduceOnlyOrder.order_id,
      notional_usd: sourceFill.notional_usd + 10,
    };
    const analytics = deriveTerminalPaperExecutionAnalytics({
      orders: [reduceOnlyOrder, ...state.orders],
      fills: [corruptReduceOnlyFill, ...state.fills],
    });

    expect(analytics.qualityDataComplete).toBe(false);
    expect(analytics.arrivalDataCorrupt).toBe(false);
    expect(analytics.arrivalDataComplete).toBe(true);
    expect(analytics.arrivalSampleCount).toBe(baseline.arrivalSampleCount);
    expect(analytics.waitDriftUsd).toBeCloseTo(baseline.waitDriftUsd!);
    expect(analytics.arrivalSlippageUsd).toBeCloseTo(baseline.arrivalSlippageUsd!);
    expect(analytics.feeInclusiveShortfallUsd).toBeCloseTo(baseline.feeInclusiveShortfallUsd!);
  });

  it("counts active partial entries instead of only cancelled remainders", () => {
    const state = sampleState();
    const pending = state.orders.find((order) => order.status === "pending" && !order.reduce_only);
    expect(pending).toBeDefined();
    const analytics = deriveTerminalPaperExecutionAnalytics({
      ...state,
      orders: pending ? [{
        ...pending,
        order_id: "paper_order_pending_partial",
        filled_base_size: pending.base_size / 2,
      }, ...state.orders] : state.orders,
    });

    expect(analytics.partiallyFilledEntryCount).toBe(2);
  });

  it("fails closed on an incomplete or internally inconsistent fill sample", () => {
    const state = sampleState();
    const corrupt: PaperTradingState = {
      ...state,
      fills: state.fills.map((fill, index) => index === 0 ? { ...fill, notional_usd: fill.notional_usd + 10 } : fill),
    };
    const analytics = deriveTerminalPaperExecutionAnalytics(corrupt);

    expect(analytics.qualityDataComplete).toBe(false);
    expect(analytics.fillCount).toBe(2);
    expect(analytics.fillNotionalUsd).toBeNull();
    expect(analytics.feesUsd).toBeNull();
    expect(analytics.executionAdjustmentUsd).toBeNull();
    expect(analytics.executionAdjustmentBps).toBeNull();
    expect(analytics.medianSubmitToFillMs).toBeNull();
    expect(analytics.arrivalDataComplete).toBe(false);
    expect(analytics.arrivalDataCorrupt).toBe(true);
    expect(analytics.arrivalSlippageUsd).toBeNull();
  });

  it("fails closed when persisted fee arithmetic is inconsistent", () => {
    const state = sampleState();
    const corrupt: PaperTradingState = {
      ...state,
      fills: state.fills.map((fill, index) => index === 0 ? { ...fill, fee_usd: fill.fee_usd + 1 } : fill),
    };
    const analytics = deriveTerminalPaperExecutionAnalytics(corrupt);

    expect(analytics.qualityDataComplete).toBe(false);
    expect(analytics.feesUsd).toBeNull();
    expect(analytics.effectiveFeeBps).toBeNull();
    expect(analytics.arrivalDataComplete).toBe(false);
    expect(analytics.arrivalDataCorrupt).toBe(true);
    expect(analytics.feeInclusiveShortfallUsd).toBeNull();
  });

  it("uses positive-as-adverse signs for both buys and sells", () => {
    let buy = createPaperTradingState({ now: T0, assumptions: { fee_bps: 0, slippage_bps: 0 } });
    buy = placePaperOrder(buy, {
      ...marketOrder(T1, 100),
      order_type: "limit",
      time_in_force: "GTC",
      limit_price: 200,
    });
    buy = advancePaperTrading(buy, observation(T2, 102, 1));

    let sell = createPaperTradingState({ now: T0, assumptions: { fee_bps: 0, slippage_bps: 0 } });
    sell = placePaperOrder(sell, {
      ...marketOrder(T1, 100),
      side: "sell",
      order_type: "limit",
      time_in_force: "GTC",
      limit_price: 1,
    });
    sell = advancePaperTrading(sell, observation(T2, 99, 1));

    for (const state of [buy, sell]) {
      const analytics = deriveTerminalPaperExecutionAnalytics(state);
      expect(analytics.waitDriftUsd).toBeCloseTo(2);
      expect(analytics.arrivalExecutionAdjustmentUsd).toBeCloseTo(0);
      expect(analytics.arrivalSlippageUsd).toBeCloseTo(2);
      expect(analytics.arrivalSlippageBps).toBeCloseTo(200);
    }
  });

  it("weights partial fills by arrival notional and preserves the decomposition", () => {
    let state = createPaperTradingState({ now: T0, assumptions: { fee_bps: 0, slippage_bps: 0 } });
    state = placePaperOrder(state, {
      ...marketOrder(T1, 100),
      order_type: "limit",
      time_in_force: "GTC",
      limit_price: 200,
      quote_notional_usd: 200,
      base_size: 2,
    });
    state = advancePaperTrading(state, observation(T2, 101, 0.5));
    state = advancePaperTrading(state, observation(T3, 103, 1.5));
    const analytics = deriveTerminalPaperExecutionAnalytics(state);

    expect(analytics.arrivalSampleCount).toBe(2);
    expect(analytics.waitDriftUsd).toBeCloseTo(5);
    expect(analytics.waitDriftBps).toBeCloseTo(250);
    expect(analytics.arrivalExecutionAdjustmentUsd).toBeCloseTo(0);
    expect(analytics.arrivalSlippageUsd).toBeCloseTo(5);
    expect(analytics.feeInclusiveShortfallUsd).toBeCloseTo(5);
  });

  it("reports favorable arrival performance as negative", () => {
    let state = createPaperTradingState({ now: T0, assumptions: { fee_bps: 0, slippage_bps: 0 } });
    state = placePaperOrder(state, {
      ...marketOrder(T1, 100),
      order_type: "limit",
      time_in_force: "GTC",
      limit_price: 200,
    });
    state = advancePaperTrading(state, observation(T2, 98, 1));
    const analytics = deriveTerminalPaperExecutionAnalytics(state);

    expect(analytics.waitDriftUsd).toBeCloseTo(-2);
    expect(analytics.arrivalSlippageUsd).toBeCloseTo(-2);
    expect(analytics.feeInclusiveShortfallUsd).toBeCloseTo(-2);
  });

  it("excludes missing legacy benchmarks without suppressing fill-time quality", () => {
    const state = sampleState();
    const legacy = {
      ...state,
      orders: state.orders.map((order) => ({ ...order, arrival_reference_price: null })),
    };
    const analytics = deriveTerminalPaperExecutionAnalytics(legacy);

    expect(analytics.qualityDataComplete).toBe(true);
    expect(analytics.executionAdjustmentUsd).toBeCloseTo(0.152);
    expect(analytics.arrivalDataComplete).toBe(false);
    expect(analytics.arrivalDataCorrupt).toBe(false);
    expect(analytics.arrivalEligibleFillCount).toBe(2);
    expect(analytics.arrivalSampleCount).toBe(0);
    expect(analytics.waitDriftUsd).toBeNull();
    expect(analytics.arrivalSlippageUsd).toBeNull();
    expect(analytics.feeInclusiveShortfallUsd).toBeNull();
  });

  it("computes partial TCA from valid samples while excluding missing legacy benchmarks", () => {
    const state = sampleState();
    const missingOrderId = state.fills[0].order_id;
    const partialLegacy = {
      ...state,
      orders: state.orders.map((order) => order.order_id === missingOrderId
        ? { ...order, arrival_reference_price: null }
        : order),
    };
    const remainingFill = state.fills.find((fill) => fill.order_id !== missingOrderId)!;
    const expected = deriveTerminalPaperExecutionAnalytics({ ...state, fills: [remainingFill] });
    const analytics = deriveTerminalPaperExecutionAnalytics(partialLegacy);

    expect(analytics.qualityDataComplete).toBe(true);
    expect(analytics.arrivalEligibleFillCount).toBe(2);
    expect(analytics.arrivalSampleCount).toBe(1);
    expect(analytics.arrivalDataComplete).toBe(false);
    expect(analytics.arrivalDataCorrupt).toBe(false);
    expect(analytics.waitDriftUsd).toBeCloseTo(expected.waitDriftUsd!);
    expect(analytics.arrivalExecutionAdjustmentUsd).toBeCloseTo(expected.arrivalExecutionAdjustmentUsd!);
    expect(analytics.arrivalSlippageUsd).toBeCloseTo(expected.arrivalSlippageUsd!);
    expect(analytics.feeInclusiveShortfallUsd).toBeCloseTo(expected.feeInclusiveShortfallUsd!);
  });

  it("fails only arrival metrics closed on a corrupt explicit benchmark", () => {
    const state = sampleState();
    const corrupt = {
      ...state,
      orders: state.orders.map((order) => state.fills.some((fill) => fill.order_id === order.order_id)
        ? { ...order, arrival_reference_price: Number.POSITIVE_INFINITY }
        : order),
    };
    const analytics = deriveTerminalPaperExecutionAnalytics(corrupt);

    expect(analytics.qualityDataComplete).toBe(true);
    expect(analytics.executionAdjustmentUsd).toBeCloseTo(0.152);
    expect(analytics.arrivalDataComplete).toBe(false);
    expect(analytics.arrivalDataCorrupt).toBe(true);
    expect(analytics.arrivalEligibleFillCount).toBe(2);
    expect(analytics.waitDriftUsd).toBeNull();
    expect(analytics.arrivalSlippageUsd).toBeNull();
    expect(analytics.feeInclusiveShortfallUsd).toBeNull();
  });
});

function sampleState() {
  let state = createPaperTradingState({
    now: T0,
    assumptions: { fee_bps: 10, slippage_bps: 10 },
  });
  state = placePaperOrder(state, marketOrder(T1, 100));
  state = advancePaperTrading(state, observation(T2, 100, 0.5));
  state = placePaperOrder(state, marketOrder(T3, 100));
  state = advancePaperTrading(state, observation(T4, 102, 2));
  state = placePaperOrder(state, limitOrder(T5, 90));
  state = cancelPaperOrder(state, state.orders[0].order_id, T6);
  state = placePaperOrder(state, limitOrder(T7, 80));
  state = replacePaperOrder(state, state.orders[0].order_id, { limit_price: 81 }, T8);
  return state;
}

function marketOrder(submittedAt: string, referencePrice: number): PaperOrderInput {
  return {
    venue_id: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    side: "buy",
    order_type: "market",
    time_in_force: "IOC",
    reference_price: referencePrice,
    quote_notional_usd: referencePrice,
    base_size: 1,
    submitted_at: submittedAt,
  };
}

function limitOrder(submittedAt: string, limitPrice: number): PaperOrderInput {
  return {
    venue_id: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    side: "buy",
    order_type: "limit",
    time_in_force: "GTC",
    limit_price: limitPrice,
    quote_notional_usd: limitPrice,
    base_size: 1,
    submitted_at: submittedAt,
  };
}

function observation(observedAt: string, ask: number, askSize: number): PaperMarketObservation {
  return {
    venue_id: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    market_state: "live",
    fetched_at: observedAt,
    observed_at: observedAt,
    quote_fetched_at: observedAt,
    book_fetched_at: observedAt,
    max_age_ms: 30_000,
    best_bid: ask - 1,
    best_ask: ask,
    mark_price: ask,
    bids: [{ price: ask - 1, size: 10 }],
    asks: [{ price: ask, size: askSize }],
    trades: [],
  };
}
