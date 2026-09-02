import assert from "node:assert/strict";
import test from "node:test";
import { cashflowValuationEvidenceMessage, executionVenueSpec } from "@ghola/execution-core";
import {
  modelCarryPairPreflight,
  preflightCarryExecutionMatrix,
  preflightCarryPair,
} from "../src/execution/carry-preflight.js";
import { storeCarryVenueQualification } from "../src/execution/carry-qualification.js";
import { liquidationDistanceSourceForVenue } from "../src/venues/liquidation-distance.js";

const NOW = 1_800_000_000_000;

function snapshot(venueId) {
  const shadow = executionVenueSpec(venueId).adapter_capabilities.perp_shadow;
  const quoteAsset = venueId === "hyperliquid" || venueId === "aster" ? "USDT" : "USD";
  const settlementAsset = venueId === "aster" ? "USDT" : "USDC";
  return {
    version: 1,
    venue_id: venueId,
    adapter_mode: "shadow_read_only",
    source_schema: shadow.source_schema,
    trading_api_available: true,
    contract_id: `${venueId}:BTC`,
    economic_equivalence_id: "carry:BTC-usd-linear",
    asset: "BTC",
    market: "BTC-USD",
    quote_asset: quoteAsset,
    collateral_asset: venueId === "aster" ? "USDT" : "USDC",
    funding_settlement_asset: settlementAsset,
    fee_settlement_asset: settlementAsset,
    asset_valuations: [cashflowValuation(quoteAsset)],
    contract_type: "linear_perp",
    mark_price_e8: 10_000_000_000_000,
    index_price_e8: 10_000_000_000_000,
    best_bid_e8: 9_999_000_000_000,
    best_ask_e8: 10_001_000_000_000,
    depth_bids: [{ price_e8: 9_999_000_000_000, size_e8: 100_000_000 }],
    depth_asks: [{ price_e8: 10_001_000_000_000, size_e8: 100_000_000 }],
    funding_rate_e12_per_interval: venueId === "aster" ? 400_000_000 : 100_000_000,
    funding_interval_ms: venueId === "aster" ? 28_800_000 : 3_600_000,
    maker_fee_bps: 0,
    taker_fee_bps: 1,
    minimum_notional_micro_usdc: 1_000_000,
    quantity_step_e8: 1_000,
    price_tick_e8: 1_000_000,
    initial_margin_bps: 1_000,
    maintenance_margin_bps: 500,
    liquidation_fee_bps: 0,
    margin_model: shadow.margin_model,
    liquidation_model: shadow.liquidation_model,
    as_of_ms: NOW,
    source_observed_at_ms: { market: NOW, funding: NOW, orderbook: NOW },
    source_max_age_ms: { market: 60_000, funding: 60_000, orderbook: 60_000 },
    stale_sources: [],
    status: "ready",
    stale: false,
    missing_fields: [],
    quality_flags: [],
    executable: false,
  };
}

function cashflowValuation(sourceAsset) {
  const valuation = {
    version: 1,
    source_asset: sourceAsset,
    valuation_asset: "USDC",
    verified: true,
    credit_rate_e8: 100_000_000,
    debit_rate_e8: 100_000_000,
    observed_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 30_000,
    evidence_source: "test:cashflow-book:v1",
    evidence_commitment: `carry:cashflow-valuation:evidence:${(sourceAsset === "USDT" ? "a" : "b").repeat(64)}`,
  };
  return { ...valuation, evidence_message: cashflowValuationEvidenceMessage(valuation) };
}

function assertPublicValuationBinding(result) {
  for (const leg of result.evidence) {
    const expected = snapshot(leg.venue_id);
    assert.equal(leg.quote_asset, expected.quote_asset);
    assert.equal(leg.funding_settlement_asset, expected.funding_settlement_asset);
    assert.equal(leg.fee_settlement_asset, expected.fee_settlement_asset);
    assert.deepEqual(leg.asset_valuations, expected.asset_valuations);
  }
}

test("rejects missing margin evidence through the shared shadow contract before account verification", async () => {
  let verificationCalls = 0;
  await assert.rejects(preflightCarryPair({
    body: {
      version: 1,
      owner_commitment: "owner_commitment_0001",
      work_order_commitment: "carry_pair_margin_gap_0001",
      asset: "BTC",
      long_venue_id: "hyperliquid",
      short_venue_id: "lighter",
      notional_usd: 100,
      horizon_days: 30,
      venue_access: { hyperliquid: access(), lighter: access() },
    },
    recipient: {},
    state: {},
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => [{
      ...snapshot(venue_id),
      ...(venue_id === "hyperliquid" ? { maintenance_margin_bps: null } : {}),
    }],
    verifyOrder: async () => {
      verificationCalls += 1;
      throw new Error("must_not_verify_account");
    },
  }), /carry_shadow_unavailable:hyperliquid:normalized_field_missing:hyperliquid:BTC:maintenance_margin_bps/);
  assert.equal(verificationCalls, 0);
});

function access(ownerCommitment = "owner_commitment_0001") {
  return {
    status: "ready",
    owner_commitment: ownerCommitment,
    account_commitment: "account_commitment_0001",
    vault_commitment: "vault_commitment_0001",
    policy_commitment: "policy_commitment_0001",
    encrypted_execution_vault: { ciphertext: "sealed" },
  };
}

function riskMandate() {
  return {
    min_expected_net_benefit_bps: 1,
    exit_net_value_bps: 0,
    exit_after_consecutive_observations: 2,
    min_margin_runway_ms: 3_600_000,
    max_hedge_error_micro_usdc: 0,
    max_data_age_ms: 30_000,
    max_contract_data_skew_ms: 2_000,
    max_index_price_divergence_bps: 25,
    max_mark_price_divergence_bps: 50,
    allow_migration: false,
  };
}

function exactFeeEvidence() {
  return {
    fee_source: "test_account_fee_schedule",
    fees_exact_for_account: true,
    fees_conservative_upper_bound: false,
    liquidation_distance_bps: 2_500,
    liquidation_distance_verified: true,
    liquidation_distance_source: "test_position_snapshot",
  };
}

function flatInventory() {
  return {
    positions: [],
    open_orders: [],
    target_open_orders: [],
    position_inventory_verified: true,
    position_inventory_pagination_complete: true,
    position_inventory_has_more: false,
    open_order_inventory_verified: true,
    open_order_inventory_pagination_complete: true,
    open_order_inventory_has_more: false,
  };
}

function exactPositionInventory({ market, side, baseSize }) {
  return {
    ...flatInventory(),
    positions: [{ market, side, base_size: baseSize }],
  };
}

