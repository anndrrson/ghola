import { describe, expect, it } from "vitest";
import {
  activatePaperKillSwitch,
  advancePaperTrading,
  createPaperTradingState,
  evaluatePaperOrderRisk,
  paperAccountSummary,
  placePaperOrder,
  type PaperMarketObservation,
  type PaperTradingState,
} from "./paper-trading-engine";

const T0 = "2026-08-12T12:00:00.000Z";
const T1 = "2026-08-12T12:00:01.000Z";
const T2 = "2026-08-12T12:00:02.000Z";
const T3 = "2026-08-12T12:00:03.000Z";
const T4 = "2026-08-12T12:00:04.000Z";
const T5 = "2026-08-12T12:00:05.000Z";
const T6 = "2026-08-12T12:00:06.000Z";
const T20 = "2026-08-12T12:00:20.000Z";
const T21 = "2026-08-12T12:00:21.000Z";

describe("paper portfolio mark freshness", () => {
  it("prices only fresh marks and exposes mixed stale portfolio truth", () => {
    const state = twoOpenMarkets();
    const summary = paperAccountSummary(state, {}, { now: T6, maxAgeMs: 2_000 });

    expect(summary).toMatchObject({
      portfolio_fully_priced: false,
      open_position_count: 2,
      fresh_mark_count: 1,
      stale_mark_count: 1,
      unpriced_position_count: 1,
      unrealized_pnl_usd: 9.5,
      net_pnl_usd: 9.5,
      equity_usd: 10_009.5,
      marks_as_of: T6,
      mark_max_age_ms: 2_000,
    });
    expect(summary.marked_positions.find((position) => position.product === "BTC-PERP")).toMatchObject({
      mark_price: 99.5,
      mark_age_ms: 4_000,
      mark_status: "stale",
      unrealized_pnl_usd: null,
      market_value_usd: null,
    });
    expect(summary.marked_positions.find((position) => position.product === "ETH-PERP")).toMatchObject({
      mark_price: 209.5,
      mark_age_ms: 1_000,
      mark_status: "fresh",
      unrealized_pnl_usd: 9.5,
    });
  });

  it("classifies missing and future marks as unpriced", () => {
    const state = twoOpenMarkets();
    const missing: PaperTradingState = {
      ...state,
      marks: state.marks.filter((mark) => mark.product !== "BTC-PERP"),
    };
    expect(paperAccountSummary(missing, {}, { now: T6, maxAgeMs: 10_000 })).toMatchObject({
      portfolio_fully_priced: false,
      missing_mark_count: 1,
      unpriced_position_count: 1,
    });

    const future: PaperTradingState = {
      ...state,
      marks: state.marks.map((mark) => mark.product === "BTC-PERP" ? {
        ...mark,
        fetched_at: T20,
        observed_at: T20,
      } : mark),
    };
    const futureSummary = paperAccountSummary(future, {}, { now: T6, maxAgeMs: 10_000 });
    expect(futureSummary).toMatchObject({ future_mark_count: 1, unpriced_position_count: 1 });
    expect(futureSummary.marked_positions.find((position) => position.product === "BTC-PERP")?.mark_status).toBe("future");
  });

  it("cannot bypass stale-mark risk with an old submitted timestamp", () => {
    const state = openMarket(createState(), "BTC-PERP", 100, T1, T2);
    const backdated = {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "ETH-PERP",
      side: "buy" as const,
      order_type: "limit" as const,
      time_in_force: "GTC" as const,
      limit_price: 200,
      reference_price: 200,
      quote_notional_usd: 200,
      base_size: 1,
      submitted_at: T0,
    };
    expect(evaluatePaperOrderRisk(state, backdated, { now: T20, maxAgeMs: 1_000 })).toMatchObject({
      allowed: false,
      code: "portfolio_marks_stale",
    });
  });

  it("blocks new exposure on stale portfolio marks but preserves a stopped emergency exit", () => {
    let state = openMarket(createState(), "BTC-PERP", 100, T1, T2);
    const entry = {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "ETH-PERP",
      side: "buy" as const,
      order_type: "limit" as const,
      time_in_force: "GTC" as const,
      limit_price: 200,
      reference_price: 200,
      quote_notional_usd: 200,
      base_size: 1,
      submitted_at: T20,
    };
    expect(evaluatePaperOrderRisk(state, entry, { maxAgeMs: 1_000 })).toMatchObject({
      allowed: false,
      code: "portfolio_marks_stale",
      metrics: { portfolio_fully_priced: false, unpriced_position_count: 1 },
    });
    expect(() => placePaperOrder(state, entry, { maxAgeMs: 1_000 })).toThrow("portfolio_marks_stale");

    state = activatePaperKillSwitch(state, T20);
    const emergencyExit = {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "sell" as const,
      order_type: "market" as const,
      time_in_force: "IOC" as const,
      reference_price: 99,
      quote_notional_usd: 99,
      base_size: 1,
      reduce_only: true,
      submitted_at: T21,
    };
    expect(evaluatePaperOrderRisk(state, emergencyExit, { maxAgeMs: 1_000 })).toMatchObject({ allowed: true, code: null });
    expect(placePaperOrder(state, emergencyExit, { maxAgeMs: 1_000 }).orders[0]).toMatchObject({
      status: "pending",
      reduce_only: true,
    });
  });

  it("ignores missing marks for closed positions", () => {
    let state = openMarket(createState(), "BTC-PERP", 100, T1, T2);
    state = placePaperOrder(state, {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "sell",
      order_type: "market",
      time_in_force: "IOC",
      reference_price: 101,
      quote_notional_usd: 101,
      base_size: 1,
      reduce_only: true,
      submitted_at: T3,
    });
    state = advancePaperTrading(state, market("BTC-PERP", 101, T4, {
      best_bid: 101,
      best_ask: 102,
      bids: [{ price: 101, size: 10 }],
      asks: [{ price: 102, size: 10 }],
    }));
    state = { ...state, marks: [] };

    const summary = paperAccountSummary(state, {}, { now: T20, maxAgeMs: 1_000 });
    expect(summary).toMatchObject({ portfolio_fully_priced: true, open_position_count: 0, unpriced_position_count: 0 });
    expect(summary.marked_positions[0]).toMatchObject({ quantity_base: 0, mark_status: "closed", unrealized_pnl_usd: 0 });
  });
});

