import { describe, expect, it } from "vitest";
import {
  advancePaperTrading,
  cancelPaperOrder,
  createPaperTradingState,
  evaluatePaperOrderRisk,
  parsePaperTradingState,
  placePaperLimitOrder,
  serializePaperTradingState,
  updatePaperOcoDefaults,
  validatePaperAttachedOco,
  type PaperLimitOrderInput,
  type PaperMarketObservation,
  type PaperOrder,
  type PaperTradingState,
} from "./paper-trading-engine";

const T0 = "2026-08-12T12:00:00.000Z";
const T1 = "2026-08-12T12:00:01.000Z";
const T2 = "2026-08-12T12:00:02.000Z";
const T3 = "2026-08-12T12:00:03.000Z";
const T4 = "2026-08-12T12:00:04.000Z";

describe("paper attached OCO exits", () => {
  it("validates long and short geometry and persists a conservative opt-in default", () => {
    expect(validatePaperAttachedOco({ side: "buy", entry_price: 100, target_price: 120, invalidation_price: 90 }).valid).toBe(true);
    expect(validatePaperAttachedOco({ side: "sell", entry_price: 100, target_price: 80, invalidation_price: 110 }).valid).toBe(true);
    expect(validatePaperAttachedOco({ side: "buy", entry_price: 100, target_price: 90, invalidation_price: 120 })).toEqual({
      valid: false,
      message: "Buy OCO requires invalidation below entry and target above entry.",
    });

    const initial = createPaperTradingState({ now: T0 });
    expect(initial.oco_defaults.enabled).toBe(false);
    const enabled = updatePaperOcoDefaults(initial, { enabled: true }, T1);
    expect(parsePaperTradingState(serializePaperTradingState(enabled))).toEqual(enabled);
    expect(enabled.journal[0]).toMatchObject({ event_type: "oco_defaults_updated" });
  });

  it("attaches two deterministic reduce-only exits only after the entry fill", () => {
    const pending = placePaperLimitOrder(baseState(), longEntry());
    expect(pending.orders).toHaveLength(1);
    expect(pending.orders[0]).toMatchObject({ order_kind: "entry", attached_oco: { target_price: 120, invalidation_price: 90 } });

    const filled = advancePaperTrading(pending, market({ best_ask: 100, observed_at: T2, fetched_at: T2 }));
    const exits = activeExits(filled);
    expect(exits).toHaveLength(2);
    expect(exits.map((order) => order.order_kind).sort()).toEqual(["oco_invalidation", "oco_target"]);
    expect(exits.every((order) => order.reduce_only && order.base_size === 1 && order.parent_order_id === pending.orders[0].order_id)).toBe(true);
    expect(exits.every((order) => order.arrival_reference_price === null)).toBe(true);
    expect(exits[0].oco_sibling_order_id).toBe(exits[1].order_id);
    expect(exits[1].oco_sibling_order_id).toBe(exits[0].order_id);
    expect(filled.positions[0].quantity_base).toBe(1);
    expect(filled.journal.some((entry) => entry.event_type === "oco_attached")).toBe(true);
  });

  it("fills a target on a later fresh quote and atomically cancels its sibling", () => {
    const entered = enterLong();
    const exited = advancePaperTrading(entered, market({ best_bid: 121, best_ask: 122, mark_price: 121, observed_at: T3, fetched_at: T3 }));

    expect(exited.orders.find((order) => order.order_kind === "oco_target")).toMatchObject({ status: "filled", fill_price: 121 });
    expect(exited.orders.find((order) => order.order_kind === "oco_invalidation")).toMatchObject({ status: "cancelled", cancelled_at: T3 });
    expect(exited.positions[0]).toMatchObject({ quantity_base: 0, realized_pnl_gross_usd: 21 });
    expect(exited.journal[0].event_type).toBe("oco_sibling_cancelled");
    expect(exited.journal[1]).toMatchObject({ event_type: "order_filled", message: expect.stringContaining("simulated OCO target") });
  });

  it("treats invalidation as simulated stop-market with deterministic adverse slippage and fees", () => {
    let state = createPaperTradingState({ now: T0, assumptions: { fee_bps: 10, slippage_bps: 10 } });
    state = placePaperLimitOrder(state, longEntry());
    state = advancePaperTrading(state, market({ best_ask: 100, observed_at: T2, fetched_at: T2 }));
    state = advancePaperTrading(state, market({ best_bid: 89, best_ask: 90, mark_price: 89, observed_at: T3, fetched_at: T3 }));

    const stop = state.orders.find((order) => order.order_kind === "oco_invalidation");
    expect(stop?.status).toBe("filled");
    expect(stop?.fill_price).toBeCloseTo(88.911);
    expect(stop?.fee_usd).toBeCloseTo(0.088911);
    expect(state.positions[0].quantity_base).toBe(0);
    expect(state.orders.find((order) => order.order_kind === "oco_target")?.status).toBe("cancelled");
  });

  it("has no look-ahead and fills the chronologically first crossing", () => {
    let state = enterLong();
    const entryTimeTrade = { price: 89, side: "sell" as const, time: Date.parse(T2), size: 1 };
    state = advancePaperTrading(state, market({ observed_at: T3, fetched_at: T3, trades: [entryTimeTrade] }));
    expect(activeExits(state)).toHaveLength(2);

    const afterBoth = advancePaperTrading(state, market({
      observed_at: T4,
      fetched_at: T4,
      trades: [
        { price: 121, side: "buy", time: Date.parse(T3) + 500, size: 1 },
        { price: 89, side: "sell", time: Date.parse(T3) + 700, size: 1 },
      ],
    }));
    expect(afterBoth.orders.find((order) => order.order_kind === "oco_target")?.status).toBe("filled");
    expect(afterBoth.orders.find((order) => order.order_kind === "oco_invalidation")?.status).toBe("cancelled");
  });

  it("shrinks exits after a partial close and replaces direction on reversal", () => {
    let state = baseState();
    state = placePaperLimitOrder(state, longEntry({ quote_notional_usd: 200, base_size: 2 }));
    state = advancePaperTrading(state, market({ best_ask: 100, observed_at: T2, fetched_at: T2 }));
    state = placePaperLimitOrder(state, plainEntry({ side: "sell", base_size: 1, quote_notional_usd: 100, submitted_at: T3 }));
    state = advancePaperTrading(state, market({ best_bid: 100, best_ask: 101, observed_at: T3, fetched_at: T3 }));

    expect(state.positions[0].quantity_base).toBe(1);
    expect(activeExits(state)).toHaveLength(2);
    expect(activeExits(state).every((order) => order.side === "sell" && order.base_size === 1)).toBe(true);
    expect(state.journal.some((entry) => entry.event_type === "oco_reconciled" && entry.message.includes("resized"))).toBe(true);

    state = placePaperLimitOrder(state, {
      ...plainEntry({ side: "sell", base_size: 2, quote_notional_usd: 200, submitted_at: T4 }),
      attached_oco: { target_price: 80, invalidation_price: 110 },
    });
    state = advancePaperTrading(state, market({
      best_bid: 100,
      best_ask: 101,
      book_revision: 4,
      observed_at: T4,
      fetched_at: T4,
    }));

    expect(state.positions[0].quantity_base).toBe(-1);
    expect(activeExits(state)).toHaveLength(2);
    expect(activeExits(state).every((order) => order.side === "buy" && order.base_size === 1)).toBe(true);
    expect(state.orders.filter((order) => order.reduce_only && order.side === "sell").every((order) => order.status === "cancelled")).toBe(true);
  });

  it("cancels both simulated exits when either sibling is manually cancelled", () => {
    const entered = enterLong();
    const target = entered.orders.find((order) => order.order_kind === "oco_target")!;
    const cancelled = cancelPaperOrder(entered, target.order_id, T3);
    expect(cancelled.orders.filter((order) => order.oco_group_id === target.oco_group_id).every((order) => order.status === "cancelled")).toBe(true);
    expect(cancelled.journal[0].message).toContain("OCO group cancelled");
  });

  it("reserves two open-order slots and migrates v2 entries safely", () => {
    const constrained = createPaperTradingState({ now: T0, riskPolicy: { max_open_orders: 1 } });
    const decision = evaluatePaperOrderRisk(constrained, longEntry());
    expect(decision).toMatchObject({ allowed: false, code: "max_open_orders" });
    expect(decision.message).toContain("2 required slots");

    const current = placePaperLimitOrder(baseState(), plainEntry());
    const legacy = JSON.parse(serializePaperTradingState(current)) as Record<string, unknown>;
    legacy.version = 2;
    delete legacy.oco_defaults;
    legacy.orders = (legacy.orders as Array<Record<string, unknown>>).map((order) => {
      const copy = { ...order };
      delete copy.order_kind;
      delete copy.reduce_only;
      delete copy.parent_order_id;
      delete copy.oco_group_id;
      delete copy.oco_sibling_order_id;
      delete copy.attached_oco;
      return copy;
    });
    const migrated = parsePaperTradingState(JSON.stringify(legacy));
    expect(migrated).toMatchObject({ version: 5, oco_defaults: { enabled: false } });
    expect(migrated?.orders[0]).toMatchObject({ order_kind: "entry", reduce_only: false, attached_oco: null });

    const killedV2 = JSON.parse(serializePaperTradingState(current)) as Record<string, unknown>;
    killedV2.version = 2;
    delete killedV2.oco_defaults;
    killedV2.orders = [];
    killedV2.risk_control = {
      ...(killedV2.risk_control as Record<string, unknown>),
      status: "killed",
      reason: "kill_switch",
      message: "Local PAPER kill switch remains active.",
      triggered_at: T2,
    };
    expect(parsePaperTradingState(JSON.stringify(killedV2))?.risk_control).toMatchObject({
      status: "killed",
      reason: "kill_switch",
      triggered_at: T2,
    });

    const tampered = JSON.parse(serializePaperTradingState(enterLong())) as PaperTradingState;
    tampered.orders.find((order) => order.order_kind === "oco_target")!.oco_sibling_order_id = "paper-order-99999999";
    expect(parsePaperTradingState(JSON.stringify(tampered))).toBeNull();
  });
});