test("verifies the exact reduce-only exit sides and filled base quantities", async () => {
  const verified = [];
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 1,
    taker_fee_bps: 3,
    ...exactFeeEvidence(),
    position_count: 1,
    open_order_count: 0,
    ...exactPositionInventory({ market: "BTCUSDT", side: "short", baseSize: "0.002" }),
  };
  const exactBases = { hyperliquid: "0.001", aster: "0.002" };
  const result = await preflightCarryPair({
    body: {
      version: 1,
      phase: "exit",
      owner_commitment: "owner_commitment_0001",
      work_order_commitment: "carry_pair_exit_preflight_0001",
      asset: "BTC",
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
      notional_usd: 100,
      horizon_days: 30,
      exit_base_size_by_venue: exactBases,
      venue_access: { hyperliquid: access(), aster: access() },
    },
    recipient: {},
    state: {},
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => [snapshot(venue_id)],
    verifyOrder: async ({ venue_id, instruction, work_order_commitment }) => {
      verified.push({ venue_id, instruction });
      const order = instruction.order;
      return {
        status: "verified_ready",
        work_order_commitment,
        account_commitment: access().account_commitment,
        verification_commitment: `verification_exit_${venue_id}`,
        checks: { order_request_checked: true, transaction_broadcast: false },
        order_shape: {
          market: venue_id === "aster" ? "BTCUSDT" : "BTC",
          side: order.side,
          base_size: order.base_size,
          limit_price: order.limit_price || "100000",
          reduce_only: order.reduce_only,
          notional_micro_usdc: Math.round(Number(order.base_size) * 100_000 * 1_000_000),
          quantity_step_e8: 1_000,
          price_tick_e8: 1_000_000,
        },
        ...(venue_id === "aster" ? { account } : {}),
      };
    },
    readHyperliquidSnapshot: async () => ({
      status: "ready_to_trade",
      trading_enabled: true,
      position_count: 1,
      open_order_count: 0,
      ...exactPositionInventory({ market: "BTC", side: "long", baseSize: "0.001" }),
    }),
    readHyperliquidCarryMetrics: async () => account,
  });

  assert.equal(result.mode, "paired_exit_no_submit");
  assert.equal(result.no_submit_ready, true);
  assert.equal(result.live_creation_ready, false);
  assertPublicValuationBinding(result);
  assert.deepEqual(verified.map(({ venue_id: venueId, instruction }) => ({
    venue_id: venueId,
    side: instruction.order.side,
    base_size: instruction.order.base_size,
    reduce_only: instruction.order.reduce_only,
  })), [
    { venue_id: "hyperliquid", side: "sell", base_size: "0.001", reduce_only: true },
    { venue_id: "aster", side: "buy", base_size: "0.002", reduce_only: true },
  ]);
});

test("pairs authenticated no-submit evidence but blocks live creation until Aster recovery is proven", async () => {
  const verified = [];
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 1.05,
    taker_fee_bps: 3.15,
    ...exactFeeEvidence(),
    position_count: 0,
    open_order_count: 0,
    ...flatInventory(),
    liquidation_distance_bps: null,
    liquidation_distance_verified: false,
    liquidation_distance_source: null,
  };
  const result = await preflightCarryPair({
    body: {
      version: 1,
      owner_commitment: "owner_commitment_0001",
      work_order_commitment: "carry_pair_preflight_0001",
      asset: "BTC",
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
      notional_usd: 100,
      horizon_days: 30,
      venue_access: { hyperliquid: access(), aster: access() },
    },
    recipient: {},
    state: {},
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => [snapshot(venue_id)],
    verifyOrder: async ({ venue_id, instruction, work_order_commitment }) => {
      verified.push({ venue_id, instruction });
      return {
        status: "verified_ready",
        work_order_commitment,
        account_commitment: access().account_commitment,
        verification_commitment: `verification_${venue_id}`,
        checks: { order_request_built: true, transaction_broadcast: false },
        order_shape: venue_id === "hyperliquid"
          ? { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 100_000_000 }
          : { notional_micro_usdc: 99_900_000 },
        ...(venue_id === "aster" ? { account } : {}),
      };
    },
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0, ...flatInventory() }),
    readHyperliquidCarryMetrics: async () => account,
  });

  assert.equal(verified.length, 2);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.no_submit_ready, true);
  assert.equal(result.live_creation_ready, false);
  assert.equal(result.creation_opportunity.live_creation_ready, false);
  assert.equal(result.creation_opportunity.all_venues_ready, true);
  assert.equal(typeof result.creation_opportunity.long_margin_runway_ms, "number");
  assert.equal(result.creation_opportunity.input_evidence.version, 1);
  assertPublicValuationBinding(result);
  assert.deepEqual(result.creation_opportunity.input_evidence.legs.map((leg, index) => ({
    venue_id: leg.venue_id,
    side: leg.side,
    snapshot_bound: /^carry:shadow:snapshot:[0-9a-f]{64}$/.test(leg.shadow_snapshot_commitment),
    account_state_commitment: leg.account_state_commitment,
    verification_commitment: leg.verification_commitment,
    margin_model: leg.margin_model,
    liquidation_model: leg.liquidation_model,
    expected_account_state_commitment: result.account_readiness[index].account_state_commitment,
    expected_verification_commitment: result.evidence[index].verification_commitment,
  })), [
    {
      venue_id: "hyperliquid",
      side: "buy",
      snapshot_bound: true,
      account_state_commitment: result.account_readiness[0].account_state_commitment,
      verification_commitment: "verification_hyperliquid",
      margin_model: snapshot("hyperliquid").margin_model,
      liquidation_model: snapshot("hyperliquid").liquidation_model,
      expected_account_state_commitment: result.account_readiness[0].account_state_commitment,
      expected_verification_commitment: "verification_hyperliquid",
    },
    {
      venue_id: "aster",
      side: "sell",
      snapshot_bound: true,
      account_state_commitment: result.account_readiness[1].account_state_commitment,
      verification_commitment: "verification_aster",
      margin_model: snapshot("aster").margin_model,
      liquidation_model: snapshot("aster").liquidation_model,
      expected_account_state_commitment: result.account_readiness[1].account_state_commitment,
      expected_verification_commitment: "verification_aster",
    },
  ]);
  assert.ok(result.qualification_reasons.includes("venue_not_proven:aster"));
  assert.ok(result.qualification_reasons.includes("exact_quantity_recovery_unproven:aster"));
  assert.equal(result.account_readiness.every((item) => item.capital_ready), true);
  assert.deepEqual(result.account_readiness.map((item) => ({
    venue_id: item.venue_id,
    required: item.required_opening_collateral_micro_usdc,
    venue_minimum: item.venue_minimum_margin_micro_usdc,
    shortfall: item.opening_collateral_shortfall_micro_usdc,
    leverage: item.execution_leverage,
  })), [
    { venue_id: "hyperliquid", required: 100_000_000, venue_minimum: 10_000_000, shortfall: 0, leverage: 1 },
    { venue_id: "aster", required: 100_000_000, venue_minimum: 10_000_000, shortfall: 0, leverage: 1 },
  ]);
  assert.deepEqual(result.opening_capital_plan, {
    version: 1,
    status: "ready",
    total_available_balance_micro_usdc: 1_000_000_000,
    total_required_opening_collateral_micro_usdc: 200_000_000,
    total_opening_collateral_shortfall_micro_usdc: 0,
    total_excess_collateral_micro_usdc: 800_000_000,
    total_stress_adjusted_target_collateral_micro_usdc: 42_060_000,
    total_liquidation_fee_reserve_micro_usdc: 0,
    total_potential_releasable_collateral_micro_usdc: 157_940_000,
    proposal_only: true,
    live_execution_leverage_unchanged: true,
    owner_only_funding: true,
    automatic_transfer_permitted: false,
    transaction_broadcast: false,
    legs: [
      {
        venue_id: "hyperliquid",
        available_balance_micro_usdc: 500_000_000,
        required_opening_collateral_micro_usdc: 100_000_000,
        opening_collateral_shortfall_micro_usdc: 0,
        excess_collateral_micro_usdc: 400_000_000,
        recommended_action: "none",
        stress_adjusted_target_collateral_micro_usdc: 21_060_000,
        liquidation_fee_reserve_micro_usdc: 0,
        potential_releasable_collateral_micro_usdc: 78_940_000,
        owner_maximum_stress_adjusted_leverage: 4,
        owner_leverage_configuration_required: true,
      },
      {
        venue_id: "aster",
        available_balance_micro_usdc: 500_000_000,
        required_opening_collateral_micro_usdc: 100_000_000,
        opening_collateral_shortfall_micro_usdc: 0,
        excess_collateral_micro_usdc: 400_000_000,
        recommended_action: "none",
        stress_adjusted_target_collateral_micro_usdc: 21_000_000,
        liquidation_fee_reserve_micro_usdc: 0,
        potential_releasable_collateral_micro_usdc: 79_000_000,
        owner_maximum_stress_adjusted_leverage: 4,
        owner_leverage_configuration_required: true,
      },
    ],
  });
  assert.equal(result.economic_opportunity.projected_trading_cost_micro_usdc > 0, true);
});

