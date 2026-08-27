#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

export const CARRY_RELEASE_FILES = Object.freeze({
  vercelIgnore: ".vercelignore",
  coreIndex: "packages/execution-core/index.js",
  coreCarry: "packages/execution-core/carry.js",
  coreCarryTest: "packages/execution-core/test/carry.test.js",
  coreMultiLeg: "packages/execution-core/multi-leg.js",
  coreMultiLegTest: "packages/execution-core/test/multi-leg.test.js",
  registry: "packages/execution-core/venues.js",
  registryTest: "packages/execution-core/test/venues.test.js",
  server: "apps/private-agent-worker/src/server.js",
  workerPackage: "apps/private-agent-worker/package.json",
  preflight: "apps/private-agent-worker/src/execution/carry-preflight.js",
  workerMandate: "apps/private-agent-worker/src/execution/carry-mandate.js",
  positions: "apps/private-agent-worker/src/execution/carry-positions.js",
  executor: "apps/private-agent-worker/src/execution/carry-executor.js",
  privateExecution: "apps/private-agent-worker/src/execution/private-execution.js",
  adapterRegistryTest: "apps/private-agent-worker/test/carry-adapter-registry.test.js",
  qualification: "apps/private-agent-worker/src/execution/carry-qualification.js",
  readiness: "apps/private-agent-worker/src/execution/carry-readiness.js",
  reconciliation: "apps/private-agent-worker/src/execution/carry-reconciliation.js",
  releaseMaterial: "apps/private-agent-worker/src/execution/carry-release-evidence.js",
  shadow: "apps/private-agent-worker/src/execution/perp-shadow-adapters.js",
  shadowVerifier: "apps/private-agent-worker/src/execution/perp-shadow-readiness.js",
  shadowVerifierCli: "apps/private-agent-worker/scripts/verify-carry-shadow.mjs",
  shadowVerifierTest: "apps/private-agent-worker/test/verify-carry-shadow.test.js",
  hyperliquid: "apps/private-agent-worker/src/venues/hyperliquid.js",
  aster: "apps/private-agent-worker/src/venues/aster.js",
  lighter: "apps/private-agent-worker/src/venues/lighter.js",
  lighterRunner: "apps/private-agent-worker/src/venues/lighter_runner.py",
  webRoute: "apps/web/src/app/v1/private-account/carry/route.ts",
  webClient: "apps/web/src/lib/private-account-client.ts",
  webMandate: "apps/web/src/lib/carry-risk-mandate.ts",
  webMandateTest: "apps/web/src/lib/carry-risk-mandate.test.ts",
  webCollateralReview: "apps/web/src/lib/carry-collateral-review.ts",
  webPerpsTurnkey: "apps/web/src/lib/perps-turnkey-provider.tsx",
  webRegistry: "apps/web/src/lib/carry-venues.ts",
  webPage: "apps/web/src/app/carry/page.tsx",
  webTradeWorkspace: "apps/web/src/components/trade/PublicCoinbaseLiveTrade.tsx",
  webCarryChart: "apps/web/src/components/carry/CarryChartStrip.tsx",
  webCarryBuilder: "apps/web/src/components/carry/CarryTerminalBuilder.tsx",
  webCarryBuilderTest: "apps/web/src/components/carry/CarryTerminalBuilder.test.tsx",
  webCarryMarket: "apps/web/src/lib/carry-market.ts",
  webCarryLiveMarket: "apps/web/src/lib/carry-live-market.ts",
  webCarryLiveMarketTest: "apps/web/src/lib/carry-live-market.test.ts",
  webCsp: "apps/web/src/lib/csp-config.ts",
  webAccountPage: "apps/web/src/app/app/account/page.tsx",
  webAccountSetup: "apps/web/src/components/carry/CarryAccountSetup.tsx",
  webAccountConnections: "apps/web/src/lib/carry-account-connections.ts",
  webAccountConnectionsTest: "apps/web/src/lib/carry-account-connections.test.ts",
  webOnboardingRecovery: "apps/web/src/lib/carry-onboarding-recovery.ts",
  webOnboardingRecoveryTest: "apps/web/src/lib/carry-onboarding-recovery.test.ts",
  webPrivateAccount: "apps/web/src/lib/private-account.ts",
  webPrivateAccountTest: "apps/web/src/lib/private-account.test.ts",
  webPrivateAccountStore: "apps/web/src/lib/private-account-store.ts",
  webPassport: "apps/web/src/lib/private-agent-passport.ts",
  webPassportTest: "apps/web/src/lib/private-agent-passport.test.ts",
  phalaConfig: "apps/web/src/lib/private-agent-phala.ts",
  phalaConfigTest: "apps/web/src/lib/private-agent-phala.test.ts",
  webPlatformLinkRoute: "apps/web/src/app/v1/private-account/platforms/link/route.ts",
  webWorkspace: "apps/web/src/components/carry/CarryWorkspace.tsx",
  webWorkspaceTest: "apps/web/src/components/carry/CarryWorkspace.test.ts",
  asterVaultSeal: "apps/web/src/lib/aster-vault-seal.ts",
  asterVaultSealTest: "apps/web/src/lib/aster-vault-seal.test.ts",
  lighterVaultSeal: "apps/web/src/lib/lighter-vault-seal.ts",
  lighterVaultSealTest: "apps/web/src/lib/lighter-vault-seal.test.ts",
  lifecycleTest: "apps/private-agent-worker/test/carry-executor.test.js",
  workerMandateTest: "apps/private-agent-worker/test/carry-mandate.test.js",
  positionsTest: "apps/private-agent-worker/test/carry-positions.test.js",
  preflightTest: "apps/private-agent-worker/test/carry-preflight.test.js",
  qualificationTest: "apps/private-agent-worker/test/carry-qualification.test.js",
  readinessTest: "apps/private-agent-worker/test/carry-readiness.test.js",
  reconciliationTest: "apps/private-agent-worker/test/carry-reconciliation.test.js",
  releaseMaterialTest: "apps/private-agent-worker/test/carry-release-evidence.test.js",
  shadowTest: "apps/private-agent-worker/test/perp-shadow-adapters.test.js",
  asterTest: "apps/private-agent-worker/test/aster.test.js",
  lighterTest: "apps/private-agent-worker/test/lighter.test.js",
  hyperliquidMetricsTest: "apps/private-agent-worker/test/hyperliquid-account-metrics.test.js",
  evidenceVerifier: "apps/web/scripts/verify-carry-release-evidence.mjs",
  evidenceVerifierTest: "apps/web/scripts/verify-carry-release-evidence.test.mjs",
  webReconciliation: "apps/web/src/lib/carry-reconciliation.ts",
  webReconciliationTest: "apps/web/src/lib/carry-reconciliation.test.ts",
  proofRunbook: "deploy/evidence/CARRY_MAINNET_PROOF_RUNBOOK.md",
});

