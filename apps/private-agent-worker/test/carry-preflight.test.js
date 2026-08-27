import assert from "node:assert/strict";
import test from "node:test";
import { executionVenueSpec } from "@ghola/execution-core";
import {
  modelCarryPairPreflight,
  preflightCarryExecutionMatrix,
  preflightCarryPair,
} from "../src/execution/carry-preflight.js";
import { storeCarryVenueQualification } from "../src/execution/carry-qualification.js";

const NOW = 1_800_000_000_000;

function snapshot(venueId) {
  return {
    version: 1,
    venue_id: venueId,
    contract_id: `${venueId}:BTC`,
    economic_equivalence_id: "carry:BTC-usd-linear",
    asset: "BTC",
    market: "BTC-USD",
    quote_asset: venueId === "aster" ? "USDT" : "USD",
    collateral_asset: venueId === "aster" ? "USDT" : "USDC",
    contract_type: "linear_perp",
    mark_price_e8: 10_000_000_000_000,
    index_price_e8: 10_000_000_000_000,
    best_bid_e8: 9_999_000_000_000,
    best_ask_e8: 10_001_000_000_000,
    depth_bids: [{ price_e8: 9_999_000_000_000, size_e8: 100_000_000 }],
    depth_asks: [{ price_e8: 10_001_000_000_000, size_e8: 100_000_000 }],
    funding_rate_e12_per_interval: venueId === "aster" ? 400_000_000 : 100_000_000,
    funding_interval_ms: venueId === "aster" ? 28_800_000 : 3_600_000,
    quantity_step_e8: 1_000,
    price_tick_e8: 1_000_000,
    initial_margin_bps: 500,
    maintenance_margin_bps: 500,
    as_of_ms: NOW,
    stale: false,
  };
}

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
    position_count: 0,
    open_order_count: 0,
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
        verification_commitment: `verification_${venue_id}`,
        checks: { order_request_built: true, transaction_broadcast: false },
        order_shape: venue_id === "hyperliquid"
          ? { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 100_000_000 }
          : { notional_micro_usdc: 99_900_000 },
        ...(venue_id === "aster" ? { account } : {}),
      };
    },
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0 }),
    readHyperliquidCarryMetrics: async () => account,
  });

  assert.equal(verified.length, 2);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.no_submit_ready, true);
  assert.equal(result.live_creation_ready, false);
  assert.equal(result.creation_opportunity.live_creation_ready, false);
  assert.equal(result.creation_opportunity.all_venues_ready, true);
  assert.equal(typeof result.creation_opportunity.long_margin_runway_ms, "number");
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
    { venue_id: "hyperliquid", required: 100_000_000, venue_minimum: 5_000_000, shortfall: 0, leverage: 1 },
    { venue_id: "aster", required: 100_000_000, venue_minimum: 5_000_000, shortfall: 0, leverage: 1 },
  ]);
  assert.equal(result.economic_opportunity.projected_trading_cost_micro_usdc > 0, true);
});