test("rejects unlabeled numeric account fees from positive-net qualification", async () => {
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    position_count: 0,
    open_order_count: 0,
    ...flatInventory(),
  };
  const result = await preflightCarryPair({
    body: {
      version: 1,
      owner_commitment: "owner_commitment_fee_provenance_0001",
      work_order_commitment: "carry_pair_fee_provenance_0001",
      asset: "BTC",
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
      notional_usd: 100,
      horizon_days: 30,
      venue_access: {
        hyperliquid: access("owner_commitment_fee_provenance_0001"),
        aster: access("owner_commitment_fee_provenance_0001"),
      },
    },
    recipient: {},
    state: {},
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => [snapshot(venue_id)],
    verifyOrder: async ({ venue_id, work_order_commitment }) => ({
      status: "verified_ready",
      work_order_commitment,
      account_commitment: access().account_commitment,
      verification_commitment: `verification_${venue_id}`,
      checks: { order_request_checked: true, transaction_broadcast: false },
      order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
      account,
      authority_boundary: { venue_native_trade_only: true },
    }),
    readHyperliquidSnapshot: async () => ({
      status: "ready_to_trade",
      trading_enabled: true,
      position_count: 0,
      open_order_count: 0,
    }),
    readHyperliquidCarryMetrics: async () => account,
  });

  assert.equal(result.live_creation_ready, false);
  assert.ok(result.qualification_reasons.includes("account_fee_tier_unverified:hyperliquid"));
  assert.ok(result.qualification_reasons.includes("account_fee_tier_unverified:aster"));
  assert.deepEqual(result.evidence.map((leg) => leg.fee_evidence), [
    { source: null, exact_for_account: false, conservative_upper_bound: false },
    { source: null, exact_for_account: false, conservative_upper_bound: false },
  ]);
});

test("reports exact owner-funded opening shortfalls and never advertises releasable collateral", () => {
  const account = {
    can_trade: true,
    available_balance: 25,
    margin_balance: 25,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    ...exactFeeEvidence(),
    position_count: 0,
    open_order_count: 0,
    ...flatInventory(),
  };
  const evidence = [
    { venue_id: "hyperliquid", side: "buy", snapshot: snapshot("hyperliquid") },
    { venue_id: "aster", side: "sell", snapshot: snapshot("aster") },
  ].map((leg) => ({
    ...leg,
    account,
    account_snapshot: leg.venue_id === "hyperliquid"
      ? { status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0, ...flatInventory() }
      : null,
    receipt: {
      checks: { transaction_broadcast: false, order_request_checked: true },
      order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
    },
  }));
  const result = modelCarryPairPreflight({
    evidence,
    notional_usd: 100,
    horizon_days: 30,
    now_ms: NOW,
  });
  assert.equal(result.no_submit_ready, true);
  assert.equal(result.capital_ready, false);
  assert.deepEqual(result.account_readiness.map((item) => ({
    shortfall: item.opening_collateral_shortfall_micro_usdc,
    owner_only: item.owner_only_funding,
    leverage: item.execution_leverage,
  })), [
    { shortfall: 75_000_000, owner_only: true, leverage: 1 },
    { shortfall: 75_000_000, owner_only: true, leverage: 1 },
  ]);
  assert.deepEqual(result.opening_capital_plan, {
    version: 1,
    status: "owner_funding_required",
    total_available_balance_micro_usdc: 50_000_000,
    total_required_opening_collateral_micro_usdc: 200_000_000,
    total_opening_collateral_shortfall_micro_usdc: 150_000_000,
    total_excess_collateral_micro_usdc: 0,
    total_stress_adjusted_target_collateral_micro_usdc: 42_060_000,
    total_liquidation_fee_reserve_micro_usdc: 0,
    total_potential_releasable_collateral_micro_usdc: 0,
    proposal_only: true,
    live_execution_leverage_unchanged: true,
    owner_only_funding: true,
    automatic_transfer_permitted: false,
    transaction_broadcast: false,
    legs: [
      {
        venue_id: "hyperliquid",
        available_balance_micro_usdc: 25_000_000,
        required_opening_collateral_micro_usdc: 100_000_000,
        opening_collateral_shortfall_micro_usdc: 75_000_000,
        excess_collateral_micro_usdc: 0,
        recommended_action: "owner_fund_venue",
        stress_adjusted_target_collateral_micro_usdc: 21_060_000,
        liquidation_fee_reserve_micro_usdc: 0,
        potential_releasable_collateral_micro_usdc: 0,
        owner_maximum_stress_adjusted_leverage: 4,
        owner_leverage_configuration_required: true,
      },
      {
        venue_id: "aster",
        available_balance_micro_usdc: 25_000_000,
        required_opening_collateral_micro_usdc: 100_000_000,
        opening_collateral_shortfall_micro_usdc: 75_000_000,
        excess_collateral_micro_usdc: 0,
        recommended_action: "owner_fund_venue",
        stress_adjusted_target_collateral_micro_usdc: 21_000_000,
        liquidation_fee_reserve_micro_usdc: 0,
        potential_releasable_collateral_micro_usdc: 0,
        owner_maximum_stress_adjusted_leverage: 4,
        owner_leverage_configuration_required: true,
      },
    ],
  });
  const tighterRunway = modelCarryPairPreflight({
    evidence,
    notional_usd: 100,
    horizon_days: 30,
    now_ms: NOW,
    min_margin_runway_ms: 12 * 3_600_000,
  });
  assert.equal(tighterRunway.opening_capital_plan.total_stress_adjusted_target_collateral_micro_usdc, 54_120_000);
  assert.deepEqual(
    tighterRunway.opening_capital_plan.legs.map((leg) => leg.owner_maximum_stress_adjusted_leverage),
    [3, 3],
  );
});

