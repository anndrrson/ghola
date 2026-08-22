import assert from "node:assert/strict";
import test from "node:test";
import {
  assessVenueReadiness,
  evaluatePortfolioPlan,
  normalizePortfolioMandate,
  rankExecutionRoutes,
} from "../index.js";

const NOW = 1_800_000_000_000;

function mandate(overrides = {}) {
  return {
    version: 1,
    mandate_id: "mandate:portfolio:1",
    network: "testnet",
    custody_model: "self_custodial_turnkey",
    owner_wallet_id: "turnkey:owner:wallet",
    agent_wallet_id: "turnkey:agent:wallet",
    allowed_venues: ["hyperliquid", "drift", "coinbase_advanced", "jupiter"],
    allowed_assets: ["BTC", "ETH", "SOL"],
    allowed_strategies: ["best_execution", "spot_perp_hedge", "delta_neutral_carry", "exposure_rebalance"],
    configured_leverage_x100: 200,
    max_leverage_x100: 300,
    min_liquidation_distance_bps: 2_000,
    max_gross_exposure_micro_usdc: 100_000_000,
    max_net_exposure_micro_usdc: 25_000_000,
    max_asset_concentration_bps: 7_500,
    max_daily_turnover_micro_usdc: 250_000_000,
    daily_loss_limit_micro_usdc: 10_000_000,
    max_drawdown_micro_usdc: 15_000_000,
    max_drawdown_bps: 1_500,
    max_funding_bps_8h: 100,
    max_basis_bps: 500,
    max_fee_bps: 100,
    max_gas_micro_usdc: 1_000_000,
    max_open_orders: 10,
    max_model_decisions_per_hour: 20,
    max_model_cost_micro_usdc_per_day: 5_000_000,
    data_max_age_ms: 30_000,
    min_expected_net_benefit_bps: 5,
    expires_at_ms: NOW + 3_600_000,
    kill_switch: false,
    reduce_only: false,
    mainnet_activation_id: null,
    ...overrides,
  };
}

function portfolio(overrides = {}) {
  return {
    version: 1,
    as_of_ms: NOW - 500,
    equity_micro_usdc: 200_000_000,
    day_start_equity_micro_usdc: 202_000_000,
    peak_equity_micro_usdc: 205_000_000,
    daily_turnover_micro_usdc: 20_000_000,
    open_order_count: 1,
    model_decisions_last_hour: 2,
    model_cost_today_micro_usdc: 100_000,
    positions: [],
    ...overrides,
  };
}

function venue(venueId, overrides = {}) {
  const capabilities = {
    market_data: true,
    funding: true,
    fees: true,
    quotes: true,
    swap: true,
    orders: true,
    positions: true,
    collateral: true,
    balances: true,
    reconciliation: true,
    delegated_signing: true,
    trade_only_credentials: true,
    cancel: true,
    reduce_only: true,
  };
  return {
    version: 1,
    venue_id: venueId,
    status: "ready",
    as_of_ms: NOW - 250,
    latency_ms: 20,
    capabilities,
    ...overrides,
  };
}

function routeQuote(venueId, overrides = {}) {
  return {
    version: 1,
    venue_id: venueId,
    market: "SOL-USD",
    asset: "SOL",
    side: "buy",
    product_type: "spot",
    operation_class: venueId === "jupiter" ? "swap" : "spot_market_order",
    notional_micro_usdc: 10_000_000,
    available_notional_micro_usdc: 50_000_000,
    execution_price_e8: 10_000_000_000,
    fee_bps: 10,
    slippage_bps: 4,
    funding_bps: 0,
    borrow_bps: 0,
    latency_penalty_bps: 1,
    gas_micro_usdc: 1_000,
    latency_ms: 20,
    as_of_ms: NOW - 100,
    ...overrides,
  };
}

