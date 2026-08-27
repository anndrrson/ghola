import assert from "node:assert/strict";
import test from "node:test";
import {
  adverseExecutionSlippageE6Bps,
  appendCarryValueLedgerEntry,
  advanceCarryPosition,
  calculateMarginRunway,
  carryCollateralReviewMessage,
  carryRiskMandateMessage,
  compileCarryCapitalActionPlan,
  compileCarryCollateralReview,
  compileCarryPortfolioCapitalPlan,
  compileCarryPortfolioValueReport,
  compileCarryMigrationProposal,
  createCarryPosition,
  createCarryValueLedger,
  evaluateCarryOpportunity,
  estimatePerpDepthExecution,
  finalizeCarryValueLedger,
  normalizeCarryRiskMandateAuthorization,
  normalizeCarryRiskMandatePayload,
  normalizeCarryCollateralReviewPayload,
} from "../index.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

test("estimates executable price from full depth and fails closed on insufficient liquidity", () => {
  const sufficient = estimatePerpDepthExecution({
    side: "buy",
    depth_levels: [
      { price_e8: 10_000_000_000, size_e8: 100_000_000 },
      { price_e8: 10_200_000_000, size_e8: 100_000_000 },
    ],
    fallback_price_e8: 10_000_000_000,
    target_notional_micro_usdc: 150_000_000,
  });
  assert.equal(sufficient.status, "sufficient");
  assert.equal(sufficient.displayed_notional_micro_usdc, 202_000_000);
  assert.ok(sufficient.execution_price_e8 > 10_000_000_000);
  assert.ok(sufficient.execution_price_e8 < 10_200_000_000);

  const insufficient = estimatePerpDepthExecution({
    side: "sell",
    depth_levels: [{ price_e8: 10_000_000_000, size_e8: 10_000_000 }],
    target_notional_micro_usdc: 150_000_000,
  });
  assert.equal(insufficient.status, "insufficient");
  assert.equal(insufficient.displayed_notional_micro_usdc, 10_000_000);
});

test("measures only adverse execution slippage", () => {
  assert.equal(adverseExecutionSlippageE6Bps({
    side: "buy",
    mark_price_e8: 10_000_000_000,
    execution_price_e8: 10_100_000_000,
  }), 100_000_000);
  assert.equal(adverseExecutionSlippageE6Bps({
    side: "sell",
    mark_price_e8: 10_000_000_000,
    execution_price_e8: 10_100_000_000,
  }), 0);
});

function contract(venueId, fundingRate, overrides = {}) {
  return {
    version: 1,
    venue_id: venueId,
    contract_id: `contract:${venueId}:btc`,
    economic_equivalence_id: "carry:btc-usd-linear",
    asset: "BTC",
    market: "BTC-USD",
    quote_asset: "USD",
    collateral_asset: "USDC",
    contract_type: "linear_perp",
    mark_price_e8: 6_000_000_000_000,
    index_price_e8: 6_000_000_000_000,
    funding_rate_bps_per_interval: fundingRate,
    funding_interval_ms: 8 * HOUR,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    minimum_notional_micro_usdc: 10_000_000,
    quantity_step_e8: 1_000,
    price_tick_e8: 100_000,
    as_of_ms: NOW - 500,
    ...overrides,
  };
}

function runway(venueId, overrides = {}) {
  return {
    ...calculateMarginRunway({
    version: 1,
    venue_id: venueId,
    equity_micro_usdc: 2_500_000_000,
    maintenance_margin_micro_usdc: 500_000_000,
    safety_buffer_micro_usdc: 500_000_000,
    position_notional_micro_usdc: 10_000_000_000,
    stress_loss_bps_per_hour: 50,
    funding_debit_bps_per_interval: 0,
    funding_interval_ms: 8 * HOUR,
    owner_transfer_latency_ms: HOUR,
    owner_response_buffer_ms: HOUR,
    liquidation_distance_bps: 2_500,
    minimum_liquidation_distance_bps: 1_000,
    as_of_ms: NOW,
    ...overrides,
    }),
    account_commitment: overrides.account_commitment || `account:${venueId}:0001`,
  };
}

function costs() {
  return {
    entry_fee_bps: 2,
    exit_fee_bps: 2,
    entry_slippage_bps: 1,
    exit_slippage_bps: 1,
    latency_penalty_bps: 0,
    gas_micro_usdc: 0,
  };
}

function position() {
  const input = {
    version: 1,
    position_id: "carry:position:0001",
    mandate_id: "carry:mandate:0001",
    asset: "BTC",
    long_venue_id: "hyperliquid",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 10_000_000_000,
    risk_mandate: {
      min_expected_net_benefit_bps: 5,
      exit_net_value_bps: 0,
      exit_after_consecutive_observations: 2,
      min_margin_runway_ms: 6 * HOUR,
      max_hedge_error_micro_usdc: 1_000,
      max_data_age_ms: 30_000,
      max_contract_data_skew_ms: 2_000,
      max_index_price_divergence_bps: 25,
      max_mark_price_divergence_bps: 50,
      allow_migration: true,
    },
  };
  return createCarryPosition({
    ...input,
    mandate_authorization: mandateAuthorization(input),
    now_ms: NOW,
  });
}

function mandateAuthorization(input, overrides = {}) {
  const signedMandate = normalizeCarryRiskMandatePayload({
    version: 1,
    kind: "ghola_carry_risk_mandate",
    strategy_id: "delta_neutral_carry_v1",
    network: "mainnet",
    owner_commitment: "owner:carry:core:0001",
    owner_wallet_address: `0x${"11".repeat(20)}`,
    position_id: input.position_id,
    mandate_id: input.mandate_id,
    asset: input.asset,
    long_venue_id: input.long_venue_id,
    short_venue_id: input.short_venue_id,
    target_notional_micro_usdc: input.target_notional_micro_usdc,
    risk_mandate: input.risk_mandate,
    ...(input.migration_parent_position_id ? {
      migration_parent_position_id: input.migration_parent_position_id,
      migration_candidate_id: input.migration_candidate_id,
    } : {}),
    issued_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 30 * DAY,
    ...overrides,
  });
  return normalizeCarryRiskMandateAuthorization({
    version: 1,
    signed_mandate: signedMandate,
    signature: `0x${"22".repeat(65)}`,
    mandate_commitment: `0x${"33".repeat(32)}`,
  });
}