test("uses the stronger maintenance requirement without double-counting venue totals", () => {
  const account = (maintenanceMargin) => ({
    can_trade: true,
    available_balance: 100,
    margin_balance: 100,
    maintenance_margin: maintenanceMargin,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    ...exactFeeEvidence(),
    position_count: 1,
    open_order_count: 0,
  });
  const evidence = [
    { venue_id: "hyperliquid", side: "buy", account: account(8) },
    { venue_id: "aster", side: "sell", account: account(0) },
  ].map((leg) => ({
    ...leg,
    snapshot: snapshot(leg.venue_id),
    account_snapshot: leg.venue_id === "hyperliquid"
      ? { status: "ready_to_trade", trading_enabled: true, position_count: 1, open_order_count: 0 }
      : null,
    receipt: {
      checks: { transaction_broadcast: false, order_request_checked: true },
      order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
    },
  }));
  const result = modelCarryPairPreflight({
    evidence,
    notional_usd: 100,
    horizon_days: 30,
    now_ms: NOW,
    phase: "monitoring",
  });
  assert.deepEqual(result.margin_runways.map((runway) => ({
    venue_id: runway.venue_id,
    maintenance: runway.maintenance_margin_micro_usdc,
    reported: runway.reported_maintenance_margin_micro_usdc,
    floor: runway.contract_maintenance_floor_micro_usdc,
    basis: runway.maintenance_evidence_basis,
  })), [
    { venue_id: "hyperliquid", maintenance: 8_000_000, reported: 8_000_000, floor: 5_000_000, basis: "venue_account_total" },
    { venue_id: "aster", maintenance: 5_000_000, reported: 0, floor: 5_000_000, basis: "contract_spec_floor" },
  ]);
});

test("reserves liquidation fees and fails monitoring closed without verified distance", () => {
  const account = {
    can_trade: true,
    available_balance: 100,
    margin_balance: 100,
    maintenance_margin: 0,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    ...exactFeeEvidence(),
    position_count: 1,
    open_order_count: 0,
  };
  const evidence = [
    { venue_id: "hyperliquid", side: "buy" },
    { venue_id: "lighter", side: "sell" },
  ].map((leg) => ({
    ...leg,
    account: {
      ...account,
      liquidation_distance_source: liquidationDistanceSourceForVenue(leg.venue_id),
    },
    snapshot: { ...snapshot(leg.venue_id), liquidation_fee_bps: 25 },
    account_snapshot: leg.venue_id === "hyperliquid"
      ? { status: "ready_to_trade", trading_enabled: true, position_count: 1, open_order_count: 0 }
      : null,
    receipt: {
      checks: { transaction_broadcast: false, order_request_checked: true },
      order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
    },
  }));
  const opening = modelCarryPairPreflight({ evidence, notional_usd: 100, horizon_days: 30, now_ms: NOW });
  assert.equal(opening.opening_capital_plan.total_liquidation_fee_reserve_micro_usdc, 500_000);
  assert.equal(opening.opportunity.liquidation_fee_risk_micro_usdc, 500_000);

  evidence[0].account.liquidation_distance_source = liquidationDistanceSourceForVenue("lighter");
  const swappedSource = modelCarryPairPreflight({
    evidence,
    notional_usd: 100,
    horizon_days: 30,
    now_ms: NOW,
    phase: "monitoring",
  });
  assert.equal(swappedSource.margin_runways[0].liquidation_distance_verified, false);
  assert.equal(swappedSource.margin_runways[0].status, "breached");

  delete evidence[0].account.liquidation_distance_bps;
  delete evidence[0].account.liquidation_distance_verified;
  delete evidence[0].account.liquidation_distance_source;
  const monitoring = modelCarryPairPreflight({
    evidence,
    notional_usd: 100,
    horizon_days: 30,
    now_ms: NOW,
    phase: "monitoring",
  });
  assert.equal(monitoring.margin_runways[0].status, "breached");
  assert.equal(monitoring.margin_runways[0].liquidation_distance_verified, false);
  assert.ok(monitoring.opportunity.reasons.includes("margin_runway_insufficient:hyperliquid"));
});

test("prices entry and exit from notional-weighted depth without whole-bp rounding", async () => {
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 0,
    taker_fee_bps: 0,
    ...exactFeeEvidence(),
    position_count: 0,
    open_order_count: 0,
    ...flatInventory(),
  };
  const result = await preflightCarryPair({
    body: {
      version: 1,
      owner_commitment: "owner_commitment_slippage_0001",
      work_order_commitment: "carry_pair_slippage_0001",
      asset: "BTC",
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
      notional_usd: 100,
      horizon_days: 30,
      venue_access: {
        hyperliquid: access("owner_commitment_slippage_0001"),
        aster: access("owner_commitment_slippage_0001"),
      },
    },
    recipient: {},
    state: {},
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => {
      const value = snapshot(venue_id);
      const bestBid = venue_id === "hyperliquid"
        ? value.mark_price_e8 - 750_000_000
        : value.mark_price_e8 - 1_250_000_000;
      const bestAsk = venue_id === "hyperliquid"
        ? value.mark_price_e8 + 250_000_000
        : value.mark_price_e8 + 500_000_000;
      return [{
        ...value,
        best_bid_e8: bestBid,
        best_ask_e8: bestAsk,
        depth_bids: [{ price_e8: bestBid, size_e8: 100_000_000 }],
        depth_asks: venue_id === "hyperliquid"
          ? [
              { price_e8: bestAsk, size_e8: 50_000 },
              { price_e8: value.mark_price_e8 + 1_250_000_000, size_e8: 50_000 },
            ]
          : [{ price_e8: bestAsk, size_e8: 100_000_000 }],
      }];
    },
    verifyOrder: async ({ venue_id, work_order_commitment }) => ({
      status: "verified_ready",
      work_order_commitment,
      account_commitment: access().account_commitment,
      verification_commitment: `verification_${venue_id}`,
      checks: { order_request_checked: true, transaction_broadcast: false },
      order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
      account,
      authority_boundary: { venue_native_trade_only: true },
    }),
    readHyperliquidSnapshot: async () => ({
      status: "ready_to_trade",
      trading_enabled: true,
      position_count: 0,
      open_order_count: 0,
    }),
    readHyperliquidCarryMetrics: async () => account,
  });

  // 3.25 bps of depth-weighted spread plus one 1 bp latency penalty per leg.
  assert.equal(result.economic_opportunity.projected_trading_cost_micro_usdc, 52_500);
  assert.equal(result.economic_opportunity.depth_impact[0].observations[0].status, "sufficient");
  assert.equal(result.economic_opportunity.depth_impact[0].observations[0].execution_price_e8, 10_000_749_964_998);
});