function createState() {
  return createPaperTradingState({
    now: T0,
    assumptions: { fee_bps: 0, slippage_bps: 0 },
    riskPolicy: {
      max_order_notional_usd: 10_000,
      max_position_notional_usd: 50_000,
      max_open_orders: 20,
      max_session_loss_usd: 5_000,
      max_drawdown_usd: 5_000,
    },
  });
}

function twoOpenMarkets() {
  let state = openMarket(createState(), "BTC-PERP", 100, T1, T2);
  state = openMarket(state, "ETH-PERP", 200, T3, T4);
  return advancePaperTrading(state, market("ETH-PERP", 210, T5));
}

function openMarket(state: PaperTradingState, product: string, price: number, submittedAt: string, observedAt: string) {
  const placed = placePaperOrder(state, {
    venue_id: "hyperliquid",
    network: "mainnet",
    product,
    side: "buy",
    order_type: "limit",
    time_in_force: "GTC",
    limit_price: price,
    reference_price: price,
    quote_notional_usd: price,
    base_size: 1,
    submitted_at: submittedAt,
  });
  return advancePaperTrading(placed, market(product, price, observedAt));
}

function market(
  product: string,
  price: number,
  observedAt: string,
  overrides: Partial<PaperMarketObservation> = {},
): PaperMarketObservation {
  return {
    venue_id: "hyperliquid",
    network: "mainnet",
    product,
    market_state: "live",
    fetched_at: observedAt,
    observed_at: observedAt,
    quote_fetched_at: overrides.quote_fetched_at === undefined ? overrides.fetched_at ?? observedAt : overrides.quote_fetched_at,
    book_fetched_at: overrides.book_fetched_at === undefined ? overrides.fetched_at ?? observedAt : overrides.book_fetched_at,
    max_age_ms: 30_000,
    best_bid: price - 1,
    best_ask: price,
    mark_price: price,
    bids: [{ price: price - 1, size: 10 }],
    asks: [{ price, size: 10 }],
    trades: [],
    ...overrides,
  };
}
