import { describe, expect, it } from "vitest";
import {
  advancePaperTrading,
  createPaperTradingState,
  parsePaperTradingState,
  placePaperOrder,
  replacePaperOrder,
  restorePaperTradingMark,
  serializePaperTradingState,
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
const STALE = "2026-08-12T11:59:50.000Z";

describe("paper execution integrity", () => {
  it("executes entry and OCO events by crossing time, not order class", () => {
    let state = placePaperOrder(baseState(), order({
      attached_oco: { target_price: 120, invalidation_price: 90 },
    }));
    state = advancePaperTrading(state, market(T2, { best_ask: 100, asks: [{ price: 100, size: 10 }] }));
    state = placePaperOrder(state, order({
      side: "sell",
      limit_price: 110,
      quote_notional_usd: 110,
      submitted_at: T3,
    }));
    state = advancePaperTrading(state, market(T4, {
      best_bid: 100,
      best_ask: 101,
      bids: [{ price: 100, size: 10 }],
      asks: [{ price: 101, size: 10 }],
      trades: [
        { price: 111, side: "buy", time: Date.parse(T3) + 100, size: 1 },
        { price: 121, side: "buy", time: Date.parse(T3) + 500, size: 1 },
      ],
    }));

    expect(state.positions[0]).toMatchObject({ quantity_base: 0, realized_pnl_gross_usd: 11 });
    expect(state.orders.find((item) => item.submitted_at === T3)?.status).toBe("filled");
    expect(state.orders.filter((item) => item.oco_group_id).every((item) => item.status === "cancelled")).toBe(true);
  });

  it("plans attached OCO exits inside the frame without reusing consumed prints", () => {
    let state = placePaperOrder(baseState(), order({
      attached_oco: { target_price: 110, invalidation_price: 90 },
    }));
    state = placePaperOrder(state, order({
      limit_price: 120,
      reference_price: 120,
      quote_notional_usd: 120,
      submitted_at: "2026-08-12T12:00:01.100Z",
    }));
    const trades = [
      { id: "entry", price: 100, side: "sell" as const, time: Date.parse(T1) + 200, size: 1 },
      { id: "target", price: 111, side: "buy" as const, time: Date.parse(T1) + 500, size: 1 },
    ];
    state = advancePaperTrading(state, market(T2, {
      best_bid: 105,
      best_ask: 125,
      bids: [{ price: 105, size: 10 }],
      asks: [{ price: 125, size: 10 }],
      trades,
    }));

    const target = state.orders.find((item) => item.order_kind === "oco_target")!;
    expect(target).toMatchObject({ status: "filled", submitted_at: "2026-08-12T12:00:01.200Z" });
    expect(state.fills.filter((fill) => fill.reference_price === 111)).toHaveLength(1);
    const repeated = advancePaperTrading(state, market(T3, {
      best_bid: 105,
      best_ask: 125,
      bids: [{ price: 105, size: 10 }],
      asks: [{ price: 125, size: 10 }],
      trades,
    }));
    expect(repeated.orders.find((item) => item.order_id === target.order_id)?.status).toBe("filled");
    expect(repeated.fills.filter((fill) => fill.reference_price === 111)).toHaveLength(1);
  });

  it("never reuses a pre-trigger trade to fill a triggered stop-limit", () => {
    let state = placePaperOrder(baseState(), order({
      order_type: "stop_limit",
      limit_price: 104,
      stop_price: 105,
      quote_notional_usd: 104,
    }));
    const preTriggerTrades = [
      { price: 103, side: "sell" as const, time: Date.parse(T1) + 100, size: 1 },
      { price: 106, side: "buy" as const, time: Date.parse(T1) + 500, size: 1 },
    ];
    state = advancePaperTrading(state, market(T2, { best_ask: 106, asks: [{ price: 106, size: 10 }], trades: preTriggerTrades }));
    expect(state.orders[0]).toMatchObject({ status: "pending", triggered_at: "2026-08-12T12:00:01.500Z" });
    state = advancePaperTrading(state, market(T3, { best_ask: 106, asks: [{ price: 106, size: 10 }], trades: preTriggerTrades }));
    expect(state.orders[0].status).toBe("pending");
    state = advancePaperTrading(state, market(T4, {
      best_ask: 106,
      asks: [{ price: 106, size: 10 }],
      trades: [...preTriggerTrades, { price: 104, side: "sell", time: Date.parse(T3) + 100, size: 1 }],
    }));
    expect(state.orders[0]).toMatchObject({ status: "filled", fill_price: 104 });
  });

  it("bounds GTC book fills to displayed depth and retains the remainder", () => {
    let state = placePaperOrder(baseState(), order());
    state = advancePaperTrading(state, market(T2, { asks: [{ price: 100, size: 0.4 }] }));
    expect(state.orders[0]).toMatchObject({ status: "pending", filled_base_size: 0.4, remaining_base_size: 0.6 });
    state = advancePaperTrading(state, market(T3, { asks: [{ price: 100, size: 0.6 }] }));
    expect(state.orders[0]).toMatchObject({ status: "filled", filled_base_size: 1, remaining_base_size: 0 });
    expect(state.fills.map((fill) => fill.base_size)).toEqual([0.6, 0.4]);
  });

  it("accepts a new exact book revision independently of an unchanged aggregate revision", () => {
    let state = advancePaperTrading(
      placePaperOrder(baseState(), order()),
      market(T2, {
        snapshot_id: "aggregate-1",
        book_revision: Date.parse(T1),
        asks: [{ price: 100, size: 0.4 }],
      }),
    );
    state = advancePaperTrading(state, market("2026-08-12T12:00:02.100Z", {
      snapshot_id: "aggregate-1",
      fetched_at: T2,
      book_revision: Date.parse(T2),
      asks: [{ price: 100, size: 0.6 }],
    }));
    expect(state.orders[0]).toMatchObject({ status: "filled", filled_base_size: 1 });
    expect(state.fills.map((fill) => fill.base_size)).toEqual([0.6, 0.4]);
  });

  it("bounds a GTC trade fill to the crossing print size", () => {
    const state = advancePaperTrading(
      placePaperOrder(baseState(), order()),
      market(T2, {
        best_ask: 105,
        asks: [{ price: 105, size: 10 }],
        trades: [{ price: 99, side: "sell", time: Date.parse(T1) + 500, size: 0.25 }],
      }),
    );

    expect(state.orders[0]).toMatchObject({
      status: "pending",
      filled_base_size: 0.25,
      remaining_base_size: 0.75,
    });
    expect(state.fills.map((fill) => fill.base_size)).toEqual([0.25]);
  });

  it("shares one crossing print across competing opposite-side GTC orders", () => {
    let state = placePaperOrder(baseState(), order());
    state = placePaperOrder(state, order({
      side: "sell",
      limit_price: 99,
      submitted_at: "2026-08-12T12:00:01.100Z",
    }));
    state = advancePaperTrading(state, market(T2, {
      best_bid: 98,
      best_ask: 102,
      bids: [{ price: 98, size: 10 }],
      asks: [{ price: 102, size: 10 }],
      trades: [{ price: 100, side: "sell", time: Date.parse(T1) + 500, size: 0.75 }],
    }));

    expect(state.fills.reduce((total, fill) => total + fill.base_size, 0)).toBeCloseTo(0.75);
    expect(state.positions[0].quantity_base).toBeCloseTo(0.75);
    expect(state.orders.reduce((total, item) => total + item.filled_base_size, 0)).toBeCloseTo(0.75);
  });

  it("requires the compatible aggressor side for passive fills", () => {
    let state = placePaperOrder(baseState(), order({
      side: "sell",
      limit_price: 100,
    }));
    state = advancePaperTrading(state, market(T2, {
      best_bid: 98,
      best_ask: 102,
      bids: [{ price: 98, size: 10 }],
      asks: [{ price: 102, size: 10 }],
      trades: [{ id: "sell-aggressor", price: 101, side: "sell", time: Date.parse(T1) + 500, size: 1 }],
    }));
    expect(state.orders[0].status).toBe("pending");
    state = advancePaperTrading(state, market(T3, {
      best_bid: 98,
      best_ask: 102,
      bids: [{ price: 98, size: 10 }],
      asks: [{ price: 102, size: 10 }],
      trades: [
        { id: "sell-aggressor", price: 101, side: "sell", time: Date.parse(T1) + 500, size: 1 },
        { id: "buy-aggressor", price: 101, side: "buy", time: Date.parse(T2) + 500, size: 1 },
      ],
    }));
    expect(state.fills[0]).toMatchObject({ side: "sell", reference_price: 101 });
  });

  it("routes a later competing order to the next chronological unconsumed print", () => {
    let state = placePaperOrder(baseState(), order({ base_size: 0.5, quote_notional_usd: 50 }));
    state = placePaperOrder(state, order({
      base_size: 0.5,
      quote_notional_usd: 50,
      submitted_at: "2026-08-12T12:00:01.100Z",
    }));
    state = advancePaperTrading(state, market(T2, {
      best_ask: 105,
      asks: [{ price: 105, size: 10 }],
      trades: [
        { price: 99, side: "sell", time: Date.parse(T1) + 500, size: 0.5 },
        { price: 98, side: "sell", time: Date.parse(T1) + 700, size: 0.5 },
      ],
    }));

    expect(state.orders.every((item) => item.status === "filled" && item.filled_base_size === 0.5)).toBe(true);
    expect(state.fills.reduce((total, fill) => total + fill.base_size, 0)).toBeCloseTo(1);
    const laterOrder = state.orders.find((item) => item.submitted_at === "2026-08-12T12:00:01.100Z")!;
    expect(state.fills.find((fill) => fill.order_id === laterOrder.order_id)?.reference_price).toBe(98);
  });

  it("fails closed when crossing prints have missing or invalid size", () => {
    const state = advancePaperTrading(
      placePaperOrder(baseState(), order()),
      market(T2, {
        best_ask: 105,
        asks: [{ price: 105, size: 10 }],
        trades: [
          { price: 99, side: "sell", time: Date.parse(T1) + 100 },
          { price: 99, side: "sell", time: Date.parse(T1) + 200, size: 0 },
          { price: 99, side: "sell", time: Date.parse(T1) + 300, size: Number.NaN },
        ],
      }),
    );

    expect(state.orders[0]).toMatchObject({ status: "pending", filled_base_size: 0, remaining_base_size: 1 });
    expect(state.fills).toHaveLength(0);
  });

  it.each([
    ["missing one side", { best_bid: null, best_ask: 100 }],
    ["crossed", { best_bid: 101, best_ask: 100 }],
  ])("fails book execution and mark refresh closed for %s BBO", (_label, quote) => {
    const pending = placePaperOrder(baseState(), order());
    const state = advancePaperTrading(pending, market(T2, {
      ...quote,
      quote_fetched_at: T2,
      book_fetched_at: T2,
      mark_price: 120,
      asks: [{ price: 100, size: 1 }],
    }));

    expect(state.orders[0]).toMatchObject({ status: "pending", filled_base_size: 0 });
    expect(state.fills).toHaveLength(0);
    expect(state.marks).toHaveLength(0);
  });

  it("requires independently fresh quote and book component clocks for book fills", () => {
    const pending = placePaperOrder(baseState(), order());
    const staleQuote = advancePaperTrading(pending, market(T2, {
      quote_fetched_at: STALE,
      book_fetched_at: T2,
      asks: [{ price: 100, size: 1 }],
    }));
    const staleBook = advancePaperTrading(pending, market(T2, {
      quote_fetched_at: T2,
      book_fetched_at: STALE,
      asks: [{ price: 100, size: 1 }],
    }));

    expect(staleQuote.orders[0]).toMatchObject({ status: "pending", filled_base_size: 0 });
    expect(staleQuote.marks).toHaveLength(0);
    expect(staleBook.orders[0]).toMatchObject({ status: "pending", filled_base_size: 0 });
    expect(staleBook.marks[0]).toMatchObject({ mark_price: 99.5, fetched_at: T2 });
  });

  it("records the certified fresh BBO midpoint instead of re-dating an unclocked mark", () => {
    const state = advancePaperTrading(baseState(), market(T2, {
      best_bid: 99,
      best_ask: 101,
      mark_price: 120,
    }));

    expect(state.marks[0]).toMatchObject({ mark_price: 100, fetched_at: T2 });
  });

  it("executes from fresh quote and book clocks despite an old aggregate receipt time", () => {
    const state = advancePaperTrading(
      placePaperOrder(baseState(), order()),
      market(T2, {
        fetched_at: "2026-08-12T11:00:00.000Z",
        quote_fetched_at: T2,
        book_fetched_at: T2,
        asks: [{ price: 100, size: 1 }],
      }),
    );

    expect(state.orders[0]).toMatchObject({ status: "filled", filled_base_size: 1 });
    expect(state.marks[0]).toMatchObject({ mark_price: 99.5, fetched_at: T2 });
  });

  it("restores a mark from a fresh quote clock despite an old aggregate receipt time", () => {
    let state = advancePaperTrading(
      placePaperOrder(baseState(), order()),
      market(T2, { asks: [{ price: 100, size: 1 }] }),
    );
    state = restorePaperTradingMark(state, market(T3, {
      fetched_at: "2026-08-12T11:00:00.000Z",
      quote_fetched_at: T3,
      book_fetched_at: null,
      best_bid: 109,
      best_ask: 111,
      bids: [],
      asks: [],
    }));

    expect(state.marks[0]).toMatchObject({ mark_price: 110, fetched_at: T3, observed_at: T3 });
    expect(state.fills).toHaveLength(1);
  });

  it("refreshes an unchanged-price mark when an explicit snapshot carries a newer quote clock", () => {
    let state = advancePaperTrading(baseState(), market(T2, {
      snapshot_id: "stable-aggregate",
      book_revision: Date.parse(T1),
    }));
    expect(state.marks[0]?.fetched_at).toBe(T2);

    state = advancePaperTrading(state, market(T3, {
      snapshot_id: "stable-aggregate",
      fetched_at: "2026-08-12T11:00:00.000Z",
      quote_fetched_at: T3,
      book_fetched_at: T2,
      book_revision: Date.parse(T1),
    }));

    expect(state.marks[0]).toMatchObject({ mark_price: 99.5, fetched_at: T3, observed_at: T3 });
  });

  it("keeps independently timestamped sized trade fills available when quote and book components are stale", () => {
    const state = advancePaperTrading(
      placePaperOrder(baseState(), order()),
      market(T2, {
        quote_fetched_at: STALE,
        book_fetched_at: STALE,
        best_bid: null,
        best_ask: null,
        bids: [],
        asks: [],
        trades: [{ id: "fresh-sized-print", price: 99, side: "sell", time: Date.parse(T1) + 500, size: 1 }],
      }),
    );

    expect(state.orders[0]).toMatchObject({ status: "filled", filled_base_size: 1 });
    expect(state.fills).toHaveLength(1);
    expect(state.marks).toHaveLength(0);
  });

  it("does not reuse a crossing print repeated by a later frame", () => {
    const repeatedPrint = { price: 99, side: "sell" as const, time: Date.parse(T1) + 500, size: 0.25 };
    let state = advancePaperTrading(
      placePaperOrder(baseState(), order()),
      market(T2, { best_ask: 105, asks: [{ price: 105, size: 10 }], trades: [repeatedPrint] }),
    );
    const firstFill = state.fills[0];
    state = advancePaperTrading(state, market(T3, {
      best_ask: 105,
      asks: [{ price: 105, size: 10 }],
      trades: [repeatedPrint],
    }));

    expect(state.orders[0]).toMatchObject({ status: "pending", filled_base_size: 0.25, remaining_base_size: 0.75 });
    expect(state.fills).toEqual([firstFill]);
  });

  it("accepts a distinct exact-ID print at the same timestamp and fetched revision", () => {
    const at = Date.parse(T1) + 500;
    let state = advancePaperTrading(
      placePaperOrder(baseState(), order()),
      market(T2, {
        snapshot_id: "revision-1",
        best_ask: 105,
        asks: [{ price: 105, size: 10 }],
        trades: [{ id: "trade-1", price: 99, side: "sell", time: at, size: 0.25 }],
      }),
    );
    state = advancePaperTrading(state, market(T2, {
      snapshot_id: "revision-2",
      fetched_at: T2,
      best_ask: 105,
      asks: [{ price: 105, size: 10 }],
      trades: [
        { id: "trade-2", price: 98, side: "sell", time: at, size: 0.25 },
        { id: "trade-1", price: 99, side: "sell", time: at, size: 0.25 },
      ],
    }));

    expect(state.orders[0].filled_base_size).toBe(0.5);
    expect(state.fills.map((fill) => fill.reference_price)).toEqual([98, 99]);
  });

  it("does not let an order consume an ambiguous print at its submission instant", () => {
    const state = advancePaperTrading(
      placePaperOrder(baseState(), order()),
      market(T2, {
        best_ask: 105,
        asks: [{ price: 105, size: 10 }],
        trades: [{ id: "same-instant", price: 99, side: "sell", time: Date.parse(T1), size: 1 }],
      }),
    );
    expect(state.orders[0]).toMatchObject({ status: "pending", filled_base_size: 0 });
  });

  it("does not consume the same immutable book snapshot twice", () => {
    const snapshot = market(T2, {
      snapshot_id: "immutable-book-1",
      asks: [{ price: 100, size: 0.4 }],
    });
    const state = advancePaperTrading(placePaperOrder(baseState(), order()), snapshot);
    const repeated = advancePaperTrading(state, {
      ...snapshot,
      observed_at: "2026-08-12T12:00:02.100Z",
    });
    expect(repeated).toBe(state);
    expect(repeated.orders[0].filled_base_size).toBe(0.4);
  });

  it("processes a new aggregate revision without replenishing an unchanged exact book revision", () => {
    const bookRevision = Date.parse(T1);
    let state = advancePaperTrading(
      placePaperOrder(baseState(), order()),
      market(T2, { book_revision: bookRevision, asks: [{ price: 100, size: 0.4 }] }),
    );
    state = advancePaperTrading(state, market(T3, {
      book_revision: bookRevision,
      asks: [{ price: 100, size: 0.4 }],
      mark_price: 101,
      trades: [{ id: "unrelated", price: 105, side: "buy", time: Date.parse(T2) + 500, size: 1 }],
    }));
    expect(state.orders[0].filled_base_size).toBe(0.4);
    expect(state.fills).toHaveLength(1);
    expect(state.market_cursors["hyperliquid:mainnet:BTC-PERP"]).toMatchObject({
      snapshot_fetched_at: T3,
      book_snapshot_id: `hyperliquid:mainnet:BTC-PERP:book:revision:${bookRevision}`,
    });
  });

  it("consumes one shared depth ledger across competing FOK orders", () => {
    let state = placePaperOrder(baseState(), order({ order_type: "market", time_in_force: "FOK", limit_price: null }));
    state = placePaperOrder(state, order({
      order_type: "market",
      time_in_force: "FOK",
      limit_price: null,
      submitted_at: "2026-08-12T12:00:01.100Z",
    }));
    state = advancePaperTrading(state, market(T2, { asks: [{ price: 100, size: 1 }] }));

    expect(state.fills).toHaveLength(1);
    expect(state.positions[0].quantity_base).toBe(1);
    expect(state.orders.filter((item) => item.status === "filled")).toHaveLength(1);
    expect(state.orders.find((item) => item.status === "cancelled")?.cancel_reason).toBe("fok_not_fillable");
  });

  it("keeps FOK all-or-none when an earlier fill reduces available position", () => {
    let state = placePaperOrder(baseState(), order({ order_type: "market", time_in_force: "IOC", limit_price: null }));
    state = advancePaperTrading(state, market(T2, { asks: [{ price: 100, size: 1 }] }));
    state = placePaperOrder(state, order({
      side: "sell",
      limit_price: 100,
      quote_notional_usd: 50,
      base_size: 0.5,
      reduce_only: true,
      submitted_at: T3,
    }));
    state = placePaperOrder(state, order({
      side: "sell",
      order_type: "market",
      time_in_force: "FOK",
      limit_price: null,
      reduce_only: true,
      submitted_at: "2026-08-12T12:00:03.100Z",
    }));
    state = advancePaperTrading(state, market(T4, { best_bid: 100, best_ask: 101, bids: [{ price: 100, size: 1.5 }] }));

    const fok = state.orders.find((item) => item.time_in_force === "FOK" && item.reduce_only)!;
    expect(fok).toMatchObject({ status: "cancelled", filled_base_size: 0, remaining_base_size: 1 });
    expect(state.positions[0].quantity_base).toBe(0.5);
  });

  it("rejects equal and older observations per instrument idempotently", () => {
    let state = placePaperOrder(baseState(), order({ limit_price: 90 }));
    state = advancePaperTrading(state, market(T5, { best_ask: 100, asks: [{ price: 100, size: 10 }] }));
    const equal = advancePaperTrading(state, market(T5, { best_ask: 100, asks: [{ price: 100, size: 10 }] }));
    const older = advancePaperTrading(state, market(T4, { best_ask: 80, asks: [{ price: 80, size: 10 }] }));

    expect(equal).toBe(state);
    expect(older).toBe(state);
    expect(state.orders[0].status).toBe("pending");
    expect(state.updated_at).toBe(T5);

    const olderOtherInstrument = advancePaperTrading(state, market(T4, { product: "ETH-PERP" }));
    expect(olderOtherInstrument.updated_at).toBe(T5);
    expect(olderOtherInstrument.observation_times["hyperliquid:mainnet:ETH-PERP"]).toBe(T4);
  });

  it("reserves attached OCO fan-out against the open-order policy", () => {
    let state = createPaperTradingState({
      now: T0,
      assumptions: { fee_bps: 0, slippage_bps: 0 },
      riskPolicy: { max_open_orders: 2 },
    });
    state = placePaperOrder(state, order({ attached_oco: { target_price: 120, invalidation_price: 90 } }));
    expect(() => placePaperOrder(state, order({
      product: "ETH-PERP",
      submitted_at: "2026-08-12T12:00:01.100Z",
    }))).toThrow("max_open_orders");
    state = advancePaperTrading(state, market(T2, { asks: [{ price: 100, size: 10 }] }));
    expect(state.orders.filter((item) => item.status === "pending")).toHaveLength(2);
  });

  it("retains a bounded, referentially closed history beyond the activity cap", () => {
    const startedAt = Date.parse(T0);
    const iso = (offsetMs: number) => new Date(startedAt + offsetMs).toISOString();
    let state = baseState();
    for (let index = 0; index < 526; index += 1) {
      const submittedAt = iso((index + 1) * 2_000);
      const observedAt = iso((index + 1) * 2_000 + 1_000);
      state = placePaperOrder(state, order({
        side: index % 2 === 0 ? "buy" : "sell",
        order_type: "market",
        time_in_force: "IOC",
        limit_price: null,
        submitted_at: submittedAt,
      }));
      state = advancePaperTrading(state, market(observedAt, {
        book_revision: Date.parse(observedAt),
        best_bid: 99.999,
        best_ask: 100,
        bids: [{ price: 99.999, size: 10 }],
        asks: [{ price: 100, size: 10 }],
      }));
    }

    expect(state.orders).toHaveLength(500);
    expect(state.fills).toHaveLength(500);
    expect(state.fills.every((fill) => state.orders.some((order) => order.order_id === fill.order_id))).toBe(true);
    expect(deriveTerminalPaperExecutionAnalytics(state)).toMatchObject({ fillCount: 500, qualityDataComplete: true });
    expect(parsePaperTradingState(serializePaperTradingState(state))).toEqual(state);

    const pendingAt = iso(1_056_000);
    state = placePaperOrder(state, order({
      limit_price: 90,
      submitted_at: pendingAt,
      attached_oco: { target_price: 120, invalidation_price: 80 },
    }));
    const replacedId = state.orders[0].order_id;
    state = replacePaperOrder(state, replacedId, { limit_price: 100 }, iso(1_056_500));
    const replacement = state.orders.find((item) => item.status === "pending")!;
    expect(replacement.replaces_order_id).toBe(replacedId);
    expect(state.orders.find((item) => item.order_id === replacedId)?.replaced_by_order_id).toBe(replacement.order_id);

    state = advancePaperTrading(state, market(iso(1_057_000), {
      book_revision: startedAt + 1_057_000,
      best_bid: 99.999,
      best_ask: 100,
      bids: [{ price: 99.999, size: 10 }],
      asks: [{ price: 100, size: 10 }],
    }));
    const exits = state.orders.filter((item) => item.oco_group_id != null);
    expect(exits).toHaveLength(2);
    expect(exits.every((item) => item.parent_order_id === replacement.order_id)).toBe(true);
    expect(exits[0].oco_sibling_order_id).toBe(exits[1].order_id);
    expect(exits[1].oco_sibling_order_id).toBe(exits[0].order_id);
    expect(state.orders.length).toBeLessThanOrEqual(500);
    expect(state.fills.length).toBeLessThanOrEqual(500);
    expect(state.fills.every((fill) => state.orders.some((item) => item.order_id === fill.order_id))).toBe(true);
    expect(deriveTerminalPaperExecutionAnalytics(state).qualityDataComplete).toBe(true);
    expect(parsePaperTradingState(serializePaperTradingState(state))).toEqual(state);

    state = advancePaperTrading(state, market(iso(1_058_000), {
      book_revision: startedAt + 1_058_000,
      best_bid: 121,
      best_ask: 122,
      mark_price: 121,
      bids: [{ price: 121, size: 10 }],
      asks: [{ price: 122, size: 10 }],
    }));
    expect(state.positions[0].quantity_base).toBe(0);
    expect(parsePaperTradingState(serializePaperTradingState(state))).toEqual(state);
    expect(deriveTerminalPaperExecutionAnalytics(state).qualityDataComplete).toBe(true);
  }, 15_000);

  it("rejects persisted identity, sequence, fill, position, and lineage corruption", () => {
    const state = placePaperOrder(baseState(), order());
    const mutate = (apply: (value: Record<string, unknown>) => void) => {
      const value = JSON.parse(serializePaperTradingState(state)) as Record<string, unknown>;
      apply(value);
      return parsePaperTradingState(JSON.stringify(value));
    };
    expect(mutate((value) => { value.next_sequence = 1; })).toBeNull();
    expect(mutate((value) => {
      value.orders = [...(value.orders as unknown[]), ...(value.orders as unknown[])];
    })).toBeNull();
    expect(mutate((value) => {
      value.fills = [{
        fill_id: "paper-fill-00000099",
        order_id: "paper-order-99999999",
        venue_id: "hyperliquid",
        network: "mainnet",
        product: "BTC-PERP",
        side: "buy",
        base_size: 1,
        reference_price: 100,
        fill_price: 100,
        notional_usd: 100,
        fee_usd: 0,
        fee_bps: 0,
        slippage_bps: 0,
        realized_pnl_gross_usd: 0,
        filled_at: T2,
      }];
    })).toBeNull();
    expect(mutate((value) => {
      value.positions = [{
        position_key: "bogus",
        venue_id: "hyperliquid",
        network: "mainnet",
        product: "BTC-PERP",
        quantity_base: 1,
        average_entry_price: 100,
        realized_pnl_gross_usd: 0,
        fees_paid_usd: 0,
        opened_at: T1,
        updated_at: T2,
      }];
    })).toBeNull();
    expect(mutate((value) => {
      (value.orders as Array<Record<string, unknown>>)[0].replaced_by_order_id = "paper-order-99999999";
    })).toBeNull();

    let replayGuarded = placePaperOrder(baseState(), order({
      quote_notional_usd: 200,
      base_size: 2,
    }));
    replayGuarded = advancePaperTrading(replayGuarded, market(T2, {
      book_revision: 1,
      asks: [{ price: 100, size: 1 }],
    }));
    const corruptReplayGuard = (apply: (value: Record<string, unknown>) => void) => {
      const value = JSON.parse(serializePaperTradingState(replayGuarded)) as Record<string, unknown>;
      apply(value);
      return parsePaperTradingState(JSON.stringify(value));
    };
    expect(corruptReplayGuard((value) => { delete value.observation_times; })).toBeNull();
    expect(corruptReplayGuard((value) => { delete value.market_cursors; })).toBeNull();
    expect(corruptReplayGuard((value) => {
      const cursors = value.market_cursors as Record<string, Record<string, unknown>>;
      for (const cursor of Object.values(cursors)) delete cursor.book_snapshot_id;
    })).toBeNull();
    expect(corruptReplayGuard((value) => {
      const fill = (value.fills as Array<Record<string, unknown>>)[0];
      fill.notional_usd = Number(fill.notional_usd) + 1;
    })).toBeNull();
    expect(corruptReplayGuard((value) => {
      const fill = (value.fills as Array<Record<string, unknown>>)[0];
      fill.fee_usd = Number(fill.fee_usd) + 1;
    })).toBeNull();

    const legacyV4 = JSON.parse(serializePaperTradingState(state)) as Record<string, unknown>;
    legacyV4.version = 4;
    delete legacyV4.observation_times;
    delete legacyV4.market_cursors;
    expect(parsePaperTradingState(JSON.stringify(legacyV4))).toMatchObject({ observation_times: {}, market_cursors: {} });
  });

  it("migrates a v4 cursor without replenishing its last consumed book", () => {
    let state = advancePaperTrading(
      placePaperOrder(baseState(), order()),
      market(T2, {
        snapshot_id: "legacy-aggregate-1",
        book_revision: Date.parse(T2),
        asks: [{ price: 100, size: 0.4 }],
      }),
    );
    expect(state.orders[0].filled_base_size).toBe(0.4);

    const legacyV4 = JSON.parse(serializePaperTradingState(state)) as Record<string, unknown>;
    legacyV4.version = 4;
    const cursors = legacyV4.market_cursors as Record<string, Record<string, unknown>>;
    for (const cursor of Object.values(cursors)) delete cursor.book_snapshot_id;
    state = parsePaperTradingState(JSON.stringify(legacyV4)) as PaperTradingState;

    state = advancePaperTrading(state, market("2026-08-12T12:00:02.100Z", {
      snapshot_id: "legacy-aggregate-1-replayed",
      fetched_at: T2,
      quote_fetched_at: T2,
      book_fetched_at: T2,
      book_revision: Date.parse(T2),
      asks: [{ price: 100, size: 0.4 }],
    }));
    expect(state.orders[0]).toMatchObject({ status: "pending", filled_base_size: 0.4, remaining_base_size: 0.6 });
    expect(state.fills).toHaveLength(1);

    state = advancePaperTrading(state, market(T3, {
      snapshot_id: "legacy-aggregate-2",
      quote_fetched_at: T3,
      book_fetched_at: T3,
      book_revision: Date.parse(T3),
      asks: [{ price: 100, size: 0.6 }],
    }));
    expect(state.orders[0]).toMatchObject({ status: "filled", filled_base_size: 1, remaining_base_size: 0 });
    expect(state.fills).toHaveLength(2);
  });
});

function baseState(): PaperTradingState {
  return createPaperTradingState({
    now: T0,
    assumptions: { fee_bps: 0, slippage_bps: 0 },
    riskPolicy: { max_order_notional_usd: 1_000, max_position_notional_usd: 10_000, max_open_orders: 20 },
  });
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
    reference_price: 100,
    quote_notional_usd: 100,
    base_size: 1,
    submitted_at: T1,
    ...overrides,
  };
}

function market(at: string, overrides: Partial<PaperMarketObservation> = {}): PaperMarketObservation {
  return {
    venue_id: "hyperliquid",
    network: "mainnet",
    product: "BTC-PERP",
    market_state: "live",
    fetched_at: at,
    observed_at: at,
    quote_fetched_at: at,
    book_fetched_at: at,
    max_age_ms: 5_000,
    best_bid: 99,
    best_ask: 100,
    mark_price: 100,
    bids: [{ price: 99, size: 10 }],
    asks: [{ price: 100, size: 10 }],
    trades: [],
    ...overrides,
  };
}