test("fails carry economics closed when displayed depth cannot fill the target notional", async () => {
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    maintenance_margin: 0,
    maker_fee_bps: 0,
    taker_fee_bps: 0,
    ...exactFeeEvidence(),
    position_count: 0,
    open_order_count: 0,
  };
  const result = await preflightCarryPair({
    body: {
      version: 1,
      owner_commitment: "owner_commitment_depth_0001",
      work_order_commitment: "carry_pair_depth_0001",
      asset: "BTC",
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
      notional_usd: 100,
      horizon_days: 30,
      venue_access: {
        hyperliquid: access("owner_commitment_depth_0001"),
        aster: access("owner_commitment_depth_0001"),
      },
    },
    recipient: {},
    state: {},
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => {
      const value = snapshot(venue_id);
      return venue_id === "aster"
        ? [{ ...value, depth_bids: [{ ...value.depth_bids[0], size_e8: 1 }], depth_asks: [{ ...value.depth_asks[0], size_e8: 1 }] }]
        : [value];
    },
    verifyOrder: async ({ venue_id, work_order_commitment }) => ({
      status: "verified_ready",
      work_order_commitment,
      account_commitment: access().account_commitment,
      verification_commitment: `verification_${venue_id}`,
      checks: { order_request_checked: true, transaction_broadcast: false },
      order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
      account,
      authority_boundary: { venue_native_trade_only: true },
    }),
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0, ...flatInventory() }),
    readHyperliquidCarryMetrics: async () => account,
  });

  assert.equal(result.economic_opportunity.eligible, false);
  assert.ok(result.economic_opportunity.reasons.includes("depth_insufficient:aster:entry"));
  assert.ok(result.economic_opportunity.reasons.includes("depth_insufficient:aster:exit"));
});

test("rejects cross-venue market data skew before account or order verification", async () => {
  let verified = false;
  await assert.rejects(
    preflightCarryPair({
      body: {
        version: 1,
        owner_commitment: "owner_commitment_skew_0001",
        work_order_commitment: "carry_pair_skew_0001",
        asset: "BTC",
        long_venue_id: "hyperliquid",
        short_venue_id: "aster",
        notional_usd: 100,
        horizon_days: 30,
        venue_access: {
          hyperliquid: access("owner_commitment_skew_0001"),
          aster: access("owner_commitment_skew_0001"),
        },
      },
      recipient: {},
      state: {},
      env: { PRIVATE_AGENT_CARRY_MAX_MARKET_DATA_SKEW_MS: "2000" },
      now: () => NOW,
      fetchVenue: async ({ venue_id }) => [{
        ...snapshot(venue_id),
        as_of_ms: venue_id === "aster" ? NOW - 5_000 : NOW,
      }],
      verifyOrder: async () => { verified = true; },
    }),
    (error) => error?.code === "carry_market_data_skew_exceeded",
  );
  assert.equal(verified, false);
});

test("rejects same-ticker contract basis divergence before account or order verification", async () => {
  let verified = false;
  await assert.rejects(
    preflightCarryPair({
      body: {
        version: 1,
        owner_commitment: "owner_commitment_basis_0001",
        work_order_commitment: "carry_pair_basis_0001",
        asset: "BTC",
        long_venue_id: "hyperliquid",
        short_venue_id: "aster",
        notional_usd: 100,
        horizon_days: 30,
        venue_access: {
          hyperliquid: access("owner_commitment_basis_0001"),
          aster: access("owner_commitment_basis_0001"),
        },
      },
      recipient: {},
      state: {},
      env: {
        PRIVATE_AGENT_CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS: "25",
        PRIVATE_AGENT_CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS: "50",
      },
      now: () => NOW,
      fetchVenue: async ({ venue_id }) => [{
        ...snapshot(venue_id),
        index_price_e8: venue_id === "aster" ? 10_050_000_000_000 : 10_000_000_000_000,
      }],
      verifyOrder: async () => { verified = true; },
    }),
    (error) => error?.code === "carry_contract_equivalence_failed:index_price_divergence_exceeded",
  );
  assert.equal(verified, false);
});

test("rejects no-submit evidence returned for a different sealed account", async () => {
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    ...exactFeeEvidence(),
    position_count: 0,
    open_order_count: 0,
    ...flatInventory(),
  };
  await assert.rejects(
    preflightCarryPair({
      body: {
        version: 1,
        owner_commitment: "owner_commitment_binding_0001",
        work_order_commitment: "carry_pair_binding_0001",
        asset: "BTC",
        long_venue_id: "hyperliquid",
        short_venue_id: "aster",
        notional_usd: 100,
        horizon_days: 30,
        venue_access: {
          hyperliquid: access("owner_commitment_binding_0001"),
          aster: access("owner_commitment_binding_0001"),
        },
      },
      recipient: {},
      state: {},
      now: () => NOW,
      fetchVenue: async ({ venue_id }) => [snapshot(venue_id)],
      verifyOrder: async ({ venue_id, work_order_commitment }) => ({
        status: "verified_ready",
        work_order_commitment,
        account_commitment: venue_id === "aster" ? "account_commitment_wrong_0001" : access().account_commitment,
        verification_commitment: `verification_${venue_id}`,
        checks: { order_request_checked: true, transaction_broadcast: false },
        order_shape: { notional_micro_usdc: 100_000_000 },
        account,
      }),
      readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0 }),
      readHyperliquidCarryMetrics: async () => account,
    }),
    (error) => error?.code === "carry_account_verification_mismatch:aster",
  );
});

test("monitoring measures a signed basis breach without submitting or hiding it as unavailable", async () => {
  let verified = 0;
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    ...exactFeeEvidence(),
    position_count: 1,
    open_order_count: 0,
  };
  const result = await preflightCarryPair({
    body: {
      version: 1,
      phase: "monitoring",
      owner_commitment: "owner_commitment_monitor_basis_0001",
      work_order_commitment: "carry_pair_monitor_basis_0001",
      asset: "BTC",
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
      notional_usd: 100,
      horizon_days: 30,
      risk_mandate: riskMandate(),
      venue_access: {
        hyperliquid: access("owner_commitment_monitor_basis_0001"),
        aster: access("owner_commitment_monitor_basis_0001"),
      },
    },
    recipient: {},
    state: {},
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => [{
      ...snapshot(venue_id),
      index_price_e8: venue_id === "aster" ? 10_050_000_000_000 : 10_000_000_000_000,
    }],
    verifyOrder: async ({ venue_id, work_order_commitment }) => {
      verified += 1;
      return {
        status: "verified_ready",
        work_order_commitment,
        account_commitment: access().account_commitment,
        verification_commitment: `verification_${venue_id}`,
        checks: { order_request_checked: true, transaction_broadcast: false },
        order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
        account,
        authority_boundary: { venue_native_trade_only: true },
      };
    },
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 1, open_order_count: 0 }),
    readHyperliquidCarryMetrics: async () => account,
  });
  assert.equal(verified, 2);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.economic_opportunity.index_price_divergence_bps, 50);
  assert.equal(result.economic_opportunity.max_index_price_divergence_bps, 25);
  assert.match(
    result.economic_opportunity.funding_observation.evidence_commitment,
    /^carry:funding:current:[a-f0-9]{64}$/,
  );
  assert.deepEqual(result.economic_opportunity.funding_observation.source_observed_at_ms_by_venue, {
    hyperliquid: NOW,
    aster: NOW,
  });
  assert.equal(result.economic_opportunity.eligible, false);
  assert.ok(result.economic_opportunity.reasons.includes("index_price_divergence_exceeded"));
});