function migrationPosition(riskOverrides = {}) {
  const input = {
    version: 1,
    position_id: "carry:position:migration:0001",
    mandate_id: "carry:mandate:migration:0001",
    asset: "BTC",
    long_venue_id: "hyperliquid",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 10_000_000_000,
    risk_mandate: {
      min_expected_net_benefit_bps: 5,
      exit_net_value_bps: 0,
      exit_after_consecutive_observations: 2,
      min_margin_runway_ms: 6 * HOUR,
      max_hedge_error_micro_usdc: 1_000,
      max_data_age_ms: 30_000,
      max_contract_data_skew_ms: 2_000,
      max_index_price_divergence_bps: 25,
      max_mark_price_divergence_bps: 50,
      min_migration_improvement_bps: 10,
      migration_venue_allowlist: ["hyperliquid", "lighter", "aster"],
      allow_migration: true,
      ...riskOverrides,
    },
  };
  const authorization = mandateAuthorization(input);
  return {
    current: createCarryPosition({ ...input, mandate_authorization: authorization, now_ms: NOW }),
    authorization,
  };
}

function migrationCandidate(candidateId, longVenue, shortVenue, expectedNetBps, transitionCostBps) {
  return {
    candidate_id: candidateId,
    asset: "BTC",
    economic_equivalence_id: "carry:btc-usd-linear",
    long_venue_id: longVenue,
    short_venue_id: shortVenue,
    expected_net_value_bps: expectedNetBps,
    transition_cost_bps: transitionCostBps,
    eligible: true,
    no_submit_ready: true,
    transaction_broadcast: false,
    qualification_reasons: [],
    checked_at_ms: NOW,
  };
}

function event(sequence, type, overrides = {}) {
  return { version: 1, event_id: `event:${String(sequence).padStart(4, "0")}`, sequence, type, ...overrides };
}

function contractObservation(overrides = {}) {
  return {
    contract_data_skew_ms: 0,
    max_contract_data_skew_ms: 2_000,
    index_price_divergence_bps: 0,
    mark_price_divergence_bps: 0,
    max_index_price_divergence_bps: 25,
    max_mark_price_divergence_bps: 50,
    ...overrides,
  };
}

function activePositionForObservation() {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  return advanceCarryPosition({
    position: current,
    event: event(2, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
    }),
    now_ms: NOW + 2,
  }).position;
}

test("models carry after funding, round-trip costs, capital cost, risk buffer, and break-even", () => {
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1),
    short_contract: contract("lighter", 4),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: costs(),
    short_costs: costs(),
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 3,
    min_expected_net_benefit_bps: 5,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  });
  assert.equal(result.eligible, true);
  assert.equal(
    result.projected_trading_fee_micro_usdc
      + result.projected_slippage_micro_usdc
      + result.projected_gas_micro_usdc
      + result.projected_latency_buffer_micro_usdc,
    result.projected_trading_cost_micro_usdc,
  );
  assert.equal(
    result.projected_funding_credit_micro_usdc - result.projected_funding_debit_micro_usdc,
    result.projected_gross_funding_micro_usdc,
  );
  assert.equal(result.projected_gross_funding_micro_usdc, 63_000_000);
  assert.equal(result.projected_trading_cost_micro_usdc, 12_000_000);
  assert.equal(result.projected_capital_cost_micro_usdc, 2_800_000);
  assert.equal(result.risk_buffer_micro_usdc, 3_000_000);
  assert.equal(result.projected_net_value_micro_usdc, 45_200_000);
  assert.ok(result.break_even_ms > DAY && result.break_even_ms < 2 * DAY);
});

test("prices collateral basis stress separately from the base risk buffer", () => {
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1),
    short_contract: contract("lighter", 4),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: costs(),
    short_costs: costs(),
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 3,
    collateral_basis_risk_bps: 50,
    min_expected_net_benefit_bps: 5,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  });
  assert.equal(result.base_risk_buffer_micro_usdc, 3_000_000);
  assert.equal(result.collateral_basis_risk_micro_usdc, 50_000_000);
  assert.equal(result.risk_buffer_micro_usdc, 53_000_000);
  assert.equal(result.collateral_basis_risk_bps, 50);
});

test("preserves sub-basis-point funding precision", () => {
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 0, { funding_rate_e12_per_interval: 5_000_000 }),
    short_contract: contract("lighter", 0, { funding_rate_e12_per_interval: 25_000_000 }),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: { ...costs(), entry_fee_bps: 0, exit_fee_bps: 0, entry_slippage_bps: 0, exit_slippage_bps: 0 },
    short_costs: { ...costs(), entry_fee_bps: 0, exit_fee_bps: 0, entry_slippage_bps: 0, exit_slippage_bps: 0 },
    capital_cost_bps_per_day: 0,
    risk_buffer_bps: 0,
    min_expected_net_benefit_bps: 0,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  });
  assert.equal(result.projected_gross_funding_micro_usdc, 4_200_000);
  assert.equal(result.eligible, true);
});

test("preserves account-specific sub-basis-point fee precision", () => {
  const preciseCosts = {
    entry_fee_e6_bps: 1_050_000,
    exit_fee_e6_bps: 1_050_000,
    entry_slippage_bps: 0,
    exit_slippage_bps: 0,
    latency_penalty_bps: 0,
    gas_micro_usdc: 0,
  };
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1, { taker_fee_e6_bps: 1_050_000 }),
    short_contract: contract("lighter", 4, { taker_fee_e6_bps: 1_050_000 }),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: preciseCosts,
    short_costs: preciseCosts,
    capital_cost_bps_per_day: 0,
    risk_buffer_bps: 0,
    min_expected_net_benefit_bps: 0,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  });
  assert.equal(result.projected_trading_cost_micro_usdc, 4_200_000);
});

test("preserves sub-basis-point slippage precision", () => {
  const preciseCosts = {
    entry_fee_e6_bps: 0,
    exit_fee_e6_bps: 0,
    entry_slippage_e6_bps: 105_000,
    exit_slippage_e6_bps: 105_000,
    latency_penalty_bps: 0,
    gas_micro_usdc: 0,
  };
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1),
    short_contract: contract("lighter", 4),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: preciseCosts,
    short_costs: preciseCosts,
    capital_cost_bps_per_day: 0,
    risk_buffer_bps: 0,
    min_expected_net_benefit_bps: 0,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  });
  assert.equal(result.projected_trading_cost_micro_usdc, 420_000);
});