function routeIntent(overrides = {}) {
  return {
    version: 1,
    market: "SOL-USD",
    asset: "SOL",
    side: "buy",
    product_type: "spot",
    notional_micro_usdc: 10_000_000,
    reference_price_e8: 10_000_000_000,
    allowed_venues: ["jupiter", "coinbase_advanced"],
    data_max_age_ms: 30_000,
    max_fee_bps: 100,
    max_slippage_bps: 50,
    max_gas_micro_usdc: 100_000,
    max_latency_ms: 2_000,
    autonomous: true,
    expected_gross_benefit_bps: 40,
    min_expected_net_benefit_bps: 5,
    ...overrides,
  };
}

function carryPlan(overrides = {}) {
  return {
    version: 1,
    plan_id: "plan:carry:0001",
    network: "testnet",
    custody_model: "self_custodial_turnkey",
    owner_wallet_id: "turnkey:owner:wallet",
    agent_wallet_id: "turnkey:agent:wallet",
    strategy_id: "delta_neutral_carry",
    risk_effect: "neutral",
    as_of_ms: NOW - 100,
    benefit_source: "deterministic_market_state",
    expected_gross_benefit_bps: 35,
    model_decision_id: "model:decision:0001",
    model_cost_micro_usdc: 25_000,
    legs: [
      {
        venue_id: "jupiter",
        asset: "SOL",
        market: "SOL-USD",
        product_type: "spot",
        operation_class: "swap",
        side: "buy",
        notional_micro_usdc: 10_000_000,
        leverage_x100: 100,
        liquidation_distance_bps: 100_000,
        reduce_only: false,
        spread_bps: 2,
        slippage_bps: 2,
        fee_bps: 5,
        funding_bps_8h: 0,
        borrow_bps: 0,
        basis_bps: 50,
        latency_penalty_bps: 1,
        gas_micro_usdc: 1_000,
      },
      {
        venue_id: "hyperliquid",
        asset: "SOL",
        market: "SOL-USD",
        product_type: "perp",
        operation_class: "limit_order",
        side: "sell",
        notional_micro_usdc: 10_000_000,
        leverage_x100: 200,
        liquidation_distance_bps: 5_000,
        reduce_only: false,
        spread_bps: 2,
        slippage_bps: 2,
        fee_bps: 5,
        funding_bps_8h: -5,
        borrow_bps: 0,
        basis_bps: 50,
        latency_penalty_bps: 1,
        gas_micro_usdc: 0,
      },
    ],
    ...overrides,
  };
}

test("mandate normalization preserves owner/agent separation and rejects pooled custody", () => {
  const normalized = normalizePortfolioMandate(mandate());
  assert.notEqual(normalized.owner_wallet_id, normalized.agent_wallet_id);
  assert.throws(
    () => normalizePortfolioMandate(mandate({ custody_model: "pooled" })),
    /self-custodial Turnkey/,
  );
  assert.throws(
    () => normalizePortfolioMandate(mandate({ agent_wallet_id: "turnkey:owner:wallet" })),
    /must differ/,
  );
});

test("venue readiness fails closed on quarantine, stale state, and missing capabilities", () => {
  const readiness = assessVenueReadiness({
    venue_state: venue("hyperliquid", {
      status: "quarantined",
      as_of_ms: NOW - 60_000,
      capabilities: { market_data: true },
    }),
    required_capabilities: ["market_data", "orders", "reconciliation"],
    now_ms: NOW,
    max_age_ms: 30_000,
  });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.reasons.includes("venue_quarantined"));
  assert.ok(readiness.reasons.includes("venue_state_stale"));
  assert.ok(readiness.reasons.includes("capability_missing:orders"));
});

