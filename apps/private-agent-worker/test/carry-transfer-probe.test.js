import assert from "node:assert/strict";
import test from "node:test";
import { createCarryTransferRouteProbe } from "../src/execution/carry-transfer-probe.js";

const NOW = 1_800_000_000_000;

test("compiles a same-asset route from exact read-only component bounds", async () => {
  const probe = createCarryTransferRouteProbe({
    venue_route_readers: readers(),
  });
  const quote = await probe(request());
  assert.equal(quote.status, "available");
  assert.equal(quote.minimum_transfer_micro_usdc, 3_000_000);
  assert.equal(quote.maximum_transfer_micro_usdc, 200_000_000);
  assert.equal(quote.fee_micro_usdc, 1_250_000);
  assert.equal(quote.conversion_rate_e8, 100_000_000);
  assert.equal(quote.estimated_latency_ms, 315_000);
  assert.equal(quote.owner_approval_required, true);
  assert.equal(quote.fund_movement_authorized, false);
  assert.equal(quote.transaction_broadcast, false);
});

test("prices USDC-USDT conversion as a bounded component of the route", async () => {
  const probe = createCarryTransferRouteProbe({
    venue_route_readers: readers({ destinationAsset: "USDT" }),
    read_conversion_quote: async () => component({
      kind: "conversion",
      source_asset: "USDC",
      destination_asset: "USDT",
      minimum_transfer_micro_usdc: 5_000_000,
      maximum_transfer_micro_usdc: 100_000_000,
      fee_upper_bound_micro_usdc: 70_000,
      slippage_upper_bound_micro_usdc: 90_000,
      latency_upper_bound_ms: 20_000,
      rate_floor_e8: 99_800_000,
    }),
  });
  const quote = await probe(request({
    to_venue_id: "aster",
    destination_collateral_asset: "USDT",
    conversion_required: true,
  }));
  assert.equal(quote.maximum_transfer_micro_usdc, 100_000_000);
  assert.equal(quote.conversion_quote_verified, true);
  assert.equal(quote.conversion_rate_e8, 99_800_000);
  assert.equal(quote.conversion_fee_micro_usdc, 70_000);
  assert.equal(quote.conversion_slippage_micro_usdc, 90_000);
  assert.equal(quote.fee_micro_usdc, 1_410_000);
});

test("rejects components detached from the exact account state", async () => {
  const unbound = readers();
  unbound.lighter.read_withdrawal_quote = async () => component({
    kind: "withdrawal",
    venue_id: "lighter",
    collateral_asset: "USDC",
    account_state_commitment: "carry:account-state:lighter:stale",
    fee_upper_bound_micro_usdc: 1_000_000,
    latency_upper_bound_ms: 300_000,
  });
  const probe = createCarryTransferRouteProbe({ venue_route_readers: unbound });
  await assert.rejects(() => probe(request()), /carry_transfer_probe_component_binding_invalid/);
});

function request(overrides = {}) {
  return {
    from_venue_id: "lighter",
    to_venue_id: "hyperliquid",
    source_collateral_asset: "USDC",
    destination_collateral_asset: "USDC",
    conversion_required: false,
    source_account_state_commitment: "carry:account-state:lighter:0001",
    destination_account_state_commitment: "carry:account-state:hyperliquid:0001",
    checked_at_ms: NOW,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    automatic_transfer_permitted: false,
    ...overrides,
  };
}

function readers({ destinationAsset = "USDC" } = {}) {
  return {
    lighter: {
      read_withdrawal_quote: async () => component({
        kind: "withdrawal",
        venue_id: "lighter",
        collateral_asset: "USDC",
        account_state_commitment: "carry:account-state:lighter:0001",
        fee_upper_bound_micro_usdc: 1_000_000,
        latency_upper_bound_ms: 300_000,
      }),
    },
    hyperliquid: {
      read_deposit_quote: async () => component({
        kind: "deposit",
        venue_id: "hyperliquid",
        collateral_asset: destinationAsset,
        account_state_commitment: "carry:account-state:hyperliquid:0001",
        minimum_transfer_micro_usdc: 3_000_000,
        maximum_transfer_micro_usdc: 200_000_000,
        fee_upper_bound_micro_usdc: 250_000,
        latency_upper_bound_ms: 15_000,
      }),
    },
    aster: {
      read_deposit_quote: async () => component({
        kind: "deposit",
        venue_id: "aster",
        collateral_asset: destinationAsset,
        account_state_commitment: "carry:account-state:hyperliquid:0001",
        minimum_transfer_micro_usdc: 3_000_000,
        maximum_transfer_micro_usdc: 200_000_000,
        fee_upper_bound_micro_usdc: 250_000,
        latency_upper_bound_ms: 15_000,
      }),
    },
  };
}

function component(overrides = {}) {
  return {
    status: "available",
    valuation_asset: "USD",
    verified: true,
    capacity_bound_verified: true,
    fee_upper_bound_verified: true,
    latency_upper_bound_verified: true,
    read_only: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    minimum_transfer_micro_usdc: 0,
    maximum_transfer_micro_usdc: 500_000_000,
    fee_upper_bound_micro_usdc: 0,
    slippage_upper_bound_micro_usdc: 0,
    latency_upper_bound_ms: 0,
    as_of_ms: NOW,
    ...overrides,
  };
}
