import assert from "node:assert/strict";
import test from "node:test";
import {
  appendCarryValueLedgerEntry,
  advanceCarryPosition,
  calculateMarginRunway,
  createCarryPosition,
  createCarryValueLedger,
  evaluateCarryOpportunity,
  finalizeCarryValueLedger,
} from "../index.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

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
  return calculateMarginRunway({
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
  });
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
  return createCarryPosition({
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
      allow_migration: true,
    },
    now_ms: NOW,
  });
}

function event(sequence, type, overrides = {}) {
  return { version: 1, event_id: `event:${String(sequence).padStart(4, "0")}`, sequence, type, ...overrides };
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
  });
  assert.equal(result.eligible, true);
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
  });
  assert.equal(result.projected_trading_cost_micro_usdc, 4_200_000);
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
      as_of_ms: NOW + 4,
      expected_net_value_bps: -1,
      margin_runway_ms_by_venue: { hyperliquid: 30 * HOUR, lighter: 30 * HOUR },
    }),
    now_ms: NOW + 4,
  }).position;
  assert.equal(current.status, "exiting");
  assert.deepEqual(current.next_actions, ["reduce_only_close_both_legs"]);
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
  const flat = advanceCarryPosition({
    position: notFlat,
    event: event(5, "exit_reconciled", { gross_exposure_micro_usdc: 0, open_order_count: 0 }),
    now_ms: NOW + 5,
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
