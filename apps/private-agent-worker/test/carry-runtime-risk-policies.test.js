import assert from "node:assert/strict";
import test from "node:test";
import { createReadOnlyCarryRuntimePolicies } from "../src/execution/carry-runtime-risk-policies.js";

const NOW = 1_800_000_000_000;

test("creates fresh read-only route guardrails without movement authority", () => {
  const policies = createReadOnlyCarryRuntimePolicies();
  const deposit = policies.deposit_policy_provider({ venue_id: "hyperliquid", checked_at_ms: NOW });
  const withdrawal = policies.withdrawal_policy_provider({
    venue_id: "aster",
    collateral_asset: "USDT",
    checked_at_ms: NOW,
  });
  const conversion = policies.conversion_policy_provider({ checked_at_ms: NOW });

  for (const policy of [deposit, withdrawal, conversion]) {
    assert.equal(policy.read_only, true);
    assert.equal(policy.owner_approval_required, true);
    assert.equal(policy.fund_movement_authorized, false);
    assert.equal(policy.transaction_broadcast, false);
    assert.equal(policy.observed_at_ms, NOW);
    assert.equal(policy.expires_at_ms, NOW + 60_000);
  }
  assert.equal(deposit.maximum_transfer_micro_usdc, 250_000_000);
  assert.equal(conversion.market, "USDCUSDT");
});

test("fails closed for unsupported runtime policy bindings", () => {
  const policies = createReadOnlyCarryRuntimePolicies();
  assert.equal(policies.deposit_policy_provider({ venue_id: "edge_x", checked_at_ms: NOW }), null);
  assert.equal(policies.withdrawal_policy_provider({
    venue_id: "hyperliquid",
    collateral_asset: "USDT",
    checked_at_ms: NOW,
  }), null);
});