test("rejects a false carry spread built from cross-venue observations outside the skew budget", () => {
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1, { as_of_ms: NOW - 500 }),
    short_contract: contract("lighter", 4, { as_of_ms: NOW - 5_000 }),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: costs(),
    short_costs: costs(),
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 3,
    min_expected_net_benefit_bps: 5,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
  });
  assert.equal(result.contract_data_skew_ms, 4_500);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("contract_data_skew_exceeded"));
});

test("rejects same-ticker contracts whose index or mark basis exceeds equivalence budgets", () => {
  const result = evaluateCarryOpportunity({
    version: 1,
    long_contract: contract("hyperliquid", 1),
    short_contract: contract("lighter", 4, {
      index_price_e8: 6_030_000_000_000,
      mark_price_e8: 6_060_000_000_000,
    }),
    notional_micro_usdc: 10_000_000_000,
    capital_committed_micro_usdc: 4_000_000_000,
    horizon_ms: 7 * DAY,
    long_costs: costs(),
    short_costs: costs(),
    capital_cost_bps_per_day: 1,
    risk_buffer_bps: 3,
    min_expected_net_benefit_bps: 5,
    min_margin_runway_ms: 6 * HOUR,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
    max_index_price_divergence_bps: 25,
    max_mark_price_divergence_bps: 50,
  });
  assert.equal(result.index_price_divergence_bps, 50);
  assert.equal(result.mark_price_divergence_bps, 100);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("index_price_divergence_exceeded"));
  assert.ok(result.reasons.includes("mark_price_divergence_exceeded"));
});

test("margin runway exposes owner response risk without granting transfer authority", () => {
  const healthy = runway("hyperliquid");
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.runway_ms, 30 * HOUR);
  assert.equal(healthy.automatic_transfer_permitted, false);

  const critical = runway("hyperliquid", {
    equity_micro_usdc: 1_050_000_000,
    maintenance_margin_micro_usdc: 500_000_000,
    safety_buffer_micro_usdc: 500_000_000,
  });
  assert.equal(critical.status, "critical");
  assert.equal(critical.owner_action_required, true);
});

test("capital planner quantifies the minimum owner top-up without transfer authority", () => {
  const current = activePositionForObservation();
  const plan = compileCarryCapitalActionPlan({
    version: 1,
    position: current,
    margin_runways: [
      runway("hyperliquid", {
        equity_micro_usdc: 1_350_000_000,
        maintenance_margin_micro_usdc: 500_000_000,
        safety_buffer_micro_usdc: 500_000_000,
        owner_transfer_latency_ms: 2 * HOUR,
        owner_response_buffer_ms: 2 * HOUR,
      }),
      runway("lighter"),
    ],
    now_ms: NOW,
  });
  assert.equal(plan.status, "owner_action_required");
  assert.equal(plan.recommended_action, "owner_collateral_review");
  assert.equal(plan.minimum_additional_collateral_micro_usdc, 50_000_014);
  assert.deepEqual(plan.legs.map((leg) => leg.recommended_action), ["owner_fund_venue", "none"]);
  assert.equal(plan.proposal_only, true);
  assert.equal(plan.transaction_broadcast, false);
  assert.equal(plan.automatic_transfer_permitted, false);
});

test("portfolio capital planner aggregates shared accounts and proposes owner-only reallocation", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [
      runway("hyperliquid", {
        equity_micro_usdc: 1_350_000_000,
        maintenance_margin_micro_usdc: 500_000_000,
        safety_buffer_micro_usdc: 500_000_000,
        owner_transfer_latency_ms: 2 * HOUR,
        owner_response_buffer_ms: 2 * HOUR,
      }),
      runway("lighter"),
    ],
    now_ms: NOW,
  });
  const secondPlan = {
    ...positionPlan,
    position_id: "carry:position:0002",
    minimum_additional_collateral_micro_usdc: 25_000_000,
    legs: positionPlan.legs.map((leg) => leg.venue_id === "hyperliquid"
      ? {
          ...leg,
          runway_ms: 3 * HOUR,
          minimum_additional_collateral_micro_usdc: 25_000_000,
        }
      : leg),
  };
  const plan = compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 40_000_000,
    position_plans: [positionPlan, secondPlan],
  });
  assert.equal(plan.status, "owner_action_required");
  assert.equal(plan.position_count, 2);
  assert.equal(plan.account_count, 2);
  assert.equal(plan.total_requested_micro_usdc, 450_000_028);
  assert.equal(plan.total_potential_releasable_micro_usdc, 900_000_000);
  assert.equal(plan.total_proposed_internal_reallocation_micro_usdc, 450_000_028);
  assert.equal(plan.net_new_owner_capital_requested_micro_usdc, 0);
  assert.equal(plan.total_proposed_allocation_micro_usdc, 0);
  assert.equal(plan.total_uncovered_shortfall_micro_usdc, 0);
  assert.deepEqual(plan.allocations[0].position_ids, ["carry:position:0001", "carry:position:0002"]);
  assert.equal(plan.allocations[0].proposed_internal_reallocation_micro_usdc, 450_000_028);
  assert.equal(plan.proposed_reallocations[0].from_venue_id, "lighter");
  assert.equal(plan.proposed_reallocations[0].to_venue_id, "hyperliquid");
  assert.equal(plan.proposed_reallocations[0].amount_micro_usdc, 450_000_028);
  assert.equal(plan.owner_transfer_approval_required, true);
  assert.equal(plan.owner_approval_required, true);
  assert.equal(plan.proposal_only, true);
  assert.equal(plan.transaction_broadcast, false);
  assert.equal(plan.automatic_transfer_permitted, false);
});

test("portfolio capital planner quarantines stale evidence and allocates nothing", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [
      runway("hyperliquid", {
        equity_micro_usdc: 1_350_000_000,
        maintenance_margin_micro_usdc: 500_000_000,
        safety_buffer_micro_usdc: 500_000_000,
        owner_transfer_latency_ms: 2 * HOUR,
        owner_response_buffer_ms: 2 * HOUR,
      }),
      runway("lighter"),
    ],
    now_ms: NOW,
  });
  const plan = compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW + 30_001,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 100_000_000,
    position_plans: [positionPlan],
  });
  assert.equal(plan.status, "quarantined");
  assert.equal(plan.recommended_action, "reconcile_only");
  assert.equal(plan.total_proposed_allocation_micro_usdc, 0);
  assert.equal(plan.unallocated_owner_capital_micro_usdc, 100_000_000);
  assert.deepEqual(plan.stale_position_ids, ["carry:position:0001"]);
});

