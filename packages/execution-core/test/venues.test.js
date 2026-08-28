import assert from "node:assert/strict";
import test from "node:test";
import {
  CARRY_BROWSER_STREAM_VENUES,
  CARRY_EXECUTION_VENUES,
  CARRY_EXECUTION_REQUIRED_ADAPTER_CAPABILITIES,
  CARRY_RECOVERY_POLICY,
  CORE_PERP_VENUES,
  EXECUTION_VENUE_SPECS,
  assessVenueReadiness,
  carryExecutionQualification,
  executionVenueLabel,
  requiredVenueCapabilities,
  supportsExactQuantityRecovery,
  venueAdapterCapability,
  venuesWithAdapterCapability,
} from "../index.js";

const NOW = 1_800_000_000_000;

test("registry centralizes five core perp candidates without claiming qualification", () => {
  assert.deepEqual(CORE_PERP_VENUES, [
    "hyperliquid",
    "lighter",
    "aster",
    "edgex",
    "dydx",
  ]);
  assert.deepEqual(CARRY_EXECUTION_VENUES, ["hyperliquid", "lighter", "aster"]);
  assert.deepEqual(CARRY_EXECUTION_REQUIRED_ADAPTER_CAPABILITIES, [
    "carry_execution",
    "no_submit_reconciliation",
    "exact_quantity_recovery",
  ]);
  assert.deepEqual(CARRY_RECOVERY_POLICY, {
    ambiguous_submission: "freeze_reconcile_never_retry",
    partial_fill: "exact_quantity_reduce_only",
    worker_restart: "reconcile_before_action",
  });
  assert.deepEqual(CARRY_BROWSER_STREAM_VENUES, ["lighter", "aster", "edgex", "dydx"]);
  assert.equal(EXECUTION_VENUE_SPECS.hyperliquid.qualification_status, "proven");
  assert.equal(EXECUTION_VENUE_SPECS.lighter.qualification_status, "integration");
  assert.equal(EXECUTION_VENUE_SPECS.lighter.worker_routing_status, "implemented_unproven");
  assert.equal(EXECUTION_VENUE_SPECS.lighter.exact_quantity_recovery_adapter, "lighter_v1");
  assert.equal(EXECUTION_VENUE_SPECS.aster.worker_routing_status, "implemented_unproven");
  assert.equal(EXECUTION_VENUE_SPECS.aster.exact_quantity_recovery_adapter, "aster_v1");
  assert.equal(supportsExactQuantityRecovery("lighter"), false);
  assert.equal(supportsExactQuantityRecovery("aster"), false);
  assert.equal(supportsExactQuantityRecovery("hyperliquid"), true);
  assert.equal(supportsExactQuantityRecovery("coinbase_advanced"), true);
  assert.equal(EXECUTION_VENUE_SPECS.coinbase_advanced.exact_quantity_recovery_adapter, "coinbase_advanced_v1");
  assert.equal(EXECUTION_VENUE_SPECS.dydx.qualification_status, "candidate");
  assert.equal(EXECUTION_VENUE_SPECS.variational_omni.qualification_status, "research_only");
  assert.equal(executionVenueLabel("hyperliquid"), "Hyperliquid");
  assert.equal(executionVenueLabel("edgex"), "edgeX");
  assert.equal(executionVenueLabel("venue_unregistered"), "venue_unregistered");
  assert.equal(venueAdapterCapability("dydx", "perp_shadow")?.adapter_id, "dydx_shadow_v1");
  assert.equal(venueAdapterCapability("dydx", "carry_execution"), null);
  assert.deepEqual(venuesWithAdapterCapability("collateral_route_observer", {
    cohort: "core_perp",
    product: "perp",
  }), ["hyperliquid", "lighter", "aster"]);
  assert.equal(venueAdapterCapability("hyperliquid", "collateral_route_observer")?.owner_approval_required, true);
  assert.equal(venueAdapterCapability("hyperliquid", "collateral_route_observer")?.collateral_asset, "USDC");
  assert.equal(venueAdapterCapability("lighter", "collateral_route_observer")?.collateral_asset, "USDC");
  assert.equal(venueAdapterCapability("aster", "collateral_route_observer")?.collateral_asset, "USDT");
  assert.deepEqual(venuesWithAdapterCapability("perp_shadow", {
    cohort: "core_perp",
    product: "perp",
    statuses: ["enabled"],
  }), CORE_PERP_VENUES);
});

test("candidate venues cannot enter Carry until the identical execution contract is complete", () => {
  for (const venueId of CARRY_EXECUTION_VENUES) {
    assert.deepEqual(carryExecutionQualification(venueId), { venue_id: venueId, eligible: true, gaps: [] });
  }
  for (const venueId of ["edgex", "dydx"]) {
    assert.deepEqual(carryExecutionQualification(venueId), {
      venue_id: venueId,
      eligible: false,
      gaps: [
        "adapter_missing:carry_execution",
        "adapter_missing:no_submit_reconciliation",
        "adapter_missing:exact_quantity_recovery",
      ],
    });
  }
});

test("carry requires contract, history, margin, liquidation, cancel, and reduce-only evidence", () => {
  const route = requiredVenueCapabilities({ venue_id: "lighter", product_type: "perp" });
  const carry = requiredVenueCapabilities({ venue_id: "lighter", product_type: "perp", mode: "carry" });
  for (const capability of ["contract_specs", "funding_history", "margin", "liquidation", "cancel", "reduce_only"]) {
    assert.equal(route.includes(capability), false);
    assert.equal(carry.includes(capability), true);
  }
});

test("an unproven venue fails closed until every required capability is observed", () => {
  const required = requiredVenueCapabilities({ venue_id: "aster", product_type: "perp", mode: "carry" });
  const readiness = assessVenueReadiness({
    venue_state: {
      version: 1,
      venue_id: "aster",
      status: "ready",
      as_of_ms: NOW - 100,
      capabilities: Object.fromEntries(required.map((capability) => [capability, capability !== "liquidation"])),
    },
    required_capabilities: required,
    now_ms: NOW,
    max_age_ms: 30_000,
  });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.reasons, ["capability_missing:liquidation"]);
});
