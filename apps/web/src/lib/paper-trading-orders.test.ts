import { describe, expect, it } from "vitest";
import {
  advancePaperTrading,
  cancelAllPaperOrders,
  createPaperTradingState,
  parsePaperTradingState,
  placePaperOrder,
  replacePaperOrder,
  serializePaperTradingState,
  type PaperMarketObservation,
  type PaperOrderInput,
  type PaperTradingState,
} from "./paper-trading-engine";

const T0 = "2026-08-12T12:00:00.000Z";
const T1 = "2026-08-12T12:00:01.000Z";
const T2 = "2026-08-12T12:00:02.000Z";
const T3 = "2026-08-12T12:00:03.000Z";
const T4 = "2026-08-12T12:00:04.000Z";

describe("institutional paper order management", () => {
  it("fills GTC limits on the chronologically first post-submission crossing", () => {
    const pending = placePaperOrder(baseState(), order({
      order_type: "limit",
      time_in_force: "GTC",
      limit_price: 100,
    }));
    const filled = advancePaperTrading(pending, market({
      best_ask: 105,
      trades: [
        { price: 99, side: "sell", time: Date.parse(T0), size: 1 },
        { price: 99.5, side: "sell", time: Date.parse(T1) + 200, size: 1 },
        { price: 98, side: "sell", time: Date.parse(T1) + 500, size: 1 },
      ],
    }));

    expect(filled.orders[0]).toMatchObject({ status: "filled", fill_price: 99.5 });
    expect(filled.fills[0].reference_price).toBe(99.5);
  });

  it("applies IOC partial-fill and FOK all-or-none semantics from displayed depth", () => {
    const depth = market({
      best_ask: 100,
      asks: [{ price: 100, size: 0.4 }],
    });
    const ioc = advancePaperTrading(placePaperOrder(baseState(), order({
      order_type: "market",
      time_in_force: "IOC",
      limit_price: null,
    })), depth);
    expect(ioc.orders[0]).toMatchObject({
      status: "cancelled",
      filled_base_size: 0.4,
      remaining_base_size: 0.6,
      cancel_reason: "ioc_remainder_cancelled",
    });
    expect(ioc.positions[0].quantity_base).toBe(0.4);

    const fok = advancePaperTrading(placePaperOrder(baseState(), order({
      order_type: "market",
      time_in_force: "FOK",
      limit_price: null,
    })), depth);
    expect(fok.orders[0]).toMatchObject({
      status: "cancelled",
      filled_base_size: 0,
      remaining_base_size: 1,
      cancel_reason: "fok_not_fillable",
    });
    expect(fok.fills).toHaveLength(0);
  });

  it("fails closed for quote-only market IOC/FOK and marketable GTC orders", () => {
    const quoteOnly = market({ best_ask: 100, asks: undefined });
    const ioc = advancePaperTrading(placePaperOrder(baseState(), order({
      order_type: "market",
      time_in_force: "IOC",
      limit_price: null,
    })), quoteOnly);
    expect(ioc.orders[0]).toMatchObject({
      status: "cancelled",
      filled_base_size: 0,
      cancel_reason: "ioc_not_marketable",
    });

    const fok = advancePaperTrading(placePaperOrder(baseState(), order({
      order_type: "market",
      time_in_force: "FOK",
      limit_price: null,
    })), quoteOnly);
    expect(fok.orders[0]).toMatchObject({
      status: "cancelled",
      filled_base_size: 0,
      cancel_reason: "fok_not_fillable",
    });

    const gtc = advancePaperTrading(placePaperOrder(baseState(), order({ limit_price: 100 })), quoteOnly);
    expect(gtc.orders[0]).toMatchObject({ status: "pending", filled_base_size: 0, remaining_base_size: 1 });
    expect([...ioc.fills, ...fok.fills, ...gtc.fills]).toHaveLength(0);
    expect([...ioc.positions, ...fok.positions, ...gtc.positions]).toHaveLength(0);
  });

  it("triggers quote-only stops without claiming fills and rejects missing or invalid relevant depth", () => {
    const quoteOnly = market({ best_ask: 106, asks: undefined });
    const gtc = advancePaperTrading(placePaperOrder(baseState(), order({
      order_type: "stop",
      time_in_force: "GTC",
      limit_price: null,
      stop_price: 105,
    })), quoteOnly);
    expect(gtc.orders[0]).toMatchObject({ status: "pending", triggered_at: T2, filled_base_size: 0 });

    const ioc = advancePaperTrading(placePaperOrder(baseState(), order({
      order_type: "stop",
      time_in_force: "IOC",
      limit_price: null,
      stop_price: 105,
    })), quoteOnly);
    expect(ioc.orders[0]).toMatchObject({
      status: "cancelled",
      triggered_at: T2,
      filled_base_size: 0,
      cancel_reason: "ioc_not_marketable",
    });

    for (const asks of [[], [{ price: 0, size: 1 }], [{ price: 107, size: 1 }]]) {
      const failed = advancePaperTrading(placePaperOrder(baseState(), order({
        order_type: "market",
        time_in_force: "FOK",
        limit_price: null,
      })), market({ best_ask: 106, asks }));
      expect(failed.orders[0]).toMatchObject({
        status: "cancelled",
        filled_base_size: 0,
        cancel_reason: "fok_not_fillable",
      });
      expect(failed.fills).toHaveLength(0);
    }
  });

  it("never claims a reduce-only emergency fill without explicit relevant depth", () => {
    let state = advancePaperTrading(placePaperOrder(baseState(), order({
      order_type: "market",
      time_in_force: "IOC",
      limit_price: null,
    })), market({ best_ask: 100, asks: [{ price: 100, size: 1 }] }));
    state = placePaperOrder(state, order({
      side: "sell",
      order_type: "market",
      time_in_force: "IOC",
      limit_price: null,
      reduce_only: true,
      submitted_at: T3,
    }));
    state = advancePaperTrading(state, market({
      fetched_at: T4,
      observed_at: T4,
      best_bid: 100,
      bids: undefined,
    }));

    expect(state.orders.find((item) => item.reduce_only)).toMatchObject({
      status: "cancelled",
      filled_base_size: 0,
      cancel_reason: "ioc_not_marketable",
    });
    expect(state.positions[0].quantity_base).toBe(1);
    expect(state.fills).toHaveLength(1);
  });

  it("activates stop and stop-limit orders without using pre-submission trades", () => {
    const stop = placePaperOrder(baseState(), order({
      order_type: "stop",
      time_in_force: "GTC",
      limit_price: null,
      stop_price: 105,
    }));
    const stopped = advancePaperTrading(stop, market({
      best_ask: 106,
      asks: [{ price: 106, size: 1 }],
      trades: [
        { price: 106, side: "buy", time: Date.parse(T0) },
        { price: 105, side: "buy", time: Date.parse(T1) + 500, size: 1 },
      ],
    }));
    expect(stopped.orders[0]).toMatchObject({ status: "filled", triggered_at: "2026-08-12T12:00:01.500Z", fill_price: 106 });

    let stopLimit = placePaperOrder(baseState(), order({
      order_type: "stop_limit",
      time_in_force: "GTC",
      limit_price: 105.5,
      stop_price: 105,
    }));
    stopLimit = advancePaperTrading(stopLimit, market({
      best_ask: 106,
      asks: [{ price: 106, size: 1 }],
      trades: [{ price: 105, side: "buy", time: Date.parse(T1) + 500, size: 1 }],
    }));
    expect(stopLimit.orders[0]).toMatchObject({ status: "pending", triggered_at: "2026-08-12T12:00:01.500Z" });
    stopLimit = advancePaperTrading(stopLimit, market({
      best_ask: 105,
      asks: [{ price: 105, size: 1 }],
      fetched_at: T3,
      observed_at: T3,
    }));
    expect(stopLimit.orders[0]).toMatchObject({ status: "filled", fill_price: 105 });
  });

  it("ignores unsized stop prints and timestamps book execution at observation time", () => {
    const pending = placePaperOrder(baseState(), order({
      order_type: "stop",
      time_in_force: "GTC",
      limit_price: null,
      stop_price: 105,
    }));
    const unsized = advancePaperTrading(pending, market({
      best_ask: 104,
      asks: [{ price: 104, size: 10 }],
      trades: [{ price: 105, side: "buy", time: Date.parse(T1) + 500 }],
    }));
    expect(unsized.orders[0]).toMatchObject({ status: "pending", triggered_at: null });

    const triggered = advancePaperTrading(pending, market({
      best_ask: 106,
      asks: [{ price: 106, size: 10 }],
      trades: [{ id: "stop-trigger", price: 105, side: "buy", time: Date.parse(T1) + 500, size: 1 }],
    }));
    expect(triggered.orders[0]).toMatchObject({
      status: "filled",
      triggered_at: "2026-08-12T12:00:01.500Z",
      filled_at: T2,
      fill_price: 106,
    });
  });

  it("updates trailing anchors chronologically and enforces reduce-only at placement", () => {
    let state = placePaperOrder(baseState(), order({ order_type: "market", time_in_force: "IOC", limit_price: null }));
    state = advancePaperTrading(state, market({ best_ask: 100, asks: [{ price: 100, size: 1 }] }));
    expect(state.positions[0].quantity_base).toBe(1);

    expect(() => placePaperOrder(state, order({
      side: "buy",
      order_type: "limit",
      limit_price: 90,
      reduce_only: true,
      submitted_at: T3,
    }))).toThrow("paper_reduce_only_side_invalid");
    expect(() => placePaperOrder(state, order({
      side: "sell",
      order_type: "limit",
      limit_price: 110,
      base_size: 2,
      quote_notional_usd: 220,
      reduce_only: true,
      submitted_at: T3,
    }))).toThrow("paper_reduce_only_size_invalid");

    state = placePaperOrder(state, order({
      side: "sell",
      order_type: "trailing_stop",
      time_in_force: "GTC",
      limit_price: null,
      trail_offset_bps: 1_000,
      reduce_only: true,
      submitted_at: T3,
    }));
    state = advancePaperTrading(state, market({
      best_bid: 109,
      best_ask: 110,
      fetched_at: T4,
      observed_at: T4,
      trades: [
        { price: 120, side: "buy", time: Date.parse(T3) + 100, size: 1 },
        { price: 109, side: "sell", time: Date.parse(T3) + 200, size: 1 },
      ],
    }));
    expect(state.orders[0]).toMatchObject({ status: "pending", trail_anchor_price: 120, stop_price: 108 });
    state = advancePaperTrading(state, market({
      best_bid: 107,
      best_ask: 108,
      bids: [{ price: 107, size: 1 }],
      asks: [{ price: 108, size: 1 }],
      fetched_at: "2026-08-12T12:00:05.000Z",
      observed_at: "2026-08-12T12:00:05.000Z",
      trades: [{ price: 107, side: "sell", time: Date.parse(T4) + 100, size: 1 }],
    }));
    expect(state.orders[0].status).toBe("filled");
    expect(state.positions[0].quantity_base).toBe(0);
  });

  it("atomically replaces pending orders, preserves lineage, and cancels all scoped orders", () => {
    let state = placePaperOrder(baseState(), order({ limit_price: 95, reference_price: 94 }));
    const originalId = state.orders[0].order_id;
    state = replacePaperOrder(state, originalId, {
      limit_price: 96,
      quote_notional_usd: 192,
      base_size: 2,
    }, T2);
    const replacement = state.orders.find((item) => item.status === "pending")!;
    expect(state.orders.find((item) => item.order_id === originalId)).toMatchObject({
      status: "replaced",
      replaced_by_order_id: replacement.order_id,
    });
    expect(replacement).toMatchObject({
      limit_price: 96,
      base_size: 2,
      arrival_reference_price: null,
      replaces_order_id: originalId,
    });
    expect(state.journal[0].event_type).toBe("order_replaced");

    state = placePaperOrder(state, order({ product: "ETH-PERP", submitted_at: T3 }));
    const cancelled = cancelAllPaperOrders(state, T4, { venue_id: "hyperliquid" });
    expect(cancelled.orders.filter((item) => item.status === "pending")).toHaveLength(0);
    expect(cancelled.journal[0]).toMatchObject({ event_type: "orders_cancelled", message: expect.stringContaining("2") });
  });

  it("replaces only the unfilled residual when desired total size is unchanged", () => {
    let state = placePaperOrder(baseState(), order({
      quote_notional_usd: 200,
      base_size: 2,
      reference_price: 100,
    }));
    state = advancePaperTrading(state, market({
      best_ask: 100,
      asks: [{ price: 100, size: 0.5 }],
    }));
    const originalId = state.orders[0].order_id;

    state = replacePaperOrder(state, originalId, { limit_price: 99 }, T3);
    const replacement = state.orders.find((item) => item.status === "pending")!;
    expect(state.orders.find((item) => item.order_id === originalId)).toMatchObject({
      status: "replaced",
      filled_base_size: 0.5,
    });
    expect(replacement).toMatchObject({
      base_size: 1.5,
      remaining_base_size: 1.5,
      quote_notional_usd: 150,
    });

    state = advancePaperTrading(state, market({
      fetched_at: T4,
      observed_at: T4,
      best_bid: 98,
      best_ask: 99,
      bids: [{ price: 98, size: 10 }],
      asks: [{ price: 99, size: 10 }],
    }));
    expect(state.positions[0].quantity_base).toBeCloseTo(2);
    expect(state.fills.reduce((total, fill) => total + fill.base_size, 0)).toBeCloseTo(2);
  });

  it("uses changed desired total size without re-ordering prior partial fills", () => {
    let state = placePaperOrder(baseState(), order({
      quote_notional_usd: 200,
      base_size: 2,
      reference_price: 100,
    }));
    state = advancePaperTrading(state, market({
      best_ask: 100,
      asks: [{ price: 100, size: 0.5 }],
    }));
    const originalId = state.orders[0].order_id;

    expect(() => replacePaperOrder(state, originalId, {
      quote_notional_usd: 50,
      base_size: 0.5,
    }, T3)).toThrow("paper_order_replace_size_filled");

    state = replacePaperOrder(state, originalId, {
      limit_price: 99,
      quote_notional_usd: 125,
      base_size: 1.25,
    }, T3);
    expect(state.orders.find((item) => item.status === "pending")).toMatchObject({
      base_size: 0.75,
      remaining_base_size: 0.75,
      quote_notional_usd: 75,
    });
    state = advancePaperTrading(state, market({
      fetched_at: T4,
      observed_at: T4,
      best_bid: 98,
      best_ask: 99,
      bids: [{ price: 98, size: 10 }],
      asks: [{ price: 99, size: 10 }],
    }));
    expect(state.positions[0].quantity_base).toBeCloseTo(1.25);
    expect(state.fills.reduce((total, fill) => total + fill.base_size, 0)).toBeCloseTo(1.25);
  });

  it("persists only an explicitly supplied replacement arrival benchmark", () => {
    let state = placePaperOrder(baseState(), order({ limit_price: 95, reference_price: 94 }));
    state = replacePaperOrder(state, state.orders[0].order_id, {
      limit_price: 96,
      reference_price: 97,
    }, T2);

    expect(state.orders.find((item) => item.status === "pending")).toMatchObject({
      limit_price: 96,
      arrival_reference_price: 97,
    });
  });

  it("migrates v4 orders with an unavailable arrival benchmark instead of inferring one", () => {
    const current = placePaperOrder(baseState(), order({ limit_price: 99, reference_price: 101 }));
    const legacy = JSON.parse(serializePaperTradingState(current)) as Record<string, unknown>;
    legacy.version = 4;
    legacy.orders = (legacy.orders as Array<Record<string, unknown>>).map((value) => {
      const next = { ...value };
      delete next.arrival_reference_price;
      return next;
    });

    expect(parsePaperTradingState(JSON.stringify(legacy))).toMatchObject({
      version: 5,
      orders: [{ arrival_reference_price: null }],
    });
  });

  it("rejects a v5 order with a missing or corrupt arrival benchmark field", () => {
    const current = placePaperOrder(baseState(), order({ reference_price: 101 }));
    const missing = JSON.parse(serializePaperTradingState(current)) as Record<string, unknown>;
    delete (missing.orders as Array<Record<string, unknown>>)[0].arrival_reference_price;
    expect(parsePaperTradingState(JSON.stringify(missing))).toBeNull();

    const corrupt = JSON.parse(serializePaperTradingState(current)) as Record<string, unknown>;
    (corrupt.orders as Array<Record<string, unknown>>)[0].arrival_reference_price = -1;
    expect(parsePaperTradingState(JSON.stringify(corrupt))).toBeNull();
  });

  it("migrates v3 limit orders with conservative order-management defaults", () => {
    const current = placePaperOrder(baseState(), order({ limit_price: 99 }));
    const legacy = JSON.parse(serializePaperTradingState(current)) as Record<string, unknown>;
    legacy.version = 3;
    legacy.orders = (legacy.orders as Array<Record<string, unknown>>).map((value) => {
      const next = { ...value };
      for (const key of [
        "order_type", "time_in_force", "stop_price", "trail_offset_bps", "trail_anchor_price",
        "triggered_at", "filled_base_size", "remaining_base_size", "cancel_reason",
        "replaces_order_id", "replaced_by_order_id",
      ]) delete next[key];
      return next;
    });

    expect(parsePaperTradingState(JSON.stringify(legacy))?.orders[0]).toMatchObject({
      order_type: "limit",
      time_in_force: "GTC",
      stop_price: null,
      filled_base_size: 0,
      remaining_base_size: 1,
      cancel_reason: null,
      arrival_reference_price: null,
    });
  });
});

function baseState(): PaperTradingState {
  return createPaperTradingState({ now: T0, assumptions: { fee_bps: 0, slippage_bps: 0 } });
}

function order(overrides: Partial<PaperOrderInput> = {}): PaperOrderInput {
  return {
    venue_id: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    side: "buy",
    order_type: "limit",
    time_in_force: "GTC",
    limit_price: 100,
    stop_price: null,
    trail_offset_bps: null,
    quote_notional_usd: 100,
    base_size: 1,
    reduce_only: false,
    submitted_at: T1,
    ...overrides,
  };
}

function market(overrides: Partial<PaperMarketObservation> = {}): PaperMarketObservation {
  return {
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
    bids: [{ price: 99, size: 10 }],
    asks: [{ price: 101, size: 10 }],
    trades: [],
    ...overrides,
  };
}
