import { describe, expect, it } from "vitest";
import {
  addPaperJournalNote,
  advancePaperTrading,
  cancelPaperOrder,
  createPaperTradingState,
  exportPaperTradingJournal,
  paperAccountSummary,
  paperTradingStorageKey,
  PAPER_TRADING_GUEST_SCOPE,
  PAPER_TRADING_LEGACY_STORAGE_KEY,
  PAPER_TRADING_STORAGE_KEY,
  parsePaperTradingState,
  placePaperLimitOrder,
  resetPaperTradingState,
  serializePaperTradingState,
  updatePaperTradingAssumptions,
  type PaperMarketObservation,
} from "./paper-trading-engine";

const T0 = "2026-08-12T12:00:00.000Z";
const T1 = "2026-08-12T12:00:01.000Z";
const T2 = "2026-08-12T12:00:02.000Z";

describe("paper trading engine", () => {
  it("derives isolated account and guest storage keys without reusing legacy data", () => {
    const left = `subject_${"a".repeat(32)}`;
    const right = `subject_${"b".repeat(32)}`;
    expect(paperTradingStorageKey(left)).not.toBe(paperTradingStorageKey(right));
    expect(paperTradingStorageKey(PAPER_TRADING_GUEST_SCOPE)).toBe(PAPER_TRADING_STORAGE_KEY);
    expect(PAPER_TRADING_STORAGE_KEY).not.toBe(PAPER_TRADING_LEGACY_STORAGE_KEY);
    expect(paperTradingStorageKey("subject_user-a")).toBeNull();
  });

  it("places a deterministic pending limit order without venue side effects", () => {
    const state = placePaperLimitOrder(createPaperTradingState({ now: T0 }), {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "buy",
      limit_price: 99,
      reference_price: 100,
      quote_notional_usd: 198,
      submitted_at: T1,
    });

    expect(state.orders[0]).toMatchObject({
      order_id: "paper-order-00000001",
      status: "pending",
      base_size: 2,
      arrival_reference_price: 100,
      fill_id: null,
    });
    expect(state.journal[0]).toMatchObject({
      journal_id: "paper-journal-00000002",
      event_type: "order_placed",
    });
    expect(state.mode).toBe("paper");
    expect(parsePaperTradingState(serializePaperTradingState(state))).toEqual(state);
  });

  it("fills once on a fresh ask cross and accounts for slippage and fees", () => {
    const initial = createPaperTradingState({
      now: T0,
      assumptions: { fee_bps: 10, slippage_bps: 10 },
    });
    const placed = placePaperLimitOrder(initial, {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "buy",
      limit_price: 101,
      quote_notional_usd: 101,
      base_size: 1,
      submitted_at: T1,
    });
    const filled = advancePaperTrading(placed, observation({ best_ask: 100, mark_price: 100, observed_at: T2 }));

    expect(filled.orders[0]).toMatchObject({ status: "filled", fill_price: 100.1 });
    expect(filled.fills).toHaveLength(1);
    expect(filled.fills[0].fee_usd).toBeCloseTo(0.1001);
    expect(filled.positions[0]).toMatchObject({ quantity_base: 1, average_entry_price: 100.1 });
    expect(filled.marks[0]).toMatchObject({ product: "BTC-PERP", mark_price: 99.5 });

    const repeated = advancePaperTrading(filled, observation({ best_ask: 99, observed_at: "2026-08-12T12:00:03.000Z" }));
    expect(repeated.fills).toHaveLength(1);
  });

  it("fails closed on stale, fallback, and expired market observations", () => {
    const pending = placePaperLimitOrder(createPaperTradingState({ now: T0 }), {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "buy",
      limit_price: 101,
      quote_notional_usd: 101,
      submitted_at: T1,
    });

    expect(advancePaperTrading(pending, observation({ market_state: "stale" }))).toBe(pending);
    expect(advancePaperTrading(pending, observation({ market_state: "fallback" }))).toBe(pending);
    expect(advancePaperTrading(pending, observation({
      fetched_at: T0,
      observed_at: "2026-08-12T12:00:20.000Z",
      max_age_ms: 5_000,
    }))).toBe(pending);
    expect(pending.orders[0].status).toBe("pending");
  });

  it("cancels only pending orders and never fills them later", () => {
    const pending = placePaperLimitOrder(createPaperTradingState({ now: T0 }), {
      venue_id: "coinbase",
      network: "mainnet",
      product: "BTC-USD",
      side: "sell",
      limit_price: 101,
      quote_notional_usd: 101,
      submitted_at: T1,
    });
    const cancelled = cancelPaperOrder(pending, pending.orders[0].order_id, T2);
    const advanced = advancePaperTrading(cancelled, observation({
      venue_id: "coinbase",
      product: "BTC-USD",
      best_bid: 110,
      observed_at: "2026-08-12T12:00:03.000Z",
    }));

    expect(advanced.orders[0].status).toBe("cancelled");
    expect(advanced.fills).toHaveLength(0);
    expect(() => cancelPaperOrder(cancelled, cancelled.orders[0].order_id, T2)).toThrow("paper_order_not_pending");
  });

  it("closes and reverses a position with exact realized and unrealized P&L", () => {
    let state = createPaperTradingState({ now: T0, assumptions: { fee_bps: 0, slippage_bps: 0 } });
    state = placePaperLimitOrder(state, {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "buy",
      limit_price: 100,
      quote_notional_usd: 200,
      base_size: 2,
      submitted_at: T1,
    });
    state = advancePaperTrading(state, observation({ best_ask: 100, mark_price: 100, observed_at: T2 }));
    state = placePaperLimitOrder(state, {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "sell",
      limit_price: 110,
      quote_notional_usd: 330,
      base_size: 3,
      submitted_at: "2026-08-12T12:00:03.000Z",
    });
    state = advancePaperTrading(state, observation({
      best_bid: 110,
      best_ask: 111,
      mark_price: 105,
      fetched_at: "2026-08-12T12:00:04.000Z",
      observed_at: "2026-08-12T12:00:04.000Z",
    }));

    expect(state.positions[0]).toMatchObject({
      quantity_base: -1,
      average_entry_price: 110,
      realized_pnl_gross_usd: 20,
    });
    expect(state.fills[0].realized_pnl_gross_usd).toBe(20);
    expect(paperAccountSummary(state)).toMatchObject({
      realized_pnl_gross_usd: 20,
      unrealized_pnl_usd: -0.5,
      net_pnl_usd: 19.5,
      equity_usd: 10_019.5,
      fill_count: 2,
    });
  });

  it("uses only post-submission trades to cross a resting order", () => {
    const pending = placePaperLimitOrder(createPaperTradingState({ now: T0 }), {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "buy",
      limit_price: 100,
      quote_notional_usd: 100,
      submitted_at: T1,
    });
    const oldTrade = advancePaperTrading(pending, observation({
      best_ask: 105,
      trades: [{ price: 99, side: "sell", time: Date.parse(T0), size: 1 }],
    }));
    const newTrade = advancePaperTrading(oldTrade, observation({
      best_ask: 105,
      fetched_at: "2026-08-12T12:00:03.000Z",
      observed_at: "2026-08-12T12:00:03.000Z",
      trades: [{ price: 99, side: "sell", time: Date.parse(T2) + 500, size: 1 }],
    }));

    expect(oldTrade.orders[0].status).toBe("pending");
    expect(newTrade.orders[0].status).toBe("filled");
    expect(newTrade.orders[0].fill_price).toBeCloseTo(99.0297);
  });

  it("round-trips local state, exports an explicit warning, journals notes, and resets", () => {
    let state = createPaperTradingState({ now: T0 });
    state = addPaperJournalNote(state, { message: "  Wait for the reclaim.  ", created_at: T1, product: "BTC-PERP" });
    state = updatePaperTradingAssumptions(state, { fee_bps: 4, slippage_bps: 6 }, T2);

    expect(parsePaperTradingState(serializePaperTradingState(state))).toEqual(state);
    const exported = JSON.parse(exportPaperTradingJournal(state, T2)) as {
      warning: string;
      state: typeof state;
    };
    expect(exported.warning).toContain("PAPER SIMULATION ONLY");
    expect(exported.state.journal[0].event_type).toBe("assumptions_updated");
    expect(exported.state.journal[1].message).toBe("Wait for the reclaim.");

    const reset = resetPaperTradingState(state, T2, { confirmed: true });
    expect(reset.orders).toEqual([]);
    expect(reset.journal).toEqual([]);
    expect(reset.assumptions).toEqual({ starting_equity_usd: 10_000, fee_bps: 4, slippage_bps: 6 });
    expect(parsePaperTradingState('{"mode":"live"}')).toBeNull();
  });
});

function observation(overrides: Partial<PaperMarketObservation> = {}): PaperMarketObservation {
  const market: PaperMarketObservation = {
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
    ...market,
    bids: market.bids ?? (market.best_bid == null ? undefined : [{ price: market.best_bid, size: 10 }]),
    asks: market.asks ?? (market.best_ask == null ? undefined : [{ price: market.best_ask, size: 10 }]),
  };
}
