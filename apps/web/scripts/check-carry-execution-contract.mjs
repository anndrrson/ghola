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
  workerState: "apps/private-agent-worker/src/state/private-state.js",
  workerPackage: "apps/private-agent-worker/package.json",
  preflight: "apps/private-agent-worker/src/execution/carry-preflight.js",
  fundingPersistence: "apps/private-agent-worker/src/execution/carry-funding-persistence.js",
  routingAdvantage: "apps/private-agent-worker/src/execution/carry-routing-advantage.js",
  shadowQualification: "apps/private-agent-worker/src/execution/carry-shadow-qualification.js",
  shadowSnapshot: "apps/private-agent-worker/src/execution/carry-shadow-snapshot.js",
  workerMandate: "apps/private-agent-worker/src/execution/carry-mandate.js",
  positions: "apps/private-agent-worker/src/execution/carry-positions.js",
  transferProbe: "apps/private-agent-worker/src/execution/carry-transfer-probe.js",
  transferVenueReaders: "apps/private-agent-worker/src/execution/carry-transfer-venue-readers.js",
  stablecoinConversion: "apps/private-agent-worker/src/execution/carry-stablecoin-conversion.js",
  depositQuote: "apps/private-agent-worker/src/execution/carry-deposit-quote.js",
  runtimeRiskPolicies: "apps/private-agent-worker/src/execution/carry-runtime-risk-policies.js",
  privatePrimeReadiness: "apps/private-agent-worker/src/execution/carry-private-prime-readiness.js",
  privatePrimeAuthentication: "apps/private-agent-worker/src/execution/carry-private-prime-authentication.js",
  opportunityAuthentication: "apps/private-agent-worker/src/execution/carry-opportunity-authentication.js",
  transferRoutes: "apps/private-agent-worker/src/execution/carry-transfer-routes.js",
  recordScan: "apps/private-agent-worker/src/execution/carry-record-scan.js",
  loopSupervisor: "apps/private-agent-worker/src/execution/carry-loop-supervisor.js",
  executor: "apps/private-agent-worker/src/execution/carry-executor.js",
  multiLegOrchestrator: "apps/private-agent-worker/src/execution/multi-leg-orchestrator.js",
  privateExecution: "apps/private-agent-worker/src/execution/private-execution.js",
  adapterRegistryTest: "apps/private-agent-worker/test/carry-adapter-registry.test.js",
  multiLegOrchestratorTest: "apps/private-agent-worker/test/multi-leg-orchestrator.test.js",
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
  workerAttestedSigner: "apps/private-agent-worker/src/venues/shielded_funding_attestation.js",
  lighterRunner: "apps/private-agent-worker/src/venues/lighter_runner.py",
  webRoute: "apps/web/src/app/v1/private-account/carry/route.ts",
  webWorkerRouting: "apps/web/src/lib/private-account-worker-routing.ts",
  webWorkerRoutingTest: "apps/web/src/lib/private-account-worker-routing.test.ts",
  webEnvExample: "apps/web/.env.example",
  webClient: "apps/web/src/lib/private-account-client.ts",
  webMandate: "apps/web/src/lib/carry-risk-mandate.ts",
  webMandateTest: "apps/web/src/lib/carry-risk-mandate.test.ts",
  webCollateralReview: "apps/web/src/lib/carry-collateral-review.ts",
  webPrivatePrimeReadiness: "apps/web/src/lib/carry-private-prime-readiness.ts",
  webPrivatePrimeReadinessTest: "apps/web/src/lib/carry-private-prime-readiness.test.ts",
  webPrivatePrimeAuthentication: "apps/web/src/lib/carry-private-prime-worker-authentication.ts",
  webPrivatePrimeAuthenticationTest: "apps/web/src/lib/carry-private-prime-worker-authentication.test.ts",
  webCreationOpportunityAuthentication: "apps/web/src/lib/carry-creation-opportunity-authentication.ts",
  webCreationOpportunityAuthenticationTest: "apps/web/src/lib/carry-creation-opportunity-authentication.test.ts",
  webPerpsTurnkey: "apps/web/src/lib/perps-turnkey-provider.tsx",
  webRegistry: "apps/web/src/lib/carry-venues.ts",
  webCredentialOnboarding: "apps/web/src/lib/venue-credential-onboarding.ts",
  webCredentialOnboardingTest: "apps/web/src/lib/venue-credential-onboarding.test.ts",
  webPage: "apps/web/src/app/carry/page.tsx",
  webTradeWorkspace: "apps/web/src/components/trade/PublicCoinbaseLiveTrade.tsx",
  webTradeReadiness: "apps/web/src/lib/trade-readiness.ts",
  webTradeReadinessTest: "apps/web/src/lib/trade-readiness.test.ts",
  webCarryChart: "apps/web/src/components/carry/CarryChartStrip.tsx",
  webCarryChartTest: "apps/web/src/components/carry/CarryChartStrip.test.tsx",
  webCarryBuilder: "apps/web/src/components/carry/CarryTerminalBuilder.tsx",
  webCarryBuilderTest: "apps/web/src/components/carry/CarryTerminalBuilder.test.tsx",
  webCarryMarket: "apps/web/src/lib/carry-market.ts",
  webCarryMarketTest: "apps/web/src/lib/carry-market.test.ts",
  webCarryLiveMarket: "apps/web/src/lib/carry-live-market.ts",
  webCarryLiveMarketTest: "apps/web/src/lib/carry-live-market.test.ts",
  webCsp: "apps/web/src/lib/csp-config.ts",
  webAccountPage: "apps/web/src/app/app/account/page.tsx",
  webAccountSetup: "apps/web/src/components/carry/CarryAccountSetup.tsx",
  webAccountConnections: "apps/web/src/lib/carry-account-connections.ts",
  webAccountConnectionsTest: "apps/web/src/lib/carry-account-connections.test.ts",
  webOnboardingRecovery: "apps/web/src/lib/carry-onboarding-recovery.ts",
  webOnboardingRecoveryTest: "apps/web/src/lib/carry-onboarding-recovery.test.ts",
  webSetupAuthRecovery: "apps/web/src/lib/carry-setup-auth-recovery.ts",
  webSetupAuthRecoveryTest: "apps/web/src/lib/carry-setup-auth-recovery.test.ts",
  lighterActivationReadiness: "apps/web/src/lib/lighter-activation-readiness.ts",
  lighterActivationReadinessTest: "apps/web/src/lib/lighter-activation-readiness.test.ts",
  webPrivateAccount: "apps/web/src/lib/private-account.ts",
  webPrivateAccountTest: "apps/web/src/lib/private-account.test.ts",
  webPrivateAccountStore: "apps/web/src/lib/private-account-store.ts",
  webPassport: "apps/web/src/lib/private-agent-passport.ts",
  webPassportTest: "apps/web/src/lib/private-agent-passport.test.ts",
  phalaConfig: "apps/web/src/lib/private-agent-phala.ts",
  phalaConfigTest: "apps/web/src/lib/private-agent-phala.test.ts",
  webPlatformLinkRoute: "apps/web/src/app/v1/private-account/platforms/link/route.ts",
  asterVaultSeal: "apps/web/src/lib/aster-vault-seal.ts",
  asterVaultSealTest: "apps/web/src/lib/aster-vault-seal.test.ts",
  lighterVaultSeal: "apps/web/src/lib/lighter-vault-seal.ts",
  lighterVaultSealTest: "apps/web/src/lib/lighter-vault-seal.test.ts",
  lifecycleTest: "apps/private-agent-worker/test/carry-executor.test.js",
  workerMandateTest: "apps/private-agent-worker/test/carry-mandate.test.js",
  positionsTest: "apps/private-agent-worker/test/carry-positions.test.js",
  transferProbeTest: "apps/private-agent-worker/test/carry-transfer-probe.test.js",
  transferVenueReadersTest: "apps/private-agent-worker/test/carry-transfer-venue-readers.test.js",
  stablecoinConversionTest: "apps/private-agent-worker/test/carry-stablecoin-conversion.test.js",
  depositQuoteTest: "apps/private-agent-worker/test/carry-deposit-quote.test.js",
  runtimeRiskPoliciesTest: "apps/private-agent-worker/test/carry-runtime-risk-policies.test.js",
  privatePrimeReadinessTest: "apps/private-agent-worker/test/carry-private-prime-readiness.test.js",
  privatePrimeAuthenticationTest: "apps/private-agent-worker/test/carry-private-prime-authentication.test.js",
  opportunityAuthenticationTest: "apps/private-agent-worker/test/carry-opportunity-authentication.test.js",
  transferRoutesTest: "apps/private-agent-worker/test/carry-transfer-routes.test.js",
  recordScanTest: "apps/private-agent-worker/test/carry-record-scan.test.js",
  loopSupervisorTest: "apps/private-agent-worker/test/carry-loop-supervisor.test.js",
  preflightTest: "apps/private-agent-worker/test/carry-preflight.test.js",
  fundingPersistenceTest: "apps/private-agent-worker/test/carry-funding-persistence.test.js",
  routingAdvantageTest: "apps/private-agent-worker/test/carry-routing-advantage.test.js",
  shadowQualificationTest: "apps/private-agent-worker/test/carry-shadow-qualification.test.js",
  shadowSnapshotTest: "apps/private-agent-worker/test/carry-shadow-snapshot.test.js",
  serverTest: "apps/private-agent-worker/test/server.test.js",
  qualificationTest: "apps/private-agent-worker/test/carry-qualification.test.js",
  readinessTest: "apps/private-agent-worker/test/carry-readiness.test.js",
  reconciliationTest: "apps/private-agent-worker/test/carry-reconciliation.test.js",
  releaseMaterialTest: "apps/private-agent-worker/test/carry-release-evidence.test.js",
  shadowTest: "apps/private-agent-worker/test/perp-shadow-adapters.test.js",
  asterTest: "apps/private-agent-worker/test/aster.test.js",
  lighterTest: "apps/private-agent-worker/test/lighter.test.js",
  hyperliquidMetricsTest: "apps/private-agent-worker/test/hyperliquid-account-metrics.test.js",
  hyperliquidReconcileTest: "apps/private-agent-worker/test/hyperliquid-reconcile.test.js",
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
  const requireCount = (key, value, count, code) => {
    if (String(sources[key] || "").split(value).length - 1 < count) failures.push(code);
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
  for (const adapterId of [
    "hyperliquid_arbitrum_usdc_v1",
    "lighter_arbitrum_usdc_v1",
    "aster_arbitrum_usdt_v1",
  ]) {
    requireText("registry", `adapter("${adapterId}", "implemented_unproven"`, `carry_collateral_route_adapter_missing:${adapterId}`);
  }
  requireText("registry", 'collateral_asset: "USDT"', "carry_aster_usdt_collateral_missing");
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
  requireText("registry", "export const CARRY_RECOVERY_POLICY", "carry_recovery_policy_registry_missing");
  requireText("registry", 'ambiguous_submission: "freeze_reconcile_never_retry"', "carry_recovery_ambiguity_policy_missing");
  requireText("registry", 'partial_fill: "exact_quantity_reduce_only"', "carry_recovery_partial_fill_policy_missing");
  requireText("registry", 'worker_restart: "reconcile_before_action"', "carry_recovery_restart_policy_missing");
  requireText("registry", "export function carryExecutionQualification", "carry_qualification_report_missing");
  requireText("registryTest", "candidate venues cannot enter Carry until the identical execution contract is complete", "carry_candidate_fail_closed_test_missing");
  requireText("registryTest", "registry type unions stay synchronized with runtime capability registry", "carry_registry_type_union_guard_missing");
  requireText("adapterRegistryTest", 'registeredCarryAdapterId(venueId, "exact_quantity_recovery")', "carry_worker_recovery_registry_test_missing");
  requireText("multiLegOrchestratorTest", "CARRY_EXECUTION_VENUES.flatMap", "carry_three_venue_recovery_matrix_missing");
  requireText("multiLegOrchestratorTest", "hedgeVenue !== filledVenue", "carry_ordered_pair_recovery_matrix_missing");
  requireText("multiLegOrchestratorTest", "reduce_only === true", "carry_recovery_reduce_only_assertion_missing");
  requireText("coreMultiLeg", '"leg_finalized"', "carry_terminal_reconciliation_event_missing");
  requireText("coreMultiLegTest", "records a venue-terminal leg without claiming that Ghola cancelled it", "carry_terminal_reconciliation_event_test_missing");
  requireText("multiLegOrchestrator", '"reconcile_before_cancel"', "carry_reconcile_before_cancel_missing");
  requireText("multiLegOrchestrator", '"reconcile_after_cancel"', "carry_reconcile_after_cancel_missing");
  requireText("multiLegOrchestratorTest", "recovers a crash after exact cancel without cancelling twice", "carry_cancel_ack_restart_test_missing");
  requireText("multiLegOrchestratorTest", "reconciles a terminal late fill before cancel and never cancels or resubmits it", "carry_late_fill_before_cancel_test_missing");
  requireText("multiLegOrchestrator", "settlePriorRecoveryExecutions", "carry_recovery_child_reconciliation_missing");
  requireText("multiLegOrchestrator", "applied_filled_micro_usdc", "carry_recovery_incremental_fill_accounting_missing");
  requireText("multiLegOrchestratorTest", "reconciles a partial recovery child before submitting the residual unwind", "carry_partial_recovery_child_test_missing");
  requireCount("multiLegOrchestrator", "recoveryProofTargetsLeg(", 3, "carry_recovery_exact_target_gate_missing");
  requireText("multiLegOrchestrator", "proof?.broadcast_performed === true", "carry_recovery_live_broadcast_gate_missing");
  requireText("multiLegOrchestratorTest", "rejects a mismatched target", "carry_recovery_exact_target_test_missing");
  requireText("multiLegOrchestratorTest", "reconciles a partial reduce-only completion without reopening the filled leg", "carry_partial_completion_child_test_missing");
  requireText("asterTest", "allows exact reconciliation of a durably recorded recovery child", "aster_recovery_child_authorization_test_missing");
  requireCount("privateExecution", "cached?.receipt && !readOnlyReconcile", 3, "carry_fresh_reconciliation_read_missing");
  requireText("asterTest", "refreshes read-only Aster reconciliation instead of replaying a stale cache", "carry_fresh_reconciliation_read_test_missing");
  requireText("webAccountSetup", "shouldResumeUnsignedTurnkeySetup", "carry_setup_session_recovery_missing");
  requireText("webAccountConnections", "carryNoSubmitVerificationHref", "carry_setup_no_submit_handoff_missing");
  requireText("webAccountSetup", "href={noSubmitReturnTo}", "carry_setup_no_submit_link_missing");
  requireText("webTradeWorkspace", 'carryNoSubmitQuery !== "no-submit"', "carry_terminal_no_submit_intent_missing");
  requireText("webTradeWorkspace", "Worker update required", "carry_terminal_runtime_mismatch_ui_missing");
  requireText("webTradeReadinessTest", "keeps deployment faults out of wallet onboarding", "carry_terminal_runtime_mismatch_test_missing");
  requireText("webCarryBuilder", "autoRunNoSubmitConsumedRef", "carry_terminal_no_submit_one_shot_missing");
  requireText("webCarryBuilderTest", "consumes the setup handoff once and runs only the no-submit proof", "carry_terminal_no_submit_handoff_test_missing");
  requireText("webSetupAuthRecovery", "!input.usingTurnkeyOwner || input.authorizationProofCreated", "carry_setup_auth_proof_boundary_missing");
  requireText("webSetupAuthRecoveryTest", "reauthenticates an exact prepared action", "carry_setup_unsigned_recovery_test_missing");
  requireText("webSetupAuthRecoveryTest", "never reauthenticates as a substitute for reconciling", "carry_setup_authorization_reconciliation_test_missing");
  requireText("lighterActivationReadiness", "LIGHTER_ACTIVATION_READINESS_MAX_AGE_MS", "lighter_activation_freshness_gate_missing");
  requireText("lighterActivationReadiness", "responseOwner.toLowerCase() !== ownerAddress.toLowerCase()", "lighter_activation_owner_binding_missing");
  requireText("lighterActivationReadiness", "body.ready !== (baseDepositReady && ethereumAssociationReady)", "lighter_activation_evidence_consistency_missing");
  requireText("lighterActivationReadinessTest", "rejects another owner and stale evidence", "lighter_activation_owner_freshness_test_missing");
  requireText("lighterActivationReadinessTest", "rejects flags or blockers that contradict", "lighter_activation_consistency_test_missing");
  requireText("registry", "export const CARRY_BROWSER_STREAM_VENUES", "browser_stream_capability_registry_missing");
  requireText("registry", "export function venueAdapterCapability", "adapter_capability_lookup_missing");
  requireText("registry", "export function venuesWithAdapterCapability", "adapter_capability_query_missing");
  requireText("registry", "export function executionVenueLabel", "venue_label_registry_missing");
  requireText("registryTest", 'executionVenueLabel("edgex")', "venue_label_registry_test_missing");
  requireText("coreIndex", 'from "./venues.js"', "registry_export_missing");
  requireText("coreIndex", "venueAdapterCapability", "adapter_capability_export_missing");
  requireText("coreIndex", "CARRY_EXECUTION_REQUIRED_ADAPTER_CAPABILITIES", "carry_required_adapter_contract_export_missing");
  requireText("coreIndex", "CARRY_RECOVERY_POLICY", "carry_recovery_policy_export_missing");
  requireText("coreIndex", "carryExecutionQualification", "carry_qualification_report_export_missing");
  requireText("coreIndex", 'from "./carry.js"', "carry_domain_export_missing");
  requireText("coreIndex", "evaluatePerpContractPairBasis", "carry_contract_basis_export_missing");
  requireText("webRegistry", 'from "@ghola/execution-core"', "web_registry_bridge_missing");
  requireText("webRegistry", "EXECUTION_CORE_CARRY_VENUES", "web_execution_registry_missing");
  requireText("webRegistry", "EXECUTION_CORE_PERP_VENUES", "web_shadow_registry_missing");
  requireText("webRegistry", "EXECUTION_CORE_BROWSER_STREAM_VENUES", "web_stream_registry_missing");
  forbidText("webRegistry", '["hyperliquid", "lighter", "aster"]', "web_execution_registry_duplicated");
  requireText("webCredentialOnboarding", "export type CredentialOnboardingVenue = CarryExecutionVenue", "carry_onboarding_registry_type_missing");
  requireText("webCredentialOnboardingTest", "derives onboarding coverage from the execution capability registry", "carry_onboarding_registry_test_missing");
  requireText("webCredentialOnboardingTest", "for (const venue of CARRY_EXECUTION_VENUES)", "carry_onboarding_registry_iteration_missing");
  requireText("webClient", "venue_id: CarryExecutionVenue;", "carry_platform_link_registry_type_missing");
  requireText("webPrivateAccount", "...CARRY_EXECUTION_VENUES", "private_account_manifest_registry_missing");
  requireText("webPrivateAccount", "type CarryExecutionVenueId", "private_account_venue_type_registry_missing");
  requireText("webPrivateAccount", 'executionVenueLabel(venueId)', "private_account_venue_label_registry_missing");
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

  requireText("webRoute", "const worker = carryShadowWorkerConfig();", "carry_public_shadow_worker_boundary_missing");
  requireText("webRoute", "shadow_url: process.env.GHOLA_CARRY_SHADOW_WORKER_URL", "carry_public_shadow_worker_env_missing");
  requireText("webWorkerRouting", "export function resolveCarryShadowWorkerUrl", "carry_public_shadow_worker_resolver_missing");
  requireText("webWorkerRoutingTest", "keeps public Carry intelligence independent from private execution", "carry_public_shadow_worker_boundary_test_missing");
  requireText("webEnvExample", "GHOLA_CARRY_SHADOW_WORKER_URL", "carry_public_shadow_worker_example_missing");
  requireText("webCarryBuilder", "const auth = useThumperAuth();", "carry_private_poll_auth_boundary_missing");
  requireText("webCarryBuilder", "const privateSessionReady = auth.authenticated && !auth.loading;", "carry_private_poll_auth_gate_missing");
  requireText("webCarryBuilderTest", "does not poll private Carry state before Ghola authentication", "carry_private_poll_auth_test_missing");

  requireText("shadow", "CORE_PERP_VENUES.map", "shadow_registry_iteration_missing");
  requireText("shadow", "SUPPORTED_EXECUTION_VENUES.flatMap", "shadow_capability_registry_missing");
  requireText("shadow", 'venueAdapterCapability(venueId, "perp_shadow")', "shadow_capability_lookup_missing");
  requireText("shadow", "shadow_adapter_unimplemented", "shadow_unknown_adapter_fail_closed_missing");
  forbidText("shadow", "hyperliquid: Object.freeze", "shadow_capability_registry_duplicated");
  requireText("shadow", "max_age_ms", "shadow_staleness_gate_missing");
  requireText("shadow", "observedAtMs", "edgex_response_freshness_missing");
  requireText("shadow", "funding_source_stale", "edgex_funding_source_staleness_gate_missing");
  requireText("shadowTest", "keeps fresh edgeX responses live without trusting a stale funding source", "edgex_split_freshness_test_missing");
  requireText("shadow", "liquidation_has_no_clearance_fee", "hyperliquid_liquidation_fee_evidence_gate_missing");
  requireText("shadow", "fees_venue_base_tier_ceiling", "hyperliquid_base_fee_provenance_missing");
  requireText("shadow", "minimum_notional_protocol_floor", "hyperliquid_minimum_notional_provenance_missing");
  requireText("shadowTest", "normalizes Hyperliquid public base economics conservatively", "hyperliquid_public_economics_test_missing");
  requireText("shadow", "fees_venue_base_schedule", "aster_base_fee_provenance_missing");
  requireText("shadowTest", "keeps unsupported Aster quote fee schedules degraded", "aster_unknown_fee_schedule_test_missing");
  requireText("shadow", "fees_chain_parameter_ceiling", "dydx_chain_fee_provenance_missing");
  requireText("shadow", "fees_chain_source_consensus", "dydx_chain_fee_consensus_missing");
  requireText("shadow", "minimum_notional_market_step", "dydx_minimum_notional_provenance_missing");
  requireText("shadow", "liquidation_fee_protocol_default", "dydx_liquidation_fee_provenance_missing");
  requireText("shadowTest", "keeps dYdX degraded when its live chain fee parameters are unavailable", "dydx_missing_chain_fee_gate_test_missing");
  requireText("shadowTest", "degrades dYdX instead of choosing between conflicting chain fee sources", "dydx_chain_fee_conflict_gate_test_missing");
  requireText("workerPackage", '"verify:carry-shadow"', "carry_shadow_verifier_script_missing");
  requireText("shadowVerifierCli", "verifyCarryShadowSet", "carry_shadow_verifier_cli_runtime_missing");
  requireText("shadowVerifierCli", "verifyCarryShadowSoak(sampleResults", "carry_shadow_soak_cli_missing");
  requireText("shadowVerifierCli", "GHOLA_CARRY_SHADOW_SAMPLES", "carry_shadow_soak_sample_control_missing");
  requireText("shadowVerifier", "CORE_PERP_VENUES", "carry_shadow_verifier_registry_missing");
  requireText("shadowVerifier", 'Object.freeze(["BTC", "ETH", "SOL"])', "carry_shadow_core_assets_missing");
  requireText("shadowVerifier", "missing_field_unjustified", "carry_shadow_missing_field_evidence_gate_missing");
  requireText("shadowVerifier", "export function verifyCarryShadowSoak", "carry_shadow_soak_verifier_missing");
  requireText("shadowVerifier", "shadow_soak_sample_failed", "carry_shadow_soak_intermittent_failure_gate_missing");
  requireText("shadowVerifier", "snapshot_evidence", "carry_shadow_snapshot_evidence_missing");
  requireText("shadowVerifier", "shadow_soak_sample_commitment_invalid", "carry_shadow_sample_commitment_gate_missing");
  requireText("shadowVerifier", "source_observation_commitment", "carry_shadow_source_observation_commitment_missing");
  requireText("shadowVerifier", "shadow_soak_source_observation_commitments_reused", "carry_shadow_source_observation_reuse_gate_missing");
  requireText("shadowVerifier", "shadow_soak_snapshot_not_ready", "carry_shadow_degraded_qualification_gate_missing");
  requireText("shadowVerifier", "read_only_boundary_invalid", "carry_shadow_read_only_gate_missing");
  requireText("shadowVerifier", "snapshot_stale", "carry_shadow_freshness_gate_missing");
  requireText("shadowVerifier", "venue_duplicate", "carry_shadow_duplicate_venue_gate_missing");
  requireText("shadowVerifier", "reference_price_invalid", "carry_shadow_reference_price_gate_missing");
  requireText("shadowVerifier", "liquidity_depth_missing", "carry_shadow_liquidity_depth_gate_missing");
  requireText("shadowVerifier", "source_observation_stale", "carry_shadow_component_freshness_gate_missing");
  requireText("shadowVerifier", "missing_field_manifest_mismatch", "carry_shadow_missing_manifest_gate_missing");
  requireText("shadowVerifier", "normalized_field_invalid", "carry_shadow_economic_bounds_gate_missing");
  requireText("shadowVerifierTest", "rejects unsafe normalized economic fields", "carry_shadow_economic_bounds_test_missing");
  requireText("shadowVerifier", "snapshot_status_inconsistent", "carry_shadow_status_integrity_gate_missing");
  requireText("shadowVerifierTest", "accepts one fresh normalized shadow for every venue and core asset", "carry_shadow_complete_set_test_missing");
  requireText("shadowVerifierTest", "qualifies only consecutive complete five-venue shadow samples", "carry_shadow_soak_test_missing");
  requireText("shadowVerifierTest", "rejects tampered or reused shadow sample commitments", "carry_shadow_commitment_test_missing");
  requireText("shadowVerifierTest", "rejects wrapper-time progress that reuses every venue source observation", "carry_shadow_source_observation_reuse_test_missing");
  requireText("shadowVerifierTest", "rejects a venue source timestamp that regresses between samples", "carry_shadow_source_observation_regression_test_missing");
  requireText("shadowVerifierTest", "rejects a one-shot snapshot as durable shadow qualification", "carry_shadow_one_shot_rejection_test_missing");
  requireText("shadowVerifierTest", "rejects normalized gaps without explicit quality evidence", "carry_shadow_quality_evidence_test_missing");
  requireText("shadowVerifierTest", "never promotes them to durable qualification", "carry_shadow_degraded_qualification_test_missing");
  requireText("shadowVerifierTest", "rejects duplicate or unregistered venue rows", "carry_shadow_duplicate_venue_test_missing");
  requireText("shadowVerifierTest", "rejects normalized shadow proof without valid two-sided liquidity depth", "carry_shadow_liquidity_depth_test_missing");
  requireText("shadowVerifierTest", "rejects stale component feeds hidden behind a fresh aggregate timestamp", "carry_shadow_component_freshness_test_missing");
  requireText("shadowVerifierTest", "rejects a missing-field manifest or readiness status that contradicts normalized data", "carry_shadow_manifest_integrity_test_missing");
  requireText("preflight", "carry_shadow_unavailable", "stale_shadow_quarantine_missing");
  requireText("preflight", "verifyCarryShadowSnapshot", "carry_preflight_shared_shadow_contract_missing");
  requireText("preflight", "trustedAccountFeeEvidence", "carry_account_fee_provenance_gate_missing");
  requireText("preflight", "venue_authority_unverified", "carry_matrix_authority_boundary_missing");
  requireText("preflight", "carry_market_data_skew_exceeded", "carry_market_data_skew_gate_missing");
  requireText("preflightTest", "rejects cross-venue market data skew before account or order verification", "carry_market_data_skew_test_missing");
  requireText("preflightTest", "rejects missing margin evidence through the shared shadow contract before account verification", "carry_preflight_shared_shadow_contract_test_missing");
  requireText("preflightTest", "rejects unlabeled numeric account fees from positive-net qualification", "carry_account_fee_provenance_test_missing");
  requireText("preflightTest", "credential_authority_boundary_unacceptable:hyperliquid", "carry_missing_authority_boundary_test_missing");
  requireText("preflight", "carry_contract_equivalence_failed", "carry_contract_equivalence_gate_missing");
  requireText("preflightTest", "rejects same-ticker contract basis divergence before account or order verification", "carry_contract_equivalence_test_missing");
  requireText("preflightTest", "monitoring measures a signed basis breach without submitting or hiding it as unavailable", "carry_monitor_contract_basis_test_missing");
  requireText("preflight", "collateral_basis", "collateral_basis_model_missing");
  requireText("preflight", "export async function preflightCarryExecutionMatrix", "carry_three_venue_no_submit_matrix_missing");
  requireText("preflight", "allVenuePairs(orderedVenues)", "carry_all_pair_no_submit_matrix_missing");
  requireText("preflight", "Promise.allSettled(pairs.map", "carry_no_submit_pair_fault_isolation_missing");
  requireText("server", 'access.status === "not_ready"', "carry_matrix_not_ready_marker_validation_missing");
  requireText("server", "non-ready venue access must be sanitized", "carry_matrix_not_ready_marker_sanitization_missing");
  requireText("preflight", "storeCarryExecutionDiagnostic", "carry_partial_matrix_diagnostic_store_missing");
  requireText("readiness", "export async function readCarryExecutionDiagnostic", "carry_partial_matrix_diagnostic_restore_missing");
  requireText("readiness", "reusable_for_readiness: false", "carry_partial_matrix_diagnostic_authority_boundary_missing");
  requireText("readinessTest", "persists partial matrix diagnostics without creating reusable readiness", "carry_partial_matrix_diagnostic_test_missing");
  requireText("preflightTest", "isolates failed pairs without discarding successful no-submit evidence or retrying", "carry_no_submit_pair_fault_isolation_test_missing");
  requireText("preflight", "carryPairUnreadyCode(result.value)", "carry_no_submit_exact_unready_venue_missing");
  requireText("preflightTest", "persists the exact venue when a completed pair reports authorization unavailable", "carry_no_submit_exact_unready_venue_test_missing");
  requireText("preflight", "leg_evidence: (result?.evidence || [])", "carry_pair_leg_evidence_missing");
  requireText("privateExecution", "account_commitment: body.account_commitment || null", "carry_no_submit_receipt_account_binding_missing");
  requireText("privateExecution", "account_commitment: allocation?.account_commitment || body.account_commitment || null", "carry_hyperliquid_no_submit_account_binding_missing");
  requireText("privateExecution", "account_commitment: input.account_commitment || input.body.account_commitment || null", "carry_live_receipt_account_binding_missing");
  requireText("preflight", "carry_account_verification_mismatch", "carry_no_submit_account_match_gate_missing");
  requireText("coreCarry", "carryCreationOpportunityAuthenticationMessage", "carry_creation_opportunity_message_missing");
  requireText("coreIndex", "carryCreationOpportunityAuthenticationMessage", "carry_creation_opportunity_message_export_missing");
  requireText("opportunityAuthentication", "signAttestedWorkerMessage", "carry_creation_opportunity_attested_signing_missing");
  requireText("opportunityAuthentication", "verifyCarryCreationOpportunityAuthentication", "carry_creation_opportunity_verifier_missing");
  requireText("preflight", "authenticateCarryCreationOpportunity", "carry_creation_opportunity_authentication_missing");
  requireText("positions", "verifyCarryCreationOpportunityAuthentication", "carry_creation_opportunity_storage_gate_missing");
  requireText("positions", "opportunity_provenance: workerOpportunity.authentication", "carry_creation_opportunity_provenance_missing");
  requireText("positionsTest", "refuses unsigned or client-modified Carry creation economics", "carry_creation_opportunity_tamper_test_missing");
  requireText("opportunityAuthenticationTest", "rejects changed economics, wrong owners, signers, and expired evidence", "carry_creation_opportunity_authentication_test_missing");
  for (const source of ["coreCarry", "preflight", "positions", "executor", "multiLegOrchestrator"]) {
    forbidText(source, "@ai-sdk/", `carry_deterministic_boundary_ai_sdk_present:${source}`);
    forbidText(source, "generateText(", `carry_deterministic_boundary_generate_text_present:${source}`);
    forbidText(source, "streamText(", `carry_deterministic_boundary_stream_text_present:${source}`);
    forbidText(source, "generateObject(", `carry_deterministic_boundary_generate_object_present:${source}`);
  }
  requireText("readiness", "leg.account_commitment !== venue?.account_commitment", "carry_readiness_leg_account_binding_missing");
  requireText("preflightTest", "verifies all three execution venues through one no-broadcast matrix", "carry_three_venue_no_submit_matrix_test_missing");
  requireText("preflight", "storeCarryExecutionReadiness", "carry_three_venue_readiness_persistence_missing");
  requireText("readiness", "runtimeCarryQualificationImageDigest", "carry_readiness_image_binding_missing");
  requireText("readiness", "account_commitment", "carry_readiness_account_binding_missing");
  requireText("readiness", "carry_readiness_stale", "carry_readiness_freshness_gate_missing");
  requireText("readiness", "carry_readiness_commitment_invalid", "carry_readiness_integrity_gate_missing");
  requireText("readiness", "export function verifyCarryExecutionReadinessResult", "carry_readiness_result_verifier_missing");
  requireText("readiness", "readiness_commitment: readinessResultCommitment(material)", "carry_readiness_result_commitment_missing");
  requireText("readinessTest", "rejects tampered readiness summaries", "carry_readiness_result_tamper_test_missing");
  requireText("readiness", 'venueAdapterCapability(venueId, "no_submit_reconciliation")', "carry_readiness_no_submit_adapter_binding_missing");
  requireText("readiness", 'venueAdapterCapability(venueId, "exact_quantity_recovery")', "carry_readiness_recovery_adapter_binding_missing");
  requireText("readiness", "sameRecoveryPolicy(evidence.recovery_policy)", "carry_readiness_recovery_policy_gate_missing");
  requireText("readiness", "recovery_ready: recoveryReady", "carry_readiness_recovery_output_missing");
  requireText("readinessTest", "persists deployment-, owner-, account-, and registry-bound three-venue readiness", "carry_readiness_binding_test_missing");
  requireText("readinessTest", "rejects stale or tampered readiness instead of reusing transient UI state", "carry_readiness_stale_test_missing");
  requireText("readinessTest", "rejects readiness after any sealed venue binding rotates", "carry_readiness_rotation_test_missing");
  requireText("readinessTest", "requires every unique venue pair before three-venue readiness passes", "carry_all_pair_readiness_test_missing");
  requireText("readiness", "carry_readiness_leg_venue_binding_mismatch", "carry_pair_leg_receipt_binding_missing");
  requireText("readinessTest", "binds every pair to both exact no-submit leg receipts", "carry_pair_leg_receipt_binding_test_missing");
  requireText("readinessTest", "rejects readiness detached from exact no-submit and recovery adapters", "carry_readiness_recovery_binding_test_missing");
  requireText("readiness", "carryAccountStateCommitment", "carry_no_submit_account_state_commitment_missing");
  requireText("readiness", "carry_readiness_leg_account_state_invalid", "carry_no_submit_account_state_validation_missing");
  requireText("preflight", "account_state_commitments", "carry_no_submit_account_state_propagation_missing");
  requireText("readinessTest", "item.position_count === 0", "carry_no_submit_exact_flat_counts_test_missing");
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
  requireText("preflight", "account.opening_collateral_shortfall_micro_usdc === 0", "carry_unfunded_releasable_collateral_gate_missing");
  requireText("preflightTest", "never advertises releasable collateral", "carry_opening_capital_plan_test_missing");
  requireText("preflight", "Math.max(reportedMaintenance, contractMaintenanceFloor)", "carry_maintenance_double_count_gate_missing");
  requireText("preflight", "maintenance_evidence_basis", "carry_maintenance_evidence_basis_missing");
  requireText("preflightTest", "without double-counting venue totals", "carry_maintenance_double_count_test_missing");
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
  requireText("coreCarry", 'if (status !== "healthy") unverifiableMargin = true', "margin_runway_null_status_gate_missing");
  requireText("coreCarryTest", "a warning cannot relabel a null margin runway as verified infinity", "margin_runway_null_warning_test_missing");
  requireText("coreCarry", "if (status === null)", "margin_runway_status_required_missing");
  requireText("coreCarryTest", "a numeric margin runway without verified status triggers an immediate reduce-only exit", "margin_runway_status_required_test_missing");
  requireText("coreCarry", "previousObservationAsOf === asOf", "carry_funding_flip_distinct_observation_gate_missing");
  requireText("coreCarryTest", "new wrapper timestamps cannot manufacture confirmations from replayed funding sources", "carry_funding_flip_replay_test_missing");
  requireText("coreCarry", "export function compileCarryCapitalActionPlan", "carry_capital_action_compiler_missing");
  requireText("coreIndex", "compileCarryCapitalActionPlan", "carry_capital_action_export_missing");
  requireText("coreCarry", "carry_capital_automatic_transfer_forbidden", "carry_capital_transfer_boundary_missing");
  requireText("coreCarryTest", "quantifies the minimum owner top-up without transfer authority", "carry_capital_owner_plan_test_missing");
  requireText("coreCarryTest", "quarantines stale evidence and permits reconciliation only", "carry_capital_stale_quarantine_test_missing");
  requireText("coreCarry", "export function compileCarryPortfolioCapitalPlan", "carry_portfolio_capital_compiler_missing");
  requireText("coreIndex", "compileCarryPortfolioCapitalPlan", "carry_portfolio_capital_export_missing");
  requireText("coreCarry", "carry_portfolio_capital_position_authority_boundary", "carry_portfolio_capital_authority_gate_missing");
  requireText("coreCarry", 'account_commitment: identifier(raw.account_commitment, "carry_capital_runway_account")', "carry_capital_account_normalization_missing");
  requireText("coreCarry", 'account_state_commitment: identifier(raw.account_state_commitment, "carry_capital_runway_account_state")', "carry_capital_account_state_normalization_missing");
  requireText("preflight", "account_state_commitment: accountReadiness[index].account_state_commitment", "carry_capital_account_state_propagation_missing");
  requireText("coreCarry", "const accountGroups = new Map();", "carry_portfolio_capital_account_aggregation_missing");
  requireText("coreCarry", "proposed_reallocations: proposedReallocations", "carry_portfolio_capital_reallocation_missing");
  requireText("coreCarry", "owner_transfer_approval_required", "carry_portfolio_capital_transfer_approval_missing");
  requireText("coreCarry", "function normalizeCarryTransferRouteEvidence", "carry_transfer_route_normalization_missing");
  requireText("coreCarry", "transfer_route_arrival_unsafe", "carry_transfer_arrival_safety_gate_missing");
  requireText("coreCarry", "gross_debit_micro_usdc", "carry_transfer_fee_debit_accounting_missing");
  requireText("coreCarry", "route_verified: true", "carry_transfer_route_proof_missing");
  requireText("coreCarry", 'evidence_source: raw.evidence_source === "attested_worker"', "carry_transfer_attested_source_gate_missing");
  requireText("coreCarry", "carry_transfer_route_adapter_binding", "carry_transfer_adapter_binding_missing");
  requireText("coreCarry", 'route.source_account_state_commitment === source.account_state_commitment', "carry_transfer_source_state_binding_missing");
  requireText("coreCarry", 'route.destination_account_state_commitment === request.account_state_commitment', "carry_transfer_destination_state_binding_missing");
  requireText("coreCarry", "carry_transfer_route_quote_unverified", "carry_transfer_all_in_quote_gate_missing");
  requireText("coreCarry", "carry_transfer_route_asset_binding", "carry_transfer_asset_binding_missing");
  requireText("coreCarry", "carry_collateral_review_transfer_conversion_unverified", "carry_transfer_conversion_review_gate_missing");
  requireText("coreCarryTest", "aggregates shared accounts and proposes owner-only reallocation", "carry_portfolio_capital_account_test_missing");
  requireText("coreCarryTest", "never treats an unverified or late transfer as rescued margin", "carry_transfer_route_failure_test_missing");
  requireText("coreCarryTest", "carry:account-state:lighter:stale", "carry_transfer_stale_account_state_test_missing");
  requireText("coreCarryTest", "rejects one account commitment claimed by multiple venues", "carry_portfolio_capital_account_collision_test_missing");
  requireText("coreCarryTest", "quarantines stale evidence and allocates nothing", "carry_portfolio_capital_stale_test_missing");
  requireText("coreCarry", "export function compileCarryPortfolioValueReport", "carry_portfolio_value_compiler_missing");
  requireText("coreIndex", "compileCarryPortfolioValueReport", "carry_portfolio_value_export_missing");
  requireText("coreIndex", "normalizeCarryLifecycleValueAttribution", "carry_lifecycle_value_attribution_export_missing");
  requireText("coreCarry", "export function normalizeCarryLifecycleValueAttribution", "carry_lifecycle_value_attribution_core_missing");
  requireText("coreCarry", "carry_portfolio_value_capital_authority_boundary", "carry_portfolio_value_authority_gate_missing");
  requireText("coreCarry", "value_proof_status: valueProofStatus", "carry_portfolio_value_proof_status_missing");
  requireText("coreCarry", "potential_new_cash_avoided_micro_usdc: reallocation", "carry_portfolio_cash_avoidance_missing");
  requireText("coreCarryTest", "separates finalized after-cost proof from accruing estimates", "carry_portfolio_value_separation_test_missing");
  requireText("coreCarryTest", "rejects duplicate, tampered, or fund-moving evidence", "carry_portfolio_value_failure_test_missing");
  requireText("coreCarry", "projected_trading_fee_micro_usdc", "carry_modeled_fee_attribution_missing");
  requireText("coreCarry", "carry_value_modeled_trading_breakdown_mismatch", "carry_modeled_cost_reconciliation_missing");
  requireText("coreCarry", "summarizeValueAttribution", "carry_value_attribution_missing");
  requireText("coreCarry", "carry_value_entry_replay_mismatch", "carry_value_conflicting_replay_gate_missing");
  requireText("coreCarryTest", "rejects modeled component totals that do not reconcile", "carry_modeled_cost_reconciliation_test_missing");
  requireText("coreCarryTest", "rejects a conflicting replay under the same entry id", "carry_value_conflicting_replay_test_missing");
  requireText("coreCarry", "carryRiskMandateMessage", "carry_signed_mandate_message_missing");
  requireText("webMandate", 'owner_only_operations: ["fund", "transfer", "withdraw"]', "carry_web_mandate_owner_only_missing");
  requireText("webMandateTest", 'owner_only_operations: ["fund", "transfer", "withdraw"]', "carry_web_mandate_owner_only_test_missing");
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
  requireText("transferRoutes", "export async function storeCarryTransferRouteEvidence", "carry_transfer_route_store_missing");
  requireText("transferRoutes", "export async function observeCarryTransferRoutes", "carry_transfer_route_observer_missing");
  requireText("transferRoutes", "all_in_fee_verified", "carry_transfer_route_all_in_fee_missing");
  requireText("transferRoutes", "source_collateral_asset", "carry_transfer_route_collateral_assets_missing");
  requireText("transferRoutes", "carry_transfer_route_probe_authority_boundary", "carry_transfer_route_probe_authority_missing");
  requireText("transferRoutes", "probeRoute(request, routeScopedProbeContext", "carry_transfer_route_private_context_missing");
  requireText("transferRoutes", "routeScopedProbeContext", "carry_transfer_route_least_privilege_missing");
  requireText("transferRoutes", "export async function loadCarryTransferRouteEvidence", "carry_transfer_route_loader_missing");
  requireText("transferRoutes", "evidenceCommitment(evidence)", "carry_transfer_route_commitment_missing");
  requireText("transferRoutes", 'evidence_source: "attested_worker"', "carry_transfer_route_attestation_missing");
  requireText("transferRoutes", "venueAdapterCapability", "carry_transfer_route_registry_binding_missing");
  requireText("transferRoutesTest", "stores only commitment-backed worker transfer-route evidence", "carry_transfer_route_worker_test_missing");
  requireText("transferRoutesTest", "rejects tampered, stale, and registry-mismatched transfer routes", "carry_transfer_route_failure_test_missing");
  requireText("transferRoutesTest", "keeps incomplete or missing route probes unavailable", "carry_transfer_route_probe_fail_closed_test_missing");
  requireText("transferRoutesTest", "requires explicit USDC-USDT conversion economics for Aster routes", "carry_transfer_route_conversion_test_missing");
  requireText("transferProbe", "export function createCarryTransferRouteProbe", "carry_transfer_component_probe_missing");
  requireText("transferProbe", "fee_upper_bound_verified", "carry_transfer_fee_bound_missing");
  requireText("transferProbe", "Promise.all(reads)", "carry_transfer_component_parallelism_missing");
  requireText("transferProbeTest", "prices USDC-USDT conversion as a bounded component of the route", "carry_transfer_component_conversion_test_missing");
  requireText("transferProbeTest", "rejects components detached from the exact account state", "carry_transfer_component_binding_test_missing");
  requireText("stablecoinConversion", "createAsterStablecoinConversionQuoteReader", "carry_conversion_live_reader_missing");
  requireText("stablecoinConversion", "USDCUSDT&limit=100", "carry_conversion_live_depth_missing");
  requireText("stablecoinConversion", "fund_movement_authorized: false", "carry_conversion_authority_boundary_missing");
  requireText("stablecoinConversionTest", "bounds USDC to USDT conversion from fresh Aster depth without submitting", "carry_conversion_live_test_missing");
  requireText("stablecoinConversionTest", "fails closed for stale books, stale policy, and unsupported pairs", "carry_conversion_failure_test_missing");
  requireText("depositQuote", "createCarryDepositQuoteReader", "carry_deposit_live_reader_missing");
  requireText("depositQuote", "eth_getCode", "carry_deposit_hyperliquid_bridge_probe_missing");
  requireText("depositQuote", "eth_gasPrice", "carry_deposit_live_gas_probe_missing");
  requireText("depositQuote", "ETHUSDT", "carry_deposit_live_gas_valuation_missing");
  requireText("depositQuote", "api/v1/deposit/networks", "carry_deposit_lighter_network_probe_missing");
  requireText("depositQuote", "deposit/assets?chainIds=42161", "carry_deposit_aster_assets_probe_missing");
  requireText("depositQuoteTest", "verifies Hyperliquid and Lighter Arbitrum deposit routes without submitting", "carry_deposit_live_test_missing");
  requireText("depositQuoteTest", "fails closed for missing live support, stale policy, or target drift", "carry_deposit_failure_test_missing");
  requireText("transferVenueReaders", "createCarryTransferVenueReaders", "carry_transfer_venue_readers_missing");
  requireText("transferVenueReaders", "estimateFee?chainId=42161&asset=USDT", "carry_transfer_aster_live_fee_missing");
  requireText("transferVenueReaders", "carry_transfer_aster_fee_above_policy", "carry_transfer_aster_fee_ceiling_missing");
  requireText("transferVenueReadersTest", "fails closed for stale policy or a live Aster fee above its ceiling", "carry_transfer_venue_reader_failure_test_missing");
  requireText("lighter", "export async function readLighterWithdrawalRouteQuote", "carry_transfer_lighter_route_reader_missing");
  requireText("lighterRunner", 'action == "route_terms"', "carry_transfer_lighter_route_terms_missing");
  requireText("lighterRunner", '"transaction_broadcast": False', "carry_transfer_lighter_route_no_broadcast_missing");
  requireText("lighterTest", "reads exact Lighter withdrawal capacity and delay without broadcasting", "carry_transfer_lighter_route_test_missing");
  requireText("positions", "loadCarryTransferRouteEvidence", "carry_transfer_routes_worker_binding_missing");
  requireText("positions", "export async function refreshStoredCarryTransferRoutes", "carry_transfer_route_supervised_refresh_missing");
  requireText("positions", "probe_transfer_route: probeTransferRoute", "carry_transfer_route_internal_probe_missing");
  requireText("positions", "venue_access_by_account", "carry_transfer_route_sealed_access_missing");
  requireText("server", "createCarryTransferRouteProbe", "carry_transfer_route_compiler_wiring_missing");
  requireText("server", "createCarryTransferVenueReaders", "carry_transfer_venue_reader_wiring_missing");
  requireText("server", "probeTransferRoute: probeCarryTransferRoute", "carry_transfer_route_server_injection_missing");
  requireText("privateExecution", "export async function readLighterCarryWithdrawalRoute", "carry_transfer_lighter_private_reader_missing");
  requireText("adapterRegistryTest", "Lighter route reads open only the exact sealed monitoring account", "carry_transfer_lighter_private_reader_test_missing");
  requireText("privateExecution", "export async function readPrivateCarryAccountCapacity", "carry_transfer_private_capacity_reader_missing");
  requireText("privateExecution", "fund_movement_authorized: false", "carry_transfer_private_capacity_authority_missing");
  requireText("server", "readPrivateCarryAccountCapacity", "carry_transfer_private_capacity_wiring_missing");
  requireText("adapterRegistryTest", "Carry route capacity opens only the exact sealed venue account", "carry_transfer_private_capacity_test_missing");
  requireText("positions", 'transfer_route_evidence_status: routeEvidence.ok ? "verified" : "unavailable"', "carry_transfer_route_status_missing");
  requireText("positions", "carry_portfolio_capital_evidence_incomplete", "carry_portfolio_capital_incomplete_gate_missing");
  requireText("positionsTest", "compiles an owner-only portfolio capital plan from stored monitoring evidence", "carry_portfolio_capital_worker_test_missing");
  requireText("positionsTest", "transfer_route_missing:", "carry_transfer_routes_worker_test_missing");
  requireText("positionsTest", "worker monitoring refreshes owner-scoped collateral routes from exact account state", "carry_transfer_route_supervision_test_missing");
  requireText("server", '"/carry/positions/capital-plan"', "carry_portfolio_capital_route_missing");
  forbidText("server", "transfer_routes: body.transfer_routes", "carry_transfer_routes_client_trust_present");
  requireText("coreCarry", "export function compileCarryCollateralReview", "carry_collateral_review_core_missing");
  requireText("coreCarry", "fund_movement_authorized: false", "carry_collateral_review_fund_boundary_missing");
  requireText("coreCarry", "carry_collateral_review_transfer_route_unverified", "carry_collateral_review_route_gate_missing");
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
  requireText("webCarryMarket", "liquidation_fee_bps?: number | null", "carry_web_liquidation_contract_missing");
  requireText("webCarryMarket", "liquidation_model?: string | null", "carry_web_liquidation_model_missing");
  requireText("webCarryBuilder", 'label="LIQUIDATION"', "carry_terminal_liquidation_display_missing");
  requireText("webCarryBuilder", "carryLiquidationSummary(candidate)", "carry_terminal_liquidation_binding_missing");
  requireText("webCarryBuilderTest", "fails closed when either leg lacks verified liquidation economics", "carry_terminal_liquidation_test_missing");
  requireText("webCarryBuilder", "model.contractDataSkewMs", "carry_terminal_public_source_sync_missing");
  requireText("webCarryBuilder", "SHADOW POSITION · LIVE-DATA MODEL", "carry_terminal_shadow_position_missing");
  requireText("webCarryBuilder", "NO WALLET · NO DEPOSIT · NO ORDER", "carry_terminal_shadow_safety_boundary_missing");
  requireText("webCarryBuilderTest", "SHADOW POSITION · LIVE-DATA MODEL", "carry_terminal_shadow_position_test_missing");
  requireText("webCarryBuilder", 'label="RISK MANDATE"', "carry_terminal_risk_mandate_display_missing");
  requireText("webCarryBuilder", "carryRiskMandateSummary(defaultCarryRiskMandate())", "carry_terminal_risk_mandate_binding_missing");
  requireText("webCarryBuilder", "OWNER MOVES", "carry_terminal_owner_only_boundary_missing");
  requireText("webCarryBuilderTest", "fails closed when the visible risk mandate is malformed", "carry_terminal_risk_mandate_test_missing");
  requireText("webCarryBuilder", "model.indexPriceDivergenceBps", "carry_terminal_public_index_basis_missing");
  requireText("webCarryBuilder", 'label="OWNER CAPITAL"', "carry_terminal_capital_action_missing");
  requireText("webCarryBuilder", "automatic_transfer_permitted !== false", "carry_terminal_capital_authority_gate_missing");
  requireText("webCarryBuilder", "STRESS CAPITAL ·", "carry_terminal_stress_capital_missing");
  requireText("webClient", "getCarryPortfolioCapitalPlan", "carry_portfolio_capital_client_missing");
  requireText("webClient", "minimum_transfer_arrival_buffer_ms", "carry_transfer_routes_client_binding_missing");
  forbidText("webClient", "transfer_routes", "carry_transfer_routes_browser_injection_present");
  requireText("webClient", "getCarryCollateralReview", "carry_collateral_review_client_missing");
  requireText("webClient", "approveCarryCollateralReview", "carry_collateral_review_approval_client_missing");
  requireText("webCollateralReview", "buildCarryCollateralReviewAuthorization", "carry_collateral_review_web_authorization_missing");
  requireText("webRoute", 'action === "capital_plan"', "carry_portfolio_capital_proxy_missing");
  requireText("webRoute", '["capital_plan", "collateral_review", "value_report"].includes(action)', "carry_capital_proxy_allowlist_missing");
  forbidText("webRoute", "transfer_routes", "carry_transfer_routes_proxy_injection_present");
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
  requireText("webCarryBuilder", "CAPITAL OFFSET ·", "carry_terminal_capital_efficiency_missing");
  requireText("webCarryBuilder", "STALE EVIDENCE · RECONCILE ONLY", "carry_terminal_portfolio_stale_gate_missing");
  requireText("webCarryBuilderTest", "PORTFOLIO CAPITAL · $15 REALLOCATE · $10 NEW CASH · OWNER ONLY", "carry_terminal_portfolio_capital_test_missing");
  requireText("webCarryBuilderTest", "PORTFOLIO CAPITAL · $12.5 RELEASABLE · OWNER ONLY", "carry_terminal_portfolio_optimization_test_missing");
  requireText("webCarryBuilderTest", "PORTFOLIO VALUE · $19.5 REAL · $10 OPEN MODEL · +$4.5 Δ", "carry_terminal_portfolio_value_test_missing");
  requireText("webCarryBuilderTest", "CAPITAL OFFSET · $15 NEW CASH AVOIDED · OWNER MOVE", "carry_terminal_capital_efficiency_test_missing");
  requireText("webCarryBuilder", "live_execution_leverage_unchanged !== true", "carry_terminal_stress_leverage_boundary_missing");
  requireText("webCarryBuilderTest", "UP TO 1× OWNER CONFIG", "carry_terminal_stress_capital_test_missing");
  requireText("webCarryBuilderTest", '$10 → LIGHTER · OWNER', "carry_terminal_capital_action_test_missing");
  requireText("webCarryBuilder", 'label="LEDGER"', "carry_terminal_value_ledger_missing");
  requireText("webCarryBuilder", 'label="EXEC Δ"', "carry_terminal_execution_attribution_missing");
  requireText("webCarryBuilderTest", "FEE +$0.5 · SLIP −$0.25", "carry_terminal_execution_attribution_test_missing");
  requireText("webCarryBuilder", "const netUsd = opportunity ? proofNet : model.netUsd", "carry_terminal_proof_economics_fallback_missing");
  requireText("webCarryBuilder", 'if (proof) return { value: "UNVERIFIED"', "carry_terminal_proof_capital_fallback_missing");
  requireText("webCarryBuilder", "carryTerminalGrossFunding(candidate, proof ? proofOpportunity || {} : null)", "carry_terminal_proof_gross_fallback_missing");
  requireText("webCarryBuilder", "carryVenueMinimumMarginSummary(model, proof)", "carry_terminal_proof_margin_fallback_missing");
  requireText("webCarryBuilderTest", "never replaces incomplete worker proof with browser estimates", "carry_terminal_proof_fallback_test_missing");
  requireText("webCarryBuilderTest", "carryTerminalGrossFunding(candidate(), {}).value", "carry_terminal_proof_gross_fallback_test_missing");
  requireText("webCarryBuilderTest", "carryVenueMinimumMarginSummary(model, {}).value", "carry_terminal_proof_margin_fallback_test_missing");
  requireText("webMandate", "defaultCarryRiskMandate", "carry_default_migration_mandate_missing");
  requireText("webMandate", "allow_migration: true", "carry_default_migration_disabled");
  requireText("webCarryBuilder", "SIGN MIGRATION", "carry_terminal_migration_signing_missing");
  requireText("webCarryBuilderTest", "binds a replacement signature to the selected flat migration parent", "carry_terminal_migration_lineage_test_missing");
  requireText("webMandate", "recoverMessageAddress", "carry_web_signature_recovery_missing");
  requireText("webMandateTest", "rejects wrong-owner, expired, and cross-position replay", "carry_signed_mandate_replay_test_missing");
  requireText("coreCarry", "opportunity_evidence_commitment", "carry_owner_opportunity_binding_missing");
  requireText("positions", "carry_opportunity_mandate_mismatch", "carry_worker_opportunity_binding_missing");
  requireText("positions", "opportunity_authentication_material", "carry_durable_opportunity_material_missing");
  requireText("positions", "require_material: false", "carry_monitor_opportunity_reverification_missing");
  requireText("executor", "verifyStoredCarryOpportunityBinding({ record })", "carry_entry_opportunity_reverification_missing");
  requireText("releaseMaterial", "carry_release_opportunity_provenance_unproven", "carry_release_opportunity_reverification_missing");
  requireText("webCarryBuilder", "opportunityEvidenceCommitment", "carry_terminal_opportunity_binding_missing");
  requireText("webMandateTest", "rejects a changed worker-signed opportunity after owner approval", "carry_opportunity_substitution_test_missing");
  requireText("webCarryBuilderTest", "does not spend owner authentication on an unbound creation opportunity", "carry_unbound_opportunity_auth_spend_test_missing");
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
  requireText("qualification", "qualification_account_binding_mismatch", "qualification_account_lineage_gate_missing");
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
  requireText("executor", "assessCarryTerminalExecutionReceipt", "carry_live_terminal_receipt_gate_missing");
  requireText("executor", "carry_execution_receipt_work_order_mismatch", "carry_live_receipt_work_order_binding_missing");
  requireText("executor", "carry_execution_receipt_account_mismatch", "carry_live_receipt_account_binding_missing");
  requireText("executor", "carry_execution_receipt_venue_mismatch", "carry_live_receipt_venue_binding_missing");
  requireText("executor", "carry_execution_receipt_terminal_proof_unverified", "carry_live_receipt_terminal_proof_missing");
  requireText("executor", "carry_exact_entry_receipt_unverified", "carry_exit_entry_receipt_revalidation_missing");
  requireText("executor", 'proof.broadcast_performed !== true', "carry_live_receipt_broadcast_proof_missing");
  requireText("lifecycleTest", "live Carry receipts are bound to the exact venue, account, work order, and terminal venue proof", "carry_live_terminal_receipt_test_missing");
  requireText("executor", "item.account_commitment !== expectedAccountCommitment", "carry_exit_account_lineage_gate_missing");
  requireText("reconciliation", "assessCarryFlatReconciliation", "carry_exact_flat_reconciliation_gate_missing");
  requireText("reconciliation", "carry_reconciliation_account_binding_mismatch", "carry_reconciliation_account_lineage_gate_missing");
  requireText("webReconciliation", "commitment(item.account_commitment)", "carry_web_reconciliation_account_lineage_gate_missing");
  requireText("reconciliationTest", "rejects aggregate-only, unsafe, duplicate, and residual venue claims", "carry_exact_flat_reconciliation_test_missing");
  requireText("releaseMaterial", "assessCarryFlatReconciliation", "carry_release_venue_final_state_gate_missing");
  requireText("qualification", "hasExactCarryFlatReconciliation", "carry_qualification_exact_flat_gate_missing");
  requireText("positions", "hasExactCarryFlatReconciliation", "carry_migration_exact_flat_gate_missing");
  requireText("webCarryBuilder", "hasExactCarryFlatReconciliation", "carry_terminal_exact_flat_gate_missing");
  requireText("webCarryBuilderTest", "does not claim flat from aggregate-only reconciliation", "carry_terminal_aggregate_flat_rejection_test_missing");
  requireText("webReconciliationTest", "rejects aggregate-only flat claims", "carry_web_exact_flat_test_missing");
  requireText("releaseMaterialTest", "refuses aggregate-only final reconciliation evidence", "carry_release_aggregate_only_rejection_test_missing");
  requireText("releaseMaterialTest", "refuses duplicate, mismatched, or non-flat venue final state", "carry_release_venue_final_state_test_missing");
  requireText("releaseMaterial", "carry_release_${phase}_account_binding_mismatch", "carry_release_receipt_account_lineage_gate_missing");
  requireText("releaseMaterialTest", "refuses release evidence assembled from another account's execution receipt", "carry_release_receipt_account_lineage_test_missing");
  requireText("evidenceVerifier", "entry_account_binding_mismatch", "carry_release_verifier_entry_account_lineage_missing");
  requireText("evidenceVerifier", "exit_account_binding_mismatch", "carry_release_verifier_exit_account_lineage_missing");
  requireText("evidenceVerifier", "final_owner_binding_mismatch", "carry_release_verifier_owner_lineage_missing");
  requireText("evidenceVerifierTest", "rejects lifecycle proof whose owner, position, or leg belongs to another account", "carry_release_verifier_account_lineage_test_missing");
  requireText("releaseMaterial", "worker_material_commitment", "carry_release_material_commitment_missing");
  requireText("releaseMaterial", "readCarryShadowQualification", "carry_release_shadow_qualification_gate_missing");
  requireText("releaseMaterial", "shadow_qualification: {", "carry_release_shadow_qualification_evidence_missing");
  requireText("releaseMaterial", "source_observation_commitments: shadowQualification.source_observation_commitments", "carry_release_shadow_source_observation_evidence_missing");
  requireText("releaseMaterial", "const fundingLegId = carryPositionLegId(record.position, sagaLeg.venue_id)", "carry_release_canonical_funding_leg_missing");
  requireText("releaseMaterial", 'funding_micro_usdc: sumSignedEntries(fundingLedgerEntries, "funding")', "carry_release_leg_funding_missing");
  requireText("releaseMaterialTest", "funding_micro_usdc), [60, -10]", "carry_release_leg_funding_test_missing");
  requireText("releaseMaterialTest", "carryPositionLegId({ position_id: positionId", "carry_release_canonical_funding_leg_test_missing");
  requireText("evidenceVerifier", "realized_funding_evidence_mismatch", "carry_release_funding_reconciliation_missing");
  requireText("evidenceVerifier", "shadow_qualification_image_mismatch", "carry_release_shadow_image_verifier_missing");
  requireText("evidenceVerifier", "shadow_qualification_samples_incomplete", "carry_release_shadow_soak_verifier_missing");
  requireText("evidenceVerifier", "shadow_qualification_source_observations_invalid", "carry_release_shadow_source_observation_verifier_missing");
  requireText("evidenceVerifierTest", "rejects funding not reconciled to exact venue legs", "carry_release_funding_reconciliation_test_missing");
  requireText("evidenceVerifierTest", "rejects missing, incomplete, or image-mismatched five-venue shadow qualification", "carry_release_shadow_qualification_test_missing");
  requireCount("privateExecution", "submit_count: readOnlyReconcile ? 0 : 1", 3, "durable_submit_count_missing");
  requireText("privateExecution", "ambiguity_retry_count: 0", "durable_retry_count_missing");
  requireText("privateExecution", 'venueAdapterCapability(venueId, capability)', "worker_carry_capability_registry_missing");
  requireText("privateExecution", 'registeredCarryAdapter(venue_id, "carry_execution")', "worker_carry_execution_registry_dispatch_missing");
  requireText("privateExecution", 'registeredCarryAdapter(venue_id, "no_submit_reconciliation")', "worker_carry_no_submit_registry_dispatch_missing");
  requireText("privateExecution", 'registeredCarryAdapterId(venueId, "carry_execution")', "worker_carry_funding_registry_dispatch_missing");
  requireText("privateExecution", "openAccountBoundExecutionVault", "carry_execution_vault_account_binding_missing");
  requireCount("privateExecution", 'deriveClientOrderId("gh",', 4, "aster_client_order_length_guard_missing");
  requireText("privateExecution", "opened.associatedDataText !== expectedAad", "carry_execution_vault_exact_aad_missing");
  requireText("privateExecution", '`account:${accountCommitment}`', "carry_execution_vault_account_commitment_missing");
  forbidText("privateExecution", 'aadPrefix: "ghola/hyperliquid-execution-vault-v1"', "hyperliquid_prefix_only_vault_open_forbidden");
  forbidText("privateExecution", 'aadPrefix: "ghola/aster-execution-vault-v1"', "aster_prefix_only_vault_open_forbidden");
  requireText("adapterRegistryTest", "shadow-only candidates cannot enter worker Carry dispatch", "worker_carry_registry_fail_closed_test_missing");
  requireText("adapterRegistryTest", "adapter_missing:no_submit_reconciliation", "worker_carry_no_submit_registry_gate_missing");
  requireText("adapterRegistryTest", "Carry funding history dispatches through the registered Aster adapter", "worker_carry_funding_registry_test_missing");

  requireText("hyperliquid", "target_client_order_matched", "hyperliquid_target_match_proof_missing");
  requireText("hyperliquid", "venueCloid === targetCloid", "hyperliquid_reconciliation_response_binding_missing");
  requireText("hyperliquid", "isTerminalHyperliquidOrderStatus(normalizedVenueOrderStatus)", "hyperliquid_reconciliation_terminal_gate_missing");
  requireText("hyperliquidReconcileTest", "rejects an orderStatus row that does not match the requested CLOID", "hyperliquid_reconciliation_response_binding_test_missing");
  requireText("hyperliquidReconcileTest", "keeps a matching open order non-terminal", "hyperliquid_reconciliation_terminal_test_missing");
  requireText("aster", "submitAndReconcileAsterExecution", "aster_exact_reconcile_missing");
  requireText("aster", "target_client_order_matched", "aster_target_match_proof_missing");
  requireText("lighter", "submitAndReconcileLighterExecution", "lighter_exact_reconcile_missing");
  requireText("lighter", "target_client_order_matched", "lighter_target_match_proof_missing");
  requireText("aster", "submission_outcome_ambiguous", "aster_ambiguity_freeze_missing");
  requireText("lighter", "submission_ambiguous", "lighter_ambiguity_freeze_missing");
  requireText("aster", "submission_retry_count: 0", "aster_ambiguous_submit_retry_guard_missing");
  requireText("lighter", "submission_retry_count: 0", "lighter_ambiguous_submit_retry_guard_missing");
  requireText("aster", "const maxAttempts = Math.max", "aster_reconciliation_bound_missing");
  requireText("lighter", "const maxAttempts = Math.max", "lighter_reconciliation_bound_missing");
  requireText("aster", "clientOrderId: reconciliationClientOrderId", "aster_reconciliation_target_drift_guard_missing");
  requireText("lighter", "clientOrderIndex: reconciliationClientOrderIndex", "lighter_reconciliation_target_drift_guard_missing");
  requireText("aster", "market: reconciliationMarket", "aster_reconciliation_market_drift_guard_missing");
  requireText("lighter", "market: reconciliationMarket", "lighter_reconciliation_market_drift_guard_missing");
  requireText("asterTest", "recovers an ambiguous Aster submit response by reading the exact order without resubmitting", "aster_ambiguous_reconciliation_test_missing");
  requireText("lighterTest", "recovers an ambiguous Lighter submit response by reading the exact order without resubmitting", "lighter_ambiguous_reconciliation_test_missing");
  requireText("asterTest", "bounds exact-order reconciliation when an ambiguous Aster submit cannot be found", "aster_reconciliation_bound_test_missing");
  requireText("lighterTest", "bounds exact-order reconciliation when an ambiguous Lighter submit cannot be found", "lighter_reconciliation_bound_test_missing");
  requireText("asterTest", "keeps explicit Aster reconciliation bound to the original order across read failures", "aster_reconciliation_target_test_missing");
  requireText("lighterTest", "keeps explicit Lighter reconciliation bound to the original order across read failures", "lighter_reconciliation_target_test_missing");
  requireText("lighterTest", "rejects a mismatched Lighter reconciliation row after an ambiguous submission", "lighter_reconciliation_response_binding_test_missing");
  requireText("lighter", "returnedClientOrderIndex === targetClientOrderIndex", "lighter_reconciliation_response_binding_missing");
  forbidText("aster", "submitAndReconcileAsterExecution({\n  credential,\n  instruction,\n  clientOrderId,\n  retry", "aster_retry_forbidden");
  forbidText("lighter", "submitAndReconcileLighterExecution({\n  credential,\n  instruction,\n  clientOrderIndex,\n  retry", "lighter_retry_forbidden");

  requireText("positions", "PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_MAX_NOTIONAL_MICRO_USDC", "pilot_notional_cap_missing");
  requireText("positions", "margin_runway_status_by_venue", "carry_monitor_runway_status_missing");
  requireText("positions", "const venueReads = await Promise.all", "carry_funding_parallel_read_missing");
  requireText("positions", "entries.sort(compareFundingEntries)", "carry_funding_canonical_order_missing");
  requireText("positions", "legId: carryPositionLegId(initial.position, read.venue_id)", "carry_funding_leg_binding_missing");
  requireText("positions", 'return "carry_market_data_skew_exceeded"', "carry_storage_skew_gate_missing");
  requireText("positions", 'return "carry_contract_basis_exceeded"', "carry_storage_contract_basis_gate_missing");
  requireText("positions", 'return "carry_unsigned_contract_basis_limit"', "carry_storage_signed_basis_gate_missing");
  requireText("positionsTest", "refuses storage until venue accounts, synchronized equivalent contracts, and margin runways pass", "carry_storage_skew_test_missing");
  requireText("positionsTest", "margin_runway_status_by_venue.hyperliquid", "carry_monitor_runway_status_test_missing");
  requireText("positionsTest", "monitoring reads both venue funding ledgers concurrently and commits them deterministically", "carry_funding_parallel_read_test_missing");
  requireText("positionsTest", "monitoring canonicalizes settlement order and rejects a changed replay", "carry_funding_replay_test_missing");
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
  requireText("preflight", "observeCarryFundingPersistence", "carry_funding_persistence_preflight_missing");
  requireText("preflight", "conservative_funding_rate_e12_by_venue", "carry_conservative_funding_pricing_missing");
  requireText("fundingPersistence", "DEFAULT_MIN_SAMPLES = 8", "carry_funding_sample_floor_missing");
  requireText("fundingPersistence", "DEFAULT_MIN_SPAN_MS = 30 * 60_000", "carry_funding_span_floor_missing");
  requireText("fundingPersistence", "appendDistinct", "carry_funding_duplicate_observation_gate_missing");
  requireText("fundingPersistence", '"funding_not_persistent"', "carry_funding_flip_entry_gate_missing");
  requireText("fundingPersistence", "percentile(longRates, 0.75", "carry_funding_adverse_long_quartile_missing");
  requireText("fundingPersistence", "percentile(shortRates, 0.25", "carry_funding_adverse_short_quartile_missing");
  requireText("fundingPersistence", "observeCarryFundingUniverse", "carry_funding_shadow_observer_missing");
  requireText("fundingPersistence", "startCarryFundingObservationLoop", "carry_unattended_funding_observer_missing");
  requireText("fundingPersistence", "observeCarryShadowQualification", "carry_shadow_qualification_observer_missing");
  requireText("fundingPersistence", "writeCarryShadowSnapshot", "carry_shadow_snapshot_observer_missing");
  requireText("shadowQualification", "verifyCarryShadowSoak", "carry_shadow_qualification_soak_missing");
  requireText("shadowQualification", "PHALA_CVM_IMAGE_DIGEST", "carry_shadow_qualification_image_binding_missing");
  requireText("shadowQualification", "sample_results: sampleResults", "carry_shadow_qualification_persistence_missing");
  requireText("shadowQualification", "source_observation_commitments", "carry_shadow_qualification_source_binding_missing");
  requireText("shadowQualification", "transaction_broadcast: false", "carry_shadow_qualification_no_broadcast_missing");
  requireText("shadowQualification", "export function verifyCarryShadowQualification", "carry_shadow_result_verifier_missing");
  requireText("shadowQualification", "qualification_commitment: qualificationResultCommitment(material)", "carry_shadow_result_commitment_missing");
  requireText("shadowQualificationTest", "rejects tampered qualification summaries", "carry_shadow_result_tamper_test_missing");
  requireText("shadowQualificationTest", "persists three consecutive complete five-venue samples without broadcasting", "carry_shadow_qualification_test_missing");
  requireText("shadowQualificationTest", "does not persist wrapper-only samples when venue source observations are unchanged", "carry_shadow_qualification_wrapper_reuse_test_missing");
  requireText("shadowQualificationTest", "resets consecutive qualification after one failed venue sample", "carry_shadow_qualification_reset_test_missing");
  requireText("shadowQualificationTest", "does not qualify complete-looking samples with degraded venue economics", "carry_shadow_qualification_degraded_test_missing");
  requireText("shadowQualificationTest", "fails closed for stale, tampered, or differently pinned qualification", "carry_shadow_qualification_integrity_test_missing");
  requireText("shadowSnapshot", "verifyCarryShadowSet", "carry_shadow_snapshot_reverification_missing");
  requireText("shadowSnapshot", "shadow_snapshot_evidence_invalid", "carry_shadow_snapshot_integrity_gate_missing");
  requireText("shadowSnapshot", "shadow_snapshot_stale", "carry_shadow_snapshot_freshness_gate_missing");
  requireText("shadowSnapshot", "shadow_snapshot_source_stale", "carry_shadow_snapshot_source_freshness_gate_missing");
  requireText("shadowSnapshot", "shadow_snapshot_proof_incomplete", "carry_shadow_snapshot_proof_gate_missing");
  requireText("shadowSnapshot", "transaction_broadcast: false", "carry_shadow_snapshot_no_broadcast_missing");
  requireText("shadowSnapshotTest", "serves a fresh commitment-backed five-venue snapshot from the durable observer", "carry_shadow_snapshot_cache_test_missing");
  requireText("shadowSnapshotTest", "rejects stale, tampered, or degraded durable snapshots and forces a live refresh", "carry_shadow_snapshot_fail_closed_test_missing");
  requireText("server", "readCarryShadowSnapshot", "carry_shadow_snapshot_read_path_missing");
  requireText("server", 'served_from: "live_fetch"', "carry_shadow_live_fallback_missing");
  requireText("server", "carryShadowRefreshes", "carry_shadow_refresh_singleflight_missing");
  requireText("serverTest", "coalesces concurrent cold reads", "carry_shadow_refresh_singleflight_test_missing");
  requireText("server", "funding_persistence: fundingPersistence", "carry_funding_shadow_cycle_missing");
  requireText("server", "shadow_qualification: shadowQualification", "carry_shadow_qualification_cycle_missing");
  requireText("server", "carryFundingObservationLoop?.stop?.()", "carry_unattended_funding_observer_lifecycle_missing");
  requireText("fundingPersistenceTest", "does not manufacture persistence from rapid duplicate checks", "carry_funding_duplicate_observation_test_missing");
  requireText("fundingPersistenceTest", "clips a current funding spike to adverse historical quartiles", "carry_funding_spike_test_missing");
  requireText("fundingPersistenceTest", "rejects carry whose historical funding advantage is not persistent", "carry_funding_persistence_test_missing");
  requireText("fundingPersistenceTest", "collects every trusted executable route during the normal shadow cycle", "carry_funding_shadow_observer_test_missing");
  requireText("fundingPersistenceTest", "collects funding history without an open browser", "carry_unattended_funding_observer_test_missing");
  requireText("fundingPersistenceTest", "resumes durable funding history after a worker restart", "carry_funding_restart_persistence_test_missing");
  requireText("fundingPersistence", "currentFundingObservation(evidence)", "carry_current_funding_source_binding_missing");
  requireText("fundingPersistenceTest", "monitoring commits current venue funding source observations", "carry_current_funding_source_test_missing");
  requireText("positions", "funding_observation_commitment: fundingObservation?.evidence_commitment", "carry_monitor_funding_commitment_missing");
  requireText("coreCarry", "funding_observation_evidence_mismatch", "carry_funding_observation_mismatch_gate_missing");
  requireText("coreCarryTest", "new wrapper timestamps cannot manufacture confirmations from replayed funding sources", "carry_funding_source_replay_test_missing");
  requireText("releaseMaterial", "releaseFundingObservations", "carry_release_funding_source_gate_missing");
  requireText("releaseMaterialTest", "refuses wrapper observations that reuse venue funding sources", "carry_release_funding_source_test_missing");
  requireText("evidenceVerifier", "funding_observation_source_reused", "carry_release_verifier_funding_source_gate_missing");
  requireText("fundingPersistence", 'name: "carry_shadow_observer"', "carry_shadow_observer_supervisor_missing");
  requireText("fundingPersistence", "supervisor.runOnce", "carry_shadow_observer_supervision_missing");
  requireText("fundingPersistenceTest", "supervises five-venue observation failures and stalls", "carry_shadow_observer_supervision_test_missing");
  requireText("phalaConfig", "expectedCarryWorkerConfig", "carry_runtime_config_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_POSITION_LIVE_SUBMIT', "carry_live_submit_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_ENABLED', "carry_pilot_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_QUALIFICATION_PILOT_MAX_NOTIONAL_MICRO_USDC', "carry_pilot_cap_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MAX_MARKET_DATA_SKEW_MS', "carry_market_data_skew_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS', "carry_index_basis_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS', "carry_mark_basis_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MONITOR_ENABLED', "carry_monitor_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MONITOR_INTERVAL_MS', "carry_monitor_interval_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_ENABLED', "carry_shadow_observer_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_INTERVAL_MS', "carry_shadow_observer_interval_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_SHADOW_OBSERVER_STALL_MS', "carry_shadow_observer_stall_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_SAMPLES', "carry_shadow_qualification_samples_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_MAX_AGE_MS', "carry_shadow_qualification_freshness_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MONITOR_CONCURRENCY', "carry_monitor_concurrency_compose_missing");
  requireText("positions", "mapConcurrentOrdered(records, concurrency", "carry_monitor_bounded_concurrency_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_EXECUTION_CONCURRENCY', "carry_execution_concurrency_compose_missing");
  requireText("executor", "mapConcurrentOrdered(tasks, concurrency", "carry_execution_bounded_concurrency_missing");
  requireText("lifecycleTest", "recovery work is bounded-concurrent and failure-isolated", "carry_execution_concurrency_test_missing");
  requireText("recordScan", "before_updated_at", "carry_record_scan_cursor_missing");
  requireText("workerState", "idx_worker_carry_positions_owner_status_scan", "carry_record_scan_composite_index_missing");
  requireText("workerState", "(record_json->>'updated_at') DESC, position_id DESC", "carry_record_scan_index_order_missing");
  requireText("positions", "listAllCarryPositionRecords", "carry_monitor_full_scan_missing");
  requireText("executor", "listAllCarryPositionRecords", "carry_recovery_full_scan_missing");
  requireText("recordScanTest", "beyond the 500-record storage page", "carry_record_scan_scale_test_missing");
  requireText("loopSupervisor", "consecutive_failures", "carry_loop_health_state_missing");
  requireText("loopSupervisor", 'status: "stalled"', "carry_loop_stall_detection_missing");
  requireText("loopSupervisor", "export function verifyCarrySupervisionHealth", "carry_supervision_evidence_verifier_missing");
  requireText("loopSupervisor", "evidence_commitment: supervisionCommitment(material)", "carry_supervision_commitment_missing");
  requireText("loopSupervisorTest", "attests fresh healthy supervision across every critical loop", "carry_supervision_attestation_test_missing");
  requireText("server", "checked_at_ms: requestStartedAt", "carry_supervision_request_time_binding_missing");
  requireText("positions", "maxSilenceMs: stallAfterMs", "carry_monitor_stall_deadline_missing");
  requireText("executor", "maxSilenceMs: stallAfterMs", "carry_execution_stall_deadline_missing");
  requireText("positions", "supervisor.runOnce", "carry_monitor_supervision_missing");
  requireText("positions", 'observation_source: "supervised_loop"', "carry_supervised_observation_missing");
  requireText("positionsTest", 'observation_source, "supervised_loop"', "carry_supervised_observation_test_missing");
  requireText("executor", "supervisor.runOnce", "carry_execution_supervision_missing");
  requireText("multiLegOrchestrator", 'name: "multi_leg_recovery"', "carry_recovery_supervisor_missing");
  requireText("multiLegOrchestrator", "supervisor.runOnce", "carry_recovery_supervision_missing");
  requireText("multiLegOrchestratorTest", "supervises multi-leg recovery failures and stalls", "carry_recovery_supervision_test_missing");
  requireText("loopSupervisor", "recovery: recoveryHealth", "carry_recovery_aggregate_missing");
  requireText("loopSupervisorTest", "does not mask a degraded recovery loop", "carry_recovery_aggregate_test_missing");
  requireText("loopSupervisorTest", "does not mask a failed market observation loop", "carry_observation_aggregate_test_missing");
  requireText("server", "recovery: multiLegRecoveryLoop", "carry_recovery_server_health_missing");
  requireText("server", "observation: carryFundingObservationLoop", "carry_observation_server_health_missing");
  requireText("executor", "const audit = await ensureRestartAudit()", "carry_restart_audit_retry_missing");
  requireText("lifecycleTest", "automatic exit retries a failed restart audit before any execution sweep", "carry_restart_audit_retry_test_missing");
  requireText("server", "carry_supervision: carrySupervision", "carry_supervision_health_missing");
  requireText("server", "carry_supervision_not_ready", "carry_entry_supervision_gate_missing");
  requireText("serverTest", "reports degraded Carry supervision without pretending the worker stopped", "carry_supervision_http_test_missing");
  requireText("webCarryBuilder", "carrySupervisionSummary", "carry_terminal_supervision_missing");
  requireText("webCarryBuilder", "RISK ENGINE NOT READY", "carry_terminal_supervision_gate_missing");
  requireText("webCarryBuilder", 'recovery.status === "healthy"', "carry_terminal_recovery_health_missing");
  requireText("webCarryBuilder", 'observation.status === "healthy"', "carry_terminal_observation_health_missing");
  requireText("webCarryBuilderTest", "blocks a draft entry when monitoring, automatic exit, or recovery is degraded", "carry_terminal_supervision_test_missing");
  requireText("webCarryBuilderTest", "RECOVERY DEGRADED", "carry_terminal_recovery_health_test_missing");
  requireText("loopSupervisorTest", "fails closed when a successful loop stops making progress", "carry_loop_stall_test_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_MONITOR_STALL_MS', "carry_monitor_stall_compose_missing");
  requireText("phalaConfig", 'PRIVATE_AGENT_CARRY_EXECUTION_STALL_MS', "carry_execution_stall_compose_missing");
  requireText("loopSupervisorTest", "without leaking exception text", "carry_loop_error_redaction_test_missing");
  requireText("releaseMaterial", 'event?.observation_source === "supervised_loop"', "carry_release_supervised_monitoring_missing");
  requireText("releaseMaterialTest", "refuses release evidence assembled from manual-only monitoring", "carry_release_supervised_monitoring_test_missing");
  requireText("releaseMaterialTest", "refuses a single unattended observation as a monitoring period", "carry_release_monitoring_cadence_test_missing");
  requireText("releaseMaterialTest", "refuses a lifecycle with a monitoring outage", "carry_release_monitoring_outage_test_missing");
  requireText("releaseMaterialTest", "refuses monitoring gaps beyond the signed freshness budget", "carry_release_monitoring_gap_test_missing");
  requireText("releaseMaterial", "readCarryExecutionReadiness({", "carry_release_three_venue_readiness_missing");
  requireText("releaseMaterial", "carry_release_three_venue_readiness_unproven", "carry_release_three_venue_fail_closed_missing");
  requireText("releaseMaterial", "execution_readiness: releaseExecutionReadiness({", "carry_release_three_venue_material_missing");
  requireText("releaseMaterialTest", "without creation-time three-venue readiness", "carry_release_three_venue_worker_test_missing");
  requireText("evidenceVerifier", "sameStrings(executionReadiness.registry_venue_ids, CARRY_EXECUTION_VENUES)", "carry_release_three_venue_verifier_missing");
  requireText("evidenceVerifier", "sameRecord(executionReadiness.recovery_policy, CARRY_RECOVERY_POLICY)", "carry_release_three_venue_recovery_verifier_missing");
  requireText("evidenceVerifierTest", "without all three execution venue bindings", "carry_release_three_venue_verifier_test_missing");
  requireText("evidenceVerifierTest", "permits ambiguity retries", "carry_release_three_venue_recovery_test_missing");
  requireText("releaseMaterial", "releaseExitTrigger", "carry_release_exit_trigger_missing");
  requireText("releaseMaterialTest", "refuses a release without an owner request or measured mandate breach", "carry_release_exit_trigger_test_missing");
  requireText("releaseMaterialTest", "binds an automatic exit to the signed net-carry threshold", "carry_release_signed_exit_trigger_test_missing");
  requireText("evidenceVerifier", 'supervision.mode === "attested_worker_loop"', "carry_release_supervision_verifier_missing");
  requireText("evidenceVerifier", 'automaticObservations >= 2', "carry_release_monitoring_cadence_verifier_missing");
  requireText("evidenceVerifier", 'supervision.failure_count === 0', "carry_release_monitoring_outage_verifier_missing");
  requireText("evidenceVerifier", 'maxObservationGapMs <= maxAllowedGapMs', "carry_release_monitoring_gap_verifier_missing");
  requireText("evidenceVerifier", "verifyExitTrigger", "carry_release_exit_trigger_verifier_missing");
  requireText("evidenceVerifierTest", "rejects an exit without exact owner or signed-mandate trigger evidence", "carry_release_exit_trigger_verifier_test_missing");
  requireText("evidenceVerifierTest", "rejects monitoring that was not produced by the unattended worker loop", "carry_release_supervision_verifier_test_missing");
  requireText("phalaConfigTest", 'PRIVATE_AGENT_CARRY_MONITOR_INTERVAL_MS: "5000"', "carry_monitor_five_second_runtime_test_missing");
  requireText("phalaConfigTest", 'PRIVATE_AGENT_CARRY_MAX_MARKET_DATA_SKEW_MS: "750"', "carry_market_data_skew_runtime_test_missing");
  requireText("phalaConfigTest", 'PRIVATE_AGENT_CARRY_MAX_INDEX_PRICE_DIVERGENCE_BPS: "12"', "carry_index_basis_runtime_test_missing");
  requireText("phalaConfigTest", 'PRIVATE_AGENT_CARRY_MAX_MARK_PRICE_DIVERGENCE_BPS: "24"', "carry_mark_basis_runtime_test_missing");
  requireText("phalaConfigTest", 'PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_SAMPLES: "3"', "carry_shadow_qualification_samples_runtime_test_missing");
  requireText("phalaConfigTest", 'PRIVATE_AGENT_CARRY_SHADOW_QUALIFICATION_MAX_AGE_MS: "600000"', "carry_shadow_qualification_freshness_runtime_test_missing");
  requireText("phalaConfig", "...expectedCarryWorkerConfig()", "carry_runtime_drift_gate_missing");
  requireText("phalaConfigTest", "pins an explicitly enabled capped Carry qualification runtime", "carry_runtime_drift_test_missing");
  requireText("server", 'req.headers["x-ghola-carry-qualification-confirmed"] === "true"', "worker_confirmation_header_missing");
  requireText("server", '"/carry/positions/release-evidence"', "worker_release_evidence_route_missing");
  requireText("server", '"/carry/positions/exit-request"', "carry_owner_exit_route_missing");
  requireText("server", "requestStoredCarryPositionExit", "carry_owner_exit_boundary_missing");
  requireText("positions", "type: \"manual_exit_requested\"", "carry_owner_exit_event_missing");
  requireText("positions", "if (read.cursor_ms > priorCursor) cursors[read.venue_id] = read.cursor_ms", "carry_funding_backfill_cursor_resume_missing");
  requireText("positionsTest", "authoritative funding backfill resumes across ticks for a year-long Carry Position", "carry_funding_backfill_resume_test_missing");
  requireText("positionsTest", "requestStoredCarryPositionExit", "carry_owner_exit_boundary_test_missing");
  forbidText("server", '"/carry/positions/events"', "carry_client_lifecycle_mutation_exposed");
  forbidText("server", '"/carry/positions/value-entries"', "carry_client_value_entry_mutation_exposed");
  forbidText("server", '"/carry/positions/finalize"', "carry_client_value_finalization_exposed");
  requireText("serverTest", '"/carry/positions/value-entries"', "carry_retired_value_mutation_route_test_missing");
  requireText("server", '"/carry/preflight-matrix"', "carry_three_venue_no_submit_worker_route_missing");
  requireText("serverTest", "proves the three-venue no-submit matrix and durable exact account state over HTTP", "carry_three_venue_no_submit_http_proof_missing");
  requireText("serverTest", "returns ready-pair evidence when a matrix venue has a sanitized not-ready marker", "carry_partial_matrix_http_proof_missing");
  requireText("server", '"/carry/readiness"', "carry_readiness_resume_worker_route_missing");
  requireText("server", "readCarryExecutionReadiness", "carry_readiness_resume_worker_missing");
  requireText("server", "readCarryExecutionDiagnostic", "carry_diagnostic_resume_worker_missing");
  requireText("server", "createReadOnlyCarryRuntimePolicies", "carry_runtime_route_policy_default_missing");
  requireText("server", "route_observation_configured: typeof probeCarryTransferRoute", "carry_runtime_route_observation_status_missing");
  requireText("server", "loadCarryTransferRouteEvidence", "carry_runtime_route_evidence_read_missing");
  requireText("server", "observePreopenCarryTransferRoutes", "carry_preopen_route_observation_missing");
  requireText("server", "collateral_route_observation: routeObservation", "carry_preopen_route_response_missing");
  requireText("server", "route_evidence: routeEvidence", "carry_private_prime_route_evidence_binding_missing");
  requireText("server", "readCompletedCarryLifecycleProof", "carry_private_prime_lifecycle_read_missing");
  requireText("server", "lifecycle_proof: lifecycleProof", "carry_private_prime_lifecycle_binding_missing");
  requireCount("server", "private_prime_authentication: authenticateCarryPrivatePrimeReadiness({", 2, "carry_private_prime_worker_authentication_missing");
  requireText("privatePrimeAuthentication", "carryPrivatePrimeWorkerAuthenticationMessage", "carry_private_prime_worker_authentication_payload_missing");
  requireText("privatePrimeAuthentication", 'createHmac("sha256", secret)', "carry_private_prime_worker_authentication_mac_missing");
  requireText("privatePrimeAuthentication", "workerCapabilitySecret(env)", "carry_private_prime_worker_authentication_secret_missing");
  requireText("privatePrimeAuthentication", "signAttestedWorkerMessage", "carry_private_prime_worker_attested_signature_missing");
  requireText("workerAttestedSigner", "export function signAttestedWorkerMessage", "carry_attested_worker_signer_missing");
  requireText("privatePrimeAuthenticationTest", "exact no-submit request", "carry_private_prime_worker_authentication_test_missing");
  requireText("serverTest", "matrix.private_prime_authentication.mac_hex", "carry_private_prime_worker_authentication_http_test_missing");
  requireText("serverTest", "matrix.private_prime_authentication.attestation_bound", "carry_private_prime_worker_attested_signature_http_test_missing");
  requireText("transferRoutes", "export async function observePreopenCarryTransferRoutes", "carry_preopen_route_compiler_missing");
  requireText("transferRoutes", "automatic_transfer_permitted: false", "carry_preopen_route_transfer_boundary_missing");
  requireText("transferRoutesTest", "before any position is opened", "carry_preopen_route_observation_test_missing");
  requireText("serverTest", "collateral_route_observation.observed_route_count, 6", "carry_preopen_route_http_test_missing");
  requireText("runtimeRiskPolicies", "owner_approval_required: true", "carry_runtime_route_owner_gate_missing");
  requireText("runtimeRiskPolicies", "fund_movement_authorized: false", "carry_runtime_route_movement_gate_missing");
  requireText("runtimeRiskPolicies", "transaction_broadcast: false", "carry_runtime_route_broadcast_gate_missing");
  requireText("runtimeRiskPoliciesTest", "unsupported runtime policy bindings", "carry_runtime_route_fail_closed_test_missing");
  requireText("releaseMaterial", "export async function recordCompletedCarryLifecycleProof", "carry_lifecycle_proof_recording_missing");
  requireText("releaseMaterial", "carryLifecycleProofKey(ownerCommitment, imageDigest, material.position.asset)", "carry_lifecycle_proof_asset_record_binding_missing");
  requireText("releaseMaterial", "carryLifecycleProofKey(ownerCommitment, imageDigest, normalizedAsset)", "carry_lifecycle_proof_asset_read_binding_missing");
  requireText("releaseMaterial", "asset: normalizedAsset", "carry_lifecycle_proof_asset_assessment_binding_missing");
  requireCount("server", "readCompletedCarryLifecycleProof({\n            state,\n            owner_commitment: body.owner_commitment,\n            asset: body.asset,", 2, "carry_lifecycle_proof_asset_http_binding_missing");
  requireText("releaseMaterialTest", "keeps lifecycle proof storage isolated per asset", "carry_lifecycle_proof_asset_isolation_test_missing");
  requireText("releaseMaterial", "final_flat_zero_orders: true", "carry_lifecycle_proof_flat_gate_missing");
  requireText("releaseMaterial", "proof?.broadcast_performed !== true", "carry_lifecycle_proof_live_broadcast_gate_missing");
  requireText("releaseMaterial", "proof.evidence_commitment === lifecycleProofCommitment(proof)", "carry_lifecycle_proof_integrity_gate_missing");
  requireText("releaseMaterial", "safeLifecycleValueAttribution(proof.value_attribution)", "carry_lifecycle_proof_value_attribution_gate_missing");
  requireText("releaseMaterial", "normalizeCarryLifecycleValueAttribution", "carry_lifecycle_proof_shared_value_attribution_missing");
  requireText("evidenceVerifier", "leg?.live_order_broadcast !== true", "carry_release_live_broadcast_verifier_missing");
  requireText("executor", "recordLifecycleProofAfterExit", "carry_lifecycle_proof_exit_hook_missing");
  requireText("privatePrimeReadiness", 'proof_level: pairedLifecycle.verified ? "live_paired_lifecycle" : "pre_broadcast_readiness"', "carry_private_prime_proof_level_missing");
  requireText("privatePrimeReadiness", "live_paired_lifecycle_proven: pairedLifecycle.verified", "carry_private_prime_live_proof_boundary_missing");
  requireText("privatePrimeReadiness", "ready_for_live_users: readyForLiveUsers", "carry_private_prime_live_user_gate_missing");
  requireText("privatePrimeReadiness", "assessCompletedCarryLifecycleProof({", "carry_private_prime_lifecycle_commitment_verification_missing");
  requireText("privatePrimeReadiness", "verifyCarrySupervisionHealth(carrySupervision", "carry_private_prime_supervision_verification_missing");
  requireText("privatePrimeReadiness", "Number.isSafeInteger(proof?.realized_net_value_micro_usdc)", "carry_private_prime_realized_net_gate_missing");
  requireText("privatePrimeReadiness", "realized_net_value_micro_usdc: verified ? proof.realized_net_value_micro_usdc : null", "carry_private_prime_realized_net_output_missing");
  requireText("privatePrimeReadiness", "safeLifecycleValueAttribution(proof?.value_attribution)", "carry_private_prime_value_attribution_gate_missing");
  requireText("privatePrimeReadiness", "normalizeCarryLifecycleValueAttribution", "carry_private_prime_shared_value_attribution_missing");
  requireText("privatePrimeReadiness", "value_attribution: verified ? valueAttribution : null", "carry_private_prime_value_attribution_output_missing");
  requireText("privatePrimeReadiness", "function minimumExpiry(readinessExpiry, shadowCheckedAt, routeExpiry, supervisionExpiry, lifecycleExpiry)", "carry_private_prime_lifecycle_expiry_binding_missing");
  requireText("privatePrimeReadiness", "assessedSupervision.health.checked_at_ms + 5_000", "carry_private_prime_supervision_expiry_binding_missing");
  requireText("privatePrimeReadiness", "pairedLifecycle.verified ? pairedLifecycle.expires_at_ms : null", "carry_private_prime_lifecycle_expiry_input_missing");
  requireText("privatePrimeReadinessTest", "never lets aggregate readiness outlive its paired lifecycle proof", "carry_private_prime_lifecycle_expiry_test_missing");
  requireText("privatePrimeReadinessTest", "never lets aggregate readiness outlive its supervision heartbeat", "carry_private_prime_supervision_expiry_test_missing");
  requireText("privatePrimeReadiness", "proof?.owner_commitment === readiness?.owner_commitment", "carry_private_prime_lifecycle_owner_binding_missing");
  requireText("privatePrimeReadiness", "proof?.worker_image_digest === readiness?.image_digest", "carry_private_prime_lifecycle_image_binding_missing");
  requireText("privatePrimeReadiness", "collateral_route_evidence_unverified", "carry_private_prime_route_evidence_gate_missing");
  requireText("privatePrimeReadiness", "verifyCarryExecutionReadinessResult(readiness", "carry_private_prime_readiness_wrapper_verification_missing");
  requireText("privatePrimeReadiness", "verifyCarryShadowQualification(shadowQualification", "carry_private_prime_shadow_wrapper_verification_missing");
  requireText("privatePrimeReadiness", "image_digest: readiness?.image_digest", "carry_private_prime_shadow_image_binding_missing");
  requireText("privatePrimeReadiness", "verifyCarryTransferRouteEvidence(routeEvidence?.evidence)", "carry_private_prime_route_commitment_verification_missing");
  requireText("coreCarry", "export function canonicalCarryCommitmentJson", "carry_private_prime_shared_canonicalizer_missing");
  requireText("coreCarry", "export function carryPrivatePrimeWorkerAuthenticationMessage", "carry_private_prime_authentication_contract_missing");
  requireText("coreIndex", "carryPrivatePrimeWorkerAuthenticationMessage", "carry_private_prime_authentication_contract_export_missing");
  requireText("privatePrimeReadiness", "canonicalCarryCommitmentJson(material)", "carry_private_prime_worker_canonicalizer_missing");
  requireText("webPrivatePrimeReadiness", "canonicalCarryCommitmentJson(material)", "carry_private_prime_web_canonicalizer_missing");
  requireText("webPrivatePrimeReadiness", "value.evidence_commitment === carryPrivatePrimeEvidenceCommitment(value)", "carry_private_prime_ui_commitment_verification_missing");
  requireText("privatePrimeReadiness", "evidence?.owner_commitment === readiness?.owner_commitment", "carry_private_prime_route_owner_binding_missing");
  requireText("privatePrimeReadiness", "nowMs - checkedAtMs <= 30_000", "carry_private_prime_route_freshness_gate_missing");
  requireText("privatePrimeReadiness", "routesBoundToCurrentAccounts", "carry_private_prime_route_account_state_binding_missing");
  requireText("privatePrimeReadiness", "failure_recovery: failureRecovery", "carry_private_prime_recovery_output_missing");
  requireText("privatePrimeReadiness", 'technicalReasons.push("three_venue_recovery_unproven")', "carry_private_prime_recovery_gate_missing");
  requireText("privatePrimeReadiness", "const noSubmitReady = technicalReasons.length === 0", "carry_private_prime_capital_free_no_submit_gate_missing");
  requireText("privatePrimeReadiness", "noSubmitReady && capitalReady && pairedLifecycle.verified", "carry_private_prime_live_capital_gate_missing");
  requireText("privatePrimeReadinessTest", "refuses private-prime readiness without exact three-venue recovery policy", "carry_private_prime_recovery_test_missing");
  requireText("privatePrimeReadinessTest", "without overstating live proof", "carry_private_prime_proof_boundary_test_missing");
  requireText("privatePrimeReadinessTest", "durable paired lifecycle evidence", "carry_private_prime_live_proof_test_missing");
  requireText("privatePrimeReadinessTest", "lifecycle proof with a valid-looking but mismatched commitment", "carry_private_prime_lifecycle_commitment_test_missing");
  requireText("privatePrimeReadinessTest", "without fresh owner-bound route evidence", "carry_private_prime_route_evidence_test_missing");
  requireText("privatePrimeReadinessTest", "valid-looking but mismatched commitment", "carry_private_prime_route_commitment_test_missing");
  requireText("privatePrimeReadinessTest", "stale or image-unbound five-venue qualification wrappers", "carry_private_prime_shadow_wrapper_test_missing");
  requireText("privatePrimeReadinessTest", "malformed three-venue readiness wrappers", "carry_private_prime_readiness_wrapper_test_missing");
  requireText("privatePrimeReadinessTest", "tampered three-venue readiness summaries", "carry_private_prime_readiness_summary_tamper_test_missing");
  requireText("privatePrimeReadinessTest", "tampered five-venue qualification summaries", "carry_private_prime_shadow_summary_tamper_test_missing");
  requireText("privatePrimeReadinessTest", "tampered supervision health wrappers", "carry_private_prime_supervision_tamper_test_missing");
  requireText("webPrivatePrimeReadinessTest", "aggregate with a recomputable-looking but mismatched commitment", "carry_private_prime_ui_commitment_test_missing");
  requireText("webPrivatePrimeReadiness", "expiresAt <= supervisionCheckedAt + 5_000", "carry_private_prime_ui_supervision_expiry_missing");
  requireText("webPrivatePrimeReadinessTest", "after supervision becomes stale", "carry_private_prime_ui_supervision_expiry_test_missing");
  requireText("webPrivatePrimeReadiness", 'value.proof_level === "live_paired_lifecycle"', "carry_private_prime_ui_proof_level_gate_missing");
  requireText("webPrivatePrimeReadiness", "value.live_paired_lifecycle_proven === true", "carry_private_prime_ui_live_proof_gate_missing");
  requireText("webPrivatePrimeReadiness", "value.ready_for_live_users === expectedLiveReady", "carry_private_prime_ui_live_user_gate_missing");
  requireText("webPrivatePrimeReadiness", "QUALIFIED · NO-SUBMIT ONLY · LIVE PAIRED PROOF REQUIRED", "carry_private_prime_ui_prebroadcast_disclosure_missing");
  requireText("webPrivatePrimeReadinessTest", "no-submit aggregate relabeled as ready for live users", "carry_private_prime_ui_live_user_test_missing");
  requireText("webCarryBuilderTest", "QUALIFIED · NO-SUBMIT ONLY · LIVE PAIRED PROOF REQUIRED", "carry_terminal_prebroadcast_disclosure_test_missing");
  requireText("webPrivatePrimeReadiness", "integer(pairedLifecycle.realized_net_value_micro_usdc)", "carry_private_prime_ui_realized_net_gate_missing");
  requireText("webPrivatePrimeReadiness", "parseLifecycleValueAttribution(pairedLifecycle.value_attribution)", "carry_private_prime_ui_value_attribution_gate_missing");
  requireText("webPrivatePrimeReadiness", "normalizeCarryLifecycleValueAttribution", "carry_private_prime_ui_shared_value_attribution_missing");
  requireText("webPrivatePrimeReadiness", "ΔMODEL ${formatSignedMicroUsd(value.variance_from_modeled_micro_usdc)}", "carry_private_prime_ui_value_attribution_display_missing");
  requireText("webPrivatePrimeReadiness", "expiresAt <= lifecycleExpiresAt", "carry_private_prime_ui_lifecycle_expiry_gate_missing");
  requireText("webPrivatePrimeReadiness", "pairedLifecycle.final_flat_zero_orders === true", "carry_private_prime_ui_flat_proof_gate_missing");
  requireText("webPrivatePrimeReadiness", "route.verified === true", "carry_private_prime_ui_route_evidence_gate_missing");
  requireText("webPrivatePrimeReadiness", "route.fund_movement_authorized === false", "carry_private_prime_ui_route_authority_gate_missing");
  requireText("webPrivatePrimeReadiness", "CARRY_RECOVERY_POLICY", "carry_private_prime_ui_recovery_policy_missing");
  requireText("webPrivatePrimeReadiness", "REC ·", "carry_private_prime_ui_recovery_display_missing");
  requireText("webPrivatePrimeReadinessTest", "rejects recovery coverage that permits ambiguous retries", "carry_private_prime_ui_recovery_test_missing");
  requireText("webPrivatePrimeReadiness", 'reason !== "opening_capital_shortfall"', "carry_private_prime_ui_capital_free_no_submit_gate_missing");
  requireText("webPrivatePrimeReadiness", "expectedReady && capitalReady && lifecycleReady", "carry_private_prime_ui_live_capital_gate_missing");
  requireText("webPrivatePrimeReadinessTest", "capital-free no-submit readiness without claiming live-entry readiness", "carry_private_prime_ui_capital_test_missing");
  requireText("webPrivatePrimeAuthentication", "carryPrivatePrimeWorkerAuthenticationMessage", "carry_private_prime_gateway_authentication_payload_missing");
  requireText("webPrivatePrimeAuthentication", 'createHmac("sha256", secret)', "carry_private_prime_gateway_authentication_mac_missing");
  requireText("webPrivatePrimeAuthentication", "timingSafeEqual(leftBytes, rightBytes)", "carry_private_prime_gateway_authentication_timing_safe_missing");
  requireText("webPrivatePrimeAuthentication", "ed25519.verify(", "carry_private_prime_gateway_attested_signature_missing");
  requireText("webPrivatePrimeAuthentication", "GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64", "carry_private_prime_gateway_signer_pin_missing");
  requireText("webPrivatePrimeAuthentication", "readiness.owner_commitment === ownerCommitment", "carry_private_prime_gateway_owner_binding_missing");
  requireText("webPrivatePrimeAuthentication", "expiresAtMs > now_ms", "carry_private_prime_gateway_expiry_missing");
  requireText("webPrivatePrimeAuthenticationTest", "replay under another work order", "carry_private_prime_gateway_authentication_test_missing");
  requireText("webPrivatePrimeAuthenticationTest", 'GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: "wrong-pin"', "carry_private_prime_gateway_signer_pin_test_missing");
  requireText("webRoute", "verifyCarryPrivatePrimeWorkerAuthentication({", "carry_private_prime_gateway_authentication_missing");
  requireText("webRoute", "workerCapabilitySecret(process.env) || worker.token", "carry_private_prime_gateway_authentication_secret_missing");
  requireText("webRoute", "return response({ error: authenticated.error }, 502", "carry_private_prime_gateway_authentication_fail_closed_missing");
  requireText("webCreationOpportunityAuthentication", "carryCreationOpportunityAuthenticationMessage", "carry_creation_opportunity_gateway_payload_missing");
  requireText("webCreationOpportunityAuthentication", "GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64", "carry_creation_opportunity_gateway_signer_pin_missing");
  requireText("webCreationOpportunityAuthentication", "ed25519.verify(", "carry_creation_opportunity_gateway_signature_missing");
  requireText("webCreationOpportunityAuthentication", "expiresAtMs <= nowMs", "carry_creation_opportunity_gateway_expiry_missing");
  requireText("webCreationOpportunityAuthenticationTest", "changed economics, another owner, expiry, missing proof, and a wrong signer pin", "carry_creation_opportunity_gateway_tamper_test_missing");
  requireText("webRoute", "verifyCarryCreationOpportunityWorkerAuthentication({", "carry_creation_opportunity_gateway_authentication_missing");
  requireText("webRoute", 'action === "preflight_pair"', "carry_creation_opportunity_gateway_pair_gate_missing");
  requireText("webCarryBuilder", 'label="PRIVATE PRIME"', "carry_private_prime_terminal_metric_missing");
  requireText("webCarryBuilder", "carryPrivatePrimeSummary", "carry_private_prime_terminal_validation_missing");
  requireText("webCarryBuilderTest", "without claiming a live lifecycle", "carry_private_prime_terminal_test_missing");
  requireText("webCarryBuilderTest", "3/3 REC", "carry_private_prime_terminal_recovery_missing");
  requireText("webCarryBuilder", "carryCreationProofFreshness(proofOpportunity)", "carry_creation_proof_freshness_missing");
  requireText("webCarryBuilder", "const canSave = actionableProof && creationProofFreshness.fresh", "carry_creation_stale_action_gate_missing");
  requireText("webCarryBuilder", "CHECK EXPIRED · rerun the no-submit check before signing", "carry_creation_expiry_guidance_missing");
  requireText("webCarryBuilderTest", "removes an expired creation action instead of failing after owner signing", "carry_creation_expiry_test_missing");
  requireText("webRoute", '"x-ghola-carry-qualification-confirmed": "true"', "web_confirmation_header_missing");
  requireText("webClient", "qualification_pilot_confirmed", "web_confirmation_input_missing");
  requireText("webClient", "preflightCarryExecutionMatrix", "carry_three_venue_no_submit_client_missing");
  requireText("webClient", "getCarryExecutionReadiness", "carry_readiness_resume_client_missing");
  requireText("webCarryBuilder", "asset: candidate.asset", "carry_readiness_route_client_binding_missing");
  requireText("webRoute", 'action === "preflight_matrix"', "carry_three_venue_no_submit_web_route_missing");
  requireText("webRoute", "workerMatrixVenueAccess", "carry_partial_matrix_gateway_missing");
  requireText("webPassportTest", "forwards sanitized missing-venue markers so ready Carry pairs still produce evidence", "carry_partial_matrix_gateway_test_missing");
  requireText("webRoute", 'action === "readiness"', "carry_readiness_resume_web_route_missing");
  requireText("webRoute", 'action === "request_exit"', "carry_owner_exit_web_route_missing");
  requireText("webClient", 'action: "request_exit"', "carry_owner_exit_client_missing");
  forbidText("webRoute", 'action === "event"', "carry_web_generic_event_mutation_exposed");
  forbidText("webRoute", 'action === "value_entry"', "carry_web_value_entry_mutation_exposed");
  forbidText("webRoute", 'action === "finalize"', "carry_web_value_finalization_exposed");
  requireText("webRoute", "horizon_days: input.horizon_days", "carry_readiness_route_web_binding_missing");
  requireText("webPage", 'redirect("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open")', "carry_integrated_terminal_redirect_missing");
  forbidText("webPage", "CarryWorkspace", "carry_standalone_workspace_restored");
  requireText("webTradeWorkspace", "CarryChartStrip", "carry_chart_strip_missing");
  requireText("webTradeWorkspace", 'label="Funding / 1h"', "hyperliquid_funding_interval_label_incorrect");
  requireText("webCarryChart", "createCarryLiveMarketStream", "carry_live_stream_missing");
  requireText("webCarryChart", "createCarryPatchPublisher", "carry_ui_publication_coalescer_missing");
  requireText("webCarryChart", "CARRY_UI_PUBLISH_INTERVAL_MS", "carry_ui_publish_throttle_missing");
  requireText("webCarryChart", "CARRY_ROUTE_DISPLAY_MAX_AGE_MS", "carry_ui_stale_route_gate_missing");
  requireText("webCarryChart", "const freshCandidates", "carry_ui_execution_stale_route_gate_missing");
  requireText("webCarryChart", "expectedNetDailyUsd", "carry_net_value_display_missing");
  requireText("webCarryChart", "isCarryExecutionVenue(candidate.long.venue_id)", "carry_executable_route_fallback_missing");
  requireText("webCarryChart", "rankCarryCandidatesByNet", "carry_net_route_ranking_missing");
  requireText("webCarryChart", 'aria-label="Carry execution route"', "carry_execution_route_selector_missing");
  requireText("webCarryChart", "preferredExecutionRouteKey", "carry_execution_route_return_binding_missing");
  requireText("webCarryChart", "selectedExecution || selectedObserved", "carry_primary_rail_execution_alignment_missing");
  requireText("webCarryChart", "data-route-mode={routeMode}", "carry_primary_rail_route_mode_missing");
  requireText("webCarryChart", '{routeMode === "execution" ? "EXEC" : "SHADOW"}', "carry_primary_rail_visible_route_mode_missing");
  requireText("webCarryChartTest", "restores only an exact currently qualified execution route", "carry_execution_route_return_test_missing");
  requireText("webCarryChartTest", "keeps the primary rail aligned with the executable builder route", "carry_primary_rail_execution_alignment_test_missing");
  requireText("webCarryChartTest", "labels a five-venue opportunity as shadow when no execution adapter is qualified", "carry_primary_rail_shadow_test_missing");
  requireText("webCarryChartTest", "never substitutes another route when the requested pair is stale", "carry_execution_route_substitution_test_missing");
  requireText("webCarryChartTest", "quarantines aged quotes from both display and execution", "carry_ui_execution_stale_route_test_missing");
  requireText("webCarryChart", "CarryTerminalBuilder", "carry_terminal_builder_missing");
  requireText("webCarryChart", "XVENUE", "carry_terminal_rail_missing");
  requireText("webCarryChart", "formatBps", "carry_basis_point_display_missing");
  requireText("webCarryChart", "grossDailyBps", "carry_gross_value_display_missing");
  requireText("webCarryChart", "NET24H", "carry_net_value_display_missing");
  requireText("webCarryChart", "routeHasPositiveNet", "carry_positive_net_qualification_missing");
  requireText("webCarryChart", "carryFundingEvidenceForCandidate", "carry_public_funding_evidence_missing");
  requireText("webCarryChart", "data-edge-evidence={edgeEvidence.status}", "carry_funding_evidence_state_missing");
  requireText("webCarryChart", "EVID {edgeEvidence.value}", "carry_funding_evidence_display_missing");
  requireText("webCarryMarket", "carryMarketQualificationEvidence", "carry_market_qualification_model_missing");
  requireText("webCarryMarket", "CORE_PERP_VENUES.map((venueId) => [venueId, executionVenueLabel(venueId)])", "carry_market_venue_label_registry_missing");
  requireText("webAccountSetup", "return executionVenueLabel(venueId);", "carry_setup_venue_label_registry_missing");
  requireText("webCarryMarket", "CARRY_SHADOW_QUALIFICATION_COMMITMENT", "carry_market_qualification_commitment_gate_missing");
  requireText("webCarryChart", "data-market-evidence={marketEvidence.status}", "carry_market_qualification_state_missing");
  requireText("webCarryChart", "{marketEvidence.value}", "carry_market_qualification_display_missing");
  requireText("webCarryMarket", "durability check required", "carry_point_in_time_edge_warning_missing");
  requireText("webCarryChart", 'data-modeled-net-positive={selectedHasPositiveNet ? "true" : "false"}', "carry_point_in_time_net_state_missing");
  forbidText("webCarryChart", 'data-route-qualified={selectedHasPositiveNet ? "true" : "false"}', "carry_single_tick_route_qualification_forbidden");
  requireText("webCarryMarket", "export function carryRoutingAdvantage", "carry_routing_advantage_model_missing");
  requireText("webCarryMarketTest", "refuses a routing-edge claim when exact anchor costs are unavailable", "carry_routing_advantage_fail_closed_test_missing");
  requireText("routingAdvantage", "evaluateCarryOpportunity", "carry_routing_advantage_core_model_missing");
  requireText("fundingPersistence", "conservative_funding_rate_e12_by_venue", "carry_routing_advantage_conservative_funding_missing");
  requireText("fundingPersistence", "current_feed_set_complete: currentFeedSetComplete", "carry_shadow_observer_complete_feed_health_missing");
  requireText("fundingPersistence", '"carry_shadow_feed_set_incomplete"', "carry_shadow_observer_complete_feed_error_missing");
  requireText("routingAdvantage", 'kind: "carry_routing_advantage"', "carry_routing_advantage_worker_evidence_missing");
  requireText("routingAdvantage", "account_fee_tier_included: false", "carry_routing_advantage_fee_boundary_missing");
  requireText("routingAdvantage", "execution_ready: false", "carry_routing_advantage_execution_boundary_missing");
  requireText("routingAdvantage", "transaction_broadcast: false", "carry_routing_advantage_broadcast_boundary_missing");
  requireText("routingAdvantage", "carry:routing:advantage:", "carry_routing_advantage_commitment_missing");
  requireText("routingAdvantageTest", "fails closed instead of estimating an unpriced route", "carry_routing_advantage_worker_fail_closed_test_missing");
  requireText("shadowSnapshot", "routing_advantage: routingAdvantage", "carry_routing_advantage_durable_snapshot_missing");
  requireText("server", "routing_advantage: routingAdvantage", "carry_routing_advantage_api_missing");
  requireText("webCarryMarket", "carryRoutingAdvantageEvidence", "carry_routing_advantage_evidence_gate_missing");
  requireText("webCarryMarket", "CARRY_ROUTING_ADVANTAGE_COMMITMENT", "carry_routing_advantage_commitment_gate_missing");
  requireText("webCarryChart", "{routingEvidence.label} {formatRoutingAdvantage", "carry_routing_advantage_display_missing");
  requireText("webCarryChart", "data-routing-evidence={routingEvidence.status}", "carry_routing_advantage_state_missing");
  requireText("webCarryMarket", "not realized P&L.", "carry_routing_advantage_modeled_disclosure_missing");
  requireText("webCarryChartTest", "shows modeled routing edge without presenting it as realized P&L", "carry_routing_advantage_disclosure_test_missing");
  requireText("webCarryChartTest", "upgrades modeled edge only when worker evidence matches the selected route", "carry_routing_advantage_worker_ui_test_missing");
  requireText("webCarryChart", "AGE {formatAge", "carry_feed_age_display_missing");
  requireText("webCarryChartTest", "shows only commitment-backed worker history as durable route evidence", "carry_public_funding_evidence_test_missing");
  requireText("webCarryChartTest", "shows compact worker-bound five-venue market evidence", "carry_market_qualification_display_test_missing");
  requireText("webCarryChartTest", "fails closed when five-venue market readiness is not release-bound", "carry_market_qualification_fail_closed_test_missing");
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
  requireText("webCarryBuilder", "carryFleetGuardSummary", "carry_terminal_partial_fleet_evidence_missing");
  requireText("webCarryBuilder", "CONNECT FLEET", "carry_terminal_fleet_remediation_missing");
  requireText("webCarryBuilder", "/account?setup=carry&return_to=", "carry_terminal_fleet_setup_scope_missing");
  requireText("webCarryBuilderTest", 'item.textContent === "CONNECT FLEET"', "carry_terminal_fleet_remediation_test_missing");
  requireText("webCarryBuilderTest", "FLEET 1/3 · ASTER BLOCKED", "carry_terminal_partial_fleet_evidence_test_missing");
  requireText("webCarryBuilder", "readyStoredDiagnostic", "carry_terminal_diagnostic_restore_missing");
  requireText("webCarryBuilderTest", "restores fresh diagnostic-only fleet evidence after refresh without treating it as readiness", "carry_terminal_diagnostic_restore_test_missing");
  forbidText("webCarryBuilder", '["hyperliquid", "lighter", "aster"]', "carry_terminal_matrix_registry_duplicated");
  requireText("webCarryBuilder", "preflightCarryPair", "carry_terminal_pair_no_submit_missing");
  requireText("webCarryBuilder", "long_venue=${encodeURIComponent(candidate.long.venue_id)}", "carry_terminal_pair_setup_binding_missing");
  requireText("webCarryBuilder", "&carry=open&long_venue=${encodeURIComponent(candidate.long.venue_id)}&short_venue=${encodeURIComponent(candidate.short.venue_id)}", "carry_terminal_pair_return_binding_missing");
  requireText("webCarryBuilder", "createCarryPosition", "carry_terminal_position_creation_missing");
  requireText("webCarryBuilder", "executeCarryPositionEntry", "carry_terminal_entry_missing");
  requireText("webCarryBuilder", "requestCarryPositionExit", "carry_terminal_exit_missing");
  requireText("webCarryBuilder", "ARM CAPPED PROOF", "carry_terminal_qualification_path_missing");
  requireText("webCarryBuilder", "CONFIRM LIVE PAIRED ENTRY", "carry_terminal_separate_confirmation_missing");
  requireText("webCarryBuilder", "FLAT · 0 ORDERS", "carry_terminal_flat_state_missing");
  requireText("webCarryBuilder", "RETRY POSITION SYNC", "carry_terminal_position_sync_gate_missing");
  requireText("webCarryBuilder", "LEG RUNWAY", "carry_terminal_runway_display_missing");
  requireText("webCarryBuilderTest", "HYP 2.0H · LTR 1.0H · WARNING", "carry_terminal_each_leg_runway_test_missing");
  requireText("webCarryBuilderTest", "fails closed when a venue claims risk alongside an infinite runway", "carry_terminal_runway_integrity_test_missing");
  requireText("webCarryBuilder", 'label="CARRY SIGNAL"', "carry_terminal_funding_flip_signal_missing");
  requireText("webCarryBuilder", "carryFundingFlipSummary", "carry_terminal_funding_flip_derivation_missing");
  requireText("webCarryBuilderTest", "shows the deterministic funding-flip count before reduce-only exit", "carry_terminal_funding_flip_test_missing");
  requireText("webCarryBuilder", 'label="PORTFOLIO RUNWAY"', "carry_terminal_portfolio_runway_missing");
  requireText("webCarryBuilder", "carryPortfolioRunwaySummary", "carry_terminal_portfolio_runway_derivation_missing");
  requireText("webCarryBuilderTest", "shows the worst verified shared-account runway across the portfolio", "carry_terminal_portfolio_runway_test_missing");
  requireText("webCarryBuilder", 'label="EDGE CONF"', "carry_terminal_funding_persistence_missing");
  requireText("webCarryBuilderTest", "shows only commitment-backed persistent funding as durable", "carry_terminal_funding_persistence_test_missing");
  requireText("webCarryBuilder", "window.setTimeout(refresh", "carry_terminal_monitor_refresh_missing");
  requireText("webCarryBuilderTest", "keeps checking and arming no-submit until a separate live-entry click", "carry_terminal_boundary_test_missing");
  requireText("webCarryBuilderTest", "keeps the selected pair usable when the three-venue fleet matrix is not ready", "carry_terminal_pair_isolation_test_missing");
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
  requireText("webCarryMarket", "carryStaleSources", "carry_component_staleness_gate_missing");
  requireText("webCarryMarket", "stale_sources: staleSources", "carry_stale_source_evidence_missing");
  requireText("webCarryMarket", "carryContractsAreComparable", "carry_terminal_contract_equivalence_gate_missing");
  requireText("webCarryMarket", "evaluatePerpContractPairBasis", "carry_terminal_shared_basis_engine_missing");
  requireText("webCarryMarket", "CARRY_CAPITAL_COST_BPS_PER_DAY", "carry_terminal_capital_cost_missing");
  requireText("webCarryMarket", "CARRY_BASE_RISK_BUFFER_BPS", "carry_terminal_risk_buffer_missing");
  requireText("webCarryMarket", "CARRY_LATENCY_BUFFER_BPS_PER_LEG", "carry_terminal_latency_buffer_missing");
  requireText("webCarryMarket", "CARRY_STABLE_COLLATERAL_BASIS_RISK_BPS", "carry_terminal_collateral_basis_buffer_missing");
  requireText("webCarryMarket", "applyCarryLivePatches", "carry_incremental_quote_engine_missing");
  requireText("webCarryMarketTest", "does not let an orderbook patch revive stale funding", "carry_partial_patch_staleness_test_missing");
  requireText("webCarryMarketTest", "excludes same-ticker contracts when equivalence, basis, or synchronization evidence fails", "carry_terminal_contract_equivalence_test_missing");
  requireText("webCarryMarketTest", "charges capital, latency, and cross-collateral basis buffers before ranking net value", "carry_terminal_complete_net_cost_test_missing");
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
  requireText("webAccountSetup", "carryWorkerPlatformGate", "carry_setup_worker_platform_gate_missing");
  requireText("webAccountSetup", "data-worker-platform-status", "carry_setup_worker_platform_status_missing");
  requireText("webAccountConnections", "Venue connections are preserved", "carry_setup_wallet_loop_prevention_missing");
  requireText("webAccountConnectionsTest", "distinguishing a worker authorization mismatch", "carry_setup_worker_mismatch_test_missing");
  requireText("webAccountConnectionsTest", "unlocks route verification only when every execution venue is connected", "carry_setup_all_venues_test_missing");
  requireText("webAccountConnectionsTest", "scopes guided setup to the selected pair without weakening fleet setup", "carry_setup_pair_scope_test_missing");
  requireText("webAccountSetup", "carryAccountConnectionProgressForVenues", "carry_setup_pair_scope_missing");
  requireText("webAccountSetup", "carryExecutionPairFromReturnTo(safeReturnTo)", "carry_setup_pair_return_binding_missing");
  requireText("webAccountConnectionsTest", "recovers only an exact distinct execution pair from a terminal return", "carry_setup_pair_return_test_missing");
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
  requireText("webCarryBuilder", 'label="COLLATERAL"', "user_collateral_assets_missing");
  requireText("webCarryBuilder", "carryCollateralBasisSummary", "user_risk_disclosure_missing");
  requireText("webCarryBuilderTest", "shows collateral assets and only worker-priced cross-collateral stress", "user_collateral_risk_test_missing");
  requireText("webCarryMarketTest", "ranks every equivalent pair by net value instead of gross funding alone", "carry_net_route_ranking_test_missing");

  requireText("lifecycleTest", "bootstraps one capped candidate only after separate qualification confirmation", "qualification_lifecycle_test_missing");
  requireText("lifecycleTest", "executes every qualified Hyperliquid, Lighter, and Aster pair through one contract", "carry_three_venue_pair_contract_test_missing");
  requireText("lifecycleTest", "completes a supervised restart-to-flat lifecycle for every qualified venue pair", "carry_three_venue_full_lifecycle_matrix_missing");
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