test("reports exact owner-funded opening shortfalls without granting transfer authority", () => {
  const account = {
    can_trade: true,
    available_balance: 25,
    margin_balance: 25,
    initial_margin: 0,
    maintenance_margin: 0,
    maker_fee_bps: 1,
    taker_fee_bps: 2,
    position_count: 0,
    open_order_count: 0,
  };
  const evidence = [
    { venue_id: "hyperliquid", side: "buy", snapshot: snapshot("hyperliquid") },
    { venue_id: "aster", side: "sell", snapshot: snapshot("aster") },
  ].map((leg) => ({
    ...leg,
    account,
    account_snapshot: leg.venue_id === "hyperliquid"
      ? { status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0 }
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
    position_count: 0,
    open_order_count: 0,
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
      verification_commitment: `verification_${venue_id}`,
      checks: { order_request_checked: true, transaction_broadcast: false },
      order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
      account,
      authority_boundary: { venue_native_trade_only: true },
    }),
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0 }),
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
    position_count: 0,
    open_order_count: 0,
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
      verification_commitment: `verification_${venue_id}`,
      checks: { order_request_checked: true, transaction_broadcast: false },
      order_shape: { notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
      account,
      authority_boundary: { venue_native_trade_only: true },
    }),
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0 }),
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
    position_count: 0,
    open_order_count: 0,
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
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0 }),
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
    position_count: 0,
    open_order_count: 0,
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
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0 }),
    readHyperliquidCarryMetrics: async () => account,
  });

  assert.equal(result.no_submit_ready, true);
  assert.equal(result.transaction_broadcast, false);
  assert.equal(result.capital_ready, true);
  assert.deepEqual(result.venues.map((item) => item.venue_id).sort(), ["aster", "hyperliquid", "lighter"]);
  assert.equal(result.venues.every((item) => item.checks.transaction_broadcast === false), true);
  assert.equal(result.pairs.length, 3);
  assert.deepEqual(result.pairs.map((pair) => [pair.long_venue_id, pair.short_venue_id].sort().join(":")).sort(), [
    "aster:hyperliquid",
    "aster:lighter",
    "hyperliquid:lighter",
  ]);
  assert.equal(result.pairs.every((pair) => pair.leg_evidence.length === 2), true);
  assert.equal(result.pairs.every((pair) => pair.capital_ready === true && pair.account_readiness.length === 2), true);
  assert.equal(result.pairs.every((pair, index) =>
    pair.work_order_commitment === `carry_matrix_preflight_0001_pair_${index + 1}`
    && pair.leg_evidence.every((leg) => leg.work_order_commitment === `${pair.work_order_commitment}_${leg.venue_id}`)
  ), true);
  assert.equal(result.venues.every((venue) => venue.verification_commitments.length === 2), true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.readiness.ready, true);
  assert.equal(result.readiness.capital_ready, true);
  assert.equal(result.readiness.owner_commitment, "owner_commitment_matrix_0001");
  assert.equal(result.readiness.image_digest, "sha256:abcdef123456");
  assert.equal(rows.size, 1);
  assert.equal(new Set(calls.map((call) => call.venue_id)).size, 3);
  assert.equal(result.checked_at, new Date(NOW).toISOString());
  assert.equal(nowCalls, 1);
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
      adapter_id: executionVenueSpec("aster").exact_quantity_recovery_adapter,
      image_digest: image,
      network: "mainnet",
      verified_at_ms: NOW,
      no_submit: { transaction_broadcast: false, account_state_checked: true, order_request_checked: true, evidence_commitment: "no_submit_aster_0001" },
      entry_reconciliation: { live_order_broadcast: true, target_client_order_matched: true, final_venue_execution_proven: true, filled_base_size: "0.001", evidence_commitment: "entry_aster_0001" },
      exit_recovery: { live_order_broadcast: true, reduce_only: true, exact_base_quantity: true, final_venue_execution_proven: true, account_state_checked: true, gross_exposure_micro_usdc: 0, open_order_count: 0, evidence_commitment: "exit_aster_0001" },
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
    position_count: 0,
    open_order_count: 0,
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
    env: { PRIVATE_AGENT_IMAGE_DIGEST: image },
    now: () => NOW,
    fetchVenue: async ({ venue_id }) => [{
      ...snapshot(venue_id),
      funding_rate_e12_per_interval: venue_id === "aster" ? 2_000_000_000 : 0,
    }],
    verifyOrder: async ({ venue_id, work_order_commitment }) => ({
      status: "verified_ready",
      work_order_commitment,
      verification_commitment: `verification_${venue_id}`,
      checks: { order_request_checked: true, transaction_broadcast: false, account_state_checked: true },
      order_shape: { market: "BTC-USD", base_size: "0.001", limit_price: "100000", notional_micro_usdc: 100_000_000, quantity_step_e8: 1_000, price_tick_e8: 1_000_000 },
      account,
      ...(venue_id === "aster" ? { authority_boundary: { venue_native_trade_only: true } } : {}),
    }),
    readHyperliquidSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true, position_count: 0, open_order_count: 0 }),
    readHyperliquidCarryMetrics: async () => account,
  };
  const result = await preflightCarryPair({ ...preflightInput, state });

  assert.equal(result.collateral_basis.supported, true);
  assert.equal(result.economic_opportunity.collateral_basis_mode, "usdc_usdt_stress_buffer");
  assert.equal(result.economic_opportunity.collateral_basis_risk_bps, 50);
  assert.equal(result.qualification_reasons.length, 0);
  assert.equal(result.live_creation_ready, true);
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
