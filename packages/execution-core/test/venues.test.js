import assert from "node:assert/strict";
import test from "node:test";
import {
  CARRY_EXECUTION_VENUES,
  CORE_PERP_VENUES,
  EXECUTION_VENUE_SPECS,
  assessVenueReadiness,
  requiredVenueCapabilities,
  supportsExactQuantityRecovery,
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
  assert.equal(EXECUTION_VENUE_SPECS.hyperliquid.qualification_status, "proven");
  assert.equal(EXECUTION_VENUE_SPECS.lighter.qualification_status, "integration");
  assert.equal(EXECUTION_VENUE_SPECS.lighter.worker_routing_status, "implemented_unproven");
  assert.equal(EXECUTION_VENUE_SPECS.lighter.exact_quantity_recovery_adapter, "lighter_v1");
  assert.equal(EXECUTION_VENUE_SPECS.aster.worker_routing_status, "implemented_unproven");
  assert.equal(EXECUTION_VENUE_SPECS.aster.exact_quantity_recovery_adapter, "aster_v1");
  assert.equal(supportsExactQuantityRecovery("lighter"), false);
  assert.equal(supportsExactQuantityRecovery("aster"), false);
  assert.equal(supportsExactQuantityRecovery("hyperliquid"), true);
  assert.equal(EXECUTION_VENUE_SPECS.dydx.qualification_status, "candidate");
  assert.equal(EXECUTION_VENUE_SPECS.variational_omni.qualification_status, "research_only");
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
