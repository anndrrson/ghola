import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AUTOPILOT_ACCOUNT_DEFAULT_VENUES,
  AUTOPILOT_ACCOUNT_READINESS_VENUES,
  AUTOPILOT_ACCOUNT_VENUES,
  AUTOPILOT_WORKER_DEFAULT_VENUES,
  AUTOPILOT_WORKER_VENUES,
  CARRY_BROWSER_STREAM_VENUES,
  CARRY_EXECUTION_VENUES,
  CARRY_EXECUTION_REQUIRED_ADAPTER_CAPABILITIES,
  CARRY_RECOVERY_POLICY,
  CARRY_SHADOW_ASSETS,
  CONNECTOR_SDK_VENUES,
  CORE_PERP_VENUES,
  EXECUTION_VENUE_SPECS,
  SUPPORTED_EXECUTION_VENUES,
  PRIVATE_EXECUTION_INSTRUCTION_VENUES,
  assessVenueReadiness,
  carryExecutionQualification,
  connectorSdkDefaultVenue,
  executionVenueLabel,
  mandatoryNoSubmitChecks,
  normalizeCarryShadowAssets,
  requiredVenueCapabilities,
  supportsExactQuantityRecovery,
  venueAdapterCapability,
  venuesWithAdapterCapability,
} from "../index.js";

const NOW = 1_800_000_000_000;