test("portfolio capital planner rejects any plan that weakens owner-only authority", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
  });
  assert.throws(() => compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 0,
    position_plans: [{ ...positionPlan, automatic_transfer_permitted: true }],
  }), /carry_portfolio_capital_position_authority_boundary/);
});

test("portfolio capital planner rejects one account commitment claimed by multiple venues", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
  });
  const sharedAccountPlan = {
    ...positionPlan,
    legs: positionPlan.legs.map((leg) => leg.venue_id === "lighter"
      ? { ...leg, account_commitment: "account:hyperliquid:0001" }
      : leg),
  };
  assert.throws(() => compileCarryPortfolioCapitalPlan({
    version: 1,
    now_ms: NOW,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 0,
    position_plans: [sharedAccountPlan],
  }), /carry_portfolio_capital_account_venue_mismatch/);
});

test("collateral review binds exact owner-only moves without authorizing fund movement", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [
      runway("hyperliquid", {
        equity_micro_usdc: 1_350_000_000,
        maintenance_margin_micro_usdc: 500_000_000,
        safety_buffer_micro_usdc: 500_000_000,
        owner_transfer_latency_ms: 2 * HOUR,
        owner_response_buffer_ms: 2 * HOUR,
      }),
      runway("lighter"),
    ],
    now_ms: NOW,
  });
  const review = compileCarryCollateralReview({
    version: 1,
    owner_commitment: "owner:commitment:0001",
    review_id: "carry:review:0001",
    now_ms: NOW,
    expires_at_ms: NOW + 10 * 60_000,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 0,
    position_plans: [positionPlan],
  });
  assert.equal(review.status, "signature_required");
  assert.equal(review.owner_signature_required, true);
  assert.equal(review.transfer_instructions.length, 1);
  assert.equal(review.transfer_instructions[0].from_venue_id, "lighter");
  assert.equal(review.transfer_instructions[0].to_venue_id, "hyperliquid");
  assert.equal(review.execution_authorized, false);
  assert.equal(review.fund_movement_authorized, false);
  assert.equal(review.transaction_broadcast, false);
  assert.match(carryCollateralReviewMessage(review), /^Ghola Carry collateral review v1\n/);
  assert.throws(() => normalizeCarryCollateralReviewPayload({
    ...review,
    execution_authorized: true,
  }), /carry_collateral_review_authority_boundary/);
  assert.throws(() => normalizeCarryCollateralReviewPayload({
    ...review,
    transfer_instructions: [{
      ...review.transfer_instructions[0],
      amount_micro_usdc: review.transfer_instructions[0].amount_micro_usdc + 1,
    }],
  }), /carry_collateral_review_instruction_plan_mismatch/);
});

test("collateral review exposes no instruction when capital evidence is stale", () => {
  const positionPlan = compileCarryCapitalActionPlan({
    version: 1,
    position: activePositionForObservation(),
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW,
  });
  const review = compileCarryCollateralReview({
    version: 1,
    owner_commitment: "owner:commitment:0001",
    review_id: "carry:review:stale:0001",
    now_ms: NOW + 30_001,
    expires_at_ms: NOW + 30_001 + 10 * 60_000,
    max_data_age_ms: 30_000,
    owner_capital_budget_micro_usdc: 100_000_000,
    position_plans: [positionPlan],
  });
  assert.equal(review.status, "blocked");
  assert.equal(review.owner_signature_status, "blocked");
  assert.deepEqual(review.transfer_instructions, []);
  assert.deepEqual(review.funding_instructions, []);
});

test("capital planner quarantines stale evidence and permits reconciliation only", () => {
  const current = activePositionForObservation();
  const plan = compileCarryCapitalActionPlan({
    version: 1,
    position: current,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW + 30_001,
  });
  assert.equal(plan.status, "quarantined");
  assert.equal(plan.recommended_action, "reconcile_only");
  assert.equal(plan.reconciliation_required, true);
  assert.equal(plan.reduce_only_exit_required, false);
  assert.equal(plan.owner_funding_required, false);
  assert.equal(plan.minimum_additional_collateral_micro_usdc, 0);
  assert.ok(plan.reasons.includes("margin_data_stale:hyperliquid"));
  assert.equal(plan.automatic_transfer_permitted, false);
});

test("capital planner prioritizes an expired signed mandate over stale evidence", () => {
  const current = activePositionForObservation();
  const plan = compileCarryCapitalActionPlan({
    version: 1,
    position: current,
    margin_runways: [runway("hyperliquid"), runway("lighter")],
    now_ms: NOW + 30 * DAY,
  });
  assert.equal(plan.status, "exit_required");
  assert.equal(plan.recommended_action, "reduce_only_exit");
  assert.equal(plan.reduce_only_exit_required, true);
  assert.equal(plan.reconciliation_required, false);
  assert.ok(plan.reasons.includes("risk_mandate_expired"));
  assert.equal(plan.transaction_broadcast, false);
});

test("capital planner rejects evidence that could grant automatic transfer authority", () => {
  const current = activePositionForObservation();
  assert.throws(() => compileCarryCapitalActionPlan({
    version: 1,
    position: current,
    margin_runways: [
      { ...runway("hyperliquid"), automatic_transfer_permitted: true },
      runway("lighter"),
    ],
    now_ms: NOW,
  }), /carry_capital_automatic_transfer_forbidden/);
});

test("legacy signed mandates remain verifiable without newly added contract-limit fields", () => {
  const input = {
    version: 1,
    kind: "ghola_carry_risk_mandate",
    strategy_id: "delta_neutral_carry_v1",
    network: "mainnet",
    owner_commitment: "owner:carry:legacy:0001",
    owner_wallet_address: `0x${"11".repeat(20)}`,
    position_id: "carry:position:legacy:0001",
    mandate_id: "carry:mandate:legacy:0001",
    asset: "BTC",
    long_venue_id: "hyperliquid",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 10_000_000,
    risk_mandate: {
      min_expected_net_benefit_bps: 5,
      exit_net_value_bps: 0,
      exit_after_consecutive_observations: 2,
      min_margin_runway_ms: 6 * HOUR,
      max_hedge_error_micro_usdc: 1_000,
      max_data_age_ms: 30_000,
      allow_migration: false,
    },
    issued_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 30 * DAY,
  };
  const normalized = normalizeCarryRiskMandatePayload(input);
  assert.equal(Object.hasOwn(normalized.risk_mandate, "max_contract_data_skew_ms"), false);
  assert.equal(carryRiskMandateMessage(input).includes("max_contract_data_skew_ms"), false);
});

