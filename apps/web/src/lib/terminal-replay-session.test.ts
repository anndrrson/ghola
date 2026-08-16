import { describe, expect, it } from "vitest";
import {
  REPLAY_FILL_MODEL,
  REPLAY_SESSION_LIMITS,
  advanceReplaySession,
  cancelReplayOrder,
  createReplaySession,
  forkReplaySession,
  parseReplaySession,
  prepareReplaySource,
  resetReplaySession,
  seekReplaySession,
  serializeReplaySession,
  stepReplaySession,
  submitReplayOrder,
  type ReplaySourceInput,
} from "./terminal-replay-session";

describe("terminal replay session", () => {
  it("fingerprints normalized instrument and source data deterministically", () => {
    const a = prepareReplaySource(source());
    const b = prepareReplaySource(source());
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^ghola-replay-fp-v1:[0-9a-f]{64}$/);
    expect(Object.isFrozen(a.candles)).toBe(true);

    const changed = source();
    changed.candles[2] = { ...changed.candles[2], c: "101.01" };
    expect(prepareReplaySource(changed).fingerprint).not.toBe(a.fingerprint);
  });

  it("makes orders eligible on the next candle and is duplicate-step idempotent", () => {
    const data = prepareReplaySource(source());
    const initial = createReplaySession(data, { assumptions: { fee_bps: 10, slippage_bps: 20 } });
    const placed = submitReplayOrder(initial, data, { type: "market", side: "buy", size: 1 });

    expect(placed.orders[0]).toMatchObject({ submitted_cursor: 0, eligible_cursor: 1, status: "pending" });
    expect(advanceReplaySession(placed, data, 0)).toBe(placed);

    const filled = stepReplaySession(placed, data);
    expect(filled.cursor).toBe(1);
    expect(filled.fills).toHaveLength(1);
    expect(filled.fills[0]).toMatchObject({
      execution_model: REPLAY_FILL_MODEL,
      reference_price: 100,
      fill_price: 100.2,
      fee_bps: 10,
      slippage_bps: 20,
      bar_cursor: 1,
    });
    expect(filled.fills[0].fee_usd).toBeCloseTo(0.1002);
    expect(advanceReplaySession(filled, data, 1)).toBe(filled);
  });

  it("handles favorable limit gaps and adverse stop gaps without claiming L2 execution", () => {
    const data = prepareReplaySource(source({
      candles: [
        bar(0, 100, 101, 99, 100),
        bar(1, 90, 112, 89, 105),
      ],
    }));
    const state = createReplaySession(data, { assumptions: { fee_bps: 0, slippage_bps: 100 } });
    const limit = submitReplayOrder(state, data, { type: "limit", side: "buy", size: 1, limit_price: 95 });
    const stopped = submitReplayOrder(limit, data, { type: "stop", side: "sell", size: 1, stop_price: 105 });
    const result = stepReplaySession(stopped, data);

    const limitFill = result.fills.find((fill) => fill.order_id === limit.orders.at(-1)?.order_id);
    const stopFill = result.fills.find((fill) => fill.order_id === stopped.orders.at(-1)?.order_id);
    expect(limitFill).toMatchObject({ reference_price: 90, fill_price: 90.9, trigger: "gap_open", execution_model: "bar_model" });
    expect(stopFill).toMatchObject({ reference_price: 90, fill_price: 89.1, trigger: "gap_open", execution_model: "bar_model" });
  });

  it("models stop-limit activation conservatively", () => {
    const data = prepareReplaySource(source({
      candles: [
        bar(0, 100, 101, 99, 100),
        bar(1, 100, 106, 99, 104),
        bar(2, 102, 104, 101, 103),
      ],
    }));
    let state = createReplaySession(data, { assumptions: { fee_bps: 0, slippage_bps: 0 } });
    state = submitReplayOrder(state, data, {
      type: "stop_limit", side: "buy", size: 1, stop_price: 105, limit_price: 103,
    });
    state = stepReplaySession(state, data);
    expect(state.orders[0]).toMatchObject({ status: "pending", triggered_cursor: 1 });
    expect(state.fills).toHaveLength(0);

    state = stepReplaySession(state, data);
    expect(state.fills[0]).toMatchObject({ reference_price: 102, fill_price: 102, trigger: "gap_open" });
  });

  it("fills a marketable stop-limit from its trigger, capped by its limit", () => {
    const data = prepareReplaySource(source({
      candles: [bar(0, 100, 101, 99, 100), bar(1, 100, 105, 99, 104)],
    }));
    let state = createReplaySession(data, { assumptions: { fee_bps: 0, slippage_bps: 100 } });
    state = submitReplayOrder(state, data, {
      type: "stop_limit", side: "buy", size: 1, stop_price: 105, limit_price: 106,
    });
    state = stepReplaySession(state, data);
    expect(state.fills[0]).toMatchObject({
      reference_price: 105,
      fill_price: 106,
      trigger: "stop_limit_activation",
    });
  });

  it("caps adverse slippage at the limit price on an intrabar limit touch", () => {
    const data = prepareReplaySource(source({
      candles: [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 94, 96)],
    }));
    let state = createReplaySession(data, { assumptions: { fee_bps: 0, slippage_bps: 100 } });
    state = submitReplayOrder(state, data, { type: "limit", side: "buy", size: 2, limit_price: 95 });
    state = stepReplaySession(state, data);
    expect(state.fills[0]).toMatchObject({
      reference_price: 95,
      fill_price: 95,
      slippage_bps: 100,
      slippage_cost_usd: 0,
      execution_model: "bar_model",
    });
  });

  it("gives an adverse bracket stop priority when stop and target touch the same bar", () => {
    const data = prepareReplaySource(source({
      candles: [
        bar(0, 100, 101, 99, 100),
        bar(1, 100, 102, 98, 100),
        bar(2, 100, 106, 94, 100),
      ],
    }));
    let state = createReplaySession(data, { assumptions: { fee_bps: 0, slippage_bps: 0 } });
    state = submitReplayOrder(state, data, {
      type: "market",
      side: "buy",
      size: 1,
      attached_oco: { stop_price: 95, target_price: 105 },
    });
    state = advanceReplaySession(state, data, 2);

    const exit = state.fills.find((fill) => fill.side === "sell");
    expect(exit).toMatchObject({ reference_price: 95, fill_price: 95, order_role: "oco_stop" });
    expect(state.orders.find((order) => order.role === "oco_target")).toMatchObject({
      status: "cancelled", cancel_reason: "oco_sibling_filled",
    });
    expect(state.performance).toMatchObject({ realized_pnl_gross_usd: -5, realized_r: -1 });
    expect(state.positions[0]).toMatchObject({ status: "closed", mae_usd: 5, mfe_usd: 2, realized_r: -1 });
  });

  it("tracks fees, realized/unrealized P&L, MAE/MFE, and realized R", () => {
    const data = prepareReplaySource(source({
      candles: [
        bar(0, 100, 100, 100, 100),
        bar(1, 100, 105, 95, 102),
        bar(2, 110, 112, 108, 111),
      ],
    }));
    let state = createReplaySession(data, { assumptions: { fee_bps: 10, slippage_bps: 0 } });
    state = submitReplayOrder(state, data, { type: "market", side: "buy", size: 1, risk_usd: 5 });
    state = stepReplaySession(state, data);
    expect(state.performance).toMatchObject({
      realized_pnl_gross_usd: 0,
      unrealized_pnl_gross_usd: 2,
      fees_usd: 0.1,
      net_pnl_usd: 1.9,
    });
    state = submitReplayOrder(state, data, { type: "market", side: "sell", size: 1, reduce_only: true });
    state = stepReplaySession(state, data);

    expect(state.performance.realized_pnl_gross_usd).toBe(10);
    expect(state.performance.fees_usd).toBeCloseTo(0.21);
    expect(state.performance.net_pnl_usd).toBeCloseTo(9.79);
    expect(state.performance.realized_r).toBeCloseTo(1.958);
    expect(state.positions[0]).toMatchObject({ mae_usd: 5, mfe_usd: 10, status: "closed" });
  });

  it("never lets a reduce-only order reverse or create a position", () => {
    const data = prepareReplaySource(source());
    let state = createReplaySession(data);
    state = submitReplayOrder(state, data, { type: "market", side: "sell", size: 1, reduce_only: true });
    state = stepReplaySession(state, data);
    expect(state.fills).toHaveLength(0);
    expect(state.positions).toHaveLength(0);
    expect(state.orders[0]).toMatchObject({ status: "cancelled", cancel_reason: "position_unavailable" });
  });

  it("keeps manual stepping and range advance byte-equivalent", () => {
    const data = prepareReplaySource(source());
    const placed = submitReplayOrder(createReplaySession(data), data, {
      type: "limit", side: "buy", size: 2, limit_price: 99,
    });
    const ranged = advanceReplaySession(placed, data, 3);
    const manual = stepReplaySession(stepReplaySession(stepReplaySession(placed, data), data), data);
    expect(serializeReplaySession(manual)).toBe(serializeReplaySession(ranged));
  });

  it("fails closed on backward seek after any action, with explicit clean fork/reset", () => {
    const data = prepareReplaySource(source());
    const freelySeekable = createReplaySession(data, { cursor: 2 });
    expect(seekReplaySession(freelySeekable, data, 1).cursor).toBe(1);

    const placed = submitReplayOrder(seekReplaySession(freelySeekable, data, 1), data, {
      type: "market", side: "buy", size: 1,
    });
    expect(() => seekReplaySession(placed, data, 0)).toThrow("replay_backward_seek_requires_fork_or_reset");
    expect(resetReplaySession(placed, data, 0)).toMatchObject({ cursor: 0, orders: [], fills: [], journal: [] });
    expect(forkReplaySession(placed, data, 0)).toMatchObject({ cursor: 0, orders: [], fills: [], journal: [] });
  });

  it("rejects mutated or mismatched sources before changing state", () => {
    const input = source();
    const data = prepareReplaySource(input);
    const state = createReplaySession(data);
    const mutated = {
      ...data,
      candles: data.candles.map((candle, index) => index === 1 ? { ...candle, h: 999 } : { ...candle }),
    };
    expect(() => stepReplaySession(state, mutated)).toThrow("replay_source_fingerprint_mismatch");

    const other = prepareReplaySource(source({
      instrument: { venue: "fixture", product: "ETH-PERP", interval: "1m" },
    }));
    expect(() => submitReplayOrder(state, other, { type: "market", side: "buy", size: 1 })).toThrow(
      "replay_source_fingerprint_mismatch",
    );
    expect(() => prepareReplaySource(source({
      candles: [bar(0, 100, 99, 98, 100)],
    }))).toThrow("replay_source_ohlc_invalid");
  });

  it("validates cancellation and persisted state, with byte-stable export", () => {
    const data = prepareReplaySource(source());
    const state = submitReplayOrder(createReplaySession(data), data, {
      type: "limit", side: "buy", size: 1, limit_price: 50,
    });
    const cancelled = cancelReplayOrder(state, data, state.orders[0].order_id);
    expect(cancelled.orders[0]).toMatchObject({ status: "cancelled", cancel_reason: "user_cancelled" });

    const encoded = serializeReplaySession(cancelled);
    const parsed = parseReplaySession(encoded);
    expect(parsed).not.toBeNull();
    expect(serializeReplaySession(parsed!)).toBe(encoded);
    expect(parseReplaySession(encoded.replace('"size":1', '"size":0'))).toBeNull();

    const oversized = {
      ...cancelled,
      orders: Array.from({ length: REPLAY_SESSION_LIMITS.orders + 1 }, () => cancelled.orders[0]),
    };
    expect(() => serializeReplaySession(oversized)).toThrow("replay_state_invalid");
  });

  it("rejects persisted fill/order graph tampering and cursor-mark mismatch", () => {
    const data = prepareReplaySource(source());
    const filled = stepReplaySession(submitReplayOrder(createReplaySession(data), data, {
      type: "market", side: "buy", size: 1,
    }), data);
    const wrongFillLink = structuredClone(filled);
    wrongFillLink.orders[0].fill_id = "replay-fill-99999999";
    expect(parseReplaySession(JSON.stringify(wrongFillLink))).toBeNull();

    const wrongModel = structuredClone(filled);
    wrongModel.fills[0].execution_model = "l2" as "bar_model";
    expect(parseReplaySession(JSON.stringify(wrongModel))).toBeNull();

    const wrongMark = structuredClone(filled);
    wrongMark.performance.mark_price = 102.5;
    wrongMark.performance.unrealized_pnl_gross_usd = 2.47;
    wrongMark.performance.net_pnl_usd = 2.4449925;
    wrongMark.performance.equity_usd = 10_002.4449925;
    expect(() => stepReplaySession(wrongMark, data)).toThrow("replay_state_source_cursor_mismatch");
  });
});

function source(overrides: Partial<ReplaySourceInput> = {}): ReplaySourceInput {
  const base: ReplaySourceInput = {
    source_id: "fixture:btc:1m:v1",
    instrument: { venue: "fixture", product: "BTC-PERP", interval: "1m" },
    candles: [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 103, 98, 102),
      bar(2, 102, 104, 97, 101),
      bar(3, 101, 105, 96, 104),
    ],
  };
  return {
    ...base,
    ...overrides,
    instrument: { ...base.instrument, ...overrides.instrument },
  };
}

function bar(t: number, o: number, h: number, l: number, c: number) {
  return { t, T: t + 1, o: String(o), h: String(h), l: String(l), c: String(c), v: "10", n: 1 };
}