test("migration preflight applies signed opening limits and never broadcasts", async () => {
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 1,
    taker_fee_bps: 3,
    ...exactFeeEvidence(),
    position_count: 0,
    open_order_count: 0,
    ...flatInventory(),
  };
  const result = await preflightCarryPair({
    body: {
      version: 1,
      phase: "migration",
      owner_commitment: "owner_commitment_migration_0001",
      work_order_commitment: "carry_pair_migration_0001",
      asset: "BTC",
      long_venue_id: "hyperliquid",
      short_venue_id: "lighter",
      notional_usd: 100,
      horizon_days: 30,
      risk_mandate: riskMandate(),
      venue_access: {
        hyperliquid: access("owner_commitment_migration_0001"),
        lighter: access("owner_commitment_migration_0001"),
      },
    },
    recipient: {},
    state: {},
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => [snapshot(venue_id)],
    verifyOrder: async ({ venue_id, work_order_commitment }) => ({
      status: "verified_ready",
      work_order_commitment,
      account_commitment: access().account_commitment,
      verification_commitment: `verification_${venue_id}`,
      checks: { order_request_checked: true, transaction_broadcast: false },
      order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
      account,
      authority_boundary: { venue_native_trade_only: true },
    }),
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0, ...flatInventory() }),
    readHyperliquidCarryMetrics: async () => account,
  });
  assert.equal(result.mode, "paired_migration_no_submit");
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.no_submit_ready, true);
  assert.equal(result.capital_ready, true);
  assert.equal(result.economic_opportunity.max_contract_data_skew_ms, 2_000);
});

test("rejects cross-owner sealed venue access before order verification", async () => {
  let verified = false;
  await assert.rejects(
    preflightCarryPair({
      body: {
        version: 1,
        owner_commitment: "owner_commitment_other",
        work_order_commitment: "carry_pair_owner_mismatch",
        asset: "BTC",
        long_venue_id: "hyperliquid",
        short_venue_id: "aster",
        notional_usd: 100,
        horizon_days: 30,
        venue_access: { hyperliquid: access(), aster: access() },
      },
      recipient: {},
      state: {},
      now: () => NOW,
      fetchVenue: async ({ venue_id }) => [snapshot(venue_id)],
      verifyOrder: async () => { verified = true; },
    }),
    (error) => error?.code === "carry_account_owner_mismatch:hyperliquid",
  );
  assert.equal(verified, false);
});

test("accepts Lighter's owner-destination custody boundary and conservative fee ceiling", async () => {
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 0,
    taker_fee_bps: 0,
    ...exactFeeEvidence(),
    position_count: 0,
    open_order_count: 0,
    ...flatInventory(),
  };
  const result = await preflightCarryPair({
    body: {
      version: 1,
      owner_commitment: "owner_commitment_0002",
      work_order_commitment: "carry_pair_preflight_0002",
      asset: "BTC",
      long_venue_id: "hyperliquid",
      short_venue_id: "lighter",
      notional_usd: 100,
      horizon_days: 30,
      venue_access: { hyperliquid: access("owner_commitment_0002"), lighter: access("owner_commitment_0002") },
    },
    recipient: {},
    state: {},
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => [snapshot(venue_id)],
    verifyOrder: async ({ venue_id, instruction, work_order_commitment }) => ({
      status: "verified_ready",
      work_order_commitment,
      account_commitment: access().account_commitment,
      verification_commitment: `verification_${venue_id}`,
      checks: { order_request_checked: true, transaction_broadcast: false },
      order_shape: { notional_micro_usdc: 99_900_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
      ...(venue_id === "lighter" ? {
        account: { ...account, fees_exact_for_account: false, fees_conservative_upper_bound: true },
        authority_boundary: {
          venue_native_trade_only: false,
          withdrawal_request_permitted: false,
          secure_withdrawal_destination: "owner_l1_only",
          owner_wallet_key_present: false,
          non_owner_fund_movement_possible: false,
        },
      } : {}),
      instruction_venue: instruction.venue_id,
    }),
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0, ...flatInventory() }),
    readHyperliquidCarryMetrics: async () => account,
  });

  assert.equal(result.no_submit_ready, true);
  assert.equal(result.live_creation_ready, false);
  assert.equal(result.qualification_reasons.includes("credential_authority_boundary_unacceptable:lighter"), false);
  assert.equal(result.qualification_reasons.includes("account_fee_tier_unverified:lighter"), false);
  assert.ok(result.qualification_reasons.includes("venue_not_proven:lighter"));
  assert.ok(result.qualification_reasons.includes("exact_quantity_recovery_unproven:lighter"));
  assert.equal(result.evidence.find((item) => item.venue_id === "lighter").authority_boundary.venue_native_trade_only, false);
});

