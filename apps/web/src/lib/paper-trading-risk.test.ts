import { describe, expect, it } from "vitest";
import {
  activatePaperKillSwitch,
  advancePaperTrading,
  createPaperTradingState,
  defaultPaperRiskPolicy,
  evaluatePaperOrderRisk,
  parsePaperTradingState,
  placePaperLimitOrder,
  placePaperOrder,
  rearmPaperRiskControl,
  resetPaperTradingState,
  serializePaperTradingState,
  updatePaperRiskPolicy,
  type PaperLimitOrderInput,
  type PaperMarketObservation,
  type PaperTradingState,
} from "./paper-trading-engine";

const T0 = "2026-08-12T12:00:00.000Z";
const T1 = "2026-08-12T12:00:01.000Z";
const T2 = "2026-08-12T12:00:02.000Z";
const T3 = "2026-08-12T12:00:03.000Z";
const T4 = "2026-08-12T12:00:04.000Z";
const T5 = "2026-08-12T12:00:05.000Z";

describe("paper trading risk policy", () => {
  it("starts armed with conservative equity-relative limits and explains oversize orders", () => {
    const state = createPaperTradingState({ now: T0 });
    expect(state.risk_policy).toEqual({
      max_order_notional_usd: 500,
      max_position_notional_usd: 1_000,
      max_open_orders: 5,
      max_session_loss_usd: 200,
      max_drawdown_usd: 300,
    });
    expect(defaultPaperRiskPolicy(100)).toMatchObject({
      max_order_notional_usd: 5,
      max_position_notional_usd: 10,
      max_session_loss_usd: 2,
      max_drawdown_usd: 3,
    });

    const decision = evaluatePaperOrderRisk(state, order({ quote_notional_usd: 501, base_size: 5.01 }));
    expect(decision).toMatchObject({ allowed: false, code: "max_order_notional" });
    expect(decision.message).toBe("Order notional $501.00 exceeds the $500.00 PAPER order limit.");
    expect(() => placePaperLimitOrder(state, order({ quote_notional_usd: 501, base_size: 5.01 })))
      .toThrow("max_order_notional: Order notional $501.00 exceeds");
  });

  it("blocks projected position stacking before resting limits can bypass the cap", () => {
    let state = withPolicy({
      max_order_notional_usd: 125,
      max_position_notional_usd: 150,
      max_open_orders: 5,
    });
    state = placePaperLimitOrder(state, order({ quote_notional_usd: 100, base_size: 1 }));
    const decision = evaluatePaperOrderRisk(state, order({ submitted_at: T2, quote_notional_usd: 100, base_size: 1 }));

    expect(decision).toMatchObject({ allowed: false, code: "max_position_notional" });
    expect(decision.metrics.projected_position_notional_usd).toBe(200);
    expect(decision.message).toContain("Projected BTC-PERP position $200.00 exceeds the $150.00");
  });

  it("enforces the global resting-order count with an actionable rejection", () => {
    let state = withPolicy({
      max_order_notional_usd: 100,
      max_position_notional_usd: 1_000,
      max_open_orders: 1,
    });
    state = placePaperLimitOrder(state, order({ quote_notional_usd: 50, base_size: 0.5 }));
    const decision = evaluatePaperOrderRisk(state, order({
      product: "ETH-PERP",
      quote_notional_usd: 50,
      base_size: 0.5,
      submitted_at: T2,
    }));

    expect(decision).toMatchObject({ allowed: false, code: "max_open_orders" });
    expect(decision.message).toBe("1 resting PAPER orders plus 1 required slot would exceed the 1-order limit.");
  });

  it("kills locally, cancels pending orders, and requires confirmed re-arm", () => {
    const pending = placePaperLimitOrder(createPaperTradingState({ now: T0 }), order());
    const killed = activatePaperKillSwitch(pending, T2);

    expect(killed.risk_control).toMatchObject({ status: "killed", reason: "kill_switch", triggered_at: T2 });
    expect(killed.orders[0]).toMatchObject({ status: "cancelled", cancelled_at: T2 });
    expect(evaluatePaperOrderRisk(killed, order({ submitted_at: T3 }))).toMatchObject({ allowed: false, code: "kill_switch" });
    expect(() => rearmPaperRiskControl(killed, { confirmed: false, rearmed_at: T3 }))
      .toThrow("paper_risk_rearm_confirmation_required");

    const rearmed = rearmPaperRiskControl(killed, { confirmed: true, rearmed_at: T3 });
    expect(rearmed.risk_control).toMatchObject({
      status: "armed",
      reason: null,
      session_started_at: T3,
      session_start_equity_usd: 10_000,
    });
    expect(evaluatePaperOrderRisk(rearmed, order({ submitted_at: T4 })).allowed).toBe(true);

    expect(() => resetPaperTradingState(killed, T4, { confirmed: false })).toThrow("paper_reset_confirmation_required");
    const reset = resetPaperTradingState(killed, T4, { confirmed: true });
    expect(reset).toMatchObject({
      risk_policy: killed.risk_policy,
      risk_control: { status: "armed", session_started_at: T4 },
      orders: [],
    });
  });

  it("latches the session-loss breaker and cancels exposure-increasing resting orders", () => {
    let state = withPolicy({
      max_order_notional_usd: 500,
      max_position_notional_usd: 1_000,
      max_open_orders: 5,
      max_session_loss_usd: 5,
      max_drawdown_usd: 1_000,
    });
    state = placePaperLimitOrder(state, order());
    state = advancePaperTrading(state, market({ best_ask: 100, mark_price: 100, observed_at: T2, fetched_at: T2 }));
    state = placePaperLimitOrder(state, order({ limit_price: 80, quote_notional_usd: 80, base_size: 1, submitted_at: T3 }));
    state = advancePaperTrading(state, market({ best_bid: 89, best_ask: 90, mark_price: 90, observed_at: T4, fetched_at: T4 }));

    expect(state.risk_control).toMatchObject({ status: "tripped", reason: "session_loss_limit", last_equity_usd: 9_989.5 });
    expect(state.risk_control.message).toContain("session loss $10.50 reached the $5.00 stop");
    expect(state.orders.find((item) => item.limit_price === 80)?.status).toBe("cancelled");
    expect(state.journal[0].event_type).toBe("risk_control_tripped");
  });

  it("trips before a gap-through stop, cancels entries, and still fills the protective exit", () => {
    let state = withPolicy({
      max_order_notional_usd: 500,
      max_position_notional_usd: 1_000,
      max_open_orders: 5,
      max_session_loss_usd: 5,
      max_drawdown_usd: 1_000,
    });
    state = placePaperLimitOrder(state, order());
    state = advancePaperTrading(state, market({
      best_ask: 100,
      mark_price: 100,
      asks: [{ price: 100, size: 1 }],
      observed_at: T2,
      fetched_at: T2,
    }));
    state = placePaperOrder(state, {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "sell",
      order_type: "stop",
      time_in_force: "GTC",
      stop_price: 95,
      reference_price: 100,
      quote_notional_usd: 100,
      base_size: 1,
      reduce_only: true,
      submitted_at: T3,
    });
    state = placePaperLimitOrder(state, order({
      limit_price: 80,
      quote_notional_usd: 80,
      base_size: 1,
      submitted_at: T3,
    }));

    state = advancePaperTrading(state, market({
      best_bid: 89,
      best_ask: 90,
      mark_price: 90,
      bids: [{ price: 89, size: 2 }],
      trades: [{ price: 90, side: "sell", time: Date.parse(T3) + 500 }],
      observed_at: T4,
      fetched_at: T4,
    }));

    expect(state.risk_control).toMatchObject({ status: "tripped", reason: "session_loss_limit" });
    expect(state.orders.find((item) => item.reduce_only)).toMatchObject({
      status: "filled",
      fill_price: 89,
    });
    expect(state.orders.find((item) => item.limit_price === 80)).toMatchObject({
      status: "cancelled",
      cancel_reason: "risk_control",
    });
    expect(state.positions[0].quantity_base).toBe(0);
    expect(state.risk_control.message).toContain("reduce-only protective exit remains active");
  });

  it("allows only a validated emergency exit while stopped and keeps the latch active", () => {
    let state = withPolicy({
      max_order_notional_usd: 500,
      max_position_notional_usd: 1_000,
      max_open_orders: 5,
      max_session_loss_usd: 5,
      max_drawdown_usd: 1_000,
    });
    state = placePaperLimitOrder(state, order());
    state = advancePaperTrading(state, market({ best_ask: 100, mark_price: 100, observed_at: T2, fetched_at: T2 }));
    state = advancePaperTrading(state, market({ best_bid: 89, best_ask: 90, mark_price: 90, observed_at: T3, fetched_at: T3 }));
    expect(state.risk_control.status).toBe("tripped");

    const emergencyExit = {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "sell" as const,
      order_type: "market" as const,
      time_in_force: "IOC" as const,
      reference_price: 89,
      quote_notional_usd: 89,
      base_size: 1,
      reduce_only: true,
      submitted_at: T4,
    };
    expect(evaluatePaperOrderRisk(state, emergencyExit)).toMatchObject({ allowed: true, code: null });
    expect(evaluatePaperOrderRisk(state, { ...emergencyExit, reduce_only: false })).toMatchObject({
      allowed: false,
      code: "circuit_breaker_tripped",
    });
    expect(() => placePaperOrder(state, { ...emergencyExit, side: "buy" })).toThrow("paper_reduce_only_side_invalid");
    expect(() => placePaperOrder(state, { ...emergencyExit, base_size: 1.01 })).toThrow("paper_reduce_only_size_invalid");
    expect(evaluatePaperOrderRisk(state, {
      ...emergencyExit,
      order_type: "limit",
      time_in_force: "GTC",
      limit_price: 89,
    })).toMatchObject({ allowed: false, code: "circuit_breaker_tripped" });

    state = placePaperOrder(state, emergencyExit);
    state = advancePaperTrading(state, market({
      best_bid: 89,
      best_ask: 90,
      mark_price: 89,
      bids: [{ price: 89, size: 1 }],
      observed_at: T5,
      fetched_at: T5,
    }));
    expect(state.positions[0].quantity_base).toBe(0);
    expect(state.risk_control.status).toBe("tripped");
  });

  it("partially closes against displayed depth without reversing after a manual kill", () => {
    let state = placePaperLimitOrder(withPolicy({
      max_order_notional_usd: 500,
      max_position_notional_usd: 1_000,
      max_open_orders: 5,
    }), order());
    state = advancePaperTrading(state, market({ best_ask: 100, mark_price: 100, observed_at: T2, fetched_at: T2 }));
    state = activatePaperKillSwitch(state, T3);
    state = placePaperOrder(state, {
      venue_id: "hyperliquid",
      network: "mainnet",
      product: "BTC-PERP",
      side: "sell",
      order_type: "market",
      time_in_force: "IOC",
      reference_price: 99,
      quote_notional_usd: 99,
      base_size: 1,
      reduce_only: true,
      submitted_at: T4,
    });
    state = advancePaperTrading(state, market({
      best_bid: 99,
      best_ask: 100,
      mark_price: 99,
      bids: [{ price: 99, size: 0.4 }],
      observed_at: T5,
      fetched_at: T5,
    }));

    expect(state.orders.find((item) => item.order_type === "market" && item.side === "sell")).toMatchObject({
      status: "cancelled",
      filled_base_size: 0.4,
      remaining_base_size: 0.6,
      cancel_reason: "ioc_remainder_cancelled",
    });
    expect(state.positions[0].quantity_base).toBeCloseTo(0.6);
    expect(state.risk_control.status).toBe("killed");
  });

  it("tracks the session peak and trips on drawdown after an unrealized gain", () => {
    let state = withPolicy({
      max_order_notional_usd: 500,
      max_position_notional_usd: 1_000,
      max_open_orders: 5,
      max_session_loss_usd: 1_000,
      max_drawdown_usd: 5,
    });
    state = placePaperLimitOrder(state, order());
    state = advancePaperTrading(state, market({ best_ask: 100, mark_price: 100, observed_at: T2, fetched_at: T2 }));
    state = advancePaperTrading(state, market({ best_bid: 119, best_ask: 120, mark_price: 120, observed_at: T3, fetched_at: T3 }));
    expect(state.risk_control.session_peak_equity_usd).toBe(10_019.5);
    state = advancePaperTrading(state, market({ best_bid: 109, best_ask: 110, mark_price: 110, observed_at: T4, fetched_at: T4 }));

    expect(state.risk_control).toMatchObject({ status: "tripped", reason: "max_drawdown_limit", last_equity_usd: 10_009.5 });
    expect(state.risk_control.message).toContain("drawdown $10.00 reached the $5.00 stop");
  });

  it("re-arms from current equity as a new deliberate risk session", () => {
    let state = withPolicy({
      max_order_notional_usd: 500,
      max_position_notional_usd: 1_000,
      max_open_orders: 5,
      max_session_loss_usd: 5,
      max_drawdown_usd: 1_000,
    });
    state = placePaperLimitOrder(state, order());
    state = advancePaperTrading(state, market({ best_ask: 100, mark_price: 100, observed_at: T2, fetched_at: T2 }));
    state = advancePaperTrading(state, market({ best_bid: 89, best_ask: 90, mark_price: 90, observed_at: T3, fetched_at: T3 }));
    const rearmed = rearmPaperRiskControl(state, { confirmed: true, rearmed_at: T4 });

    expect(rearmed.risk_control).toMatchObject({
      status: "armed",
      session_start_equity_usd: 9_989.5,
      session_peak_equity_usd: 9_989.5,
      last_equity_usd: 9_989.5,
    });
    const retripped = advancePaperTrading(rearmed, market({ best_bid: 83, best_ask: 84, mark_price: 84, observed_at: T5, fetched_at: T5 }));
    expect(retripped.risk_control).toMatchObject({ status: "tripped", reason: "session_loss_limit" });
  });

  it("validates policy updates and safely migrates or rejects persisted state", () => {
    const state = createPaperTradingState({ now: T0 });
    const updated = updatePaperRiskPolicy(state, {
      max_order_notional_usd: 200,
      max_position_notional_usd: 400,
      max_open_orders: 2,
    }, T1);
    expect(updated.risk_policy).toMatchObject({ max_order_notional_usd: 200, max_position_notional_usd: 400, max_open_orders: 2 });
    expect(updated.journal[0].event_type).toBe("risk_policy_updated");
    expect(() => updatePaperRiskPolicy(updated, { max_position_notional_usd: 100 }, T2)).toThrow("paper_risk_policy_invalid");

    const legacy = JSON.parse(serializePaperTradingState(state)) as Record<string, unknown>;
    legacy.version = 1;
    delete legacy.risk_policy;
    delete legacy.risk_control;
    const migrated = parsePaperTradingState(JSON.stringify(legacy));
    expect(migrated).toMatchObject({ version: 5, risk_control: { status: "armed" }, oco_defaults: { enabled: false } });

    const tampered = JSON.parse(serializePaperTradingState(updated)) as PaperTradingState;
    tampered.risk_policy.max_open_orders = 0;
    expect(parsePaperTradingState(JSON.stringify(tampered))).toBeNull();
  });
});

function withPolicy(policy: Partial<PaperTradingState["risk_policy"]>) {
  return createPaperTradingState({
    now: T0,
    assumptions: { fee_bps: 0, slippage_bps: 0 },
    riskPolicy: policy,
  });
}

function order(overrides: Partial<PaperLimitOrderInput> = {}): PaperLimitOrderInput {
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