function declaredStringUnion(source, typeName) {
  const match = source.match(new RegExp(`export type ${typeName} = ([^;]+);`));
  assert.ok(match, `${typeName} declaration is missing`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

test("registry centralizes five core perp candidates without claiming qualification", () => {
  assert.deepEqual(CORE_PERP_VENUES, [
    "hyperliquid",
    "lighter",
    "aster",
    "edgex",
    "dydx",
  ]);
  assert.deepEqual(CARRY_EXECUTION_VENUES, ["hyperliquid", "lighter", "aster"]);
  assert.deepEqual(CARRY_SHADOW_ASSETS, ["BTC", "ETH", "SOL"]);
  assert.deepEqual(CARRY_EXECUTION_REQUIRED_ADAPTER_CAPABILITIES, [
    "carry_execution",
    "no_submit_reconciliation",
    "exact_quantity_recovery",
    "credential_onboarding",
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
  assert.equal(
    venueAdapterCapability("hyperliquid", "perp_shadow")?.source_schema,
    "hyperliquid_metaAndAssetCtxs_l2Book_v2",
  );
  assert.equal(venueAdapterCapability("dydx", "perp_shadow")?.adapter_id, "dydx_shadow_v1");
  for (const venueId of CORE_PERP_VENUES) {
    const shadow = venueAdapterCapability(venueId, "perp_shadow");
    assert.match(shadow.margin_model, /^[a-z][a-z0-9_]+$/);
    assert.match(shadow.liquidation_model, /^[a-z][a-z0-9_]+$/);
    assert.notEqual(shadow.margin_model, "unavailable");
    assert.notEqual(shadow.liquidation_model, "unavailable");
  }
  assert.equal(venueAdapterCapability("dydx", "carry_execution"), null);
  assert.deepEqual(mandatoryNoSubmitChecks("hyperliquid"), [
    "sealed_vault_opened",
    "sealed_instruction_opened",
    "authority_derived",
    "policy_enforced",
    "live_gate_enforced",
    "api_wallet_loaded",
    "hyperliquid_api_reachable",
    "hyperliquid_sdk_ready",
    "account_read_checked",
    "order_request_built",
    "live_venue_checked",
  ]);
  assert.deepEqual(mandatoryNoSubmitChecks("lighter"), [
    "sdk_checked",
    "signer_matches_key",
    "market_data_checked",
    "account_state_checked",
    "margin_state_checked",
    "order_request_checked",
  ]);
  assert.deepEqual(mandatoryNoSubmitChecks("aster"), [
    "sdk_checked",
    "signer_matches_key",
    "market_data_checked",
    "account_state_checked",
    "order_request_checked",
  ]);
  assert.equal(mandatoryNoSubmitChecks("dydx"), null);
  assert.deepEqual(
    Object.fromEntries(CARRY_EXECUTION_VENUES.map((venueId) => {
      const onboarding = venueAdapterCapability(venueId, "credential_onboarding");
      return [venueId, {
        adapter_id: onboarding?.adapter_id,
        current_mode: onboarding?.current_mode,
        owner_action_required: onboarding?.owner_action_required,
        fund_movement_authorized: onboarding?.fund_movement_authorized,
        trade_submission_authorized: onboarding?.trade_submission_authorized,
      }];
    })),
    {
      hyperliquid: {
        adapter_id: "hyperliquid_turnkey_onboarding_v1",
        current_mode: "wallet_authorized_auto_provisioning",
        owner_action_required: true,
        fund_movement_authorized: false,
        trade_submission_authorized: false,
      },
      lighter: {
        adapter_id: "lighter_turnkey_change_pubkey_v1",
        current_mode: "programmatic_key_one_owner_signature",
        owner_action_required: true,
        fund_movement_authorized: false,
        trade_submission_authorized: false,
      },
      aster: {
        adapter_id: "aster_v3_agent_onboarding_v1",
        current_mode: "programmatic_key_one_owner_signature",
        owner_action_required: true,
        fund_movement_authorized: false,
        trade_submission_authorized: false,
      },
    },
  );
  assert.deepEqual(venuesWithAdapterCapability("collateral_route_observer", {
    cohort: "core_perp",
    product: "perp",
  }), ["hyperliquid", "lighter", "aster"]);
  assert.equal(venueAdapterCapability("hyperliquid", "collateral_route_observer")?.owner_approval_required, true);
  assert.equal(venueAdapterCapability("hyperliquid", "collateral_route_observer")?.collateral_asset, "USDC");
  assert.equal(venueAdapterCapability("lighter", "collateral_route_observer")?.collateral_asset, "USDC");
  assert.equal(venueAdapterCapability("aster", "collateral_route_observer")?.collateral_asset, "USDT");
  assert.deepEqual(
    Object.fromEntries(CARRY_EXECUTION_VENUES.map((venueId) => [
      venueId,
      venueAdapterCapability(venueId, "carry_execution")?.liquidation_distance_source,
    ])),
    {
      hyperliquid: "hyperliquid_clearinghouse_state_asset_positions_v1",
      lighter: "lighter_account_positions_position_value_v1",
      aster: "aster_fapi_v3_position_risk_v1",
    },
  );
  assert.equal(venueAdapterCapability("edgex", "carry_execution")?.liquidation_distance_source, undefined);
  assert.equal(venueAdapterCapability("dydx", "carry_execution")?.liquidation_distance_source, undefined);
  assert.deepEqual(venuesWithAdapterCapability("perp_shadow", {
    cohort: "core_perp",
    product: "perp",
    statuses: ["enabled"],
  }), CORE_PERP_VENUES);
});

test("registry preserves legacy autopilot, sealing, and connector surface ordering", () => {
  assert.deepEqual(AUTOPILOT_WORKER_VENUES, [
    "jupiter", "phoenix", "backpack", "hyperliquid", "drift", "coinbase_advanced",
  ]);
  assert.deepEqual(AUTOPILOT_WORKER_DEFAULT_VENUES, [
    "jupiter", "phoenix", "hyperliquid", "coinbase_advanced",
  ]);
  assert.deepEqual(AUTOPILOT_ACCOUNT_VENUES, [
    "jupiter", "phoenix", "backpack", "hyperliquid", "coinbase_advanced",
  ]);
  assert.deepEqual(AUTOPILOT_ACCOUNT_DEFAULT_VENUES, AUTOPILOT_ACCOUNT_VENUES);
  assert.deepEqual(AUTOPILOT_ACCOUNT_READINESS_VENUES, [
    "hyperliquid", "phoenix", "backpack", "jupiter", "coinbase_advanced",
  ]);
  assert.deepEqual(PRIVATE_EXECUTION_INSTRUCTION_VENUES, [
    "hyperliquid", "coinbase_advanced", "phoenix", "jupiter",
  ]);
  assert.deepEqual(CONNECTOR_SDK_VENUES, [
    "phoenix", "jupiter", "hyperliquid", "coinbase_advanced",
  ]);
  assert.equal(connectorSdkDefaultVenue("solana_perps_market"), "phoenix");
  assert.equal(connectorSdkDefaultVenue("solana_swap_aggregator"), "jupiter");
  assert.equal(connectorSdkDefaultVenue("hyperliquid_style_market"), "hyperliquid");
  assert.equal(connectorSdkDefaultVenue("coinbase_style_provider"), "coinbase_advanced");
  assert.equal(connectorSdkDefaultVenue("rfq_solver_network"), null);
  assert.equal(AUTOPILOT_ACCOUNT_VENUES.includes("drift"), false);
  assert.equal(PRIVATE_EXECUTION_INSTRUCTION_VENUES.includes("lighter"), false);
  assert.equal(PRIVATE_EXECUTION_INSTRUCTION_VENUES.includes("aster"), false);
});

test("Carry shadow asset selections are canonical and registry-bound", () => {
  assert.deepEqual(normalizeCarryShadowAssets(undefined, { default_to_all: true }), CARRY_SHADOW_ASSETS);
  assert.deepEqual(normalizeCarryShadowAssets("sol,btc,BTC"), ["BTC", "SOL"]);
  assert.equal(normalizeCarryShadowAssets("BTC,DOGE"), null);
  assert.equal(normalizeCarryShadowAssets([]), null);
});

test("registry type unions stay synchronized with runtime capability registry", () => {
  const declarations = readFileSync(new URL("../index.d.ts", import.meta.url), "utf8");
  assert.deepEqual(declaredStringUnion(declarations, "VenueId"), SUPPORTED_EXECUTION_VENUES);
  assert.deepEqual(declaredStringUnion(declarations, "CorePerpVenueId"), CORE_PERP_VENUES);
  assert.deepEqual(declaredStringUnion(declarations, "CarryExecutionVenueId"), CARRY_EXECUTION_VENUES);
  assert.deepEqual(declaredStringUnion(declarations, "AutopilotWorkerVenueId"), AUTOPILOT_WORKER_VENUES);
  assert.deepEqual(declaredStringUnion(declarations, "AutopilotAccountVenueId"), AUTOPILOT_ACCOUNT_VENUES);
  assert.deepEqual(
    declaredStringUnion(declarations, "PrivateExecutionInstructionVenueId"),
    PRIVATE_EXECUTION_INSTRUCTION_VENUES,
  );
  assert.deepEqual(declaredStringUnion(declarations, "ConnectorSdkVenueId"), CONNECTOR_SDK_VENUES);
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
        "adapter_missing:credential_onboarding",
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