test("verifies all three execution venues through one no-broadcast matrix", async () => {
  const calls = [];
  const rows = new Map();
  let nowCalls = 0;
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 0,
    taker_fee_bps: 1,
    ...exactFeeEvidence(),
    position_count: 0,
    open_order_count: 0,
    ...flatInventory(),
    liquidation_distance_bps: null,
    liquidation_distance_verified: false,
    liquidation_distance_source: null,
  };
  const result = await preflightCarryExecutionMatrix({
    body: {
      version: 1,
      owner_commitment: "owner_commitment_matrix_0001",
      operation_class: "matrix_no_submit",
      work_order_commitment: "carry_matrix_preflight_0001",
      asset: "BTC",
      notional_usd: 100,
      horizon_days: 30,
      selected_long_venue_id: "lighter",
      selected_short_venue_id: "hyperliquid",
      venue_access: {
        hyperliquid: access("owner_commitment_matrix_0001"),
        aster: access("owner_commitment_matrix_0001"),
        lighter: access("owner_commitment_matrix_0001"),
      },
    },
    recipient: {},
    state: {
      putIdempotency: async (key, receipt) => { rows.set(key, { receipt }); return receipt; },
    },
    env: { PHALA_CVM_IMAGE_DIGEST: "sha256:abcdef123456" },
    now: () => {
      nowCalls += 1;
      return NOW;
    },
    fetchVenue: async ({ venue_id }) => [snapshot(venue_id)],
    verifyOrder: async ({ venue_id, instruction, work_order_commitment }) => {
      calls.push({ venue_id, side: instruction.order.side });
      return {
        status: "verified_ready",
        work_order_commitment,
        account_commitment: access().account_commitment,
        verification_commitment: `verification_matrix_${venue_id}_${calls.length}`,
        checks: { order_request_checked: true, transaction_broadcast: false },
        order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
        account,
        ...(venue_id === "lighter" ? {
          authority_boundary: {
            venue_native_trade_only: false,
            withdrawal_request_permitted: false,
            secure_withdrawal_destination: "owner_l1_only",
            owner_wallet_key_present: false,
            non_owner_fund_movement_possible: false,
          },
        } : { authority_boundary: { venue_native_trade_only: true } }),
      };
    },
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0, ...flatInventory() }),
    readHyperliquidCarryMetrics: async () => account,
  });

  assert.equal(result.no_submit_ready, true);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.capital_ready, true);
  assert.deepEqual(result.venues.map((item) => item.venue_id).sort(), ["aster", "hyperliquid", "lighter"]);
  assert.equal(result.venues.every((item) => item.checks.transaction_broadcast === false), true);
  assert.equal(result.pairs.length, 3);
  assert.equal(result.pairs.flatMap((pair) => pair.result?.evidence || []).every((item) =>
    item.account_state.liquidation_distance_bps === null
    && item.account_state.liquidation_distance_verified === false
    && item.account_state.liquidation_distance_source === null), true);
  assert.equal(result.selected_pair.long_venue_id, "lighter");
  assert.equal(result.selected_pair.short_venue_id, "hyperliquid");
  assert.equal(result.selected_pair.transaction_broadcast, false);
  assert.equal(result.selected_pair.error_code, null);
  assert.equal(result.selected_pair.result.no_submit_ready, true);
  assert.equal(result.selected_pair.result.creation_opportunity.worker_authentication.attestation_bound, true);
  assert.equal(result.pairs.some((pair) => pair.long_venue_id === "lighter" && pair.short_venue_id === "hyperliquid"), true);
  assert.deepEqual(result.pairs.map((pair) => [pair.long_venue_id, pair.short_venue_id].sort().join(":")).sort(), [
    "aster:hyperliquid",
    "aster:lighter",
    "hyperliquid:lighter",
  ]);
  assert.equal(result.pairs.every((pair) => pair.leg_evidence.length === 2), true);
  assert.equal(result.pairs.every((pair) => pair.leg_evidence.every((leg) =>
    leg.account_state.position_count === 0
    && leg.account_state.open_order_count === 0
    && leg.account_state.flat_zero_orders === true
    && leg.account_state.checked_at_ms === NOW
    && leg.account_state.account_state_commitment.startsWith("carry:account-state:")
  )), true);
  assert.equal(result.pairs.every((pair) => pair.capital_ready === true && pair.account_readiness.length === 2), true);
  assert.equal(result.pairs.every((pair, index) =>
    pair.work_order_commitment === `carry_matrix_preflight_0001_pair_${index + 1}`
    && pair.leg_evidence.every((leg) => leg.work_order_commitment === `${pair.work_order_commitment}_${leg.venue_id}`)
  ), true);
  assert.equal(result.venues.every((venue) => venue.verification_commitments.length === 2), true);
  assert.equal(result.venues.every((venue) => venue.account_state_commitments.length === 2), true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.readiness.ready, true);
  assert.equal(result.readiness.capital_ready, true);
  assert.equal(result.readiness.owner_commitment, "owner_commitment_matrix_0001");
  assert.equal(result.readiness.image_digest, "sha256:abcdef123456");
  assert.equal(result.readiness_evidence.kind, "carry_execution_no_submit_readiness");
  assert.equal(result.readiness_evidence.evidence_commitment, result.readiness.evidence_commitment);
  assert.equal(result.readiness_evidence.pairs.length, 3);
  assert.equal(result.readiness_evidence.pairs.every((pair) => pair.transaction_broadcast === false), true);
  assert.equal(result.diagnostic_persisted, true);
  assert.equal(result.diagnostic.diagnostic_only, true);
  assert.equal(result.diagnostic.reusable_for_readiness, false);
  assert.equal(rows.size, 2);
  assert.equal(new Set(calls.map((call) => call.venue_id)).size, 3);
  assert.equal(result.checked_at, new Date(NOW).toISOString());
  assert.equal(nowCalls, 1);
});

test("isolates failed pairs without discarding successful no-submit evidence or retrying, including ambiguous venue failures", async () => {
  const calls = [];
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 0,
    taker_fee_bps: 1,
    ...exactFeeEvidence(),
    position_count: 0,
    open_order_count: 0,
    ...flatInventory(),
  };
  const result = await preflightCarryExecutionMatrix({
    body: {
      version: 1,
      owner_commitment: "owner_commitment_matrix_partial_0001",
      operation_class: "matrix_no_submit",
      work_order_commitment: "carry_matrix_partial_0001",
      asset: "BTC",
      notional_usd: 100,
      horizon_days: 30,
      venue_access: {
        hyperliquid: access("owner_commitment_matrix_partial_0001"),
        aster: access("owner_commitment_matrix_partial_0001"),
        lighter: access("owner_commitment_matrix_partial_0001"),
      },
    },
    recipient: {},
    state: {},
    env: { PHALA_CVM_IMAGE_DIGEST: "sha256:abcdef123456" },
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => [snapshot(venue_id)],
    verifyOrder: async ({ venue_id, work_order_commitment }) => {
      calls.push(work_order_commitment);
      if (venue_id === "aster") {
        throw Object.assign(new Error("submission_outcome_ambiguous"), {
          code: "submission_outcome_ambiguous",
        });
      }
      return {
        status: "verified_ready",
        work_order_commitment,
        account_commitment: access().account_commitment,
        verification_commitment: `verification_partial_${work_order_commitment}`,
        checks: { order_request_checked: true, transaction_broadcast: false },
        order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
        account,
        ...(venue_id === "lighter" ? {
          authority_boundary: {
            venue_native_trade_only: false,
            withdrawal_request_permitted: false,
            secure_withdrawal_destination: "owner_l1_only",
            owner_wallet_key_present: false,
            non_owner_fund_movement_possible: false,
          },
        } : { authority_boundary: { venue_native_trade_only: true } }),
      };
    },
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0, ...flatInventory() }),
    readHyperliquidCarryMetrics: async () => account,
  });

  assert.equal(result.no_submit_ready, false);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.readiness, undefined);
  assert.equal(result.pairs.length, 3);
  assert.equal(result.pairs.filter((pair) => pair.no_submit_ready).length, 1);
  assert.equal(result.pairs.find((pair) => pair.no_submit_ready).leg_evidence.length, 2);
  assert.equal(result.pairs.filter((pair) => pair.error_code === "submission_outcome_ambiguous:aster").length, 2);
  const failedPairIndexes = result.pairs.flatMap((pair, index) =>
    pair.error_code === "submission_outcome_ambiguous:aster" ? [index + 1] : []);
  assert.deepEqual(
    result.failures.filter((failure) => failure.startsWith("pair_check_failed:")),
    failedPairIndexes.map((index) => `pair_check_failed:${index}:submission_outcome_ambiguous:aster`),
  );
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls).size, 6);
});