export function checkCarryExecutionContract(sources) {
  const failures = [];
  const requireText = (key, value, code) => {
    if (!String(sources[key] || "").includes(value)) failures.push(code);
  };
  const forbidText = (key, value, code) => {
    if (String(sources[key] || "").includes(value)) failures.push(code);
  };

  for (const [key, path] of Object.entries(CARRY_RELEASE_FILES)) {
    if (typeof sources[key] !== "string" || sources[key].length === 0) failures.push(`source_missing:${path}`);
  }

  requireText("vercelIgnore", "!deploy/evidence/CARRY_MAINNET_PROOF_RUNBOOK.md", "carry_proof_runbook_bundle_missing");
  requireText("proofRunbook", "Turnkey owner signs the exact Carry risk mandate", "carry_proof_runbook_owner_signature_missing");
  requireText("proofRunbook", "expiry permits only a reduce-only exit", "carry_proof_runbook_expiry_exit_missing");
  requireText("proofRunbook", "independently recover the owner signature", "carry_proof_runbook_independent_verification_missing");
  requireText("proofRunbook", "carry_execution_no_submit_matrix", "carry_proof_runbook_three_venue_matrix_missing");

  const shadowAdapters = {
    hyperliquid: "hyperliquid_shadow_v1",
    lighter: "lighter_shadow_v1",
    aster: "aster_shadow_v1",
    edgex: "edgex_shadow_v1",
    dydx: "dydx_shadow_v1",
  };
  for (const [venue, adapterId] of Object.entries(shadowAdapters)) {
    requireText("registry", `venue("${venue}"`, `registry_venue_missing:${venue}`);
    requireText("registry", `adapter("${adapterId}", "enabled"`, `shadow_adapter_missing:${venue}`);
  }
  requireText("registry", "export const CARRY_EXECUTION_VENUES", "capability_registry_missing");
  requireText(
    "registry",
    '"carry_execution",\n  "no_submit_reconciliation",\n  "exact_quantity_recovery",',
    "carry_required_adapter_contract_missing",
  );
  requireText("registry", "carryExecutionQualificationForSpec(spec).eligible", "carry_qualification_filter_missing");
  requireText(
    "registry",
    "for (const capability of CARRY_EXECUTION_REQUIRED_ADAPTER_CAPABILITIES)",
    "carry_required_adapter_iteration_missing",
  );
  requireText("registry", "export function carryExecutionQualification", "carry_qualification_report_missing");
  requireText("registryTest", "candidate venues cannot enter Carry until the identical execution contract is complete", "carry_candidate_fail_closed_test_missing");
  requireText("registry", "export const CARRY_BROWSER_STREAM_VENUES", "browser_stream_capability_registry_missing");
  requireText("registry", "export function venueAdapterCapability", "adapter_capability_lookup_missing");
  requireText("registry", "export function venuesWithAdapterCapability", "adapter_capability_query_missing");
  requireText("coreIndex", 'from "./venues.js"', "registry_export_missing");
  requireText("coreIndex", "venueAdapterCapability", "adapter_capability_export_missing");
  requireText("coreIndex", "CARRY_EXECUTION_REQUIRED_ADAPTER_CAPABILITIES", "carry_required_adapter_contract_export_missing");
  requireText("coreIndex", "carryExecutionQualification", "carry_qualification_report_export_missing");
  requireText("coreIndex", 'from "./carry.js"', "carry_domain_export_missing");
  requireText("coreIndex", "evaluatePerpContractPairBasis", "carry_contract_basis_export_missing");
  requireText("webRegistry", 'from "@ghola/execution-core"', "web_registry_bridge_missing");
  requireText("webRegistry", "EXECUTION_CORE_CARRY_VENUES", "web_execution_registry_missing");
  requireText("webRegistry", "EXECUTION_CORE_PERP_VENUES", "web_shadow_registry_missing");
  requireText("webRegistry", "EXECUTION_CORE_BROWSER_STREAM_VENUES", "web_stream_registry_missing");
  forbidText("webRegistry", '["hyperliquid", "lighter", "aster"]', "web_execution_registry_duplicated");
  requireText("webPrivateAccount", "...CARRY_EXECUTION_VENUES", "private_account_manifest_registry_missing");
  requireText("webPrivateAccount", "type CarryExecutionVenueId", "private_account_venue_type_registry_missing");
  if (String(sources.webPrivateAccount || "").split("if (isCarryExecutionVenue(venueId))").length - 1 < 3) {
    failures.push("private_account_policy_registry_missing");
  }
  requireText("webPrivateAccountTest", "derives Carry private-account policy from the execution registry", "private_account_policy_registry_test_missing");
  requireText("webPrivateAccountStore", "...CARRY_EXECUTION_VENUES", "private_agent_registry_bridge_missing");
  requireText("webPrivateAccountStore", "export const PRIVATE_AGENT_VENUE_IDS", "private_agent_registry_missing");
  requireText("webPassport", "PRIVATE_AGENT_VENUE_IDS.map", "private_agent_passport_registry_missing");
  requireText("webPassport", "PRIVATE_AGENT_VENUE_IDS.includes", "private_agent_venue_validation_registry_missing");
  forbidText("webPrivateAccount", 'venueId === "hyperliquid" || venueId === "lighter" || venueId === "aster"', "private_account_policy_registry_duplicated");
  forbidText("webPrivateAccountStore", '["hyperliquid", "lighter", "aster",', "private_agent_registry_duplicated");
  forbidText("webPassport", '["hyperliquid", "lighter", "aster",', "private_agent_passport_registry_duplicated");
  requireText("webWorkspace", "every(isCarryExecutionVenue)", "carry_workspace_execution_registry_missing");
  forbidText("webWorkspace", '["aster", "hyperliquid", "lighter"]', "carry_workspace_execution_registry_duplicated");

  requireText("shadow", "CORE_PERP_VENUES.map", "shadow_registry_iteration_missing");
  requireText("shadow", "SUPPORTED_EXECUTION_VENUES.flatMap", "shadow_capability_registry_missing");
  requireText("shadow", 'venueAdapterCapability(venueId, "perp_shadow")', "shadow_capability_lookup_missing");
  requireText("shadow", "shadow_adapter_unimplemented", "shadow_unknown_adapter_fail_closed_missing");
  forbidText("shadow", "hyperliquid: Object.freeze", "shadow_capability_registry_duplicated");
  requireText("shadow", "max_age_ms", "shadow_staleness_gate_missing");
  requireText("shadow", "observedAtMs", "edgex_response_freshness_missing");
  requireText("shadow", "funding_source_stale", "edgex_funding_source_staleness_gate_missing");
  requireText("shadowTest", "keeps fresh edgeX responses live without trusting a stale funding source", "edgex_split_freshness_test_missing");
  requireText("workerPackage", '"verify:carry-shadow"', "carry_shadow_verifier_script_missing");
  requireText("shadowVerifierCli", "verifyCarryShadowSet", "carry_shadow_verifier_cli_runtime_missing");
  requireText("shadowVerifierCli", "verifyCarryShadowSoak(sampleResults", "carry_shadow_soak_cli_missing");
  requireText("shadowVerifierCli", "GHOLA_CARRY_SHADOW_SAMPLES", "carry_shadow_soak_sample_control_missing");
  requireText("shadowVerifier", "CORE_PERP_VENUES", "carry_shadow_verifier_registry_missing");
  requireText("shadowVerifier", 'Object.freeze(["BTC", "ETH", "SOL"])', "carry_shadow_core_assets_missing");
  requireText("shadowVerifier", "missing_field_unjustified", "carry_shadow_missing_field_evidence_gate_missing");
  requireText("shadowVerifier", "export function verifyCarryShadowSoak", "carry_shadow_soak_verifier_missing");
  requireText("shadowVerifier", "shadow_soak_sample_failed", "carry_shadow_soak_intermittent_failure_gate_missing");
  requireText("shadowVerifier", "read_only_boundary_invalid", "carry_shadow_read_only_gate_missing");
  requireText("shadowVerifier", "snapshot_stale", "carry_shadow_freshness_gate_missing");
  requireText("shadowVerifier", "venue_duplicate", "carry_shadow_duplicate_venue_gate_missing");
  requireText("shadowVerifier", "reference_price_invalid", "carry_shadow_reference_price_gate_missing");
  requireText("shadowVerifierTest", "accepts one fresh normalized shadow for every venue and core asset", "carry_shadow_complete_set_test_missing");
  requireText("shadowVerifierTest", "qualifies only consecutive complete five-venue shadow samples", "carry_shadow_soak_test_missing");
  requireText("shadowVerifierTest", "rejects a one-shot snapshot as durable shadow qualification", "carry_shadow_one_shot_rejection_test_missing");
  requireText("shadowVerifierTest", "rejects normalized gaps without explicit quality evidence", "carry_shadow_quality_evidence_test_missing");
  requireText("shadowVerifierTest", "rejects duplicate or unregistered venue rows", "carry_shadow_duplicate_venue_test_missing");
  requireText("preflight", "carry_shadow_unavailable", "stale_shadow_quarantine_missing");
  requireText("preflight", "carry_market_data_skew_exceeded", "carry_market_data_skew_gate_missing");
  requireText("preflightTest", "rejects cross-venue market data skew before account or order verification", "carry_market_data_skew_test_missing");
  requireText("preflight", "carry_contract_equivalence_failed", "carry_contract_equivalence_gate_missing");
  requireText("preflightTest", "rejects same-ticker contract basis divergence before account or order verification", "carry_contract_equivalence_test_missing");
  requireText("preflightTest", "monitoring measures a signed basis breach without submitting or hiding it as unavailable", "carry_monitor_contract_basis_test_missing");
  requireText("preflight", "collateral_basis", "collateral_basis_model_missing");
  requireText("preflight", "export async function preflightCarryExecutionMatrix", "carry_three_venue_no_submit_matrix_missing");
  requireText("preflight", "allVenuePairs(orderedVenues)", "carry_all_pair_no_submit_matrix_missing");
  requireText("preflight", "leg_evidence: (result.evidence || [])", "carry_pair_leg_evidence_missing");
  requireText("preflightTest", "verifies all three execution venues through one no-broadcast matrix", "carry_three_venue_no_submit_matrix_test_missing");
  requireText("preflight", "storeCarryExecutionReadiness", "carry_three_venue_readiness_persistence_missing");
  requireText("readiness", "runtimeCarryQualificationImageDigest", "carry_readiness_image_binding_missing");
  requireText("readiness", "account_commitment", "carry_readiness_account_binding_missing");
  requireText("readiness", "carry_readiness_stale", "carry_readiness_freshness_gate_missing");
  requireText("readiness", "carry_readiness_commitment_invalid", "carry_readiness_integrity_gate_missing");
  requireText("readinessTest", "persists deployment-, owner-, account-, and registry-bound three-venue readiness", "carry_readiness_binding_test_missing");
  requireText("readinessTest", "rejects stale or tampered readiness instead of reusing transient UI state", "carry_readiness_stale_test_missing");
  requireText("readinessTest", "rejects readiness after any sealed venue binding rotates", "carry_readiness_rotation_test_missing");
  requireText("readinessTest", "requires every unique venue pair before three-venue readiness passes", "carry_all_pair_readiness_test_missing");
  requireText("readiness", "carry_readiness_leg_venue_binding_mismatch", "carry_pair_leg_receipt_binding_missing");
  requireText("readinessTest", "binds every pair to both exact no-submit leg receipts", "carry_pair_leg_receipt_binding_test_missing");
  requireText("readiness", "notionalUsd, horizonDays", "carry_readiness_route_key_missing");
  requireText("readinessTest", "preserves independent route readiness across assets and parameters", "carry_readiness_route_isolation_test_missing");
  requireText("preflight", "const noSubmitReady = connectionReady && (!monitoring || monitoringReady);", "carry_capital_free_no_submit_missing");
  requireText("preflight", "connection_ready: connectionReady", "carry_connection_readiness_evidence_missing");
  requireText("preflight", "account_commitment: access.account_commitment", "carry_capital_account_scope_missing");
  requireText("preflight", "&& modeled.capital_ready", "carry_live_capital_gate_missing");
  requireText("readiness", "opening_collateral_shortfall_micro_usdc", "carry_readiness_shortfall_binding_missing");
  requireText("readiness", "owner_only_funding", "carry_readiness_owner_funding_boundary_missing");
  requireText("readinessTest", "persists capital-free technical readiness while binding exact owner shortfalls", "carry_capital_free_readiness_test_missing");
  requireText("webCarryBuilder", "exact owner funding shortfall shown; no order submitted", "carry_terminal_capital_free_status_missing");
  requireText("preflight", "compileOpeningCapitalPlan", "carry_opening_capital_plan_missing");
  requireText("preflight", "total_opening_collateral_shortfall_micro_usdc", "carry_opening_shortfall_total_missing");
  requireText("preflight", "automatic_transfer_permitted: false", "carry_opening_transfer_boundary_missing");
  requireText("preflight", "total_stress_adjusted_target_collateral_micro_usdc", "carry_stress_capital_target_missing");
  requireText("preflight", "proposal_only: true", "carry_stress_capital_proposal_boundary_missing");
  requireText("preflight", "live_execution_leverage_unchanged: true", "carry_stress_leverage_boundary_missing");
  requireText("preflight", "owner_leverage_configuration_required", "carry_owner_leverage_action_missing");
  requireText("preflight", "executionMandate?.min_margin_runway_ms", "carry_signed_runway_capital_binding_missing");
  requireText("preflightTest", "reports exact owner-funded opening shortfalls without granting transfer authority", "carry_opening_capital_plan_test_missing");
  requireText("preflight", "carry_account_owner_mismatch", "carry_preflight_owner_binding_missing");
  requireText("preflightTest", "rejects cross-owner sealed venue access before order verification", "carry_preflight_owner_binding_test_missing");
  requireText("coreCarry", "collateral_basis_risk_bps", "collateral_basis_stress_missing");
  requireText("coreCarry", "contract_data_skew_exceeded", "carry_contract_skew_model_missing");
  requireText("coreCarryTest", "rejects a false carry spread built from cross-venue observations outside the skew budget", "carry_contract_skew_model_test_missing");
  requireText("coreCarry", "evaluatePerpContractPairBasis", "carry_contract_basis_model_missing");
  requireText("coreCarry", "index_price_divergence_exceeded", "carry_index_basis_veto_missing");
  requireText("coreCarryTest", "rejects same-ticker contracts whose index or mark basis exceeds equivalence budgets", "carry_contract_basis_model_test_missing");
  requireText("coreCarry", "calculateMarginRunway", "margin_runway_model_missing");
  requireText("coreCarry", "margin_runway_unverifiable", "margin_runway_unverifiable_exit_missing");
  requireText("coreCarry", "export function compileCarryCapitalActionPlan", "carry_capital_action_compiler_missing");
  requireText("coreIndex", "compileCarryCapitalActionPlan", "carry_capital_action_export_missing");
  requireText("coreCarry", "carry_capital_automatic_transfer_forbidden", "carry_capital_transfer_boundary_missing");
  requireText("coreCarryTest", "quantifies the minimum owner top-up without transfer authority", "carry_capital_owner_plan_test_missing");
  requireText("coreCarryTest", "quarantines stale evidence and permits reconciliation only", "carry_capital_stale_quarantine_test_missing");
  requireText("coreCarry", "export function compileCarryPortfolioCapitalPlan", "carry_portfolio_capital_compiler_missing");
  requireText("coreIndex", "compileCarryPortfolioCapitalPlan", "carry_portfolio_capital_export_missing");
  requireText("coreCarry", "carry_portfolio_capital_position_authority_boundary", "carry_portfolio_capital_authority_gate_missing");
  requireText("coreCarry", 'account_commitment: identifier(raw.account_commitment, "carry_capital_runway_account")', "carry_capital_account_normalization_missing");
  requireText("coreCarry", "const accountGroups = new Map();", "carry_portfolio_capital_account_aggregation_missing");
  requireText("coreCarry", "proposed_reallocations: proposedReallocations", "carry_portfolio_capital_reallocation_missing");
  requireText("coreCarry", "owner_transfer_approval_required", "carry_portfolio_capital_transfer_approval_missing");
  requireText("coreCarryTest", "aggregates shared accounts and proposes owner-only reallocation", "carry_portfolio_capital_account_test_missing");
  requireText("coreCarryTest", "rejects one account commitment claimed by multiple venues", "carry_portfolio_capital_account_collision_test_missing");
  requireText("coreCarryTest", "quarantines stale evidence and allocates nothing", "carry_portfolio_capital_stale_test_missing");
  requireText("coreCarry", "export function compileCarryPortfolioValueReport", "carry_portfolio_value_compiler_missing");
  requireText("coreIndex", "compileCarryPortfolioValueReport", "carry_portfolio_value_export_missing");
  requireText("coreCarry", "carry_portfolio_value_capital_authority_boundary", "carry_portfolio_value_authority_gate_missing");
  requireText("coreCarry", "value_proof_status: valueProofStatus", "carry_portfolio_value_proof_status_missing");
  requireText("coreCarryTest", "separates finalized after-cost proof from accruing estimates", "carry_portfolio_value_separation_test_missing");
  requireText("coreCarryTest", "rejects duplicate, tampered, or fund-moving evidence", "carry_portfolio_value_failure_test_missing");
  requireText("coreCarry", "projected_trading_fee_micro_usdc", "carry_modeled_fee_attribution_missing");
  requireText("coreCarry", "carry_value_modeled_trading_breakdown_mismatch", "carry_modeled_cost_reconciliation_missing");
  requireText("coreCarry", "summarizeValueAttribution", "carry_value_attribution_missing");
  requireText("coreCarryTest", "rejects modeled component totals that do not reconcile", "carry_modeled_cost_reconciliation_test_missing");
  requireText("coreCarry", "carryRiskMandateMessage", "carry_signed_mandate_message_missing");
  requireText("coreCarry", "export function compileCarryMigrationProposal", "carry_migration_compiler_missing");
  requireText("coreCarry", "migration_venue_allowlist", "carry_migration_signed_allowlist_missing");
  requireText("coreCarry", "proposal_only: true", "carry_migration_proposal_boundary_missing");
  requireText("coreCarry", "request_owner_signed_migration", "carry_migration_owner_signature_boundary_missing");
  forbidText("coreCarry", "preflight_protected_migration", "carry_migration_unimplemented_execution_claimed");
  requireText("coreCarryTest", "selects only the best fresh route inside the signed venue allowlist", "carry_migration_selection_test_missing");
  requireText("coreCarryTest", "fails closed for unsigned, stale, or unqualified destinations", "carry_migration_failure_test_missing");
  requireText("coreCarryTest", "closes the old route first and persists an owner-signature request", "carry_migration_flat_transition_test_missing");
  requireText("coreCarry", "migration_parent_position_id", "carry_migration_signed_lineage_missing");
  requireText("coreCarryTest", "cryptographically bound to its migration parent and candidate", "carry_migration_signed_lineage_test_missing");
  requireText("preflight", "paired_migration_no_submit", "carry_migration_no_submit_mode_missing");
  requireText("preflightTest", "migration preflight applies signed opening limits and never broadcasts", "carry_migration_preflight_test_missing");
  requireText("positions", "migration_candidates: migrationCandidates", "carry_monitor_migration_candidates_missing");
  requireText("positions", "Promise.allSettled", "carry_monitor_migration_single_attempt_missing");
  requireText("positionsTest", "proposes the best no-submit route only after the exit threshold", "carry_monitor_migration_test_missing");
  requireText("positions", "carry_migration_parent_not_flat", "carry_migration_flat_parent_gate_missing");
  requireText("positions", "carry_migration_candidate_mismatch", "carry_migration_selected_route_gate_missing");
  requireText("positions", "carry_migration_replacement_exists", "carry_migration_duplicate_replacement_gate_missing");
  requireText("positionsTest", "creates an owner-signed migration replacement only from the selected flat parent", "carry_migration_replacement_test_missing");
  requireText("server", "outside the signed migration allowlist", "carry_monitor_migration_allowlist_gate_missing");
  requireText("webRoute", "migration_venue_allowlist", "carry_web_migration_access_missing");
  requireText("coreCarry", "carry_mandate_position_mismatch", "carry_signed_mandate_position_binding_missing");
  requireText("coreCarry", "risk_mandate_expired", "carry_signed_mandate_expiry_exit_missing");
  requireText("coreCarry", "contract_basis_outside_mandate", "carry_signed_basis_exit_missing");
  requireText("coreCarryTest", "signed contract skew and basis limits trigger immediate reduce-only exits", "carry_signed_basis_exit_test_missing");
  requireText("workerMandate", "recoverMessageAddress", "carry_worker_signature_recovery_missing");
  requireText("workerMandate", "carry_mandate_owner_mismatch", "carry_worker_owner_binding_missing");
  requireText("workerMandate", "carry_mandate_commitment_mismatch", "carry_worker_commitment_binding_missing");
  requireText("positions", "verifyCarryRiskMandateAuthorization", "carry_storage_signature_gate_missing");
  requireText("positions", "compileCarryCapitalActionPlan", "carry_monitor_capital_plan_missing");
  requireText("positions", "capital_action_plan: capitalActionPlan", "carry_monitor_capital_evidence_missing");
  requireText("positionsTest", "stores an exact owner-only collateral recommendation without transferring", "carry_monitor_capital_plan_test_missing");
  requireText("positions", "export async function compileStoredCarryPortfolioCapitalPlan", "carry_portfolio_capital_worker_missing");
  requireText("positions", "carry_portfolio_capital_evidence_incomplete", "carry_portfolio_capital_incomplete_gate_missing");
  requireText("positionsTest", "compiles an owner-only portfolio capital plan from stored monitoring evidence", "carry_portfolio_capital_worker_test_missing");
  requireText("server", '"/carry/positions/capital-plan"', "carry_portfolio_capital_route_missing");
  requireText("coreCarry", "export function compileCarryCollateralReview", "carry_collateral_review_core_missing");
  requireText("coreCarry", "fund_movement_authorized: false", "carry_collateral_review_fund_boundary_missing");
  requireText("coreCarryTest", "binds exact owner-only moves without authorizing fund movement", "carry_collateral_review_core_test_missing");
  requireText("positions", "export async function compileStoredCarryCollateralReview", "carry_collateral_review_worker_missing");
  requireText("positionsTest", 'review.review.status, "signature_required"', "carry_collateral_review_worker_test_missing");
  requireText("server", '"/carry/positions/collateral-review"', "carry_collateral_review_route_missing");
  requireText("coreCarry", "export function normalizeCarryCollateralReviewAuthorization", "carry_collateral_review_authorization_missing");
  requireText("positions", "export async function approveStoredCarryCollateralReview", "carry_collateral_review_approval_missing");
  requireText("positions", "recoverMessageAddress", "carry_collateral_review_signature_recovery_missing");
  requireText("positions", "state.consumeCapabilityJti", "carry_collateral_review_replay_gate_missing");
  requireText("positions", "carry-collateral-plan:", "carry_collateral_review_durable_approval_missing");
  requireText("positions", "carry_collateral_review_stale", "carry_collateral_review_stale_gate_missing");
  requireText("positions", "ghola_carry_collateral_outcome_receipt", "carry_collateral_outcome_receipt_missing");
  requireText("positions", "safe_runway_verified", "carry_collateral_safe_runway_verification_missing");
  requireText("positions", "owner_action_causality_claimed: false", "carry_collateral_outcome_causality_boundary_missing");
  requireText("positions", "fund_movement_verified: false", "carry_collateral_outcome_fund_claim_boundary_missing");
  requireText("positions", "carry-collateral-latest:", "carry_collateral_followup_persistence_missing");
  requireText("positionsTest", 'approval.receipt.status, "owner_signature_verified"', "carry_collateral_review_approval_test_missing");
  requireText("positionsTest", "carry_collateral_review_replayed", "carry_collateral_review_replay_test_missing");
  requireText("positionsTest", 'verifiedOutcome.outcome_receipt.status, "safe_runway_verified"', "carry_collateral_outcome_test_missing");
  requireText("server", '"/carry/positions/collateral-review/approve"', "carry_collateral_review_approval_route_missing");
  requireText("positions", "export async function compileStoredCarryPortfolioValueReport", "carry_portfolio_value_worker_missing");
  requireText("positionsTest", 'value.report.value_proof_status, "accruing"', "carry_portfolio_value_worker_test_missing");
  requireText("server", '"/carry/positions/value-report"', "carry_portfolio_value_route_missing");
  requireText("positions", "modeledValueBreakdown", "carry_worker_value_breakdown_missing");
  requireText("positionsTest", "value_ledger.modeled.breakdown_complete", "carry_worker_value_breakdown_test_missing");
  requireText("executor", "verifyCarryRiskMandateAuthorization", "carry_entry_signature_gate_missing");
  requireText("webRoute", "verifyCarryRiskMandateAuthorization", "carry_route_signature_gate_missing");
  requireText("webPerpsTurnkey", "signCarryRiskMandate", "carry_turnkey_owner_signing_missing");
  requireText("webCarryBuilder", "signCarryRiskMandate", "carry_terminal_owner_approval_missing");
  requireText("webCarryBuilder", 'label="SOURCE SYNC"', "carry_terminal_source_sync_missing");
  requireText("webCarryBuilder", 'label="INDEX BASIS"', "carry_terminal_index_basis_missing");
  requireText("webCarryBuilder", 'label="OWNER CAPITAL"', "carry_terminal_capital_action_missing");
  requireText("webCarryBuilder", "automatic_transfer_permitted !== false", "carry_terminal_capital_authority_gate_missing");
  requireText("webCarryBuilder", "STRESS CAPITAL ·", "carry_terminal_stress_capital_missing");
  requireText("webClient", "getCarryPortfolioCapitalPlan", "carry_portfolio_capital_client_missing");
  requireText("webClient", "getCarryCollateralReview", "carry_collateral_review_client_missing");
  requireText("webClient", "approveCarryCollateralReview", "carry_collateral_review_approval_client_missing");
  requireText("webCollateralReview", "buildCarryCollateralReviewAuthorization", "carry_collateral_review_web_authorization_missing");
  requireText("webRoute", 'action === "capital_plan"', "carry_portfolio_capital_proxy_missing");
  requireText("webRoute", 'action === "collateral_review"', "carry_collateral_review_proxy_missing");
  requireText("webRoute", 'action === "approve_collateral_review"', "carry_collateral_review_approval_proxy_missing");
  requireText("webCarryBuilder", "PORTFOLIO CAPITAL ·", "carry_terminal_portfolio_capital_missing");
  requireText("webCarryBuilder", "COLLATERAL REVIEW ·", "carry_terminal_collateral_review_missing");
  requireText("webCarryBuilder", "SIGN CAPITAL REVIEW", "carry_terminal_collateral_review_approval_missing");
  requireText("webCarryBuilder", "OWNER VERIFIED · NO FUNDS MOVED", "carry_terminal_collateral_review_receipt_missing");
  requireText("webCarryBuilder", "SAFE RUNWAY VERIFIED · NO FUNDS MOVED", "carry_terminal_collateral_outcome_missing");
  requireText("webPerpsTurnkey", "signCarryCollateralReview", "carry_collateral_review_turnkey_signing_missing");
  requireText("webCarryBuilderTest", "COLLATERAL REVIEW · 1 MOVE · 0 FUND · $15 · REVIEW ONLY", "carry_terminal_collateral_review_test_missing");
  requireText("webCarryBuilderTest", "shows fresh account-state proof after an approved capital plan restores safe runway", "carry_terminal_collateral_outcome_test_missing");
  requireText("webClient", "getCarryPortfolioValueReport", "carry_portfolio_value_client_missing");
  requireText("webRoute", 'action === "value_report"', "carry_portfolio_value_proxy_missing");
  requireText("webCarryBuilder", "PORTFOLIO VALUE ·", "carry_terminal_portfolio_value_missing");
  requireText("webCarryBuilder", "STALE EVIDENCE · RECONCILE ONLY", "carry_terminal_portfolio_stale_gate_missing");
  requireText("webCarryBuilderTest", "PORTFOLIO CAPITAL · $15 REALLOCATE · $10 NEW CASH · OWNER ONLY", "carry_terminal_portfolio_capital_test_missing");
  requireText("webCarryBuilderTest", "PORTFOLIO CAPITAL · $12.5 RELEASABLE · OWNER ONLY", "carry_terminal_portfolio_optimization_test_missing");
  requireText("webCarryBuilderTest", "PORTFOLIO VALUE · $19.5 REAL · $10 OPEN MODEL · +$4.5 Δ", "carry_terminal_portfolio_value_test_missing");
  requireText("webCarryBuilder", "live_execution_leverage_unchanged !== true", "carry_terminal_stress_leverage_boundary_missing");
  requireText("webCarryBuilderTest", "UP TO 1× OWNER CONFIG", "carry_terminal_stress_capital_test_missing");
  requireText("webCarryBuilderTest", '$10 → LIGHTER · OWNER', "carry_terminal_capital_action_test_missing");
  requireText("webCarryBuilder", 'label="LEDGER"', "carry_terminal_value_ledger_missing");
  requireText("webCarryBuilder", 'label="EXEC Δ"', "carry_terminal_execution_attribution_missing");
  requireText("webCarryBuilderTest", "FEE +$0.5 · SLIP −$0.25", "carry_terminal_execution_attribution_test_missing");
  requireText("webMandate", "defaultCarryRiskMandate", "carry_default_migration_mandate_missing");
  requireText("webMandate", "allow_migration: true", "carry_default_migration_disabled");
  requireText("webCarryBuilder", "SIGN MIGRATION", "carry_terminal_migration_signing_missing");
  requireText("webCarryBuilderTest", "binds a replacement signature to the selected flat migration parent", "carry_terminal_migration_lineage_test_missing");
  requireText("webMandate", "recoverMessageAddress", "carry_web_signature_recovery_missing");
  requireText("webMandateTest", "rejects wrong-owner, expired, and cross-position replay", "carry_signed_mandate_replay_test_missing");
  requireText("workerMandateTest", "worker rejects mandate mutation, owner replay, and expiry", "carry_worker_mandate_tamper_test_missing");
  requireText("coreCarryTest", "an unverifiable null margin runway triggers an immediate reduce-only exit", "margin_runway_unverifiable_test_missing");
  requireText("coreCarryTest", "a verified healthy null runway represents zero modeled burn", "margin_runway_infinite_test_missing");

  requireText("qualification", "adapter_id: adapters.adapter_id", "qualification_adapter_binding_missing");
  requireText("qualification", 'venueAdapterCapability(venueId, "no_submit_reconciliation")', "qualification_reconciliation_registry_missing");
  requireText("qualification", "image_digest: imageDigest", "qualification_image_binding_missing");
  requireText("qualification", 'network: "mainnet"', "qualification_mainnet_proof_missing");
  requireText("qualification", "ambiguous_submission_retry_count: 0", "qualification_no_retry_proof_missing");
  requireText("qualification", "gross_exposure_micro_usdc: 0", "qualification_flat_proof_missing");
  requireText("qualification", "open_order_count: 0", "qualification_zero_orders_proof_missing");
  requireText("releaseMaterial", "buildCompletedCarryReleaseMaterial", "carry_release_material_builder_missing");
  requireText("releaseMaterial", "carry_release_monitoring_evidence_missing", "carry_release_monitoring_gate_missing");
  requireText("releaseMaterial", "carry_release_margin_runway_evidence_missing", "carry_release_runway_gate_missing");
  requireText("releaseMaterial", "carry_release_contract_equivalence_exceeded", "carry_release_contract_basis_gate_missing");
  requireText("releaseMaterial", "contract_equivalence: contractEquivalence.evidence", "carry_release_contract_basis_evidence_missing");
  requireText("releaseMaterial", "carry_release_signed_mandate_unproven", "carry_release_signed_mandate_gate_missing");
  requireText("releaseMaterial", "owner_signature", "carry_release_owner_signature_missing");
  requireText("releaseMaterial", "status: runwayStatuses[venueId]", "carry_release_runway_status_missing");
  requireText("releaseMaterial", "attempt?.submit_count !== 1", "carry_release_submit_count_gate_missing");
  requireText("releaseMaterial", "attempt?.ambiguity_retry_count !== 0", "carry_release_retry_count_gate_missing");
  requireText("executor", "venues: venueProof", "carry_reconciliation_venue_rows_missing");
  requireText("reconciliation", "assessCarryFlatReconciliation", "carry_exact_flat_reconciliation_gate_missing");
  requireText("reconciliationTest", "rejects aggregate-only, unsafe, duplicate, and residual venue claims", "carry_exact_flat_reconciliation_test_missing");
  requireText("releaseMaterial", "assessCarryFlatReconciliation", "carry_release_venue_final_state_gate_missing");
  requireText("qualification", "hasExactCarryFlatReconciliation", "carry_qualification_exact_flat_gate_missing");
  requireText("positions", "hasExactCarryFlatReconciliation", "carry_migration_exact_flat_gate_missing");
  requireText("webCarryBuilder", "hasExactCarryFlatReconciliation", "carry_terminal_exact_flat_gate_missing");
  requireText("webCarryBuilderTest", "does not claim flat from aggregate-only reconciliation", "carry_terminal_aggregate_flat_rejection_test_missing");
  requireText("webWorkspace", "hasExactCarryFlatReconciliation", "carry_workspace_exact_flat_display_missing");
  requireText("webReconciliationTest", "rejects aggregate-only flat claims", "carry_web_exact_flat_test_missing");
  requireText("releaseMaterialTest", "refuses aggregate-only final reconciliation evidence", "carry_release_aggregate_only_rejection_test_missing");
  requireText("releaseMaterialTest", "refuses duplicate, mismatched, or non-flat venue final state", "carry_release_venue_final_state_test_missing");
  requireText("releaseMaterial", "worker_material_commitment", "carry_release_material_commitment_missing");
  requireText("privateExecution", "submit_count: 1", "durable_submit_count_missing");
  requireText("privateExecution", "ambiguity_retry_count: 0", "durable_retry_count_missing");
  requireText("privateExecution", 'venueAdapterCapability(venueId, capability)', "worker_carry_capability_registry_missing");
  requireText("privateExecution", 'registeredCarryAdapter(venue_id, "carry_execution")', "worker_carry_execution_registry_dispatch_missing");
  requireText("privateExecution", 'registeredCarryAdapter(venue_id, "no_submit_reconciliation")', "worker_carry_no_submit_registry_dispatch_missing");
  requireText("privateExecution", 'registeredCarryAdapterId(venueId, "carry_execution")', "worker_carry_funding_registry_dispatch_missing");
  requireText("privateExecution", "openAccountBoundExecutionVault", "carry_execution_vault_account_binding_missing");
  requireText("privateExecution", "opened.associatedDataText !== expectedAad", "carry_execution_vault_exact_aad_missing");
  requireText("privateExecution", '`account:${accountCommitment}`', "carry_execution_vault_account_commitment_missing");
  forbidText("privateExecution", 'aadPrefix: "ghola/hyperliquid-execution-vault-v1"', "hyperliquid_prefix_only_vault_open_forbidden");
  forbidText("privateExecution", 'aadPrefix: "ghola/aster-execution-vault-v1"', "aster_prefix_only_vault_open_forbidden");
  requireText("adapterRegistryTest", "shadow-only candidates cannot enter worker Carry dispatch", "worker_carry_registry_fail_closed_test_missing");
  requireText("adapterRegistryTest", "adapter_missing:no_submit_reconciliation", "worker_carry_no_submit_registry_gate_missing");
  requireText("adapterRegistryTest", "Carry funding history dispatches through the registered Aster adapter", "worker_carry_funding_registry_test_missing");

  requireText("hyperliquid", "target_client_order_matched", "hyperliquid_target_match_proof_missing");
  requireText("aster", "submitAndReconcileAsterExecution", "aster_exact_reconcile_missing");
  requireText("aster", "target_client_order_matched", "aster_target_match_proof_missing");
  requireText("lighter", "submitAndReconcileLighterExecution", "lighter_exact_reconcile_missing");
  requireText("lighter", "target_client_order_matched", "lighter_target_match_proof_missing");
  requireText("aster", "submission_outcome_ambiguous", "aster_ambiguity_freeze_missing");
  requireText("lighter", "submission_ambiguous", "lighter_ambiguity_freeze_missing");
  forbidText("aster", "submitAndReconcileAsterExecution({\n  credential,\n  instruction,\n  clientOrderId,\n  retry", "aster_retry_forbidden");
  forbidText("lighter", "submitAndReconcileLighterExecution({\n  credential,\n  instruction,\n  clientOrderIndex,\n  retry", "lighter_retry_forbidden");

  requireText("positions", "PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_MAX_NOTIONAL_MICRO_USDC", "pilot_notional_cap_missing");
  requireText("positions", "margin_runway_status_by_venue", "carry_monitor_runway_status_missing");
  requireText("positions", 'return "carry_market_data_skew_exceeded"', "carry_storage_skew_gate_missing");
  requireText("positions", 'return "carry_contract_basis_exceeded"', "carry_storage_contract_basis_gate_missing");
  requireText("positions", 'return "carry_unsigned_contract_basis_limit"', "carry_storage_signed_basis_gate_missing");
  requireText("positionsTest", "refuses storage until venue accounts, synchronized equivalent contracts, and margin runways pass", "carry_storage_skew_test_missing");
  requireText("positionsTest", "margin_runway_status_by_venue.hyperliquid", "carry_monitor_runway_status_test_missing");
  requireText("releaseMaterialTest", "refuses release evidence without verified margin-runway status", "carry_release_runway_test_missing");
  requireText("releaseMaterialTest", "refuses release evidence without bounded contract equivalence", "carry_release_contract_basis_test_missing");
  requireText("evidenceVerifier", "margin_runway_status_missing", "carry_evidence_runway_status_gate_missing");
  requireText("evidenceVerifierTest", "rejects margin-runway proof without verified status", "carry_evidence_runway_status_test_missing");
  requireText("evidenceVerifier", "contract_index_basis_exceeded", "carry_evidence_contract_basis_gate_missing");
  requireText("evidenceVerifierTest", "rejects same-ticker proof whose contract basis exceeds the verified budget", "carry_evidence_contract_basis_test_missing");
  requireText("evidenceVerifierTest", "rejects contract limits that differ from the signed risk mandate", "carry_evidence_signed_basis_test_missing");
  requireText("executor", "carry_qualification_pilot_confirmation_required", "pilot_confirmation_gate_missing");
  requireText("executor", "submission_ambiguous", "carry_ambiguity_freeze_missing");
  requireText("coreMultiLeg", "cancel_before_submit", "carry_pre_submit_cancel_event_missing");
  requireText("coreMultiLegTest", "only while submission is provably absent", "carry_pre_submit_cancel_test_missing");
  requireText("executor", "provablyPreSubmitCarrySaga", "carry_restart_pre_submit_proof_missing");
  requireText("executor", 'transaction_broadcast: false', "carry_restart_zero_broadcast_evidence_missing");
  requireText("executor", "carry_exit_not_flat_or_open_orders_nonzero", "carry_final_flat_gate_missing");
  requireText("preflight", 'PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED === "true"', "pilot_runtime_preflight_gate_missing");
  requireText("phalaConfig", "expectedCarryWorkerConfig", "carry_runtime_config_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT', "carry_live_submit_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED', "carry_pilot_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_MAX_NOTIONAL_MICRO_USDC', "carry_pilot_cap_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MAX_MARKET_DATA_SKEW_MS', "carry_market_data_skew_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS', "carry_index_basis_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS', "carry_mark_basis_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MONITOR_ENABLED', "carry_monitor_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MONITOR_INTERVAL_MS', "carry_monitor_interval_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MONITOR_CONCURRENCY', "carry_monitor_concurrency_compose_missing");
  requireText("positions", "mapConcurrentOrdered(records, concurrency", "carry_monitor_bounded_concurrency_missing");
  requireText("phalaConfigTest", 'PRIVATE_AGENT_CARRY_MONITOR_INTERVAL_MS: "5000"', "carry_monitor_five_second_runtime_test_missing");
  requireText("phalaConfigTest", 'PRIVATE_AGENT_CARRY_MAX_MARKET_DATA_SKEW_MS: "750"', "carry_market_data_skew_runtime_test_missing");
  requireText("phalaConfigTest", 'PRIVATE_AGENT_CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS: "12"', "carry_index_basis_runtime_test_missing");
  requireText("phalaConfigTest", 'PRIVATE_AGENT_CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS: "24"', "carry_mark_basis_runtime_test_missing");
  requireText("phalaConfig", "...expectedCarryWorkerConfig()", "carry_runtime_drift_gate_missing");
  requireText("phalaConfigTest", "pins an explicitly enabled capped Carry qualification runtime", "carry_runtime_drift_test_missing");
  requireText("server", 'req.headers["x-ghola-carry-qualification-confirmed"] === "true"', "worker_confirmation_header_missing");
  requireText("server", '"/carry/positions/release-evidence"', "worker_release_evidence_route_missing");
  requireText("server", '"/carry/preflight-matrix"', "carry_three_venue_no_submit_worker_route_missing");
  requireText("server", '"/carry/readiness"', "carry_readiness_resume_worker_route_missing");
  requireText("server", "readCarryExecutionReadiness", "carry_readiness_resume_worker_missing");
  requireText("webRoute", '"x-ghola-carry-qualification-confirmed": "true"', "web_confirmation_header_missing");
  requireText("webClient", "qualification_pilot_confirmed", "web_confirmation_input_missing");
  requireText("webClient", "preflightCarryExecutionMatrix", "carry_three_venue_no_submit_client_missing");
  requireText("webClient", "getCarryExecutionReadiness", "carry_readiness_resume_client_missing");
  requireText("webCarryBuilder", "asset: candidate.asset", "carry_readiness_route_client_binding_missing");
  requireText("webRoute", 'action === "preflight_matrix"', "carry_three_venue_no_submit_web_route_missing");
  requireText("webRoute", 'action === "readiness"', "carry_readiness_resume_web_route_missing");
  requireText("webRoute", "horizon_days: input.horizon_days", "carry_readiness_route_web_binding_missing");
  requireText("webPage", "carry=open", "carry_chart_redirect_missing");
  requireText("webTradeWorkspace", "CarryChartStrip", "carry_chart_strip_missing");
  requireText("webTradeWorkspace", 'label="Funding / 1h"', "hyperliquid_funding_interval_label_incorrect");
  requireText("webCarryChart", "createCarryLiveMarketStream", "carry_live_stream_missing");
  requireText("webCarryChart", "createCarryPatchPublisher", "carry_ui_publication_coalescer_missing");
  requireText("webCarryChart", "CARRY_UI_PUBLISH_INTERVAL_MS", "carry_ui_publish_throttle_missing");
  requireText("webCarryChart", "CARRY_ROUTE_DISPLAY_MAX_AGE_MS", "carry_ui_stale_route_gate_missing");
  requireText("webCarryChart", "expectedNetDailyUsd", "carry_net_value_display_missing");
  requireText("webCarryChart", "isCarryExecutionVenue(candidate.long.venue_id)", "carry_executable_route_fallback_missing");
  requireText("webCarryChart", "rankCarryCandidatesByNet", "carry_net_route_ranking_missing");
  requireText("webCarryChart", 'aria-label="Carry execution route"', "carry_execution_route_selector_missing");
  requireText("webCarryChart", "CarryTerminalBuilder", "carry_terminal_builder_missing");
  requireText("webCarryChart", ">XVENUE<", "carry_terminal_rail_missing");
  requireText("webCarryChart", "formatBps", "carry_basis_point_display_missing");
  requireText("webCarryChart", "grossDailyBps", "carry_gross_value_display_missing");
  requireText("webCarryChart", "NET24H", "carry_net_value_display_missing");
  requireText("webCarryChart", "routeHasPositiveNet", "carry_positive_net_qualification_missing");
  requireText("webCarryChart", 'data-route-qualified={selectedHasPositiveNet ? "true" : "false"}', "carry_route_qualification_state_missing");
  requireText("webCarryChart", "AGE {formatAge", "carry_feed_age_display_missing");
  requireText("webCarryChart", "% APR", "carry_funding_period_label_missing");
  requireText("webCarryChart", "startTransition(() => setLivePatches(patches))", "carry_nonblocking_ui_publish_missing");
  forbidText("webCarryChart", "DATA {liveVenueCount}", "carry_socket_status_mislabeled_as_live_data");
  forbidText("webCarryChart", "FEEDS {liveVenueCount}", "carry_socket_status_mislabeled_as_live_data");
  forbidText("webCarryChart", "QUAL {qualifiedCandidates.length}", "carry_route_count_without_net_proof");
  forbidText("webCarryChart", "Scanning equivalent perps", "carry_marketing_status_copy_forbidden");
  requireText("webCarryBuilder", "preflightCarryExecutionMatrix", "carry_terminal_three_venue_matrix_missing");
  requireText("webCarryBuilder", "getCarryExecutionReadiness", "carry_terminal_readiness_restore_missing");
  requireText("webCarryBuilder", "readyStoredReadiness", "carry_terminal_readiness_freshness_missing");
  requireText("webCarryBuilder", "CARRY_EXECUTION_VENUES.every", "carry_terminal_matrix_registry_missing");
  forbidText("webCarryBuilder", '["hyperliquid", "lighter", "aster"]', "carry_terminal_matrix_registry_duplicated");
  requireText("webCarryBuilder", "preflightCarryPair", "carry_terminal_pair_no_submit_missing");
  requireText("webCarryBuilder", "createCarryPosition", "carry_terminal_position_creation_missing");
  requireText("webCarryBuilder", "executeCarryPositionEntry", "carry_terminal_entry_missing");
  requireText("webCarryBuilder", "requestCarryPositionExit", "carry_terminal_exit_missing");
  requireText("webCarryBuilder", "ARM CAPPED PROOF", "carry_terminal_qualification_path_missing");
  requireText("webCarryBuilder", "CONFIRM LIVE PAIRED ENTRY", "carry_terminal_separate_confirmation_missing");
  requireText("webCarryBuilder", "FLAT · 0 ORDERS", "carry_terminal_flat_state_missing");
  requireText("webCarryBuilder", "RETRY POSITION SYNC", "carry_terminal_position_sync_gate_missing");
  requireText("webCarryBuilder", "MIN RUNWAY", "carry_terminal_runway_display_missing");
  requireText("webCarryBuilder", "window.setTimeout(refresh", "carry_terminal_monitor_refresh_missing");
  requireText("webCarryBuilderTest", "keeps checking and arming no-submit until a separate live-entry click", "carry_terminal_boundary_test_missing");
  requireText("webCarryBuilderTest", "runs the three-venue matrix before checking or arming one route", "carry_terminal_three_venue_matrix_test_missing");
  requireText("webCarryBuilderTest", "restores fresh deployment-bound readiness after refresh without rerunning the three-venue matrix", "carry_terminal_readiness_restore_test_missing");
  requireText("webCarryBuilderTest", "allows a new Carry Position after the previous route proved flat with zero orders", "carry_terminal_repeat_lifecycle_test_missing");
  requireText("webCarryBuilderTest", "fails closed when the initial position sync is unavailable", "carry_terminal_position_sync_test_missing");
  requireText("webCarryBuilderTest", "shows compact live margin-runway evidence inside the terminal", "carry_terminal_runway_display_test_missing");
  requireText("webCarryBuilderTest", 'toContain("400MS")', "carry_terminal_source_sync_test_missing");
  requireText("webCarryBuilderTest", 'toContain("3BP")', "carry_terminal_index_basis_test_missing");
  const quoteEvaluationCount = String(sources.webCarryChart || "")
    .match(/quoteCarryCandidate\s*\(/g)?.length || 0;
  if (quoteEvaluationCount > 0) failures.push("carry_redundant_quote_rendering");
  const netRankingCount = String(sources.webCarryChart || "")
    .match(/rankCarryCandidatesByNet\s*\(/g)?.length || 0;
  if (netRankingCount !== 1) failures.push("carry_redundant_net_ranking");
  requireText("webCarryChart", "pricedCandidates.filter", "carry_execution_routes_not_derived_from_single_ranking");
  requireText("webCarryMarket", "CARRY_LIVE_PATCH_MAX_AGE_MS", "carry_live_staleness_gate_missing");
  requireText("webCarryMarket", "applyCarryLivePatches", "carry_incremental_quote_engine_missing");
  requireText("webCarryMarket", "export function buildPairCandidates", "carry_pair_enumeration_missing");
  requireText("webCarryMarket", "export function rankCarryCandidatesByNet", "carry_net_ranking_engine_missing");
  requireText("webCarryLiveMarket", "wss://mainnet.zklighter.elliot.ai", "lighter_live_feed_missing");
  requireText("webCarryLiveMarket", "CARRY_BROWSER_STREAM_VENUES", "carry_browser_stream_registry_missing");
  forbidText("webCarryLiveMarket", '["lighter", "aster", "dydx", "edgex"]', "carry_browser_stream_registry_duplicated");
  requireText("webCarryLiveMarket", "UNCHANGED_PATCH_HEARTBEAT_MS", "carry_live_patch_dedupe_missing");
  requireText("webCarryLiveMarket", "wss://fstream.asterdex.com", "aster_live_feed_missing");
  requireText("webCarryLiveMarket", "wss://indexer.dydx.trade", "dydx_live_feed_missing");
  requireText("webCarryLiveMarket", "wss://edgex-quote-prod-v2.edgex.exchange", "edgex_live_feed_missing");
  requireText("webCarryLiveMarketTest", "inside one 16ms UI frame", "carry_hot_path_benchmark_missing");
  requireText("webCarryLiveMarketTest", "buildPairCandidates", "carry_pair_hot_path_benchmark_missing");
  requireText("webCarryLiveMarketTest", "rankCarryCandidatesByNet", "carry_net_rank_hot_path_benchmark_missing");
  requireText("webCarryLiveMarketTest", "coalesces later ticks within one frame", "carry_ui_publication_test_missing");
  forbidText("webCarryLiveMarketTest", "below one millisecond", "carry_unrealistic_sub_ms_claim_forbidden");
  forbidText("webCarryLiveMarketTest", "sub-ms", "carry_unrealistic_sub_ms_claim_forbidden");
  requireText("webCarryLiveMarketTest", "suppresses non-BBO dYdX depth churn", "carry_depth_churn_test_missing");
  for (const host of [
    "wss://mainnet.zklighter.elliot.ai",
    "wss://fstream.asterdex.com",
    "wss://indexer.dydx.trade",
    "wss://edgex-quote-prod-v2.edgex.exchange",
  ]) requireText("webCsp", host, `carry_live_csp_missing:${host}`);
  requireText("webAccountPage", "focusedCarrySetup", "carry_account_route_missing");
  requireText("webAccountPage", "<CarryAccountSetup returnTo={returnTo}", "carry_setup_return_path_missing");
  requireText("webAccountSetup", "connectionProgress.ready", "carry_setup_all_venues_gate_missing");
  forbidText("webAccountSetup", "length >= 2", "carry_setup_partial_matrix_gate_forbidden");
  requireText("webAccountConnectionsTest", "unlocks route verification only when every execution venue is connected", "carry_setup_all_venues_test_missing");
  requireText("webAccountConnections", "export function carryAccountSetupNextAction", "carry_setup_guided_action_missing");
  requireText("webAccountSetup", "carryAccountSetupNextAction", "carry_setup_guided_action_ui_missing");
  requireText("webAccountConnectionsTest", "keeps one guided next action while skipping a venue blocked on external activation", "carry_setup_blocked_venue_resume_test_missing");
  requireText("webAccountConnectionsTest", "turns the same guided action into route verification only after all venues connect", "carry_setup_guided_completion_test_missing");
  requireText("webAccountSetup", "buildAsterExecutionVaultBundle", "aster_account_setup_missing");
  requireText("webAccountSetup", "buildLighterExecutionVaultBundle", "lighter_account_setup_missing");
  requireText("webAccountSetup", "href={safeReturnTo}", "carry_setup_terminal_return_missing");
  requireText("webAccountSetup", "return_to=${encodeURIComponent(setupReturnTo)}", "hyperliquid_setup_carry_resume_missing");
  requireText("webAccountSetup", "readCarryOnboardingRecovery", "carry_setup_recovery_restore_missing");
  requireText("webAccountSetup", "updateCarryOnboardingRecovery", "carry_setup_recovery_persist_missing");
  requireText("webOnboardingRecovery", "MAX_AGE_MS", "carry_setup_recovery_expiry_missing");
  requireText("webOnboardingRecovery", "validAster", "aster_setup_recovery_validation_missing");
  requireText("webOnboardingRecovery", "validLighter", "lighter_setup_recovery_validation_missing");
  requireText("webOnboardingRecovery", "preparation.account_commitment === accountCommitment", "carry_setup_recovery_account_binding_missing");
  requireText("webOnboardingRecovery", "keccak256(rawTransaction", "lighter_setup_recovery_hash_binding_missing");
  requireText("webOnboardingRecoveryTest", "restores the exact signed Lighter preparation after a reload", "lighter_setup_reload_test_missing");
  requireText("webOnboardingRecoveryTest", "keeps only sealed Aster material", "aster_setup_sealed_recovery_test_missing");
  requireText("webOnboardingRecoveryTest", "rejects tampered account bindings and signed Lighter transaction hashes", "carry_setup_tamper_test_missing");
  requireText("webPlatformLinkRoute", "linkAgentPlatformFromBody", "carry_platform_link_route_missing");
  requireText("webPassportTest", "does not persist an encrypted venue vault before worker verification succeeds", "carry_transactional_vault_test_missing");
  requireText("webPassportTest", "links two Carry venues through authenticated routes", "carry_onboarding_route_test_missing");
  requireText("webPassportTest", "forwards all three sealed Carry venues through one no-submit matrix", "carry_three_venue_no_submit_web_test_missing");
  const verificationGate = String(sources.webPassport || "").indexOf("if (!serverVerification.ok)");
  const vaultPersistence = String(sources.webPassport || "").indexOf("if (vaultToStore) await putVenueExecutionVault(vaultToStore)");
  if (verificationGate < 0 || vaultPersistence <= verificationGate) failures.push("carry_vault_persisted_before_verification");
  requireText("asterVaultSeal", "ghola_aster_execution_vault", "aster_vault_seal_missing");
  requireText("lighterVaultSeal", "ghola_lighter_execution_vault", "lighter_vault_seal_missing");
  requireText("webWorkspace", "CORE_PERP_VENUES.map", "web_shadow_registry_iteration_missing");
  requireText("webWorkspace", "Collateral basis stress", "user_risk_disclosure_missing");
  requireText("webWorkspace", "Collateral assets", "user_collateral_assets_missing");
  requireText("webWorkspace", "Margin runway", "user_margin_runway_missing");
  requireText("webWorkspace", "Entry requires the separate action below", "carry_submit_boundary_copy_missing");
  requireText("webWorkspaceTest", "ranks every equivalent pair by net value instead of gross funding alone", "carry_net_route_ranking_test_missing");

  requireText("lifecycleTest", "bootstraps one capped candidate only after separate qualification confirmation", "qualification_lifecycle_test_missing");
  requireText("lifecycleTest", "executes every qualified Hyperliquid, Lighter, and Aster pair through one contract", "carry_three_venue_pair_contract_test_missing");
  requireText("lifecycleTest", "carry_qualification_pilot_confirmation_required", "qualification_denial_test_missing");
  requireText("lifecycleTest", "const restarted = createWorkerState(dir)", "qualification_restart_test_missing");
  requireText("lifecycleTest", "restored.proven", "qualification_restore_assertion_missing");
  requireText("lifecycleTest", "background monitoring triggers an automatic reduce-only exit and finalizes flat value evidence", "carry_automatic_exit_lifecycle_test_missing");
  requireText("lifecycleTest", "const secondMonitor = await runCarryMonitoringTick", "carry_automatic_exit_monitor_test_missing");
  requireText("lifecycleTest", "const restartedState = createWorkerState(fixture.state_dir)", "carry_automatic_exit_restart_test_missing");
  requireText("lifecycleTest", "calls.every((call) => call.instruction.order.reduce_only === true)", "carry_automatic_exit_reduce_only_test_missing");
  requireText("lifecycleTest", "restart releases a linked entry only when its saga proves no submit occurred", "carry_restart_entry_pre_submit_test_missing");
  requireText("lifecycleTest", "restart safely retries an exit linked before any submission", "carry_restart_exit_pre_submit_test_missing");
  requireText("evidenceVerifier", "ghola_cross_venue_carry_mainnet_lifecycle_proof", "carry_release_evidence_kind_missing");
  requireText("evidenceVerifier", "exact_exit_quantity_required", "carry_release_exact_exit_gate_missing");
  requireText("evidenceVerifier", "final_open_orders_not_zero", "carry_release_zero_orders_gate_missing");
  requireText("evidenceVerifier", "realized_net_value_mismatch", "carry_release_value_reconciliation_missing");
  requireText("evidenceVerifier", "owner_signature_mismatch", "carry_release_signature_verifier_missing");
  requireText("evidenceVerifierTest", "rejects an ambiguous resubmission", "carry_release_ambiguity_test_missing");
  requireText("evidenceVerifierTest", "rejects a mutated or replayed owner mandate", "carry_release_mandate_tamper_test_missing");
  requireText("proofRunbook", "separately confirms the capped paired trade", "carry_proof_confirmation_runbook_missing");
  requireText("proofRunbook", "zero exposure and zero open orders", "carry_proof_flat_runbook_missing");

  if (failures.length) {
    throw new Error(`Carry execution contract failed: ${[...new Set(failures)].join(", ")}`);
  }
  return { ok: true, required_file_count: Object.keys(CARRY_RELEASE_FILES).length };
}

export function findUntrackedCarryReleaseFiles({ repoRoot = REPO_ROOT, run = execFileSync, gitAvailable = existsSync(resolve(repoRoot, ".git")) } = {}) {
  if (!gitAvailable) return [];
  return Object.values(CARRY_RELEASE_FILES).filter((path) => {
    try {
      run("git", ["ls-files", "--error-unmatch", path], { cwd: repoRoot, stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  });
}

export function loadCarryReleaseSources(repoRoot = REPO_ROOT) {
  return Object.fromEntries(Object.entries(CARRY_RELEASE_FILES).map(([key, path]) => {
    const absolute = resolve(repoRoot, path);
    if (!existsSync(absolute)) throw new Error(`Carry release source is missing: ${path}`);
    return [key, readFileSync(absolute, "utf8")];
  }));
}

function main() {
  const result = checkCarryExecutionContract(loadCarryReleaseSources());
  const untracked = findUntrackedCarryReleaseFiles();
  if (untracked.length > 0) {
    throw new Error(`Carry release files are not committed: ${untracked.join(", ")}`);
  }
  console.log(`[carry-execution-contract] verified ${result.required_file_count} committed sources`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