test("a replacement Carry Position is cryptographically bound to its migration parent and candidate", () => {
  const input = {
    version: 1,
    position_id: "carry:position:migration:replacement:0001",
    mandate_id: "carry:mandate:migration:replacement:0001",
    migration_parent_position_id: "carry:position:migration:0001",
    migration_candidate_id: "carry:migration:aster:0001",
    asset: "BTC",
    long_venue_id: "aster",
    short_venue_id: "lighter",
    target_notional_micro_usdc: 10_000_000_000,
    risk_mandate: migrationPosition().current.risk_mandate,
  };
  const authorization = mandateAuthorization(input);
  const replacement = createCarryPosition({ ...input, mandate_authorization: authorization, now_ms: NOW });
  assert.equal(replacement.migration_parent_position_id, input.migration_parent_position_id);
  assert.equal(replacement.migration_candidate_id, input.migration_candidate_id);
  assert.throws(
    () => createCarryPosition({
      ...input,
      migration_candidate_id: "carry:migration:tampered:0001",
      mandate_authorization: authorization,
      now_ms: NOW,
    }),
    (error) => error?.code === "carry_mandate_position_mismatch",
  );
});

test("two confirmed carry flips trigger a deterministic reduce-only exit", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  current = advanceCarryPosition({
    position: current,
    event: event(2, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
    }),
    now_ms: NOW + 2,
  }).position;
  assert.equal(current.long_filled_micro_usdc, 10_000_000_000);
  assert.equal(current.short_filled_micro_usdc, 10_000_000_000);
  assert.equal(current.hedge_error_micro_usdc, 0);
  current = advanceCarryPosition({
    position: current,
    event: event(3, "observation", {
      ...contractObservation(),
      as_of_ms: NOW + 3,
      expected_net_value_bps: -1,
      margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 3,
  }).position;
  assert.equal(current.status, "active");
  current = advanceCarryPosition({
    position: current,
    event: event(4, "observation", {
      ...contractObservation(),
      as_of_ms: NOW + 4,
      expected_net_value_bps: -1,
      margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 4,
  }).position;
  assert.equal(current.status, "exiting");
  assert.deepEqual(current.next_actions, ["reduce_only_close_both_legs"]);
});

test("migration compiler selects only the best fresh route inside the signed venue allowlist", () => {
  const { current, authorization } = migrationPosition();
  const result = compileCarryMigrationProposal({
    version: 1,
    position: current,
    mandate_authorization: authorization,
    economic_equivalence_id: "carry:btc-usd-linear",
    current_expected_net_value_bps: -2,
    candidates: [
      migrationCandidate("carry:migration:aster:0001", "hyperliquid", "aster", 20, 4),
      migrationCandidate("carry:migration:aster:0002", "lighter", "aster", 30, 3),
      migrationCandidate("carry:migration:same:0001", "hyperliquid", "lighter", 100, 0),
    ],
    now_ms: NOW,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.proposal_only, true);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.requires_reconciled_flat_transition, true);
  assert.equal(result.selected_candidate.candidate_id, "carry:migration:aster:0002");
  assert.equal(result.selected_candidate.projected_improvement_bps, 29);
  assert.ok(result.candidates.find((candidate) => candidate.candidate_id === "carry:migration:same:0001").reasons.includes("route_unchanged"));
});

test("migration compiler fails closed for unsigned, stale, or unqualified destinations", () => {
  const { current, authorization } = migrationPosition({
    migration_venue_allowlist: ["hyperliquid", "lighter"],
  });
  const result = compileCarryMigrationProposal({
    version: 1,
    position: current,
    mandate_authorization: authorization,
    economic_equivalence_id: "carry:btc-usd-linear",
    current_expected_net_value_bps: -2,
    candidates: [{
      ...migrationCandidate("carry:migration:blocked:0001", "hyperliquid", "aster", 50, 1),
      checked_at_ms: NOW - 30_001,
      no_submit_ready: false,
    }],
    now_ms: NOW,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.selected_candidate, null);
  const candidate = result.candidates[0];
  assert.ok(candidate.reasons.includes("venue_outside_signed_allowlist"));
  assert.ok(candidate.reasons.includes("candidate_not_execution_qualified"));
  assert.ok(candidate.reasons.includes("candidate_stale"));
});

test("a qualified migration closes the old route first and persists an owner-signature request", () => {
  let { current } = migrationPosition();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  current = advanceCarryPosition({
    position: current,
    event: event(2, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
    }),
    now_ms: NOW + 2,
  }).position;
  for (const sequence of [3, 4]) {
    current = advanceCarryPosition({
      position: current,
      event: event(sequence, "observation", {
        ...contractObservation(),
        as_of_ms: NOW + sequence,
        expected_net_value_bps: -2,
        economic_equivalence_id: "carry:btc-usd-linear",
        migration_candidates: [migrationCandidate(
          "carry:migration:durable:0001",
          "lighter",
          "aster",
          20,
          4,
        )],
        margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
      }),
      now_ms: NOW + sequence,
    }).position;
  }
  assert.equal(current.status, "exiting");
  assert.deepEqual(current.next_actions, ["reduce_only_close_both_legs"]);
  assert.equal(current.pending_migration.status, "awaiting_flat_exit");
  assert.equal(current.pending_migration.selected_candidate.short_venue_id, "aster");
  assert.equal(current.pending_migration.transaction_broadcast, false);
  current = advanceCarryPosition({
    position: current,
    event: event(5, "exit_reconciled", { gross_exposure_micro_usdc: 0, open_order_count: 0 }),
    now_ms: NOW + 5,
  }).position;
  assert.equal(current.status, "reconciled");
  assert.equal(current.terminal_reason, "reconciled_flat_migration_ready");
  assert.deepEqual(current.next_actions, ["request_owner_signed_migration"]);
  assert.equal(current.pending_migration.status, "owner_signature_required");
});

test("one margin runway breach triggers an immediate reduce-only exit", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  current = advanceCarryPosition({
    position: current,
    event: event(2, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
    }),
    now_ms: NOW + 2,
  }).position;
  current = advanceCarryPosition({
    position: current,
    event: event(3, "observation", {
      ...contractObservation(),
      as_of_ms: NOW + 3,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 3,
  }).position;
  assert.equal(current.status, "exiting");
  assert.equal(current.terminal_reason, "margin_runway_below_mandate");
  assert.deepEqual(current.next_actions, ["reduce_only_close_both_legs"]);
});

test("signed contract skew and basis limits trigger immediate reduce-only exits", () => {
  for (const [metrics, reason] of [
    [contractObservation({ contract_data_skew_ms: 2_001 }), "contract_data_skew_outside_mandate"],
    [contractObservation({ index_price_divergence_bps: 26 }), "contract_basis_outside_mandate"],
  ]) {
    const result = advanceCarryPosition({
      position: activePositionForObservation(),
      event: event(3, "observation", {
        ...metrics,
        as_of_ms: NOW + 3,
        expected_net_value_bps: 100,
        margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
      }),
      now_ms: NOW + 3,
    });
    assert.equal(result.position.status, "exiting");
    assert.equal(result.position.terminal_reason, reason);
    assert.deepEqual(result.position.next_actions, ["reduce_only_close_both_legs"]);
  }
});

test("missing contract-equivalence evidence freezes without retry", () => {
  const result = advanceCarryPosition({
    position: activePositionForObservation(),
    event: event(3, "observation", {
      as_of_ms: NOW + 3,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 3,
  });
  assert.equal(result.position.status, "frozen");
  assert.equal(result.position.terminal_reason, "contract_equivalence_unverifiable");
  assert.equal(result.position.retry_permitted, false);
});

test("an unverifiable null margin runway triggers an immediate reduce-only exit", () => {
  const result = advanceCarryPosition({
    position: activePositionForObservation(),
    event: event(3, "observation", {
      ...contractObservation(),
      as_of_ms: NOW + 3,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: null, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 3,
  });
  assert.equal(result.position.status, "exiting");
  assert.equal(result.position.terminal_reason, "margin_runway_unverifiable");
  assert.deepEqual(result.position.next_actions, ["reduce_only_close_both_legs"]);
});

test("a verified healthy null runway represents zero modeled burn, not missing evidence", () => {
  const result = advanceCarryPosition({
    position: activePositionForObservation(),
    event: event(3, "observation", {
      ...contractObservation(),
      as_of_ms: NOW + 3,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: null, lighter: 30 * HOUR },
      margin_runway_status_by_venue: { hyperliquid: "healthy", lighter: "healthy" },
    }),
    now_ms: NOW + 3,
  });
  assert.equal(result.position.status, "active");
  assert.equal(result.position.terminal_reason, null);
});

test("an expired signed mandate permits only a reduce-only exit", () => {
  const active = activePositionForObservation();
  const result = advanceCarryPosition({
    position: active,
    event: event(3, "observation", {
      ...contractObservation(),
      as_of_ms: NOW + 31 * DAY,
      expected_net_value_bps: 100,
      margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 31 * DAY,
  });
  assert.equal(result.position.status, "exiting");
  assert.equal(result.position.terminal_reason, "risk_mandate_expired");
  assert.deepEqual(result.position.next_actions, ["reduce_only_close_both_legs"]);
});

test("ambiguous submission freezes and permits reconciliation, never retry", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  const ambiguous = event(2, "submission_ambiguous");
  const result = advanceCarryPosition({ position: current, event: ambiguous, now_ms: NOW + 2 });
  assert.equal(result.position.status, "frozen");
  assert.equal(result.position.retry_permitted, false);
  assert.deepEqual(result.position.next_actions, ["reconcile_only"]);
  const duplicate = advanceCarryPosition({ position: result.position, event: ambiguous, now_ms: NOW + 3 });
  assert.equal(duplicate.duplicate, true);
});

test("an unavailable monitoring observation freezes without retry", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  current = advanceCarryPosition({
    position: current,
    event: event(2, "entry_reconciled", {
      long_filled_micro_usdc: 10_000_000_000,
      short_filled_micro_usdc: 10_000_000_000,
      hedge_error_micro_usdc: 0,
    }),
    now_ms: NOW + 2,
  }).position;
  const result = advanceCarryPosition({
    position: current,
    event: event(3, "observation_unavailable"),
    now_ms: NOW + 3,
  });
  assert.equal(result.ok, true);
  assert.equal(result.position.status, "frozen");
  assert.equal(result.position.retry_permitted, false);
  assert.deepEqual(result.position.next_actions, ["reconcile_only"]);
});

test("a proven no-fill entry terminates flat without an exit order", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  const result = advanceCarryPosition({
    position: current,
    event: event(2, "entry_failed_no_fill"),
    now_ms: NOW + 2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.position.status, "reconciled");
  assert.deepEqual(result.position.next_actions, []);
  assert.equal(result.position.terminal_reason, "entry_failed_no_fill");
});

test("exit is complete only when exposure is flat and open orders are zero", () => {
  let current = position();
  current = advanceCarryPosition({
    position: current,
    event: event(1, "preflight_passed", { opportunity_eligible: true, all_venues_ready: true }),
    now_ms: NOW + 1,
  }).position;
  current = advanceCarryPosition({ position: current, event: event(2, "submission_ambiguous"), now_ms: NOW + 2 }).position;
  current = advanceCarryPosition({
    position: current,
    event: event(3, "reconciliation_complete", { known_flat: false, open_order_count: 1 }),
    now_ms: NOW + 3,
  }).position;
  const notFlat = advanceCarryPosition({
    position: current,
    event: event(4, "exit_reconciled", { gross_exposure_micro_usdc: 0, open_order_count: 1 }),
    now_ms: NOW + 4,
  }).position;
  assert.equal(notFlat.status, "exiting");
  const residual = advanceCarryPosition({
    position: notFlat,
    event: event(5, "exit_reconciled", { gross_exposure_micro_usdc: 1, open_order_count: 0 }),
    now_ms: NOW + 5,
  }).position;
  assert.equal(residual.status, "exiting");
  const flat = advanceCarryPosition({
    position: residual,
    event: event(6, "exit_reconciled", { gross_exposure_micro_usdc: 0, open_order_count: 0 }),
    now_ms: NOW + 6,
  }).position;
  assert.equal(flat.status, "reconciled");
  assert.deepEqual(flat.next_actions, []);
  assert.equal(flat.long_filled_micro_usdc, 0);
  assert.equal(flat.short_filled_micro_usdc, 0);
  assert.equal(flat.hedge_error_micro_usdc, 0);
});

test("value ledger reports realized net after every cost and deduplicates evidence", () => {
  let ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:0001",
    modeled: {
      gross_funding_micro_usdc: 30_000_000,
      trading_cost_micro_usdc: 10_000_000,
      capital_cost_micro_usdc: 2_000_000,
      risk_buffer_micro_usdc: 3_000_000,
      funding_credit_micro_usdc: 30_000_000,
      funding_debit_micro_usdc: 0,
      trading_fee_micro_usdc: 8_000_000,
      slippage_micro_usdc: 1_500_000,
      gas_micro_usdc: 0,
      latency_buffer_micro_usdc: 500_000,
    },
    now_ms: NOW,
  });
  const entries = [
    ["funding", "credit", 31_000_000],
    ["trading_fee", "debit", 8_000_000],
    ["slippage", "debit", 1_500_000],
    ["capital_cost", "debit", 2_000_000],
  ];
  for (const [index, [entryType, direction, amount]] of entries.entries()) {
    const result = appendCarryValueLedgerEntry({
      ledger,
      entry: {
        version: 1,
        entry_id: `value:entry:${index + 1}`,
        sequence: index + 1,
        entry_type: entryType,
        direction,
        amount_micro_usdc: amount,
        venue_id: index < 2 ? "hyperliquid" : null,
        leg_id: index < 2 ? "carry:leg:long" : null,
        occurred_at_ms: NOW + index + 1,
        evidence_commitment: `value:evidence:${index + 1}`,
      },
      now_ms: NOW + index + 1,
    });
    assert.equal(result.ok, true);
    ledger = result.ledger;
  }
  assert.equal(ledger.modeled.net_value_micro_usdc, 15_000_000);
  assert.equal(ledger.realized.net_value_micro_usdc, 19_500_000);
  assert.equal(ledger.realized.variance_from_modeled_micro_usdc, 4_500_000);
  assert.equal(ledger.realized.attribution.status, "accruing");
  assert.equal(ledger.realized.attribution.funding_micro_usdc, 1_000_000);
  assert.equal(ledger.realized.attribution.trading_fee_micro_usdc, 0);
  assert.equal(ledger.realized.attribution.slippage_micro_usdc, 0);
  assert.equal(ledger.realized.attribution.net_value_micro_usdc, 4_500_000);
  assert.equal(ledger.realized.by_venue.hyperliquid.net_value_micro_usdc, 23_000_000);
  const duplicate = appendCarryValueLedgerEntry({
    ledger,
    entry: {
      version: 1,
      entry_id: "value:entry:4",
      sequence: 4,
      entry_type: "capital_cost",
      direction: "debit",
      amount_micro_usdc: 2_000_000,
      venue_id: null,
      leg_id: null,
      occurred_at_ms: NOW + 4,
      evidence_commitment: "value:evidence:4",
    },
    now_ms: NOW + 10,
  });
  assert.equal(duplicate.duplicate, true);
});

test("value ledger rejects modeled component totals that do not reconcile", () => {
  assert.throws(() => createCarryValueLedger({
    version: 1,
    position_id: "carry:position:0001",
    modeled: {
      gross_funding_micro_usdc: 10,
      trading_cost_micro_usdc: 5,
      capital_cost_micro_usdc: 0,
      risk_buffer_micro_usdc: 0,
      funding_credit_micro_usdc: 10,
      funding_debit_micro_usdc: 0,
      trading_fee_micro_usdc: 2,
      slippage_micro_usdc: 2,
      gas_micro_usdc: 0,
      latency_buffer_micro_usdc: 0,
    },
    now_ms: NOW,
  }), /carry_value_modeled_trading_breakdown_mismatch/);
});

test("value ledger rejects a reused evidence claim under a new entry id", () => {
  let ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:0001",
    modeled: {
      gross_funding_micro_usdc: 10,
      trading_cost_micro_usdc: 2,
      capital_cost_micro_usdc: 1,
      risk_buffer_micro_usdc: 1,
    },
    now_ms: NOW,
  });
  const first = appendCarryValueLedgerEntry({
    ledger,
    entry: {
      version: 1,
      entry_id: "value:entry:claim:1",
      sequence: 1,
      entry_type: "trading_fee",
      direction: "debit",
      amount_micro_usdc: 2,
      venue_id: "hyperliquid",
      leg_id: "carry:leg:long",
      occurred_at_ms: NOW + 1,
      evidence_commitment: "value:evidence:claim:1",
    },
    now_ms: NOW + 1,
  });
  assert.equal(first.ok, true);
  ledger = first.ledger;
  const replayedClaim = appendCarryValueLedgerEntry({
    ledger,
    entry: {
      version: 1,
      entry_id: "value:entry:claim:2",
      sequence: 2,
      entry_type: "trading_fee",
      direction: "debit",
      amount_micro_usdc: 2,
      venue_id: "hyperliquid",
      leg_id: "carry:leg:long",
      occurred_at_ms: NOW + 2,
      evidence_commitment: "value:evidence:claim:1",
    },
    now_ms: NOW + 2,
  });
  assert.equal(replayedClaim.ok, false);
  assert.equal(replayedClaim.error, "carry_value_evidence_claim_reused");
  assert.equal(replayedClaim.ledger.realized.net_value_micro_usdc, -2);
});

test("rebates can only credit realized value", () => {
  const ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:0001",
    modeled: {
      gross_funding_micro_usdc: 10,
      trading_cost_micro_usdc: 2,
      capital_cost_micro_usdc: 1,
      risk_buffer_micro_usdc: 1,
    },
    now_ms: NOW,
  });
  const invalid = appendCarryValueLedgerEntry({
    ledger,
    entry: {
      version: 1,
      entry_id: "value:entry:rebate:1",
      sequence: 1,
      entry_type: "rebate",
      direction: "debit",
      amount_micro_usdc: 2,
      venue_id: "lighter",
      leg_id: "carry:leg:short",
      occurred_at_ms: NOW + 1,
      evidence_commitment: "value:evidence:rebate:1",
    },
    now_ms: NOW + 1,
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "carry_value_rebate_must_be_credit");
});