test("persists the exact venue when a completed pair reports authorization unavailable", async () => {
  const calls = [];
  const rows = new Map();
  const readyAccount = {
    can_trade: true,
    available_balance: 0,
    margin_balance: 0,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 0,
    taker_fee_bps: 1,
    ...exactFeeEvidence(),
    position_count: 0,
    open_order_count: 0,
  };
  const result = await preflightCarryExecutionMatrix({
    body: {
      version: 1,
      owner_commitment: "owner_commitment_matrix_unready_0001",
      operation_class: "matrix_no_submit",
      work_order_commitment: "carry_matrix_unready_0001",
      asset: "BTC",
      notional_usd: 100,
      horizon_days: 30,
      venue_access: {
        hyperliquid: access("owner_commitment_matrix_unready_0001"),
        aster: access("owner_commitment_matrix_unready_0001"),
        lighter: access("owner_commitment_matrix_unready_0001"),
      },
    },
    recipient: {},
    state: {
      putIdempotency: async (key, receipt) => { rows.set(key, { receipt }); return receipt; },
    },
    env: { PHALA_CVM_IMAGE_DIGEST: "sha256:abcdef123456" },
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => [snapshot(venue_id)],
    verifyOrder: async ({ venue_id, work_order_commitment }) => {
      calls.push(work_order_commitment);
      const account = venue_id === "aster" ? { ...readyAccount, can_trade: false } : readyAccount;
      return {
        status: "verified_ready",
        work_order_commitment,
        account_commitment: access().account_commitment,
        verification_commitment: `verification_unready_${work_order_commitment}`,
        checks: { order_request_checked: true, transaction_broadcast: false },
        order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
        account,
        ...(venue_id === "lighter" ? {
          authority_boundary: {
            venue_native_trade_only: false,
            withdrawal_request_permitted: false,
            secure_withdrawal_destination: "owner_l1_only",
            owner_wallet_key_present: false,
            non_owner_fund_movement_possible: false,
          },
        } : { authority_boundary: { venue_native_trade_only: true } }),
      };
    },
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0 }),
    readHyperliquidCarryMetrics: async () => readyAccount,
  });

  assert.equal(result.no_submit_ready, false);
  assert.equal(result.capital_ready, false);
  assert.equal(result.diagnostic_persisted, true);
  assert.equal(result.pairs.filter((pair) => pair.error_code === "carry_account_not_ready:aster").length, 2);
  assert.equal(result.diagnostic.pairs.filter((pair) => pair.error_code === "carry_account_not_ready:aster").length, 2);
  assert.equal(result.failures.filter((failure) => failure.endsWith(":carry_account_not_ready:aster")).length, 2);
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls).size, 6);
  assert.equal(rows.size, 1);
});

test("enables an economically eligible Aster pair only after deployment-bound qualification", async () => {
  const image = "sha256:abcdef123456";
  const rows = new Map();
  const state = {
    getIdempotency: async (key) => rows.get(key) || null,
    putIdempotency: async (key, receipt) => { rows.set(key, { receipt }); return receipt; },
  };
  await storeCarryVenueQualification({
    state,
    now_ms: NOW,
    env: { PRIVATE_AGENT_IMAGE_DIGEST: image },
    evidence: {
      version: 1,
      venue_id: "aster",
      owner_commitment: "owner_commitment_qualification_0001",
      carry_position_id: "carry_position_qualification_0001",
      account_commitment: access().account_commitment,
      adapter_id: executionVenueSpec("aster").exact_quantity_recovery_adapter,
      image_digest: image,
      network: "mainnet",
      verified_at_ms: NOW,
      no_submit: { account_commitment: access().account_commitment, transaction_broadcast: false, account_state_checked: true, order_request_checked: true, evidence_commitment: "no_submit_aster_0001" },
      entry_reconciliation: { account_commitment: access().account_commitment, live_order_broadcast: true, target_client_order_matched: true, final_venue_execution_proven: true, target_fill_set_complete: true, filled_base_size: "0.001", evidence_commitment: "entry_aster_0001" },
      exit_recovery: { account_commitment: access().account_commitment, live_order_broadcast: true, reduce_only: true, exact_base_quantity: true, final_venue_execution_proven: true, target_fill_set_complete: true, account_state_checked: true, gross_exposure_micro_usdc: 0, open_order_count: 0, evidence_commitment: "exit_aster_0001" },
      submission_attempts: {
        entry: { work_order_commitment: "work:carry:entry:aster:0001", account_commitment: access().account_commitment, submit_count: 1, ambiguity_retry_count: 0, evidence_commitment: "attempt:entry:aster:0001" },
        exit: { work_order_commitment: "work:carry:exit:aster:0001", account_commitment: access().account_commitment, submit_count: 1, ambiguity_retry_count: 0, evidence_commitment: "attempt:exit:aster:0001" },
      },
      ambiguous_submission_retry_count: 0,
      authority_boundary_acceptable: true,
      authority_evidence_commitment: "authority_aster_0001",
    },
  });
  const account = {
    can_trade: true,
    available_balance: 500,
    margin_balance: 500,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 0,
    taker_fee_bps: 0,
    ...exactFeeEvidence(),
    position_count: 0,
    open_order_count: 0,
    ...flatInventory(),
  };
  const preflightInput = {
    body: {
      version: 1,
      owner_commitment: "owner_commitment_0003",
      work_order_commitment: "carry_pair_preflight_0003",
      asset: "BTC",
      long_venue_id: "hyperliquid",
      short_venue_id: "aster",
      notional_usd: 100,
      horizon_days: 30,
      venue_access: { hyperliquid: access("owner_commitment_0003"), aster: access("owner_commitment_0003") },
    },
    recipient: {},
    env: {
      PRIVATE_AGENT_IMAGE_DIGEST: image,
      PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MIN_SAMPLES: "1",
      PRIVATE_AGENT_CARRY_FUNDING_PERSISTENCE_MIN_SPAN_MS: "0",
    },
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => [{
      ...snapshot(venue_id),
      funding_rate_e12_per_interval: venue_id === "aster" ? 2_000_000_000 : 0,
    }],
    verifyOrder: async ({ venue_id, work_order_commitment }) => ({
      status: "verified_ready",
      work_order_commitment,
      account_commitment: access().account_commitment,
      verification_commitment: `verification_${venue_id}`,
      checks: { order_request_checked: true, transaction_broadcast: false, account_state_checked: true },
      order_shape: { market: "BTC-USD", base_size: "0.001", limit_price: "100000", notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
      account,
      authority_boundary: { venue_native_trade_only: true },
    }),
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0, ...flatInventory() }),
    readHyperliquidCarryMetrics: async () => account,
  };
  const result = await preflightCarryPair({ ...preflightInput, state });

  assert.equal(result.collateral_basis.supported, true);
  assert.equal(result.economic_opportunity.collateral_basis_mode, "usdc_usdt_stress_buffer");
  assert.equal(result.economic_opportunity.collateral_basis_risk_bps, 50);
  assert.equal(result.qualification_reasons.length, 0);
  assert.equal(result.live_creation_ready, true);
  const missingBoundary = await preflightCarryPair({
    ...preflightInput,
    state,
    verifyOrder: async (input) => {
      const receipt = await preflightInput.verifyOrder(input);
      if (input.venue_id !== "hyperliquid") return receipt;
      const { authority_boundary: _authorityBoundary, ...withoutBoundary } = receipt;
      return withoutBoundary;
    },
  });
  assert.equal(missingBoundary.live_creation_ready, false);
  assert.ok(missingBoundary.qualification_reasons.includes("credential_authority_boundary_unacceptable:hyperliquid"));
  rows.clear();
  const disabledPilot = await preflightCarryPair({ ...preflightInput, state });
  assert.equal(disabledPilot.qualification_pilot_ready, false);
  const pilot = await preflightCarryPair({
    ...preflightInput,
    state,
    env: {
      ...preflightInput.env,
      PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED: "true",
    },
  });
  assert.equal(pilot.live_creation_ready, false);
  assert.equal(pilot.qualification_pilot_ready, true);
  assert.equal(pilot.qualification_pilot_candidate_venue_id, "aster");
});