test("router chooses the lowest all-in cost and ignores a cheaper quarantined connector", () => {
  const routed = rankExecutionRoutes({
    intent: routeIntent(),
    quotes: [
      routeQuote("jupiter", { execution_price_e8: 9_990_000_000, fee_bps: 1 }),
      routeQuote("coinbase_advanced", { execution_price_e8: 10_005_000_000, fee_bps: 4 }),
    ],
    venue_states: [
      venue("jupiter", { status: "quarantined" }),
      venue("coinbase_advanced"),
    ],
    now_ms: NOW,
  });
  assert.equal(routed.ok, true);
  assert.equal(routed.selected.venue_id, "coinbase_advanced");
  assert.ok(routed.candidates.find((candidate) => candidate.venue_id === "jupiter").reasons.includes("venue_quarantined"));
  assert.equal(routed.selected.costs.total_bps, 15);
});

test("router rejects autonomous routes whose modeled costs erase the benefit", () => {
  const routed = rankExecutionRoutes({
    intent: routeIntent({ expected_gross_benefit_bps: 10 }),
    quotes: [routeQuote("jupiter", { fee_bps: 20, slippage_bps: 10 })],
    venue_states: [venue("jupiter")],
    now_ms: NOW,
  });
  assert.equal(routed.ok, false);
  assert.equal(routed.reason, "no_route_passed");
  assert.ok(routed.candidates[0].reasons.includes("expected_net_benefit_below_floor"));
});

test("portfolio risk accepts net-positive delta-neutral carry within the signed mandate", () => {
  const decision = evaluatePortfolioPlan({
    mandate: mandate(),
    portfolio: portfolio(),
    plan: carryPlan(),
    venue_states: [venue("jupiter"), venue("hyperliquid")],
    now_ms: NOW,
  });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.metrics.projected_gross_exposure_micro_usdc, 20_000_000);
  assert.equal(decision.metrics.projected_net_exposure_micro_usdc, 0);
  assert.ok(decision.metrics.expected_net_benefit_bps >= 5);
});

test("portfolio risk enforces funding, net benefit, model budget, and explicit mainnet activation", () => {
  const blockedPlan = carryPlan({
    network: "mainnet",
    expected_gross_benefit_bps: 1,
    legs: carryPlan().legs.map((leg, index) => index === 1 ? { ...leg, funding_bps_8h: 150 } : leg),
  });
  const decision = evaluatePortfolioPlan({
    mandate: mandate({
      network: "mainnet",
      mainnet_activation_id: null,
      max_model_decisions_per_hour: 2,
    }),
    portfolio: portfolio({ model_decisions_last_hour: 2 }),
    plan: blockedPlan,
    venue_states: [venue("jupiter"), venue("hyperliquid")],
    now_ms: NOW,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes("owner_mainnet_activation_required"));
  assert.ok(decision.reasons.includes("funding_limit"));
  assert.ok(decision.reasons.includes("model_decision_budget_exhausted"));
  assert.ok(decision.reasons.includes("expected_net_benefit_below_floor"));
});

test("kill switch permits only deterministic reduce-only recovery", () => {
  const reducingPlan = {
    ...carryPlan({
      strategy_id: "exposure_rebalance",
      risk_effect: "reduce",
      expected_gross_benefit_bps: -100,
      model_decision_id: null,
      legs: [{
        ...carryPlan().legs[1],
        side: "sell",
        notional_micro_usdc: 5_000_000,
        reduce_only: true,
        liquidation_distance_bps: 500,
      }],
    }),
  };
  const current = portfolio({
    positions: [{
      venue_id: "hyperliquid",
      asset: "SOL",
      market: "SOL-USD",
      product_type: "perp",
      signed_notional_micro_usdc: 10_000_000,
      leverage_x100: 200,
      liquidation_distance_bps: 500,
    }],
  });
  const decision = evaluatePortfolioPlan({
    mandate: mandate({ kill_switch: true, max_asset_concentration_bps: 10_000 }),
    portfolio: current,
    plan: reducingPlan,
    venue_states: [venue("hyperliquid", { status: "degraded" })],
    now_ms: NOW,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.action_class, "reduce_only");
  assert.equal(decision.metrics.projected_gross_exposure_micro_usdc, 5_000_000);
});