test("value ledger finalizes only with flat exposure, zero orders, and complete costs", () => {
  const ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:0001",
    modeled: {
      gross_funding_micro_usdc: 10,
      trading_cost_micro_usdc: 2,
      capital_cost_micro_usdc: 1,
      risk_buffer_micro_usdc: 1,
    },
    now_ms: NOW,
  });
  const rejected = finalizeCarryValueLedger({
    ledger,
    evidence: {
      gross_exposure_micro_usdc: 0,
      open_order_count: 1,
      costs_complete: true,
      reconciliation_commitment: "reconcile:proof:0001",
    },
    now_ms: NOW + 1,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "carry_value_final_open_orders_nonzero");
  const finalized = finalizeCarryValueLedger({
    ledger,
    evidence: {
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      costs_complete: true,
      reconciliation_commitment: "reconcile:proof:0001",
    },
    now_ms: NOW + 2,
  });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.ledger.status, "finalized");
});

test("portfolio value report separates finalized after-cost proof from accruing estimates", () => {
  const openLedger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:value:open",
    modeled: {
      gross_funding_micro_usdc: 100,
      trading_cost_micro_usdc: 20,
      capital_cost_micro_usdc: 10,
      risk_buffer_micro_usdc: 5,
    },
    now_ms: NOW,
  });
  let finalizedLedger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:value:final",
    modeled: {
      gross_funding_micro_usdc: 200,
      trading_cost_micro_usdc: 70,
      capital_cost_micro_usdc: 10,
      risk_buffer_micro_usdc: 0,
    },
    now_ms: NOW,
  });
  const entries = [
    ["funding", "credit", 200, "value:evidence:portfolio:funding"],
    ["trading_fee", "debit", 50, "value:evidence:portfolio:fee"],
    ["slippage", "debit", 20, "value:evidence:portfolio:slippage"],
    ["capital_cost", "debit", 10, "value:evidence:portfolio:capital"],
  ];
  for (const [index, [entryType, direction, amount, evidence]] of entries.entries()) {
    const appended = appendCarryValueLedgerEntry({
      ledger: finalizedLedger,
      entry: {
        version: 1,
        entry_id: `value:entry:portfolio:${index + 1}`,
        sequence: index + 1,
        entry_type: entryType,
        direction,
        amount_micro_usdc: amount,
        venue_id: index % 2 === 0 ? "hyperliquid" : "lighter",
        leg_id: index % 2 === 0 ? "carry:leg:long" : "carry:leg:short",
        occurred_at_ms: NOW + index + 1,
        evidence_commitment: evidence,
      },
      now_ms: NOW + index + 1,
    });
    assert.equal(appended.ok, true);
    finalizedLedger = appended.ledger;
  }
  const finalized = finalizeCarryValueLedger({
    ledger: finalizedLedger,
    evidence: {
      gross_exposure_micro_usdc: 0,
      open_order_count: 0,
      costs_complete: true,
      reconciliation_commitment: "reconcile:portfolio:value:0001",
    },
    now_ms: NOW + 10,
  });
  assert.equal(finalized.ok, true);
  const report = compileCarryPortfolioValueReport({
    version: 1,
    now_ms: NOW + 10,
    position_values: [
      {
        position_id: "carry:position:value:open",
        position_status: "active",
        target_notional_micro_usdc: 10_000_000,
        value_ledger: openLedger,
      },
      {
        position_id: "carry:position:value:final",
        position_status: "reconciled",
        target_notional_micro_usdc: 20_000_000,
        value_ledger: finalized.ledger,
      },
    ],
    capital_evidence: {
      status: "ready",
      plan: {
        kind: "ghola_carry_portfolio_capital_plan",
        total_requested_micro_usdc: 25,
        total_potential_releasable_micro_usdc: 15,
        total_proposed_internal_reallocation_micro_usdc: 15,
        net_new_owner_capital_requested_micro_usdc: 10,
        total_proposed_allocation_micro_usdc: 0,
        total_uncovered_shortfall_micro_usdc: 10,
        owner_transfer_approval_required: true,
        owner_funding_approval_required: false,
        proposal_only: true,
        transaction_broadcast: false,
        automatic_transfer_permitted: false,
        owner_only_operations: ["fund", "transfer", "withdraw"],
      },
    },
  });
  assert.equal(report.value_proof_status, "mixed");
  assert.equal(report.modeled.net_value_micro_usdc, 185);
  assert.equal(report.finalized_after_costs.net_value_micro_usdc, 120);
  assert.equal(report.finalized_after_costs.variance_from_modeled_micro_usdc, 0);
  assert.equal(report.unfinalized.modeled_net_value_micro_usdc, 65);
  assert.equal(report.capital_efficiency.potential_new_cash_avoided_micro_usdc, 15);
  assert.equal(report.capital_efficiency.new_owner_cash_requested_micro_usdc, 10);
  assert.equal(report.proposal_only, true);
  assert.equal(report.transaction_broadcast, false);
  assert.equal(report.automatic_transfer_permitted, false);
});

