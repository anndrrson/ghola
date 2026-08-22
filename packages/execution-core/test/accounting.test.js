import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateExecutionQuality,
  aggregatePortfolioAccounting,
  buildExecutionQualityReceipt,
  normalizeVenueAccountingSnapshot,
  reconcilePortfolioAccounting,
} from "../index.js";

const NOW = 1_800_000_000_000;

function snapshot(venueId, overrides = {}) {
  return {
    version: 1,
    snapshot_id: `snapshot:${venueId}:0001`,
    venue_id: venueId,
    account_commitment: `account:${venueId}:0001`,
    custody_type: venueId === "coinbase_advanced" ? "user_exchange_account" : "turnkey_wallet",
    as_of_ms: NOW - 100,
    sequence: 1,
    equity_micro_usdc: 50_000_000,
    collateral_micro_usdc: 10_000_000,
    fees_today_micro_usdc: 5_000,
    funding_today_micro_usdc: 0,
    balances: [{
      asset: "USDC",
      value_micro_usdc: 40_000_000,
      available_value_micro_usdc: 30_000_000,
    }],
    positions: [],
    open_orders: [],
    ...overrides,
  };
}

function quality(overrides = {}) {
  return {
    version: 1,
    execution_id: "execution:quality:0001",
    plan_commitment: "plan:quality:0001",
    venue_id: "jupiter",
    strategy_id: "best_execution",
    market: "SOL-USD",
    side: "buy",
    benchmark_source: "decision_mid",
    target_notional_micro_usdc: 10_000_000,
    benchmark_price_e8: 10_000_000_000,
    decision_at_ms: NOW,
    expected_cost_bps: 20,
    rejected: false,
    fills: [
      {
        fill_commitment: "fill:quality:0001",
        notional_micro_usdc: 5_000_000,
        price_e8: 10_010_000_000,
        fee_micro_usdc: 5_000,
        gas_micro_usdc: 500,
        filled_at_ms: NOW + 1_000,
      },
      {
        fill_commitment: "fill:quality:0002",
        notional_micro_usdc: 5_000_000,
        price_e8: 10_020_000_000,
        fee_micro_usdc: 5_000,
        gas_micro_usdc: 500,
        filled_at_ms: NOW + 1_500,
      },
    ],
    ...overrides,
  };
}

test("normalizes self-custodial and user-owned exchange accounts but forbids pooled platform custody", () => {
  assert.equal(normalizeVenueAccountingSnapshot(snapshot("jupiter")).custody_type, "turnkey_wallet");
  assert.equal(normalizeVenueAccountingSnapshot(snapshot("coinbase_advanced")).custody_type, "user_exchange_account");
  assert.throws(
    () => normalizeVenueAccountingSnapshot(snapshot("jupiter", { custody_type: "pooled_platform_account" })),
    /pooled_custody_forbidden/,
  );
});

test("aggregates venue equity, gross/net exposure, fees, funding, and liquidation distance", () => {
  const accounting = aggregatePortfolioAccounting({
    snapshots: [
      snapshot("jupiter", {
        positions: [{
          position_key: "position:spot:0001",
          asset: "SOL",
          market: "SOL-USD",
          product_type: "spot",
          signed_notional_micro_usdc: 10_000_000,
          unrealized_pnl_micro_usdc: 0,
          leverage_x100: 100,
          liquidation_distance_bps: 100_000,
        }],
      }),
      snapshot("hyperliquid", {
        equity_micro_usdc: 30_000_000,
        collateral_micro_usdc: 20_000_000,
        funding_today_micro_usdc: -25_000,
        positions: [{
          position_key: "position:perp:0001",
          asset: "SOL",
          market: "SOL-USD",
          product_type: "perp",
          signed_notional_micro_usdc: -10_000_000,
          unrealized_pnl_micro_usdc: 100_000,
          leverage_x100: 200,
          liquidation_distance_bps: 4_000,
        }],
      }),
    ],
    now_ms: NOW,
    max_age_ms: 30_000,
  });
  assert.equal(accounting.status, "ready");
  assert.equal(accounting.equity_micro_usdc, 80_000_000);
  assert.equal(accounting.gross_exposure_micro_usdc, 20_000_000);
  assert.equal(accounting.net_exposure_micro_usdc, 0);
  assert.equal(accounting.minimum_liquidation_distance_bps, 4_000);
  assert.equal(accounting.funding_today_micro_usdc, -25_000);
});

test("reconciliation freezes risk increases on position drift and stale venue state", () => {
  const expected = snapshot("hyperliquid", {
    positions: [{
      position_key: "position:perp:0001",
      asset: "SOL",
      market: "SOL-USD",
      product_type: "perp",
      signed_notional_micro_usdc: -10_000_000,
      unrealized_pnl_micro_usdc: 0,
      leverage_x100: 200,
      liquidation_distance_bps: 4_000,
    }],
  });
  const observed = {
    ...expected,
    snapshot_id: "snapshot:hyperliquid:observed",
    as_of_ms: NOW - 60_000,
    positions: [{ ...expected.positions[0], signed_notional_micro_usdc: -9_500_000 }],
  };
  const result = reconcilePortfolioAccounting({
    expected: [expected],
    observed: [observed],
    now_ms: NOW,
    max_age_ms: 30_000,
    tolerance_micro_usdc: 1_000,
  });
  assert.equal(result.status, "stale");
  assert.equal(result.freeze_risk_increase, true);
  assert.deepEqual(result.allowed_actions, ["reconcile", "cancel", "reduce_only"]);
  assert.ok(result.stale_venues.includes("hyperliquid"));
  assert.ok(result.mismatches.some((item) => item.kind === "position:position:perp:0001"));
});

test("execution-quality receipt measures fill rate and implementation shortfall", () => {
  const receipt = buildExecutionQualityReceipt(quality());
  assert.equal(receipt.fill_rate_bps, 10_000);
  assert.equal(receipt.average_fill_price_e8, 10_015_000_000);
  assert.equal(receipt.price_shortfall_bps, 15);
  assert.equal(receipt.fee_bps, 10);
  assert.equal(receipt.gas_bps, 1);
  assert.equal(receipt.implementation_shortfall_bps, 26);
  assert.equal(receipt.cost_model_error_bps, 6);
  assert.equal(receipt.decision_to_last_fill_ms, 1_500);
});

test("quality aggregation reports reject/fill rates without claiming returns", () => {
  const rejected = quality({
    execution_id: "execution:quality:0002",
    venue_id: "coinbase_advanced",
    rejected: true,
    reject_code: "venue_not_ready",
    fills: [],
  });
  const summary = aggregateExecutionQuality([quality(), rejected]);
  assert.equal(summary.execution_count, 2);
  assert.equal(summary.rejection_count, 1);
  assert.equal(summary.reject_rate_bps, 5_000);
  assert.equal(summary.aggregate_fill_rate_bps, 5_000);
  assert.equal(summary.weighted_implementation_shortfall_bps, 26);
});