function baseState() {
  return createPaperTradingState({ now: T0, assumptions: { fee_bps: 0, slippage_bps: 0 } });
}

function enterLong() {
  let state = placePaperLimitOrder(baseState(), longEntry());
  state = advancePaperTrading(state, market({ best_ask: 100, observed_at: T2, fetched_at: T2 }));
  return state;
}

function longEntry(overrides: Partial<PaperLimitOrderInput> = {}): PaperLimitOrderInput {
  return {
    ...plainEntry(),
    attached_oco: { target_price: 120, invalidation_price: 90 },
    ...overrides,
  };
}

function plainEntry(overrides: Partial<PaperLimitOrderInput> = {}): PaperLimitOrderInput {
  return {
    venue_id: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    side: "buy",
    limit_price: 100,
    quote_notional_usd: 100,
    base_size: 1,
    submitted_at: T1,
    ...overrides,
  };
}

function market(overrides: Partial<PaperMarketObservation> = {}): PaperMarketObservation {
  const observation: PaperMarketObservation = {
    venue_id: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    market_state: "live",
    fetched_at: T2,
    observed_at: T2,
    quote_fetched_at: overrides.quote_fetched_at === undefined ? overrides.fetched_at ?? T2 : overrides.quote_fetched_at,
    book_fetched_at: overrides.book_fetched_at === undefined ? overrides.fetched_at ?? T2 : overrides.book_fetched_at,
    max_age_ms: 5_000,
    best_bid: 99,
    best_ask: 101,
    mark_price: 100,
    trades: [],
    ...overrides,
  };
  return {
    ...observation,
    bids: observation.bids ?? (observation.best_bid == null ? undefined : [{ price: observation.best_bid, size: 10 }]),
    asks: observation.asks ?? (observation.best_ask == null ? undefined : [{ price: observation.best_ask, size: 10 }]),
  };
}

function activeExits(state: PaperTradingState): PaperOrder[] {
  return state.orders.filter((order) => order.reduce_only && order.status === "pending");
}
