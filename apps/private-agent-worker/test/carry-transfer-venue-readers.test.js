import assert from "node:assert/strict";
import test from "node:test";
import { createCarryTransferVenueReaders } from "../src/execution/carry-transfer-venue-readers.js";

const NOW = 1_800_000_000_000;

test("turns fresh Hyperliquid policy and exact account capacity into a read-only bound", async () => {
  const readers = createCarryTransferVenueReaders(dependencies());
  const req = request({
    from_venue_id: "hyperliquid",
    source_collateral_asset: "USDC",
    source_account_state_commitment: "carry:account-state:hyperliquid:0001",
  });
  const quote = await readers.hyperliquid.read_withdrawal_quote(req, observedContext(req));
  assert.equal(quote.kind, "withdrawal");
  assert.equal(quote.fee_upper_bound_micro_usdc, 1_000_000);
  assert.equal(quote.latency_upper_bound_ms, 300_000);
  assert.equal(quote.maximum_transfer_micro_usdc, 250_000_000);
  assert.equal(quote.fund_movement_authorized, false);
  assert.equal(quote.transaction_broadcast, false);
});

test("bounds Aster's live public withdrawal estimate under fresh policy", async () => {
  const readers = createCarryTransferVenueReaders(dependencies({
    fetchImpl: async (url, options) => {
      assert.match(url, /estimateFee\?chainId=42161&asset=USDT$/);
      assert.equal(options.method, "GET");
      return { ok: true, json: async () => ({ gasUsdValue: "0.5000001" }) };
    },
    asterFeeCeiling: 500_001,
  }));
  const req = request({
    from_venue_id: "aster",
    source_collateral_asset: "USDT",
    source_account_state_commitment: "carry:account-state:aster:0001",
  });
  const quote = await readers.aster.read_withdrawal_quote(req, observedContext(req));
  assert.equal(quote.collateral_asset, "USDT");
  assert.equal(quote.fee_upper_bound_micro_usdc, 500_001);
  assert.equal(quote.fee_upper_bound_verified, true);
});

test("fails closed for stale policy or a live Aster fee above its ceiling", async () => {
  const stale = dependencies();
  stale.withdrawal_policies.hyperliquid.expires_at_ms = NOW;
  const staleReaders = createCarryTransferVenueReaders(stale);
  const staleRequest = request({
    from_venue_id: "hyperliquid",
    source_collateral_asset: "USDC",
    source_account_state_commitment: "carry:account-state:hyperliquid:0001",
  });
  await assert.rejects(() => staleReaders.hyperliquid.read_withdrawal_quote(
    staleRequest,
    observedContext(staleRequest),
  ), /carry_transfer_withdrawal_policy_stale/);

  const expensiveReaders = createCarryTransferVenueReaders(dependencies({
    fetchImpl: async () => ({ ok: true, json: async () => ({ gasUsdValue: "0.51" }) }),
    asterFeeCeiling: 500_000,
  }));
  const expensiveRequest = request({
    from_venue_id: "aster",
    source_collateral_asset: "USDT",
    source_account_state_commitment: "carry:account-state:aster:0001",
  });
  await assert.rejects(() => expensiveReaders.aster.read_withdrawal_quote(
    expensiveRequest,
    observedContext(expensiveRequest),
  ), /carry_transfer_aster_fee_above_policy/);
});

function dependencies({ fetchImpl, asterFeeCeiling = 500_000 } = {}) {
  return {
    now: () => NOW,
    fetchImpl: fetchImpl || (async () => ({ ok: true, json: async () => ({ gasUsdValue: "0.5" }) })),
    read_account_capacity: async ({ venue_id: venueId, collateral_asset: collateralAsset }) => ({
      verified: true,
      venue_id: venueId,
      collateral_asset: collateralAsset,
      account_state_commitment: `carry:account-state:${venueId}:0001`,
      read_only: true,
      fund_movement_authorized: false,
      transaction_broadcast: false,
      minimum_transfer_micro_usdc: 3_000_000,
      maximum_transfer_micro_usdc: 250_000_000,
      as_of_ms: NOW,
    }),
    read_deposit_quote: async ({ venue_id: venueId, destination_collateral_asset: asset, destination_account_state_commitment: commitment }) => ({
      kind: "deposit",
      status: "available",
      valuation_asset: "USD",
      venue_id: venueId,
      collateral_asset: asset,
      account_state_commitment: commitment,
      verified: true,
      capacity_bound_verified: true,
      fee_upper_bound_verified: true,
      latency_upper_bound_verified: true,
      read_only: true,
      fund_movement_authorized: false,
      transaction_broadcast: false,
      minimum_transfer_micro_usdc: 3_000_000,
      maximum_transfer_micro_usdc: 250_000_000,
      fee_upper_bound_micro_usdc: 200_000,
      latency_upper_bound_ms: 30_000,
      as_of_ms: NOW,
    }),
    read_lighter_withdrawal_quote: async () => ({ status: "unavailable" }),
    withdrawal_policies: {
      hyperliquid: policy("hyperliquid", "USDC", 1_000_000, 300_000),
      aster: policy("aster", "USDT", asterFeeCeiling, 300_000),
    },
  };
}

function policy(venueId, asset, fee, latency) {
  return {
    version: 1,
    venue_id: venueId,
    collateral_asset: asset,
    verified: true,
    read_only: true,
    owner_approval_required: true,
    fund_movement_authorized: false,
    transaction_broadcast: false,
    observed_at_ms: NOW - 1_000,
    expires_at_ms: NOW + 60_000,
    fee_ceiling_micro_usdc: fee,
    latency_ceiling_ms: latency,
  };
}

function request(overrides = {}) {
  const value = {
    from_account_commitment: "account:hyperliquid:0001",
    from_venue_id: "hyperliquid",
    to_venue_id: "lighter",
    source_collateral_asset: "USDC",
    destination_collateral_asset: "USDC",
    source_account_state_commitment: "carry:account-state:hyperliquid:0001",
    destination_account_state_commitment: "carry:account-state:lighter:0001",
    checked_at_ms: NOW,
    ...overrides,
  };
  value.source_account_state_attestation_commitment = `carry:account-state-attestation:${value.from_venue_id}:0001`;
  value.from_account_commitment = `account:${value.from_venue_id}:0001`;
  return value;
}

function observedContext(req) {
  return {
    observed_account_state_by_account: {
      [req.from_account_commitment]: {
        venue_id: req.from_venue_id,
        account_commitment: req.from_account_commitment,
        expected_account_state_commitment: req.source_account_state_commitment,
        attestation_commitment: req.source_account_state_attestation_commitment,
        observed_at_ms: NOW,
        available_balance_micro_usdc: 250_000_000,
        read_only: true,
        owner_approval_required: true,
        fund_movement_authorized: false,
        transaction_broadcast: false,
      },
    },
  };
}