test("portfolio value report rejects duplicate, tampered, or fund-moving evidence", () => {
  const ledger = createCarryValueLedger({
    version: 1,
    position_id: "carry:position:value:guard",
    modeled: {
      gross_funding_micro_usdc: 100,
      trading_cost_micro_usdc: 20,
      capital_cost_micro_usdc: 10,
      risk_buffer_micro_usdc: 5,
    },
    now_ms: NOW,
  });
  const position = {
    position_id: "carry:position:value:guard",
    position_status: "active",
    target_notional_micro_usdc: 10_000_000,
    value_ledger: ledger,
  };
  const incompleteCapital = {
    status: "incomplete",
    missing_position_ids: ["carry:position:value:guard"],
  };
  assert.throws(() => compileCarryPortfolioValueReport({
    version: 1,
    now_ms: NOW + 1,
    position_values: [position, position],
    capital_evidence: incompleteCapital,
  }), /carry_portfolio_value_report_duplicate_position/);
  assert.throws(() => compileCarryPortfolioValueReport({
    version: 1,
    now_ms: NOW + 1,
    position_values: [{
      ...position,
      value_ledger: {
        ...ledger,
        realized: { ...ledger.realized, net_value_micro_usdc: 1 },
      },
    }],
    capital_evidence: incompleteCapital,
  }), /carry_portfolio_value_realized_net_mismatch/);
  assert.throws(() => compileCarryPortfolioValueReport({
    version: 1,
    now_ms: NOW + 1,
    position_values: [position],
    capital_evidence: {
      status: "ready",
      plan: {
        kind: "ghola_carry_portfolio_capital_plan",
        proposal_only: true,
        transaction_broadcast: true,
        automatic_transfer_permitted: false,
      },
    },
  }), /carry_portfolio_value_capital_authority_boundary/);
});
