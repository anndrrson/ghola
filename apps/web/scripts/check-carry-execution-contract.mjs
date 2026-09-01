#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attestCarryReleaseSourceTree } from "../../../scripts/carry-source-tree-attestation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

export const CARRY_RELEASE_FILES = Object.freeze({
  sourceTreeAttestation: "scripts/carry-source-tree-attestation.mjs",
  sourceTreeAttestationTest: "apps/web/scripts/carry-source-tree-attestation.test.mjs",
  workerImageWorkflow: ".github/workflows/build-private-agent-worker-image.yml",
  executionContract: "apps/web/scripts/check-carry-execution-contract.mjs",
  executionContractTest: "apps/web/scripts/check-carry-execution-contract.test.mjs",
  webPackage: "apps/web/package.json",
  vercelIgnore: ".vercelignore",
  coreIndex: "packages/execution-core/index.js",
  coreCarry: "packages/execution-core/carry.js",
  coreCarryTest: "packages/execution-core/test/carry.test.js",
  coreMultiLeg: "packages/execution-core/multi-leg.js",
  coreMultiLegTest: "packages/execution-core/test/multi-leg.test.js",
  registry: "packages/execution-core/venues.js",
  registryTest: "packages/execution-core/test/venues.test.js",
  liquidationDistance: "apps/private-agent-worker/src/venues/liquidation-distance.js",
  server: "apps/private-agent-worker/src/server.js",
  phalaCompose: "apps/private-agent-worker/docker-compose.phala.yml",
  phalaWorkerEnv: "scripts/lib/phala-worker-env.mjs",
  phalaWorkerEnvTest: "scripts/lib/phala-worker-env.test.mjs",
  workerState: "apps/private-agent-worker/src/state/private-state.js",
  workerPackage: "apps/private-agent-worker/package.json",
  workerDockerfile: "apps/private-agent-worker/Dockerfile",
  preflight: "apps/private-agent-worker/src/execution/carry-preflight.js",
  fundingPersistence: "apps/private-agent-worker/src/execution/carry-funding-persistence.js",
  routingAdvantage: "apps/private-agent-worker/src/execution/carry-routing-advantage.js",
  shadowQualification: "apps/private-agent-worker/src/execution/carry-shadow-qualification.js",
  shadowDevelopmentWitness: "apps/private-agent-worker/src/execution/carry-shadow-development-witness.js",
  shadowSnapshot: "apps/private-agent-worker/src/execution/carry-shadow-snapshot.js",
  workerMandate: "apps/private-agent-worker/src/execution/carry-mandate.js",
  positions: "apps/private-agent-worker/src/execution/carry-positions.js",
  portfolioValueAuthentication: "apps/private-agent-worker/src/execution/carry-portfolio-value-authentication.js",
  releaseMaterialAuthentication: "apps/private-agent-worker/src/execution/carry-release-material-authentication.js",
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
  arbitrage: "apps/private-agent-worker/src/execution/arbitrage.js",
  multiLegOrchestrator: "apps/private-agent-worker/src/execution/multi-leg-orchestrator.js",
  privateExecution: "apps/private-agent-worker/src/execution/private-execution.js",
  coinbase: "apps/private-agent-worker/src/venues/coinbase.js",
  adapterRegistryTest: "apps/private-agent-worker/test/carry-adapter-registry.test.js",
  multiLegOrchestratorTest: "apps/private-agent-worker/test/multi-leg-orchestrator.test.js",
  qualification: "apps/private-agent-worker/src/execution/carry-qualification.js",
  readiness: "apps/private-agent-worker/src/execution/carry-readiness.js",
  reconciliation: "apps/private-agent-worker/src/execution/carry-reconciliation.js",
  releaseMaterial: "apps/private-agent-worker/src/execution/carry-release-evidence.js",
  shadow: "apps/private-agent-worker/src/execution/perp-shadow-adapters.js",
  shadowVerifier: "apps/private-agent-worker/src/execution/perp-shadow-readiness.js",
  shadowVerifierCli: "apps/private-agent-worker/scripts/verify-carry-shadow.mjs",
  shadowWitnessVerifierCli: "apps/private-agent-worker/scripts/verify-carry-shadow-witness.mjs",
  shadowVerifierTest: "apps/private-agent-worker/test/verify-carry-shadow.test.js",
  shadowDevelopmentWitnessTest: "apps/private-agent-worker/test/carry-shadow-development-witness.test.js",
  hyperliquid: "apps/private-agent-worker/src/venues/hyperliquid.js",
  hyperliquidRunner: "apps/private-agent-worker/src/venues/hyperliquid_runner.py",
  hyperliquidTurnkey: "apps/private-agent-worker/src/venues/hyperliquid-turnkey.js",
  aster: "apps/private-agent-worker/src/venues/aster.js",
  lighter: "apps/private-agent-worker/src/venues/lighter.js",
  workerAttestedSigner: "apps/private-agent-worker/src/venues/shielded_funding_attestation.js",
  lighterRunner: "apps/private-agent-worker/src/venues/lighter_runner.py",
  webRoute: "apps/web/src/app/v1/private-account/carry/route.ts",
  webWorkerRouting: "apps/web/src/lib/private-account-worker-routing.ts",
  webWorkerRoutingTest: "apps/web/src/lib/private-account-worker-routing.test.ts",
  webEnvExample: "apps/web/.env.example",
  webClient: "apps/web/src/lib/private-account-client.ts",
  webClientVenueBindingTest: "apps/web/src/lib/private-account-client-venue-binding.test.ts",
  webPrivateAccountCockpit: "apps/web/src/components/private-account/PrivateAccountCockpit.tsx",
  webConnectorReconciliation: "apps/web/src/lib/private-account-connectors.ts",
  webConnectorReconciliationTest: "apps/web/src/lib/private-account-reconcile.test.ts",
  webConnectorReconciliationBindingTest: "apps/web/src/lib/private-account-reconcile-binding.test.ts",
  webConnectorExecutionTest: "apps/web/src/lib/private-account-hyperliquid.test.ts",
  webConnectorExecutionResultBindingTest: "apps/web/src/lib/private-account-execution-result-binding.test.ts",
  webConnectorResponseBindingTest: "apps/web/src/lib/private-account-response-binding.test.ts",
  webMandate: "apps/web/src/lib/carry-risk-mandate.ts",
  webMandateTest: "apps/web/src/lib/carry-risk-mandate.test.ts",
  webCollateralReview: "apps/web/src/lib/carry-collateral-review.ts",
  webPrivatePrimeReadiness: "apps/web/src/lib/carry-private-prime-readiness.ts",
  webPrivatePrimeReadinessTest: "apps/web/src/lib/carry-private-prime-readiness.test.ts",
  webPrivatePrimeAuthentication: "apps/web/src/lib/carry-private-prime-worker-authentication.ts",
  webPrivatePrimeAuthenticationTest: "apps/web/src/lib/carry-private-prime-worker-authentication.test.ts",
  webCreationOpportunityAuthentication: "apps/web/src/lib/carry-creation-opportunity-authentication.ts",
  webCreationOpportunityAuthenticationTest: "apps/web/src/lib/carry-creation-opportunity-authentication.test.ts",
  webPortfolioValueAuthentication: "apps/web/src/lib/carry-portfolio-value-worker-authentication.ts",
  webPortfolioValueAuthenticationTest: "apps/web/src/lib/carry-portfolio-value-worker-authentication.test.ts",
  webReleaseMaterialAuthentication: "apps/web/src/lib/carry-release-material-worker-authentication.ts",
  webReleaseMaterialAuthenticationTest: "apps/web/src/lib/carry-release-material-worker-authentication.test.ts",
  webPerpsTurnkey: "apps/web/src/lib/perps-turnkey-provider.tsx",
  webRegistry: "apps/web/src/lib/carry-venues.ts",
  webCredentialOnboarding: "apps/web/src/lib/venue-credential-onboarding.ts",
  webCredentialOnboardingTest: "apps/web/src/lib/venue-credential-onboarding.test.ts",
  webPage: "apps/web/src/app/carry/page.tsx",
  webTradeWorkspace: "apps/web/src/components/trade/PublicCoinbaseLiveTrade.tsx",
  webTradeLifecycleTest: "apps/web/src/lib/public-hyperliquid-trade-lifecycle.test.ts",
  webTradeReadiness: "apps/web/src/lib/trade-readiness.ts",
  webTradeReadinessTest: "apps/web/src/lib/trade-readiness.test.ts",
  webCarryChart: "apps/web/src/components/carry/CarryChartStrip.tsx",
  webCarryChartTest: "apps/web/src/components/carry/CarryChartStrip.test.tsx",
  webCarryBuilder: "apps/web/src/components/carry/CarryTerminalBuilder.tsx",
  webCarryBuilderTest: "apps/web/src/components/carry/CarryTerminalBuilder.test.tsx",
  webCarryPositionRail: "apps/web/src/components/carry/CarryPositionRail.tsx",
  webCarryPositionRailTest: "apps/web/src/components/carry/CarryPositionRail.test.tsx",
  webCarryTerminalChrome: "apps/web/src/lib/carry-terminal-chrome.ts",
  webCarryTerminalChromeTest: "apps/web/src/lib/carry-terminal-chrome.test.ts",
  webCarryMarket: "apps/web/src/lib/carry-market.ts",
  webCarryMarketTest: "apps/web/src/lib/carry-market.test.ts",
  webCarryLiveMarket: "apps/web/src/lib/carry-live-market.ts",
  webCarryLiveMarketTest: "apps/web/src/lib/carry-live-market.test.ts",
  webCsp: "apps/web/src/lib/csp-config.ts",
  webAccountPage: "apps/web/src/app/app/account/page.tsx",
  webAccountSetup: "apps/web/src/components/carry/CarryAccountSetup.tsx",
  webAccountSetupTest: "apps/web/src/components/carry/CarryAccountSetup.test.tsx",
  webAccountConnections: "apps/web/src/lib/carry-account-connections.ts",
  webAccountConnectionsTest: "apps/web/src/lib/carry-account-connections.test.ts",
  webOnboardingRecovery: "apps/web/src/lib/carry-onboarding-recovery.ts",
  webOnboardingRecoveryTest: "apps/web/src/lib/carry-onboarding-recovery.test.ts",
  webSetupAuthRecovery: "apps/web/src/lib/carry-setup-auth-recovery.ts",
  webSetupAuthRecoveryTest: "apps/web/src/lib/carry-setup-auth-recovery.test.ts",
  lighterActivationReadiness: "apps/web/src/lib/lighter-activation-readiness.ts",
  lighterActivationReadinessTest: "apps/web/src/lib/lighter-activation-readiness.test.ts",
  lighterActivationReadinessServer: "apps/web/src/lib/lighter-activation-readiness.server.ts",
  lighterActivationReadinessServerTest: "apps/web/src/lib/lighter-activation-readiness.server.test.ts",
  webPrivateAccount: "apps/web/src/lib/private-account.ts",
  webPrivateAccountTest: "apps/web/src/lib/private-account.test.ts",
  webPrivateAccountStore: "apps/web/src/lib/private-account-store.ts",
  webPrivateAccountStoreTest: "apps/web/src/lib/private-account-store.test.ts",
  webPrivateAccountRouteLib: "apps/web/src/app/v1/private-account/_lib.ts",
  webPrivacyPreviewRouteTest: "apps/web/src/app/v1/private-account/actions/privacy-preview/route.test.ts",
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
  portfolioValueAuthenticationTest: "apps/private-agent-worker/test/carry-portfolio-value-authentication.test.js",
  releaseMaterialAuthenticationTest: "apps/private-agent-worker/test/carry-release-material-authentication.test.js",
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
  coinbaseTest: "apps/private-agent-worker/test/coinbase.test.js",
  lighterConcurrencyTest: "apps/private-agent-worker/test/lighter-concurrency.test.js",
  privateStatePolicyClaimTest: "apps/private-agent-worker/test/private-state-policy-claim.test.js",
  hyperliquidMetricsTest: "apps/private-agent-worker/test/hyperliquid-account-metrics.test.js",
  hyperliquidReconcileTest: "apps/private-agent-worker/test/hyperliquid-reconcile.test.js",
  hyperliquidTurnkeyTest: "apps/private-agent-worker/test/hyperliquid-turnkey.test.js",
  liquidationDistanceTest: "apps/private-agent-worker/test/liquidation-distance.test.js",
  evidenceAssembler: "apps/web/scripts/assemble-carry-release-evidence.mjs",
  evidenceAssemblerTest: "apps/web/scripts/assemble-carry-release-evidence.test.mjs",
  evidenceVerifier: "apps/web/scripts/verify-carry-release-evidence.mjs",
  evidenceVerifierTest: "apps/web/scripts/verify-carry-release-evidence.test.mjs",
  noSubmitEvidenceVerifier: "apps/web/scripts/verify-carry-no-submit-evidence.mjs",
  noSubmitEvidenceVerifierTest: "apps/web/scripts/verify-carry-no-submit-evidence.test.mjs",
  noSubmitEvidenceAssembler: "apps/web/scripts/assemble-carry-no-submit-evidence.mjs",
  noSubmitEvidenceAssemblerTest: "apps/web/scripts/assemble-carry-no-submit-evidence.test.mjs",
  webNoSubmitEvidence: "apps/web/src/lib/carry-no-submit-evidence.ts",
  webNoSubmitEvidenceTest: "apps/web/src/lib/carry-no-submit-evidence.test.ts",
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
  const requireSectionText = (section, value, code) => {
    if (!String(section || "").includes(value)) failures.push(code);
  };
  const requireSectionCount = (section, value, count, code) => {
    if (String(section || "").split(value).length - 1 < count) failures.push(code);
  };
  const forbidSectionText = (section, value, code) => {
    if (String(section || "").includes(value)) failures.push(code);
  };
  const sourceSection = (key, start, end) => {
    const source = String(sources[key] || "");
    const startIndex = source.indexOf(start);
    if (startIndex < 0) return "";
    const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length;
    return source.slice(startIndex, endIndex < 0 ? source.length : endIndex);
  };
  const sourceOccurrenceSection = (key, start, end, occurrence = 0) => {
    const source = String(sources[key] || "");
    let startIndex = -1;
    let cursor = 0;
    for (let index = 0; index <= occurrence; index += 1) {
      startIndex = source.indexOf(start, cursor);
      if (startIndex < 0) return "";
      cursor = startIndex + start.length;
    }
    const endIndex = end ? source.indexOf(end, cursor) : source.length;
    return source.slice(startIndex, endIndex < 0 ? source.length : endIndex);
  };
  const requireOrdered = (section, before, after, code) => {
    const beforeIndex = section.indexOf(before);
    const afterIndex = section.indexOf(after);
    if (beforeIndex < 0 || afterIndex < 0 || beforeIndex >= afterIndex) failures.push(code);
  };

  for (const [key, path] of Object.entries(CARRY_RELEASE_FILES)) {
    if (typeof sources[key] !== "string" || sources[key].length === 0) failures.push(`source_missing:${path}`);
  }

  requireText("vercelIgnore", "!deploy/evidence/CARRY_MAINNET_PROOF_RUNBOOK.md", "carry_proof_runbook_bundle_missing");
  requireText("proofRunbook", "Turnkey owner signs the exact Carry risk mandate", "carry_proof_runbook_owner_signature_missing");
  requireText("proofRunbook", "expiry permits only a reduce-only exit", "carry_proof_runbook_expiry_exit_missing");
  requireText("proofRunbook", "independently recover the owner signature", "carry_proof_runbook_independent_verification_missing");
  requireText("proofRunbook", "carry_execution_no_submit_matrix", "carry_proof_runbook_three_venue_matrix_missing");
  requireText("proofRunbook", "verify:carry-no-submit-evidence", "carry_proof_runbook_no_submit_verifier_missing");
  requireText("proofRunbook", "Capital-free development witness", "carry_shadow_development_witness_runbook_missing");
  requireText("proofRunbook", "never substitutes for image-bound qualification", "carry_shadow_development_witness_boundary_missing");
  requireText("sourceTreeAttestation", "ghola-carry-release-source-tree-v1", "carry_source_tree_attestation_domain_missing");
  requireText("sourceTreeAttestation", "carry_release_source_tree_dirty", "carry_source_tree_dirty_gate_missing");
  requireText("sourceTreeAttestationTest", "ignores unrelated dirt", "carry_source_tree_unrelated_dirty_test_missing");
  requireText("sourceTreeAttestationTest", "tampered expected digest", "carry_source_tree_tamper_test_missing");
  requireText("sourceTreeAttestation", "carry_release_source_not_regular", "carry_source_tree_regular_file_gate_missing");
  requireText("sourceTreeAttestationTest", "rejects a release-critical symlink escape", "carry_source_tree_symlink_escape_test_missing");
  requireText("executionContract", "clean release-critical sources", "carry_source_tree_guard_status_missing");
  forbidText("executionContract", ["committed", "sources"].join(" "), "carry_source_tree_guard_misleading_status_present");
  requireText("shadowDevelopmentWitness", "source_tree_digest", "carry_shadow_source_tree_binding_missing");
  requireText("shadowWitnessVerifierCli", "expectedSourceTreeDigest", "carry_shadow_source_tree_verifier_missing");
  requireText("noSubmitEvidenceAssembler", "source_tree_digest", "carry_no_submit_source_tree_binding_missing");
  requireText("noSubmitEvidenceAssembler", 'import { CARRY_EXECUTION_VENUES } from "@ghola/execution-core";', "carry_no_submit_assembler_registry_import_missing");
  requireText("noSubmitEvidenceAssembler", "for (const venueId of CARRY_EXECUTION_VENUES)", "carry_no_submit_assembler_registry_iteration_missing");
  forbidText("noSubmitEvidenceAssembler", '["hyperliquid", "lighter", "aster"]', "carry_no_submit_assembler_venue_list_duplicated");
  requireText("noSubmitEvidenceAssemblerTest", "CARRY_EXECUTION_VENUES.map", "carry_no_submit_assembler_registry_test_missing");
  requireText("noSubmitEvidenceVerifier", "expected_source_tree_digest", "carry_no_submit_source_tree_verifier_missing");
  requireText("evidenceAssembler", "attestCarryReleaseSourceTree", "carry_release_source_tree_assembler_missing");
  requireText("evidenceAssemblerTest", "rejects a dirty release-critical source tree", "carry_release_source_tree_dirty_assembler_test_missing");
  requireText("evidenceVerifier", "source_tree_digest", "carry_release_source_tree_binding_missing");
  requireText("evidenceVerifier", "expected_source_tree_digest", "carry_release_source_tree_verifier_missing");
  requireText("webNoSubmitEvidence", "ghola_three_venue_no_submit_proof", "carry_preview_no_submit_artifact_missing");
  requireText("webNoSubmitEvidence", "containsCredentialMaterial", "carry_preview_no_submit_artifact_secret_gate_missing");
  requireText("webNoSubmitEvidence", 'import { CARRY_EXECUTION_VENUES } from "./carry-venues";', "carry_no_submit_registry_import_missing");
  requireText("webNoSubmitEvidence", "for (const venueId of CARRY_EXECUTION_VENUES)", "carry_no_submit_registry_iteration_missing");
  forbidText("webNoSubmitEvidence", '["hyperliquid", "lighter", "aster"]', "carry_no_submit_venue_list_duplicated");
  requireText("webNoSubmitEvidenceTest", "without credentials", "carry_preview_no_submit_artifact_test_missing");
  requireText("webNoSubmitEvidenceTest", "CARRY_EXECUTION_VENUES.map", "carry_no_submit_registry_test_missing");
  requireText("webRoute", "attachNoSubmitEvidence", "carry_preview_no_submit_capture_missing");
  requireText("noSubmitEvidenceVerifier", "parsed?.no_submit_evidence || parsed", "carry_preview_no_submit_extraction_missing");
  requireText("lighterRunner", "account_active_orders(", "lighter_pinned_active_order_api_missing");
  requireText("lighterRunner", "account_inactive_orders(", "lighter_pinned_inactive_order_api_missing");
  requireText("lighterRunner", "MAX_INACTIVE_ORDER_PAGES", "lighter_inactive_order_reconciliation_bound_missing");
  requireText("lighterRunner", "next_cursor in seen_cursors", "lighter_inactive_order_cursor_guard_missing");
  forbidText("lighterRunner", "account_orders(", "lighter_unavailable_order_api_present");
  requireText("lighterTest", "uses the pinned Lighter SDK active and inactive order APIs", "lighter_pinned_order_api_test_missing");
  requireText("workerDockerfile", 'getattr(api, "account_active_orders", None)', "lighter_image_active_order_api_guard_missing");
  requireText("workerDockerfile", 'getattr(api, "account_inactive_orders", None)', "lighter_image_inactive_order_api_guard_missing");
  requireText("workerDockerfile", 'getattr(api, "trades", None)', "lighter_image_trade_api_guard_missing");
  requireText("workerDockerfile", 'getattr(api, "trades_with_http_info", None)', "lighter_image_raw_trade_api_guard_missing");
  for (const field of [
    "trade_id", "type", "market_id", "size", "price", "usd_amount", "ask_id", "bid_id",
    "ask_client_id", "bid_client_id", "ask_account_id", "bid_account_id", "is_maker_ask",
    "maker_fee", "taker_fee",
  ]) {
    requireText("workerDockerfile", `"${field}"`, `lighter_image_trade_field_guard_missing:${field}`);
  }
  requireText("lighterRunner", "async def exact_account_order_trades(", "lighter_exact_trade_fee_reader_missing");
  requireText("lighterRunner", "trades_with_http_info(**params)", "lighter_raw_trade_read_missing");
  requireText("lighterRunner", 'raw_data = getattr(response, "raw_data", None)', "lighter_raw_trade_evidence_missing");
  requireText("lighterRunner", "MAX_TRADE_PAGES = 8", "lighter_trade_pagination_bound_missing");
  requireText("lighterRunner", "for _ in range(MAX_TRADE_PAGES):", "lighter_trade_pagination_loop_missing");
  requireText("lighterRunner", "if next_cursor is None:", "lighter_trade_pagination_completion_missing");
  requireText("lighterRunner", "if next_cursor == cursor or next_cursor in seen_cursors:", "lighter_trade_cursor_guard_missing");
  requireText("lighterRunner", 'fail("lighter trade pagination exceeded the evidence bound")', "lighter_trade_pagination_fail_closed_missing");
  requireText("lighterRunner", '"pagination_complete": True', "lighter_trade_pagination_proof_missing");
  requireText("lighterRunner", "if trade_id in seen_trade_ids:", "lighter_trade_duplicate_guard_missing");
  requireText("lighterRunner", 'if trade.get("type") != "trade":', "lighter_trade_type_binding_missing");
  requireText("lighterRunner", 'if exact_integer(trade.get("market_id"), "lighter trade market is invalid") != market_index:', "lighter_trade_market_binding_missing");
  requireText("lighterRunner", "if account_is_ask == account_is_bid:", "lighter_trade_account_binding_missing");
  requireText("lighterRunner", 'if exact_integer(bound_order_id, "lighter trade order is invalid") != order_index:', "lighter_trade_order_binding_missing");
  requireText("lighterRunner", 'if exact_integer(bound_client_id, "lighter trade client order is invalid") != client_order_index:', "lighter_trade_client_order_binding_missing");
  requireText("lighterRunner", 'role = "maker" if account_is_ask == is_maker_ask else "taker"', "lighter_trade_fee_role_binding_missing");
  requireText("lighterRunner", 'fee_key = f"{role}_fee"', "lighter_trade_realized_fee_field_missing");
  requireText("lighterRunner", "fee_tick = 0 if fee_key not in trade else exact_integer(", "lighter_omitted_zero_fee_semantics_missing");
  requireText("lighterRunner", 'trade[fee_key], "lighter trade fee tick is invalid", signed=True', "lighter_explicit_fee_validation_missing");
  requireText("lighterRunner", "LIGHTER_FEE_TICK_DENOMINATOR = Decimal(1_000_000)", "lighter_trade_fee_denominator_missing");
  requireText("lighterRunner", "fee = quote * Decimal(fee_tick) / LIGHTER_FEE_TICK_DENOMINATOR", "lighter_trade_fee_conversion_missing");
  requireText("lighterRunner", "if base_total > expected_base or quote_total > expected_quote:", "lighter_trade_total_overfill_guard_missing");
  requireText("lighterRunner", "if base_total != expected_base or quote_total != expected_quote:", "lighter_trade_total_completion_guard_missing");
  requireCount("lighterRunner", '"order_index": str(', 2, "lighter_order_index_string_proof_missing");
  requireText("lighterRunner", 'outbound_order["order_index"] = str(exact_integer(', "lighter_order_index_string_transport_missing");
  requireText("lighter", "unsignedDecimalIntegerText(order?.order_index) !== null", "lighter_original_order_id_proof_missing");
  requireText("lighter", "const orderIndex = unsignedDecimalIntegerText(raw.order_index);", "lighter_fee_order_id_string_binding_missing");
  requireText("lighter", "LIGHTER_CANCELED_ORDER_STATUSES.has(value)", "lighter_cancel_status_enum_missing");
  requireText("lighterRunner", "status in LIGHTER_CANCELED_ORDER_STATUSES", "lighter_runner_cancel_status_enum_missing");
  forbidText("lighter", '.startsWith("canceled")', "lighter_cancel_status_prefix_present");
  forbidText("lighterRunner", '.startswith("canceled")', "lighter_runner_cancel_status_prefix_present");
  for (const status of [
    "canceled", "canceled-post-only", "canceled-reduce-only", "canceled-position-not-allowed",
    "canceled-margin-not-allowed", "canceled-too-much-slippage", "canceled-not-enough-liquidity",
    "canceled-self-trade", "canceled-expired", "canceled-oco", "canceled-child",
    "canceled-liquidation", "canceled-invalid-balance",
  ]) {
    requireText("lighter", `"${status}"`, `lighter_cancel_status_enum_value_missing:${status}`);
    requireText("lighterRunner", `"${status}"`, `lighter_runner_cancel_status_enum_value_missing:${status}`);
  }
  requireText("lighter", "const zeroFillFeeExact = exactOriginalOrderObserved", "lighter_zero_fill_order_id_binding_missing");
  requireText("lighter", '&& filledBase === "0"', "lighter_zero_fill_base_binding_missing");
  requireText("lighter", '&& filledQuote === "0"', "lighter_zero_fill_quote_binding_missing");
  requireText(
    "lighter",
    'fee_quote_amount: zeroFillFeeExact ? "0" : feeProof.complete === true ? feeProof.fee_quote_amount : null',
    "lighter_exact_fee_fill_binding_missing",
  );
  forbidText("lighter", "order.fee", "lighter_synthetic_order_fee_fallback_present");
  forbidText("lighter", "order.total_fee", "lighter_synthetic_total_fee_fallback_present");
  forbidText("lighter", "order.trading_fee", "lighter_synthetic_trading_fee_fallback_present");
  requireText("lighterTest", "derives exact Lighter fees from bound paginated Trade rows", "lighter_exact_trade_fee_test_missing");
  requireText("lighterTest", '("type", "liquidation")', "lighter_trade_type_negative_test_missing");
  requireText("lighterTest", 'const largeOrderIndex = "1152921504606846975";', "lighter_large_order_index_test_missing");
  requireText("lighterTest", 'status: "canceled-too-much-slippage"', "lighter_partial_cancel_fee_test_missing");
  requireText("lighterTest", 'status: "canceled-post-only"', "lighter_zero_fill_cancel_fee_test_missing");
  requireText("lighterTest", 'del omitted_zero[0]["maker_fee"]', "lighter_omitted_zero_fee_test_missing");
  requireText("lighterTest", 'explicit_null[0]["maker_fee"] = None', "lighter_explicit_null_fee_test_missing");
  requireText("lighterTest", "zeroWithoutOrderIndex", "lighter_zero_fill_order_id_negative_test_missing");
  requireText("lighterTest", "contradictoryZero", "lighter_zero_fill_quote_negative_test_missing");
  requireText("lighterTest", '"canceled-unknown"', "lighter_unknown_cancel_status_negative_test_missing");
  const lighterReconciliation = sourceSection(
    "lighter",
    "export async function reconcileLighterExecution({",
    "function normalizedLighterFeeProof(",
  );
  requireSectionText(lighterReconciliation, "resultAccountIndex === credential.account_index", "lighter_reconcile_account_binding_missing");
  requireSectionText(lighterReconciliation, "resultMarketId !== null", "lighter_reconcile_market_shape_gate_missing");
  requireSectionText(lighterReconciliation, "nonnegativeIntegerOrNull(candidate?.market_index ?? candidate?.market_id) === resultMarketId", "lighter_reconcile_candidate_market_binding_missing");
  requireSectionText(lighterReconciliation, "submittedOrderMatchesCandidate(candidate, fingerprint", "lighter_reconcile_local_fingerprint_binding_missing");
  requireSectionText(lighterReconciliation, "expectedAccountIndex: credential.account_index", "lighter_reconcile_fingerprint_account_binding_missing");
  requireSectionText(lighterReconciliation, "expectedOrderIndex: lineageOrderIndex", "lighter_reconcile_order_lineage_binding_missing");
  requireSectionText(lighterReconciliation, "result?.target_fingerprint_checked === true", "lighter_reconcile_runner_fingerprint_check_missing");
  requireSectionText(lighterReconciliation, "result?.target_fingerprint_matched === true", "lighter_reconcile_runner_fingerprint_match_missing");
  requireSectionText(lighterReconciliation, "result?.target_identifier_collision !== true", "lighter_reconcile_fingerprint_collision_gate_missing");
  requireSectionText(lighterReconciliation, "const targetMatched = fingerprintMatched", "lighter_reconcile_target_fingerprint_gate_missing");
  const lighterCandidateFingerprint = sourceSection(
    "lighter",
    "function submittedOrderMatchesCandidate(",
    "function orderFingerprintCommitment(",
  );
  requireSectionText(lighterCandidateFingerprint, "candidate?.owner_account_index) === expectedAccountIndex", "lighter_candidate_fingerprint_account_binding_missing");
  requireSectionText(lighterCandidateFingerprint, "candidate?.client_order_index) === fingerprint.client_order_index", "lighter_candidate_fingerprint_client_binding_missing");
  requireSectionText(lighterCandidateFingerprint, "candidate?.initial_base_amount", "lighter_candidate_fingerprint_size_binding_missing");
  requireSectionText(lighterCandidateFingerprint, "candidate?.price", "lighter_candidate_fingerprint_price_binding_missing");
  requireSectionText(lighterCandidateFingerprint, 'candidate?.type === "limit"', "lighter_candidate_fingerprint_type_binding_missing");
  requireSectionText(lighterCandidateFingerprint, "candidate?.reduce_only === fingerprint.reduce_only", "lighter_candidate_fingerprint_reduce_only_binding_missing");
  requireSectionText(lighterCandidateFingerprint, "candidateTimestampMs !== null", "lighter_candidate_fingerprint_time_binding_missing");
  requireSectionText(lighterCandidateFingerprint, "candidateOrderIndex !== null", "lighter_candidate_fingerprint_order_lineage_missing");
  const lighterRunnerFingerprint = sourceSection(
    "lighterRunner",
    "def submitted_order_fingerprint_matches(",
    "def incomplete_trade_fee_proof(",
  );
  requireSectionText(lighterRunnerFingerprint, 'order.get("owner_account_index")', "lighter_runner_fingerprint_account_binding_missing");
  requireSectionText(lighterRunnerFingerprint, 'order.get("market_index")', "lighter_runner_fingerprint_market_binding_missing");
  requireSectionText(lighterRunnerFingerprint, 'fingerprint.get("market")', "lighter_runner_fingerprint_symbol_binding_missing");
  requireSectionText(lighterRunnerFingerprint, 'order.get("type") != "limit"', "lighter_runner_fingerprint_type_binding_missing");
  requireSectionText(lighterRunnerFingerprint, 'order.get("reduce_only") is not fingerprint["reduce_only"]', "lighter_runner_fingerprint_reduce_only_binding_missing");
  requireSectionText(lighterRunnerFingerprint, "abs(created_at_ms - submitted_at_ms) > LIGHTER_ORDER_TIME_SKEW_MS", "lighter_runner_fingerprint_time_binding_missing");
  requireSectionText(lighterRunnerFingerprint, "expected_order_index is not None", "lighter_runner_fingerprint_order_lineage_missing");
  requireText("lighterTest", "rejects reused Lighter client indexes when the submitted fingerprint differs", "lighter_fingerprint_collision_test_missing");
  requireText("lighterTest", "keeps same-index Lighter side, size, or price collisions ambiguous with no fills", "lighter_fingerprint_ambiguity_test_missing");

  requireText(
    "webPrivateAccountStore",
    "platform_class: GholaPlatformClass | null;\n  venue_id: GholaVenueId | null;",
    "connector_intent_venue_binding_schema_missing",
  );
  requireText(
    "webPrivateAccountStore",
    "platform_class TEXT NOT NULL,\n      venue_id TEXT NOT NULL,\n      manifest_commitment TEXT NOT NULL,",
    "connector_compiled_venue_schema_missing",
  );
  requireText(
    "webPrivateAccountStore",
    "platform_class TEXT NOT NULL,\n      venue_id TEXT NOT NULL,\n      status TEXT NOT NULL,\n      work_order JSONB NOT NULL,",
    "connector_work_order_venue_schema_missing",
  );
  requireText(
    "webPrivateAccountStore",
    "ALTER TABLE private_account_compiled_intents ADD COLUMN IF NOT EXISTS venue_id TEXT",
    "connector_compiled_legacy_venue_column_missing",
  );
  requireText(
    "webPrivateAccountStore",
    "ALTER TABLE private_account_connector_work_orders ADD COLUMN IF NOT EXISTS venue_id TEXT",
    "connector_work_order_legacy_venue_column_missing",
  );
  requireText("webConnectorReconciliation", "venuePlatformClass(input.venue_id) !== input.platform_class", "connector_compiler_venue_platform_gate_missing");
  requireText("webConnectorReconciliation", "venue_id: input.compiled_intent.venue_id", "connector_work_order_venue_commitment_missing");
  requireText("webConnectorReconciliation", "venue_id: input.work_order.venue_id", "connector_result_venue_commitment_missing");
  requireText("webConnectorReconciliation", "input.compiled_intent.venue_id !== input.readiness.venue_id", "connector_work_order_readiness_venue_gate_missing");
  requireText("webConnectorReconciliation", 'if (venueId === "aster") return "/venues/aster/orders";', "connector_aster_submit_route_missing");
  requireText("webConnectorReconciliation", 'if (venueId === "lighter") return "/venues/lighter/orders";', "connector_lighter_submit_route_missing");
  requireText("webConnectorReconciliation", 'if (venueId === "aster") return "/venues/aster/verify";', "connector_aster_verify_route_missing");
  requireText("webConnectorReconciliation", 'if (venueId === "lighter") return "/venues/lighter/verify";', "connector_lighter_verify_route_missing");
  const venueSubmitSection = sourceSection(
    "webConnectorReconciliation",
    "export async function submitConnectorWorkOrder(",
    "export async function verifyConnectorNoSubmit(",
  );
  if (!venueSubmitSection.includes('((venueId === "aster" || venueId === "lighter") && !input.venue_execution_vault)')) {
    failures.push("connector_submit_venue_vault_gate_missing");
  }
  requireOrdered(
    venueSubmitSection,
    '((venueId === "aster" || venueId === "lighter") && !input.venue_execution_vault)',
    "const res = await fetch",
    "connector_submit_venue_vault_gate_after_fetch",
  );
  if (!venueSubmitSection.includes("if (!connectorResponseBindingMatches(body, {")) {
    failures.push("connector_submit_response_binding_unconditional_missing");
  }
  for (const value of [
    "venue_id: venueId",
    "work_order_commitment: input.work_order.work_order_commitment",
    "platform_class: input.manifest.platform_class",
  ]) {
    if (!venueSubmitSection.includes(value)) failures.push("connector_submit_response_exact_binding_missing");
  }
  const venueVerifySection = sourceSection(
    "webConnectorReconciliation",
    "export async function verifyConnectorNoSubmit(",
    "export async function reconcileConnectorResult(",
  );
  if (!venueVerifySection.includes("input.readiness.venue_id !== base.venue_id")) {
    failures.push("connector_verify_readiness_venue_gate_missing");
  }
  if (!venueVerifySection.includes("if (!connectorResponseBindingMatches(body, {")) {
    failures.push("connector_verify_response_binding_unconditional_missing");
  }
  for (const value of [
    "venue_id: base.venue_id",
    "work_order_commitment: base.work_order_commitment",
    "platform_class: input.platform_class",
  ]) {
    if (!venueVerifySection.includes(value)) failures.push("connector_verify_response_exact_binding_missing");
  }
  const rawNoSubmitValidation = "const checksFailure = mandatoryNoSubmitChecksFailure(base.venue_id, body.checks);";
  if (!venueVerifySection.includes(rawNoSubmitValidation)) {
    failures.push("connector_no_submit_raw_checks_gate_missing");
  }
  const rawNoSubmitValidationSection = venueVerifySection.slice(
    Math.max(0, venueVerifySection.indexOf(rawNoSubmitValidation)),
  );
  requireOrdered(
    rawNoSubmitValidationSection,
    rawNoSubmitValidation,
    "if (checksFailure)",
    "connector_no_submit_raw_checks_failure_gate_missing",
  );
  requireOrdered(
    rawNoSubmitValidationSection,
    "if (checksFailure)",
    "return verifiedNoFundsVerification(base, {",
    "connector_no_submit_raw_checks_gate_after_acceptance",
  );
  requireOrdered(
    rawNoSubmitValidationSection,
    "if (checksFailure)",
    "checks: noFundsChecks(body.checks)",
    "connector_no_submit_checks_normalized_before_raw_validation",
  );
  const mandatoryNoSubmitFailureSection = sourceSection(
    "webConnectorReconciliation",
    "function mandatoryNoSubmitChecksFailure(",
    "function mandatoryNoSubmitChecks(",
  );
  if (!mandatoryNoSubmitFailureSection.includes(
    'if (checks.transaction_broadcast !== false) return "transaction_broadcast_not_false";',
  )) {
    failures.push("connector_no_submit_raw_transaction_broadcast_false_gate_missing");
  }
  if (!mandatoryNoSubmitFailureSection.includes(
    'if (required.some((check) => !(check in checks))) return "mandatory_no_submit_checks_incomplete";',
  )) {
    failures.push("connector_no_submit_mandatory_presence_gate_missing");
  }
  if (!mandatoryNoSubmitFailureSection.includes(
    'if (required.some((check) => checks[check] !== true)) return "mandatory_no_submit_check_failed";',
  )) {
    failures.push("connector_no_submit_mandatory_truth_gate_missing");
  }
  const mandatoryNoSubmitChecksSection = sourceSection(
    "webConnectorReconciliation",
    "function mandatoryNoSubmitChecks(",
    "function provenNoSubmitClaims(",
  );
  const mandatoryNoSubmitVenueChecks = [
    {
      id: "aster",
      start: 'if (venueId === "aster") {',
      end: 'if (venueId === "lighter") {',
      checks: ["sdk_checked", "signer_matches_key", "market_data_checked", "account_state_checked", "order_request_checked"],
    },
    {
      id: "lighter",
      start: 'if (venueId === "lighter") {',
      end: 'if (venueId === "hyperliquid") {',
      checks: ["sdk_checked", "signer_matches_key", "market_data_checked", "account_state_checked", "margin_state_checked", "order_request_checked"],
    },
    {
      id: "hyperliquid",
      start: 'if (venueId === "hyperliquid") {',
      end: 'if (venueId === "phoenix" || venueId === "drift") {',
      checks: [
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
      ],
    },
    {
      id: "phoenix_drift",
      start: 'if (venueId === "phoenix" || venueId === "drift") {',
      end: 'if (venueId === "backpack") {',
      checks: [
        "sealed_vault_opened",
        "sealed_instruction_opened",
        "authority_derived",
        "policy_enforced",
        "live_gate_enforced",
        "rpc_reachable",
        "phoenix_sdk_ready",
        "order_packet_built",
      ],
    },
    {
      id: "backpack",
      start: 'if (venueId === "backpack") {',
      end: 'if (venueId === "jupiter") {',
      checks: [
        "sealed_vault_opened",
        "sealed_instruction_opened",
        "authority_derived",
        "policy_enforced",
        "live_gate_enforced",
        "rpc_reachable",
        "backpack_rest_ready",
        "order_packet_built",
      ],
    },
    {
      id: "jupiter",
      start: 'if (venueId === "jupiter") {',
      end: 'if (venueId === "coinbase_advanced") {',
      checks: [
        "sealed_vault_opened",
        "sealed_instruction_opened",
        "authority_derived",
        "policy_enforced",
        "live_gate_enforced",
        "order_request_built",
        "jupiter_api_reachable",
        "jupiter_token_allowlist_passed",
        "jupiter_order_built",
        "jupiter_transaction_built",
      ],
    },
    {
      id: "coinbase_advanced",
      start: 'if (venueId === "coinbase_advanced") {',
      end: "return null;",
      checks: ["coinbase_api_reachable", "coinbase_order_request_built"],
    },
  ];
  for (const venue of mandatoryNoSubmitVenueChecks) {
    const startIndex = mandatoryNoSubmitChecksSection.indexOf(venue.start);
    const endIndex = mandatoryNoSubmitChecksSection.indexOf(venue.end, startIndex + venue.start.length);
    if (startIndex < 0 || endIndex < 0) {
      failures.push(`connector_no_submit_mandatory_branch_missing:${venue.id}`);
      continue;
    }
    const venueSection = mandatoryNoSubmitChecksSection.slice(startIndex, endIndex);
    for (const check of venue.checks) {
      if (!venueSection.includes(`"${check}"`)) {
        failures.push(`connector_no_submit_mandatory_checks_missing:${venue.id}:${check}`);
      }
    }
  }
  const connectorModeSection = sourceSection(
    "webConnectorReconciliation",
    "function connectorMode(",
    "function signManifest(",
  );
  if (!connectorModeSection.includes('if (env.NODE_ENV === "production") return "http";')) {
    failures.push("connector_production_local_test_override_missing");
  }
  requireOrdered(
    connectorModeSection,
    'if (env.NODE_ENV === "production") return "http";',
    'env.GHOLA_CONNECTOR_MODE === "local_test"',
    "connector_production_local_test_override_too_late",
  );
  const venueReconcileSection = sourceSection(
    "webConnectorReconciliation",
    "export async function reconcileConnectorResult(",
    "function connectorResult(",
  );
  if (!venueReconcileSection.includes("input.work_order.venue_id !== input.venue_id")) {
    failures.push("connector_reconcile_work_order_venue_gate_missing");
  }
  requireOrdered(
    venueReconcileSection,
    "input.work_order.venue_id !== input.venue_id",
    "const res = await fetch",
    "connector_reconcile_venue_gate_after_fetch",
  );
  if (!venueReconcileSection.includes('if (connectorEnv.NODE_ENV !== "test") {')) {
    failures.push("connector_synthetic_reconcile_exact_test_gate_missing");
  }
  const localTestReconcileSection = venueReconcileSection.slice(
    Math.max(0, venueReconcileSection.indexOf('if (mode === "local_test") {')),
  );
  requireOrdered(
    localTestReconcileSection,
    'if (connectorEnv.NODE_ENV !== "test") {',
    'status: "reconciled"',
    "connector_synthetic_reconcile_exact_test_gate_after_acceptance",
  );
  requireText("webPrivateAccountRouteLib", "const platformRequiresVenue =", "connector_intent_venue_requirement_missing");
  requireText("webPrivateAccountRouteLib", "venuePlatformClass(venueValue) !== platformValue", "connector_intent_platform_venue_gate_missing");
  requireText("webPrivateAccountRouteLib", "!workOrderRecord.venue_id", "connector_legacy_work_order_venue_gate_missing");
  requireText(
    "webPrivateAccountRouteLib",
    '((venueId === "aster" || venueId === "lighter") && !workOrderRecord)',
    "connector_no_submit_stored_work_order_gate_missing",
  );
  requireText("webPrivateAccountRouteLib", "input.intent.venue_id !== venueId", "connector_execution_intent_venue_gate_missing");
  requireText("webPrivateAccountRouteLib", "compiledRecord.compiled_intent.venue_id !== venueId", "connector_execution_compiled_venue_gate_missing");
  requireText("webPrivateAccountRouteLib", "const privacyRuntime = connectorVenueId", "generic_preview_connector_bypass_missing");
  requireText("webPrivateAccountRouteLib", "genericPrivacyRuntimeForIntent({", "generic_preview_runtime_missing");
  const genericPrivacyRuntimeSection = sourceSection(
    "webPrivateAccountRouteLib",
    "async function genericPrivacyRuntimeForIntent(",
    "async function connectorContextForIntent(",
  );
  for (const [value, code] of [
    ["listLinkabilityScores(input.owner.owner_commitment, 200)", "generic_preview_linkability_history_missing"],
    ["record.intent_id !== input.intent.intent_id", "generic_preview_current_intent_history_exclusion_missing"],
    ["record.platform_class === input.platform_class", "generic_preview_platform_history_binding_missing"],
    ["scoreConnectorLinkability({", "generic_preview_linkability_scoring_missing"],
    ["putLinkabilityScore({", "generic_preview_linkability_persistence_missing"],
    ["linkability_score: linkabilityScore", "generic_preview_simulation_score_binding_missing"],
  ]) {
    if (!genericPrivacyRuntimeSection.includes(value)) failures.push(code);
  }
  requireOrdered(
    genericPrivacyRuntimeSection,
    "listLinkabilityScores(input.owner.owner_commitment, 200)",
    "scoreConnectorLinkability({",
    "generic_preview_linkability_scored_before_history",
  );
  requireOrdered(
    genericPrivacyRuntimeSection,
    "scoreConnectorLinkability({",
    "putLinkabilityScore({",
    "generic_preview_linkability_persisted_before_scoring",
  );
  if (/score_bps\s*:\s*0(?:\D|$)/.test(genericPrivacyRuntimeSection)) {
    failures.push("generic_preview_zero_linkability_score_forbidden");
  }
  if (/decision\s*:\s*["']proceed["']/.test(genericPrivacyRuntimeSection)) {
    failures.push("generic_preview_proceed_decision_fabrication_forbidden");
  }
  requireText("webPrivacyPreviewRouteTest", "preserves generic previews without minting connector artifacts", "generic_preview_connector_bypass_test_missing");
  requireText("webPrivacyPreviewRouteTest", "getCompiledIntentByIntent", "generic_preview_compiled_artifact_negative_test_missing");
  requireText("webPrivacyPreviewRouteTest", "getConnectorWorkOrderByPreview", "generic_preview_work_order_negative_test_missing");
  requireText("webPrivacyPreviewRouteTest", "raises generic linkability risk from the owner's repeated private activity", "generic_preview_linkability_history_test_missing");
  requireText("webPrivacyPreviewRouteTest", "toBeGreaterThan", "generic_preview_linkability_score_increase_test_missing");
  requireText("webPrivacyPreviewRouteTest", 'not.toBe("proceed")', "generic_preview_linkability_decision_test_missing");
  requireText("webClient", "export function bindPrivateAccountSafeInputPlatform(", "connector_client_venue_switch_binding_missing");
  requireText("webClient", "venue_id: input.venue_id", "connector_client_intent_venue_transport_missing");
  requireCount("webPrivateAccountCockpit", "bindPrivateAccountSafeInputPlatform(", 5, "connector_cockpit_venue_switch_binding_missing");
  requireText("webTradeWorkspace", 'venue_id: "hyperliquid"', "public_trade_default_venue_binding_missing");
  requireText("webClientVenueBindingTest", "replaces an old venue on every execution-platform switch", "connector_client_venue_replace_test_missing");
  requireText("webClientVenueBindingTest", "removes a prior venue when switching to a non-execution platform", "connector_client_venue_clear_test_missing");
  requireText("webConnectorExecutionTest", "binds %s submit route and vault before fetch", "connector_submit_exact_venue_test_missing");
  requireText("webConnectorExecutionTest", "binds %s no-submit route and response proof", "connector_verify_exact_venue_test_missing");
  requireText("webConnectorExecutionTest", "mandatory_no_submit_checks_incomplete", "connector_no_submit_mandatory_presence_test_missing");
  requireText("webConnectorExecutionTest", "mandatory_no_submit_check_failed", "connector_no_submit_mandatory_truth_test_missing");
  requireText("webConnectorExecutionTest", "transaction_broadcast_not_false", "connector_no_submit_transaction_broadcast_test_missing");
  requireText("webConnectorExecutionTest", "delete missingBroadcastCheck.transaction_broadcast", "connector_no_submit_missing_transaction_broadcast_test_missing");
  const responseBindingSection = sourceSection(
    "webConnectorReconciliation",
    "function connectorResponseBindingMatches(",
    "function bucket(",
  );
  for (const [value, code] of [
    ["stringValue(body.venue_id) === expected.venue_id", "connector_response_venue_binding_missing"],
    ["stringValue(body.work_order_commitment) === expected.work_order_commitment", "connector_response_work_order_binding_missing"],
    ["stringValue(body.platform_class) === expected.platform_class", "connector_response_platform_binding_missing"],
  ]) if (!responseBindingSection.includes(value)) failures.push(code);
  requireText("webConnectorResponseBindingTest", "rejects missing or mismatched %s submit echoes", "connector_submit_all_venue_response_binding_test_missing");
  requireText("webConnectorResponseBindingTest", "rejects missing or mismatched %s no-submit echoes", "connector_verify_all_venue_response_binding_test_missing");
  const cachedExecutionSection = sourceSection(
    "webPrivateAccountRouteLib",
    "async function connectorForExecution(",
    "export function connectorExecutionCachedResultBindingValid(",
  );
  if ((cachedExecutionSection.match(/if \(!connectorExecutionCachedResultBindingValid\(\{/g) || []).length !== 3) {
    failures.push("connector_cached_result_all_reuse_paths_binding_missing");
  }
  if ((cachedExecutionSection.match(/error: "connector_result_binding_mismatch"/g) || []).length !== 3) {
    failures.push("connector_cached_result_all_reuse_paths_fail_closed_missing");
  }
  const cachedBindingSection = sourceSection(
    "webPrivateAccountRouteLib",
    "export function connectorExecutionCachedResultBindingValid(",
    "async function recordRejectedFundingImport(",
  );
  for (const [value, code] of [
    ["input.result_record.owner_commitment === input.owner_commitment", "connector_cached_result_owner_binding_missing"],
    ["input.result_record.work_order_commitment === input.work_order_record.work_order_commitment", "connector_cached_result_outer_work_order_binding_missing"],
    ["input.result_record.result.work_order_commitment === input.work_order_record.work_order_commitment", "connector_cached_result_inner_work_order_binding_missing"],
    ["input.result_record.platform_class === input.work_order_record.platform_class", "connector_cached_result_outer_platform_binding_missing"],
    ["input.result_record.result.platform_class === input.work_order_record.platform_class", "connector_cached_result_inner_platform_binding_missing"],
    ["Boolean(input.result_record.result.venue_id)", "connector_cached_result_non_null_venue_binding_missing"],
    ["input.result_record.result.venue_id === input.work_order_record.venue_id", "connector_cached_result_exact_venue_binding_missing"],
  ]) if (!cachedBindingSection.includes(value)) failures.push(code);
  requireText("webConnectorExecutionResultBindingTest", "accepts only the exact owner, work-order, platform, and venue binding", "connector_cached_result_binding_test_missing");
  requireText("webConnectorExecutionResultBindingTest", "rejects a mismatched %s", "connector_cached_result_tamper_matrix_test_missing");
  requireText("privateExecution", 'venue_id: "hyperliquid"', "worker_hyperliquid_response_venue_echo_missing");
  requireText("privateExecution", 'platform_class: "hyperliquid_style_market"', "worker_hyperliquid_response_platform_echo_missing");
  requireText("privateExecution", "work_order_commitment: input.body.work_order_commitment", "worker_response_work_order_echo_missing");
  requireText("serverTest", 'it("submits Hyperliquid orders through commitment and ciphertext ingress"', "worker_hyperliquid_response_binding_test_missing");
  requireText("webConnectorReconciliationTest", "fails closed before fetch for a legacy work order with no venue", "connector_legacy_reconcile_venue_test_missing");
  requireText("webConnectorReconciliationTest", "does not honor a local-test connector flag in production", "connector_production_local_test_test_missing");
  requireText("webConnectorReconciliationTest", "does not synthesize reconciliation for a local-test flag without test runtime evidence", "connector_synthetic_reconcile_exact_test_test_missing");
  const reconcileFromBodySection = sourceSection(
    "webPrivateAccountRouteLib",
    "export async function connectorReconcileFromBody(",
    "export async function connectorOperationsForOwner(",
  );
  if (!reconcileFromBodySection.includes("existingResult.owner_commitment !== owner.owner_commitment")) {
    failures.push("connector_existing_result_owner_binding_missing");
  }
  const existingResultBindingStart = reconcileFromBodySection.indexOf("if (\n    existingResult &&");
  const existingResultBindingEnd = reconcileFromBodySection.indexOf(
    "const manifestRecord =",
    existingResultBindingStart,
  );
  const existingResultBindingSection = existingResultBindingStart >= 0 && existingResultBindingEnd > existingResultBindingStart
    ? reconcileFromBodySection.slice(existingResultBindingStart, existingResultBindingEnd)
    : "";
  for (const [value, code] of [
    ["existingResult.work_order_commitment !== workOrderRecord.work_order_commitment", "connector_existing_result_record_work_order_binding_missing"],
    ["existingResult.result.work_order_commitment !== workOrderRecord.work_order_commitment", "connector_existing_result_embedded_work_order_binding_missing"],
    ["existingResult.platform_class !== workOrderRecord.platform_class", "connector_existing_result_record_platform_binding_missing"],
    ["existingResult.result.platform_class !== workOrderRecord.platform_class", "connector_existing_result_embedded_platform_binding_missing"],
    ["!existingResult.result.venue_id", "connector_existing_result_non_null_venue_binding_missing"],
    ["existingResult.result.venue_id !== workOrderRecord.venue_id", "connector_existing_result_exact_venue_binding_missing"],
    ['error: "connector_result_binding_mismatch"', "connector_existing_result_binding_failure_missing"],
  ]) {
    if (!existingResultBindingSection.includes(value)) failures.push(code);
  }
  requireText("webConnectorReconciliationBindingTest", "hides and rejects a cross-owner result", "connector_existing_result_owner_binding_test_missing");
  requireText("webConnectorReconciliationBindingTest", "record work order", "connector_existing_result_record_work_order_test_missing");
  requireText("webConnectorReconciliationBindingTest", "embedded work order", "connector_existing_result_embedded_work_order_test_missing");
  requireText("webConnectorReconciliationBindingTest", "record platform", "connector_existing_result_record_platform_test_missing");
  requireText("webConnectorReconciliationBindingTest", "embedded platform", "connector_existing_result_embedded_platform_test_missing");
  requireText("webConnectorReconciliationBindingTest", "legacy null venue", "connector_existing_result_non_null_venue_test_missing");
  requireText("webConnectorReconciliationBindingTest", "cross venue", "connector_existing_result_exact_venue_test_missing");

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
    requireText("shadow", `PERP_SHADOW_ADAPTERS.${venue}.margin_model`, `shadow_margin_model_registry_binding_missing:${venue}`);
    requireText("shadow", `PERP_SHADOW_ADAPTERS.${venue}.liquidation_model`, `shadow_liquidation_model_registry_binding_missing:${venue}`);
  }
  requireText("registry", "export const CARRY_EXECUTION_VENUES", "capability_registry_missing");
  requireText("registry", "export const CARRY_SHADOW_ASSETS", "carry_shadow_asset_registry_missing");
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
    '"carry_execution",\n  "no_submit_reconciliation",\n  "exact_quantity_recovery",\n  "credential_onboarding",',
    "carry_required_adapter_contract_missing",
  );
  for (const adapterId of [
    "hyperliquid_turnkey_onboarding_v1",
    "lighter_turnkey_change_pubkey_v1",
    "aster_v3_agent_onboarding_v1",
  ]) {
    requireText("registry", `adapter("${adapterId}", "implemented_unproven"`, `carry_credential_onboarding_adapter_missing:${adapterId}`);
  }
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
  const completionFillEvent = sourceSection(
    "coreMultiLeg",
    'if (event.type === "completion_fill") {',
    'if (event.type === "completion_failed") {',
  );
  requireSectionText(completionFillEvent, "const originalSubmissionStatus = leg.submission_status", "carry_partial_completion_submission_status_snapshot_missing");
  requireSectionText(completionFillEvent, "applyEntryFill(saga, leg, event.cumulative_filled_micro_usdc, nowMs, event)", "carry_partial_completion_fill_application_missing");
  requireSectionText(completionFillEvent, "leg.submission_status = originalSubmissionStatus", "carry_partial_completion_submission_status_preservation_missing");
  requireOrdered(completionFillEvent, "const originalSubmissionStatus", "applyEntryFill(saga,", "carry_partial_completion_snapshot_before_fill_missing");
  requireOrdered(completionFillEvent, "applyEntryFill(saga,", "leg.submission_status = originalSubmissionStatus", "carry_partial_completion_restore_after_fill_missing");
  requireText("coreMultiLegTest", 'assert.equal(saga.legs[1].submission_status, "failed")', "carry_partial_completion_submission_status_test_missing");
  requireText("multiLegOrchestrator", '"reconcile_before_cancel"', "carry_reconcile_before_cancel_missing");
  requireText("multiLegOrchestrator", '"reconcile_after_cancel"', "carry_reconcile_after_cancel_missing");
  requireText("multiLegOrchestratorTest", "recovers a crash after exact cancel without cancelling twice", "carry_cancel_ack_restart_test_missing");
  requireText("multiLegOrchestratorTest", "reconciles a terminal late fill before cancel and never cancels or resubmits it", "carry_late_fill_before_cancel_test_missing");
  requireText("multiLegOrchestrator", "settlePriorRecoveryExecutions", "carry_recovery_child_reconciliation_missing");
  requireText("multiLegOrchestrator", "applied_filled_micro_usdc", "carry_recovery_incremental_fill_accounting_missing");
  requireText("multiLegOrchestratorTest", "preserves exact base precision while reconciling a partial recovery child and residual unwind", "carry_partial_recovery_child_test_missing");
  requireCount("multiLegOrchestrator", "recoveryProofTargetsLeg(", 3, "carry_recovery_exact_target_gate_missing");
  requireText(
    "multiLegOrchestrator",
    "exactQuantityRecoveryAdapter(venueId) !== null",
    "carry_recovery_exact_target_registry_binding_missing",
  );
  forbidText(
    "multiLegOrchestrator",
    'new Set(["hyperliquid", "lighter", "aster"])',
    "carry_recovery_venue_registry_duplicated",
  );
  requireText("multiLegOrchestrator", "proof?.broadcast_performed === true", "carry_recovery_live_broadcast_gate_missing");
  requireText("multiLegOrchestratorTest", "target_client_order_matched: childReconcileAttempts > 1", "carry_recovery_exact_target_test_missing");
  requireText("multiLegOrchestratorTest", "reconciles a partial reduce-only completion for every ordered execution pair", "carry_partial_completion_pair_matrix_missing");
  requireCount("multiLegOrchestrator", "await verifyRecoveryOrderNoSubmit({", 2, "carry_recovery_exact_no_submit_gate_missing");
  requireText("multiLegOrchestrator", "receipt?.checks?.transaction_broadcast !== false", "carry_recovery_no_broadcast_proof_missing");
  requireText("multiLegOrchestrator", "shape.reduce_only !== true", "carry_recovery_reduce_only_proof_missing");
  requireText("multiLegOrchestrator", "receipt?.account_commitment !== expectedAccount", "carry_recovery_account_proof_missing");
  requireText("multiLegOrchestrator", "account_commitment: access.account_commitment || undefined", "carry_recovery_account_binding_missing");
  requireText("multiLegOrchestratorTest", "saga_recovery_no_submit_mismatch", "carry_recovery_no_submit_mismatch_test_missing");
  requireText("asterTest", "allows exact reconciliation of a durably recorded recovery child", "aster_recovery_child_authorization_test_missing");
  requireCount("privateExecution", "cached?.receipt && !readOnlyReconcile", 3, "carry_fresh_reconciliation_read_missing");
  requireText("asterTest", "refreshes read-only Aster reconciliation instead of replaying a stale cache", "carry_fresh_reconciliation_read_test_missing");
  requireText("webAccountSetup", "shouldResumeUnsignedTurnkeySetup", "carry_setup_session_recovery_missing");
  requireText("webAccountConnections", "carryNoSubmitVerificationHref", "carry_setup_no_submit_handoff_missing");
  requireText("webAccountSetup", "href={noSubmitReturnTo}", "carry_setup_no_submit_link_missing");
  requireText("webTradeWorkspace", 'carryNoSubmitQuery !== "no-submit"', "carry_terminal_no_submit_intent_missing");
  requireText("webTradeWorkspace", "const beginCarryNoSubmitRequest", "carry_terminal_no_submit_parent_start_missing");
  requireText("webTradeWorkspace", "onAutoRunNoSubmitStarted={beginCarryNoSubmitRequest}", "carry_terminal_no_submit_parent_binding_missing");
  requireText("webTradeWorkspace", "workspaceQueryRef.current = workspaceQuery", "carry_terminal_no_submit_latest_query_ref_missing");
  requireText("webTradeWorkspace", "new URLSearchParams(workspaceQueryRef.current)", "carry_terminal_no_submit_latest_query_resolution_missing");
  requireText("webTradeWorkspace", "Worker update required", "carry_terminal_runtime_mismatch_ui_missing");
  requireText("webTradeReadinessTest", "keeps deployment faults out of wallet onboarding", "carry_terminal_runtime_mismatch_test_missing");
  requireText("webCarryBuilder", "autoRunNoSubmitConsumedRef", "carry_terminal_no_submit_one_shot_missing");
  requireText(
    "webCarryBuilder",
    "autoRunNoSubmitConsumedRef.current = true;\n    onAutoRunNoSubmitStarted?.();\n    void runCheck(true)",
    "carry_terminal_no_submit_parent_start_order_missing",
  );
  requireText("webCarryBuilderTest", "resolves the setup handoff after exactly one no-submit request", "carry_terminal_no_submit_handoff_test_missing");
  requireText("webCarryBuilderTest", "keeps one no-submit request when the keyed terminal remounts in flight", "carry_terminal_no_submit_remount_test_missing");
  requireText("webTradeLifecycleTest", "resolves an in-flight carry handoff against the latest workspace query", "carry_terminal_no_submit_latest_query_test_missing");
  requireText("webCarryBuilderTest", "keeps an auth-expired handoff pending and never retries automatically", "carry_terminal_no_submit_auth_expiry_test_missing");
  requireText("webSetupAuthRecovery", "!input.usingTurnkeyOwner || input.authorizationProofCreated", "carry_setup_auth_proof_boundary_missing");
  requireText("webSetupAuthRecoveryTest", "reauthenticates an exact prepared action", "carry_setup_unsigned_recovery_test_missing");
  requireText("webSetupAuthRecoveryTest", "never reauthenticates as a substitute for reconciling", "carry_setup_authorization_reconciliation_test_missing");
  requireText("lighterActivationReadiness", "LIGHTER_ACTIVATION_READINESS_MAX_AGE_MS", "lighter_activation_freshness_gate_missing");
  requireText("lighterActivationReadiness", "responseOwner.toLowerCase() !== ownerAddress.toLowerCase()", "lighter_activation_owner_binding_missing");
  requireText("lighterActivationReadiness", "body.ready !== (lighterOwnerAccountReady && ethereumAssociationGasReady)", "lighter_activation_evidence_consistency_missing");
  requireText("lighterActivationReadinessTest", "rejects another owner and stale evidence", "lighter_activation_owner_freshness_test_missing");
  requireText("lighterActivationReadinessTest", "rejects flags or blockers that contradict", "lighter_activation_consistency_test_missing");
  requireText("lighterActivationReadinessTest", "never equates enough Ethereum gas with a verified Lighter owner account", "lighter_activation_owner_account_proof_test_missing");
  requireText("lighterActivationReadinessServer", "/api/v1/accountsByL1Address?l1_address=", "lighter_activation_owner_account_lookup_missing");
  requireText("lighterActivationReadinessServer", "selectLighterOwnerAccount", "lighter_activation_owner_account_binding_missing");
  requireText("lighterActivationReadinessServerTest", "fails closed when gas is funded but Lighter has no owner account", "lighter_activation_owner_account_server_test_missing");
  requireText("webAccountSetup", 'window.addEventListener("focus", refreshOnReturn)', "lighter_activation_return_refresh_missing");
  requireText("webAccountSetup", "lighterReadinessRequestRef.current", "lighter_activation_refresh_dedupe_missing");
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
  requireText("webCredentialOnboarding", 'venueAdapterCapability(venueId, "credential_onboarding")', "carry_onboarding_capability_registry_missing");
  requireText("webCredentialOnboarding", "CARRY_EXECUTION_VENUES.map", "carry_onboarding_registry_iteration_missing");
  requireText("webCredentialOnboarding", "fund_movement_authorized !== false", "carry_onboarding_fund_authority_registry_missing");
  requireText("webCredentialOnboarding", "trade_submission_authorized !== false", "carry_onboarding_trade_authority_registry_missing");
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
  requireText("webEnvExample", "PRIVATE_AGENT_CARRY_SHADOW_FETCH_TIMEOUT_MS=4000", "carry_shadow_timeout_policy_example_missing");
  requireText("webCarryBuilder", "const auth = useThumperAuth();", "carry_private_poll_auth_boundary_missing");
  requireText("webCarryBuilder", "const privateSessionReady = auth.authenticated && !auth.loading;", "carry_private_poll_auth_gate_missing");
  requireText("webCarryBuilderTest", "does not poll private Carry state before Ghola authentication", "carry_private_poll_auth_test_missing");
  requireText("webTradeWorkspace", "const canPollPrivateLiveTradingStatus = auth.authenticated && !auth.loading;", "trade_private_status_poll_auth_gate_missing");
  requireText("webTradeWorkspace", "if (!canPollPrivateLiveTradingStatus) return;", "trade_private_status_poll_effect_gate_missing");
  requireText("webTradeWorkspace", "[canPollPrivateLiveTradingStatus]", "trade_private_status_poll_auth_refresh_missing");

  requireText("shadow", "CORE_PERP_VENUES.map", "shadow_registry_iteration_missing");
  requireText("shadow", "assets = CARRY_SHADOW_ASSETS", "shadow_asset_registry_binding_missing");
  forbidText("shadow", 'assets = ["BTC", "ETH", "SOL"]', "shadow_asset_policy_duplicated");
  requireText("registry", "export function normalizeCarryShadowAssets", "carry_shadow_asset_normalizer_missing");
  requireText("registryTest", "Carry shadow asset selections are canonical and registry-bound", "carry_shadow_asset_normalizer_test_missing");
  requireText("coreIndex", "normalizeCarryShadowAssets", "carry_shadow_asset_normalizer_export_missing");
  requireText("server", "normalizeCarryShadowAssets(url.searchParams.get(\"assets\"), { default_to_all: true })", "carry_shadow_worker_asset_policy_missing");
  requireText("server", 'error: "carry_shadow_assets_invalid"', "carry_shadow_worker_invalid_asset_gate_missing");
  requireText("webRoute", "normalizeCarryShadowAssets(req.nextUrl.searchParams.get(\"assets\"), { default_to_all: true })", "carry_shadow_gateway_asset_policy_missing");
  requireText("webCarryChart", 'CARRY_SHADOW_ASSETS.join(",")', "carry_shadow_ui_asset_policy_missing");
  requireText("phalaConfig", 'CARRY_SHADOW_ASSETS.join(",")', "carry_shadow_runtime_asset_policy_missing");
  requireText("webPrivateAccount", "[...CARRY_SHADOW_ASSETS]", "private_account_perp_asset_policy_missing");
  forbidText("server", '"BTC,ETH,SOL"', "carry_shadow_worker_asset_policy_duplicated");
  forbidText("webRoute", '"BTC,ETH,SOL"', "carry_shadow_gateway_asset_policy_duplicated");
  forbidText("webCarryChart", 'assets=BTC,ETH,SOL', "carry_shadow_ui_asset_policy_duplicated");
  forbidText("phalaConfig", '"BTC,ETH,SOL"', "carry_shadow_runtime_asset_policy_duplicated");
  requireText("shadow", "SUPPORTED_EXECUTION_VENUES.flatMap", "shadow_capability_registry_missing");
  requireText("shadow", 'venueAdapterCapability(venueId, "perp_shadow")', "shadow_capability_lookup_missing");
  requireText("shadow", "shadow_adapter_unimplemented", "shadow_unknown_adapter_fail_closed_missing");
  forbidText("shadow", "hyperliquid: Object.freeze", "shadow_capability_registry_duplicated");
  requireText("shadow", "fetchPerpShadowVenue({ ...options, venue_id: venueId, timeout_ms: venueTimeoutMs })", "carry_shadow_end_to_end_venue_deadline_missing");
  requireText("shadow", "export function carryShadowFetchTimeoutMs", "carry_shadow_timeout_policy_missing");
  requireText("server", "timeout_ms: carryShadowFetchTimeoutMs(process.env)", "carry_shadow_http_timeout_policy_missing");
  requireText("fundingPersistence", "timeout_ms: carryShadowFetchTimeoutMs(env)", "carry_shadow_observer_timeout_policy_missing");
  requireText("fundingPersistence", "assets = CARRY_SHADOW_ASSETS", "carry_shadow_observer_asset_registry_missing");
  requireText("fundingPersistence", 'CARRY_SHADOW_ASSETS.join(",")', "carry_shadow_observer_env_default_registry_missing");
  forbidText("fundingPersistence", 'Object.freeze(["BTC", "ETH", "SOL"])', "carry_shadow_observer_asset_policy_duplicated");
  requireText("shadowTest", "caps each five-venue shadow adapter by one end-to-end deadline", "carry_shadow_end_to_end_venue_deadline_test_missing");
  requireText("shadow", "max_age_ms", "shadow_staleness_gate_missing");
  requireText("shadow", "observedAtMs", "edgex_response_freshness_missing");
  requireText("shadow", "funding_source_stale", "edgex_funding_source_staleness_gate_missing");
  requireText("shadowTest", "keeps fresh edgeX responses live without trusting a stale funding source", "edgex_split_freshness_test_missing");
  requireText("shadowTest", "quarantines every core venue when provider timing evidence is missing", "carry_shadow_provider_timestamp_test_missing");
  requireText("shadow", "wss://mainnet.zklighter.elliot.ai/stream?readonly=true", "lighter_read_only_websocket_missing");
  requireText("shadow", 'channel: "market_stats/all"', "lighter_timestamped_market_feed_missing");
  requireText("shadow", 'channel: `order_book/${marketId}`', "lighter_timestamped_orderbook_feed_missing");
  requireText("shadow", '["subscribed/order_book", "update/order_book"].includes(message?.type)', "lighter_documented_orderbook_frame_gate_missing");
  requireText("shadow", "Array.isArray(message.order_book.bids)", "lighter_complete_orderbook_bid_gate_missing");
  requireText("shadow", "Array.isArray(message.order_book.asks)", "lighter_complete_orderbook_ask_gate_missing");
  requireText("shadow", "!orderBooks.has(orderBookMatch[1])", "lighter_initial_orderbook_snapshot_gate_missing");
  requireText("shadowTest", "fails closed when a Lighter update stream never proves every requested book", "lighter_incomplete_orderbook_stream_test_missing");
  requireText("shadow", "Math.max(startedAtMs, completedAtMs)", "shadow_completed_observation_clock_missing");
  requireText("shadowTest", "fetches Lighter market, funding, and book timing from its public read-only WebSocket", "lighter_provider_timestamp_test_missing");
  forbidText("shadow", "market: nowMs", "carry_shadow_market_worker_clock_fallback_forbidden");
  forbidText("shadow", "funding: nowMs", "carry_shadow_funding_worker_clock_fallback_forbidden");
  requireText("registry", 'source_schema: "hyperliquid_metaAndAssetCtxs_l2Book_v2"', "hyperliquid_shadow_schema_v2_missing");
  requireText("registryTest", '"hyperliquid_metaAndAssetCtxs_l2Book_v2"', "hyperliquid_shadow_schema_v2_test_missing");
  const hyperliquidFetch = sourceSection(
    "shadow",
    'if (adapterId === "hyperliquid_shadow_v1") {',
    'if (adapterId === "lighter_shadow_v1") {',
  );
  requireSectionText(hyperliquidFetch, "const contextObservation = await jsonObservedRequest(", "hyperliquid_context_observed_request_missing");
  requireSectionText(hyperliquidFetch, 'body: JSON.stringify({ type: "metaAndAssetCtxs" })', "hyperliquid_context_observed_meta_request_missing");
  requireSectionText(hyperliquidFetch, "const body = contextObservation.body;", "hyperliquid_context_observed_body_binding_missing");
  requireSectionText(hyperliquidFetch, "context_observed_at_ms: contextObservation.observed_at_ms", "hyperliquid_context_observed_time_binding_missing");
  forbidSectionText(hyperliquidFetch, "const body = await jsonRequest(", "hyperliquid_context_unobserved_request_present");
  requireOrdered(
    hyperliquidFetch,
    "const contextObservation = await jsonObservedRequest(",
    "context_observed_at_ms: contextObservation.observed_at_ms",
    "hyperliquid_context_observation_order_missing",
  );
  const hyperliquidParser = sourceSection(
    "shadow",
    "export function parseHyperliquidShadow({",
    "export function parseLighterShadow({",
  );
  requireSectionText(hyperliquidParser, "context_observed_at_ms: contextObservedAtMs", "hyperliquid_context_parser_input_missing");
  requireSectionText(hyperliquidParser, "const contextSourceAtMs = timestamp(contextObservedAtMs) || null;", "hyperliquid_context_source_timestamp_missing");
  requireSectionText(hyperliquidParser, "const bookObservedAtMs = timestamp(book.time) || null;", "hyperliquid_orderbook_source_timestamp_missing");
  requireSectionText(hyperliquidParser, "as_of_ms: completeSourceTimestamp([", "hyperliquid_complete_source_timestamp_missing");
  requireSectionText(hyperliquidParser, "contextSourceAtMs,\n        bookObservedAtMs,", "hyperliquid_complete_source_inputs_missing");
  requireSectionText(hyperliquidParser, "market: contextSourceAtMs", "hyperliquid_market_context_time_missing");
  requireSectionText(hyperliquidParser, "funding: contextSourceAtMs", "hyperliquid_funding_context_time_missing");
  requireSectionText(hyperliquidParser, "orderbook: bookObservedAtMs", "hyperliquid_orderbook_book_time_missing");
  forbidSectionText(hyperliquidParser, "market: bookObservedAtMs", "hyperliquid_market_book_time_present");
  forbidSectionText(hyperliquidParser, "funding: bookObservedAtMs", "hyperliquid_funding_book_time_present");
  const completeTimestampHelper = sourceSection("shadow", "function completeSourceTimestamp(values) {", "function completedObservationTime(");
  requireSectionText(completeTimestampHelper, "values.every((value) => Number.isSafeInteger(value) && value > 0)", "carry_shadow_complete_source_validation_missing");
  requireSectionText(completeTimestampHelper, "return Math.min(...values);", "carry_shadow_oldest_complete_source_missing");
  requireText("shadowTest", "keeps Hyperliquid context freshness independent from an advancing L2 book", "hyperliquid_split_source_freshness_test_missing");
  requireText("shadowTest", "binds fetched Hyperliquid market and funding to the context response, not L2 time", "hyperliquid_context_response_binding_test_missing");
  requireText("shadow", "liquidation_has_no_clearance_fee", "hyperliquid_liquidation_fee_evidence_gate_missing");
  requireText("shadow", "fees_venue_base_tier_ceiling", "hyperliquid_base_fee_provenance_missing");
  requireText("shadow", "minimum_notional_protocol_floor", "hyperliquid_minimum_notional_provenance_missing");
  requireText("shadowTest", "normalizes Hyperliquid public base economics conservatively", "hyperliquid_public_economics_test_missing");
  requireText("stablecoinConversion", "products/USDT-USDC/book?level=2", "cashflow_usdt_liquid_book_missing");
  requireText("stablecoinConversion", "products/USDT-USD/book?level=2", "cashflow_usd_cross_book_missing");
  forbidText("stablecoinConversion", "products/USDC-USD/book?level=2", "cashflow_dead_usdc_usd_book_restored");
  requireText("shadow", "createCoinbaseUsdtCashflowValuationReader", "shadow_usdt_valuation_source_missing");
  requireText("aster", "createCoinbaseUsdtCashflowValuationReader", "aster_funding_valuation_source_missing");
  requireText("stablecoinConversionTest", "values bound USDT cashflows from fresh liquid Coinbase depth", "cashflow_usdt_depth_test_missing");
  requireText("stablecoinConversionTest", "values bound USD cashflows through two fresh Coinbase books", "cashflow_usd_cross_depth_test_missing");
  requireText("stablecoinConversion", "export function verifyCashflowValuationEvidence", "cashflow_valuation_replay_verifier_missing");
  requireText("stablecoinConversion", "cashflow_valuation_evidence_rate_mismatch", "cashflow_valuation_depth_replay_missing");
  requireText("stablecoinConversion", "coinbaseBoundValueMicroUsdc", "cashflow_valuation_exact_bound_value_missing");
  requireText("coreCarry", "return normalizedValuation.bound_value_micro_usdc;", "cashflow_valuation_exact_bound_conversion_missing");
  requireText("executor", "verifyCashflowValuationEvidence(row)", "carry_execution_valuation_replay_missing");
  requireText("positions", "verifyCashflowValuationEvidence(raw)", "carry_funding_valuation_replay_missing");
  requireText("stablecoinConversionTest", "rejects self-consistent fabricated rates", "cashflow_valuation_fabrication_test_missing");
  requireText("shadow", "fees_venue_base_schedule", "aster_base_fee_provenance_missing");
  requireText("shadowTest", "keeps unsupported Aster quote fee schedules degraded", "aster_unknown_fee_schedule_test_missing");
  requireText("shadow", "fees_chain_parameter_ceiling", "dydx_chain_fee_provenance_missing");
  requireText("shadow", "fees_chain_source_consensus", "dydx_chain_fee_consensus_missing");
  requireText("shadow", "minimum_notional_market_step", "dydx_minimum_notional_provenance_missing");
  requireText("shadow", "liquidation_fee_protocol_default", "dydx_liquidation_fee_provenance_missing");
  requireText("shadow", "jsonObservedRequest(", "dydx_observed_response_read_missing");
  requireText("shadow", "httpObservationTime(response)", "dydx_response_timestamp_binding_missing");
  requireText("shadow", "orderbook_observed_at_ms_by_market", "dydx_orderbook_timestamp_binding_missing");
  requireText("shadow", "market_funding_bound_to_indexer_response_time", "dydx_market_funding_timestamp_evidence_missing");
  requireText("shadow", "orderbook_bound_to_indexer_response_time", "dydx_orderbook_timestamp_evidence_missing");
  forbidText("shadow", '"/v4/time"', "dydx_server_clock_freshness_forbidden");
  requireText("shadowTest", "keeps dYdX degraded when its live chain fee parameters are unavailable", "dydx_missing_chain_fee_gate_test_missing");
  requireText("shadowTest", "degrades dYdX instead of choosing between conflicting chain fee sources", "dydx_chain_fee_conflict_gate_test_missing");
  requireText("shadowTest", "a fresh dYdX server clock cannot refresh detached payloads", "dydx_detached_server_clock_test_missing");
  requireText("workerPackage", '"verify:carry-shadow"', "carry_shadow_verifier_script_missing");
  requireText("workerPackage", '"verify:carry-shadow-witness"', "carry_shadow_witness_verifier_script_missing");
  requireText("shadowVerifierCli", "verifyCarryShadowSet", "carry_shadow_verifier_cli_runtime_missing");
  requireText("shadowVerifierCli", "verifyCarryShadowSoak(sampleResults", "carry_shadow_soak_cli_missing");
  requireText("shadowVerifierCli", "GHOLA_CARRY_SHADOW_SAMPLES", "carry_shadow_soak_sample_control_missing");
  requireText("shadowVerifierCli", "GHOLA_CARRY_SHADOW_MINIMUM_SPAN_MS", "carry_shadow_soak_duration_control_missing");
  requireText("shadowVerifierCli", "sampleCount > 1 ?", "carry_shadow_single_sample_delay_guard_missing");
  requireCount("shadowVerifierCli", "minimum_span_ms: minimumSpanMs", 2, "carry_shadow_soak_duration_gate_missing");
  requireText("shadowVerifierCli", "GHOLA_CARRY_SHADOW_WITNESS_PATH", "carry_shadow_witness_output_missing");
  requireText("shadowVerifierCli", "buildCarryShadowDevelopmentWitness", "carry_shadow_witness_builder_missing");
  requireText("shadowDevelopmentWitness", 'scope: "public_market_data_only"', "carry_shadow_witness_scope_missing");
  requireText("shadowDevelopmentWitness", "release_bound: false", "carry_shadow_witness_release_boundary_missing");
  requireText("shadowDevelopmentWitness", "ready_for_execution: false", "carry_shadow_witness_execution_boundary_missing");
  requireText("shadowDevelopmentWitness", "verifyCarryShadowSoak", "carry_shadow_witness_reverification_missing");
  requireText("shadowDevelopmentWitness", "witness_commitment", "carry_shadow_witness_commitment_missing");
  requireText("shadowWitnessVerifierCli", "verifyCarryShadowDevelopmentWitness", "carry_shadow_witness_independent_verifier_missing");
  requireText("shadowWitnessVerifierCli", "source_revision: sourceTree.source_revision", "carry_shadow_witness_revision_verifier_missing");
  requireText("shadowDevelopmentWitnessTest", "without claiming execution readiness", "carry_shadow_witness_boundary_test_missing");
  requireText("shadowDevelopmentWitnessTest", "rejects tampering and any attempt to promote", "carry_shadow_witness_tamper_test_missing");
  requireText("shadowVerifier", "CORE_PERP_VENUES", "carry_shadow_verifier_registry_missing");
  requireText("shadowVerifier", "DEFAULT_CARRY_SHADOW_ASSETS = CARRY_SHADOW_ASSETS", "carry_shadow_core_assets_missing");
  forbidText("shadowVerifier", 'Object.freeze(["BTC", "ETH", "SOL"])', "carry_shadow_verifier_asset_policy_duplicated");
  requireText("shadowVerifier", "missing_field_unjustified", "carry_shadow_missing_field_evidence_gate_missing");
  requireText("shadowVerifier", "snapshot.margin_model !== declared?.margin_model", "carry_shadow_margin_model_registry_gate_missing");
  requireText("shadowVerifier", "snapshot.liquidation_model !== declared?.liquidation_model", "carry_shadow_liquidation_model_registry_gate_missing");
  requireText("shadowVerifierTest", "rejects margin or liquidation models detached from the venue registry", "carry_shadow_risk_model_registry_test_missing");
  requireText("shadowVerifier", "export function verifyCarryShadowSoak", "carry_shadow_soak_verifier_missing");
  requireText("shadowVerifier", "shadow_soak_sample_failed", "carry_shadow_soak_intermittent_failure_gate_missing");
  requireText("shadowVerifier", "snapshot_evidence", "carry_shadow_snapshot_evidence_missing");
  requireText("shadowVerifier", "shadow_soak_sample_commitment_invalid", "carry_shadow_sample_commitment_gate_missing");
  requireText("shadowVerifier", "source_observation_commitment", "carry_shadow_source_observation_commitment_missing");
  requireText("shadowVerifier", "shadow_soak_source_observation_commitments_reused", "carry_shadow_source_observation_reuse_gate_missing");
  requireText("shadowVerifier", "else if (currentTimestamp === previousTimestamp)", "carry_shadow_source_equality_reuse_gate_missing");
  requireText("shadowVerifier", "shadow_soak_source_observation_reused:${sampleIndex}:${identity}:${source}", "carry_shadow_source_specific_reuse_evidence_missing");
  requireText("shadowVerifier", "shadow_soak_duration_insufficient", "carry_shadow_duration_floor_missing");
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
  requireText("shadowVerifierTest", "rejects frozen Hyperliquid context even while every L2 book advances", "hyperliquid_frozen_context_adversarial_test_missing");
  requireText("shadowVerifierTest", "rejects a venue source timestamp that regresses between samples", "carry_shadow_source_observation_regression_test_missing");
  requireText("shadowVerifierTest", "rejects rapid fresh samples that do not meet the durable observation span", "carry_shadow_duration_floor_test_missing");
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
  requireText("preflight", "selected_pair:", "carry_matrix_selected_pair_proof_missing");
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
  requireText("liquidationDistance", "export function hyperliquidLiquidationDistance", "hyperliquid_liquidation_distance_reader_missing");
  requireText("liquidationDistance", "export function lighterLiquidationDistance", "lighter_liquidation_distance_reader_missing");
  requireText("liquidationDistance", "export function asterLiquidationDistance", "aster_liquidation_distance_reader_missing");
  requireText("liquidationDistance", "export const LIQUIDATION_DISTANCE_SOURCES = Object.freeze", "liquidation_distance_source_registry_missing");
  requireText("liquidationDistance", "export function validVenueLiquidationBinding", "liquidation_distance_venue_binding_missing");
  requireText("liquidationDistance", 'venueAdapterCapability(String(venueId || ""), "carry_execution")?.liquidation_distance_source', "liquidation_distance_registry_derivation_missing");
  requireText("registry", "hyperliquid_clearinghouse_state_asset_positions_v1", "hyperliquid_liquidation_provenance_missing");
  requireText("registry", "lighter_account_positions_position_value_v1", "lighter_liquidation_provenance_missing");
  requireText("registry", "aster_fapi_v3_position_risk_v1", "aster_liquidation_provenance_missing");
  requireText("hyperliquid", "hyperliquidLiquidationDistance(state)", "hyperliquid_liquidation_reader_binding_missing");
  requireText("lighter", "lighterLiquidationDistance(account)", "lighter_liquidation_reader_binding_missing");
  requireText("lighter", "accountStatus === LIGHTER_ACCOUNT_STATUS_ACTIVE", "lighter_account_status_readiness_gate_missing");
  requireText("lighter", "availableBalance < 0", "lighter_negative_balance_gate_missing");
  requireText("lighter", "availableBalance > marginBalance", "lighter_inconsistent_balance_gate_missing");
  requireText("lighter", "expectedAccountIndex", "lighter_account_index_binding_missing");
  requireText("lighter", "sanitizeAccount(result.account, {}, { expectedAccountIndex: credential.account_index })", "lighter_credential_account_binding_missing");
  requireText("lighter", "margin_state_checked: account.margin_state_verified", "lighter_optional_margin_truthfulness_missing");
  requireText("aster", "asterLiquidationDistance(positions)", "aster_liquidation_reader_binding_missing");
  requireText("liquidationDistanceTest", "Hyperliquid flat is explicit and malformed open evidence fails closed", "hyperliquid_liquidation_fail_closed_test_missing");
  requireText("liquidationDistanceTest", "Lighter flat is explicit and never defaults malformed positions", "lighter_liquidation_fail_closed_test_missing");
  requireText("lighterTest", "derives Lighter trade readiness only from a bound active account response", "lighter_account_readiness_test_missing");
  requireText("lighterTest", "pinnedShape.checks.margin_state_checked", "lighter_pinned_account_shape_test_missing");
  requireText("lighterTest", 'total_asset_value: "-1"', "lighter_negative_balance_test_missing");
  requireText("lighterTest", "assert.equal(inactive.can_trade, false)", "lighter_credential_inactive_test_missing");
  requireText("liquidationDistanceTest", "Aster flat is explicit and malformed open evidence fails closed", "aster_liquidation_fail_closed_test_missing");
  requireText("preflight", "validVenueLiquidationBinding(value, value.position_count)", "carry_preflight_liquidation_binding_missing");
  requireText("preflight", "validVenueLiquidationBinding({ ...account, venue_id: venueId }, 1)", "carry_monitoring_liquidation_provenance_missing");
  requireText("readiness", "validVenueLiquidationBinding(value, positionCount)", "carry_readiness_liquidation_binding_missing");
  requireText("readiness", "validVenueLiquidationBinding(account, positionCount)", "carry_capital_plan_liquidation_validation_missing");
  requireText("readiness", "account?.liquidation_distance_bps === leg?.account_state?.liquidation_distance_bps", "carry_capital_plan_liquidation_binding_missing");
  requireText("readiness", 'return `carry:account-state:${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 40)}`;', "carry_account_state_commitment_width_missing");
  requireText("readinessTest", "binds verified liquidation provenance into no-submit account-state commitments", "carry_readiness_liquidation_commitment_test_missing");
  requireText("readinessTest", "rejects capital-plan liquidation evidence detached from committed venue account state", "carry_capital_plan_liquidation_binding_test_missing");
  requireText("releaseMaterial", "liquidation_distance_source: capitalByVenue.get(venueId)?.liquidation_distance_source ?? null", "carry_release_liquidation_provenance_missing");
  requireText("releaseMaterialTest", "binds liquidation evidence through release material commitment", "carry_release_liquidation_commitment_test_missing");
  requireText("positions", "account_state_evidence: accountStateEvidence", "carry_monitor_account_state_persistence_missing");
  requireText("positions", "validatedMonitoringAccountStateEvidence({", "carry_monitor_account_state_validation_missing");
  requireText("positions", "row.account_state_commitment !== carryAccountStateCommitment(row)", "carry_monitor_account_state_recomputation_missing");
  requireText("positionsTest", "monitoring durably preserves only self-contained account-state evidence bound to its capital plan", "carry_monitor_account_state_persistence_test_missing");
  requireText("positionsTest", "monitoring fails closed before persisting unbound account-state evidence", "carry_monitor_account_state_fail_closed_test_missing");
  requireText("releaseMaterial", "releaseMarginRunways({", "carry_release_live_runway_material_missing");
  requireText("releaseMaterial", "state.account_state_commitment !== carryAccountStateCommitment(state)", "carry_release_account_state_recomputation_missing");
  requireText("releaseMaterial", "liquidationDistanceSourceForVenue(venueId)", "carry_release_canonical_liquidation_source_missing");
  requireText("releaseMaterialTest", "refuses release evidence without raw live account-state lineage", "carry_release_account_state_lineage_test_missing");
  requireText("releaseMaterialTest", "refuses swapped venue liquidation sources even when commitments are recomputed", "carry_release_liquidation_source_test_missing");
  requireText("releaseMaterialTest", "refuses detached account-state and capital-plan evidence", "carry_release_account_state_detachment_test_missing");
  requireText("evidenceVerifier", "CARRY_LIQUIDATION_SOURCES", "carry_release_liquidation_source_verifier_missing");
  requireText("evidenceVerifier", "carryAccountStateCommitment({", "carry_release_account_state_recomputation_missing");
  requireText("evidenceVerifier", "margin_runway_open_position_unproven", "carry_release_open_position_verifier_missing");
  requireText("evidenceVerifier", "margin_runway_liquidation_binding_invalid", "carry_release_live_liquidation_verifier_missing");
  requireText("evidenceVerifierTest", "rejects detached or unverifiable live liquidation evidence", "carry_release_live_liquidation_verifier_test_missing");
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
  requireText("preflight", "input_evidence: creationInputEvidence(evidence, accountReadiness)", "carry_creation_input_evidence_missing");
  requireText("preflight", "carryShadowSnapshotCommitment(leg.snapshot)", "carry_creation_shadow_commitment_missing");
  requireText("preflight", "account_state_commitment: accountReadiness[index].account_state_commitment", "carry_creation_account_state_commitment_missing");
  requireText("positions", "validateCarryCreationInputEvidence(positionInput, opportunity.input_evidence)", "carry_creation_input_evidence_gate_missing");
  requireText("positions", "leg?.margin_model !== declared?.margin_model", "carry_creation_margin_model_gate_missing");
  requireText("positions", "leg?.liquidation_model !== declared?.liquidation_model", "carry_creation_liquidation_model_gate_missing");
  requireText("positionsTest", "refuses a worker-signed opportunity detached from its exact route inputs", "carry_creation_input_evidence_test_missing");
  requireText("releaseMaterial", "creation_input_evidence: creationInputEvidence.evidence", "carry_release_creation_input_evidence_missing");
  requireText("releaseMaterial", "validateCarryCreationInputEvidence(position, inputEvidence)", "carry_release_creation_input_gate_missing");
  requireText("releaseMaterialTest", "result.material.creation_input_evidence.verified", "carry_release_creation_input_test_missing");
  requireText("evidenceVerifier", "carryCreationInputEvidenceCommitment(creationInputs)", "carry_release_creation_commitment_gate_missing");
  requireText("evidenceVerifier", "leg.account_commitment === readinessVenue?.account_commitment", "carry_release_creation_account_binding_missing");
  requireText("evidenceVerifierTest", "rejects creation evidence detached from its exact venue risk and account inputs", "carry_release_creation_input_verifier_test_missing");
  requireText("releaseMaterial", "creation_input_evidence_commitment: material.creation_input_evidence.evidence_commitment", "carry_lifecycle_creation_input_commitment_missing");
  requireText("releaseMaterial", "/^carry:creation-inputs:[0-9a-f]{64}$/", "carry_lifecycle_creation_input_gate_missing");
  requireText("privatePrimeReadiness", "proof?.creation_input_evidence_commitment", "carry_private_prime_creation_input_gate_missing");
  requireText("privatePrimeReadiness", "creation_input_evidence_commitment: verified ? proof.creation_input_evidence_commitment : null", "carry_private_prime_creation_input_output_missing");
  requireText("privatePrimeReadinessTest", "without exact creation-input lineage", "carry_private_prime_creation_input_test_missing");
  requireText("webPrivatePrimeReadiness", "pairedLifecycle.creation_input_evidence_commitment", "carry_private_prime_ui_creation_input_gate_missing");
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
  requireText("depositQuote", 'venueAdapterCapability(venueId, "collateral_route_observer")', "carry_deposit_capability_registry_missing");
  requireText("depositQuote", "registeredCarryDepositQuoteAdapterId(venueId)", "carry_deposit_registry_dispatch_missing");
  forbidText("depositQuote", 'venueId === "hyperliquid"', "carry_deposit_venue_policy_duplicated");
  requireText("depositQuote", "eth_getCode", "carry_deposit_hyperliquid_bridge_probe_missing");
  requireText("depositQuote", "eth_gasPrice", "carry_deposit_live_gas_probe_missing");
  requireText("depositQuote", "ETHUSDT", "carry_deposit_live_gas_valuation_missing");
  requireText("depositQuote", "api/v1/deposit/networks", "carry_deposit_lighter_network_probe_missing");
  requireText("depositQuote", "deposit/assets?chainIds=42161", "carry_deposit_aster_assets_probe_missing");
  requireText("depositQuoteTest", "verifies Hyperliquid and Lighter Arbitrum deposit routes without submitting", "carry_deposit_live_test_missing");
  requireText("depositQuoteTest", "derives every executable Carry deposit observer from the capability registry", "carry_deposit_registry_test_missing");
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
  requireText("coreCarry", "export function carryPortfolioValueAuthenticationMessage", "carry_portfolio_value_auth_message_missing");
  requireText("coreCarry", 'funding_valuation_basis: "usdc_equivalent_at_ledger_ingestion"', "carry_portfolio_value_fx_basis_missing");
  requireText("coreCarry", "carry_portfolio_value_ledger_replay_mismatch", "carry_portfolio_value_ledger_replay_missing");
  requireText("coreCarry", "carry_portfolio_value_processed_claim_ids_mismatch", "carry_portfolio_value_claim_replay_missing");
  forbidText("positions", 'funding_valuation_basis: "usdc_equivalent_at_ledger_ingestion"', "carry_portfolio_value_fx_basis_wrapper_forbidden");
  requireText("positionsTest", 'value.report.value_proof_status, "accruing"', "carry_portfolio_value_worker_test_missing");
  requireText("server", '"/carry/positions/value-report"', "carry_portfolio_value_route_missing");
  requireText("server", "worker_authentication: authenticateCarryPortfolioValueReport({", "carry_portfolio_value_worker_response_binding_missing");
  requireText("portfolioValueAuthentication", "report_replay_bound: true", "carry_portfolio_value_worker_attestation_missing");
  requireText("portfolioValueAuthentication", "portfolioValueReportCommitment(report)", "carry_portfolio_value_worker_report_binding_missing");
  requireText("portfolioValueAuthenticationTest", "attests the exact replayed portfolio report and owner-scoped request", "carry_portfolio_value_authentication_test_missing");
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
  requireText("webRoute", "verifyCarryPortfolioValueWorkerAuthentication({", "carry_portfolio_value_web_verification_missing");
  requireText("webPortfolioValueAuthentication", "carry:portfolio-value-report:", "carry_portfolio_value_web_report_binding_missing");
  requireText("webPortfolioValueAuthentication", "GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64", "carry_portfolio_value_web_signer_pin_missing");
  requireText("webPortfolioValueAuthentication", "ed25519.verify(", "carry_portfolio_value_web_signature_missing");
  requireText("webPortfolioValueAuthenticationTest", "accepts only the exact fresh report and owner-scoped request signed by the pinned worker", "carry_portfolio_value_web_authentication_test_missing");
  requireText("webCarryBuilder", "PORTFOLIO VALUE ·", "carry_terminal_portfolio_value_missing");
  requireText("webCarryBuilder", 'report.funding_valuation_basis !== "usdc_equivalent_at_ledger_ingestion"', "carry_terminal_portfolio_fx_basis_gate_missing");
  requireText("webCarryBuilder", "UNVERIFIED FX BASIS", "carry_terminal_portfolio_fx_basis_failure_missing");
  const portfolioValueSummary = sourceSection(
    "webCarryBuilder",
    "export function carryPortfolioValueSummary(",
    "export function carryCapitalEfficiencySummary(",
  );
  requireSectionText(portfolioValueSummary, "finiteNumber(report.authoritative_finalized_position_count)", "carry_terminal_portfolio_authoritative_count_missing");
  requireSectionText(portfolioValueSummary, 'const expectedStatus = finalized === positions ? "finalized" : finalized > 0 ? "mixed" : "accruing"', "carry_terminal_portfolio_exact_status_missing");
  const finalizedPortfolioValueSummary = sourceSection(
    "webCarryBuilder",
    "if (finalized > 0) {",
    "  if (report.value_proof_status !== expectedStatus) return null;",
  );
  requireSectionText(finalizedPortfolioValueSummary, "report.value_proof_status !== expectedStatus", "carry_terminal_portfolio_status_gate_missing");
  requireSectionText(finalizedPortfolioValueSummary, "authoritativeFinalized !== finalized", "carry_terminal_portfolio_authoritative_count_gate_missing");
  requireSectionText(finalizedPortfolioValueSummary, 'report.finalized_value_provenance !== "authoritative_exchange_fill_time"', "carry_terminal_portfolio_authoritative_provenance_gate_missing");
  requireSectionText(finalizedPortfolioValueSummary, "report.real_value_verified !== true", "carry_terminal_portfolio_real_value_gate_missing");
  requireSectionText(finalizedPortfolioValueSummary, "finalizedValues.complete !== true", "carry_terminal_portfolio_complete_value_gate_missing");
  requireSectionText(finalizedPortfolioValueSummary, 'return { value: "UNVERIFIED", tone: "bad" as const }', "carry_terminal_portfolio_unverified_fallback_missing");
  requireText("webCarryBuilder", "CAPITAL OFFSET ·", "carry_terminal_capital_efficiency_missing");
  requireText("webCarryBuilder", "STALE EVIDENCE · RECONCILE ONLY", "carry_terminal_portfolio_stale_gate_missing");
  requireText("webCarryBuilderTest", "PORTFOLIO CAPITAL · $15 REALLOCATE · $10 NEW CASH · OWNER ONLY", "carry_terminal_portfolio_capital_test_missing");
  requireText("webCarryBuilderTest", "PORTFOLIO CAPITAL · $12.5 RELEASABLE · OWNER ONLY", "carry_terminal_portfolio_optimization_test_missing");
  requireText("webCarryBuilderTest", "PORTFOLIO VALUE · $19.5 REAL · $10 OPEN MODEL · +$4.5 Δ · USDC @ BOOKED FX", "carry_terminal_portfolio_value_test_missing");
  requireText("webCarryBuilderTest", "does not label portfolio P&L real without its worker-bound FX basis", "carry_terminal_portfolio_fx_basis_test_missing");
  requireText("webCarryBuilderTest", "labels portfolio P&L real only when every finalized position has an authoritative boundary", "carry_terminal_portfolio_authoritative_test_missing");
  requireText("webCarryBuilderTest", 'finalized_value_provenance: "unverified_or_conservative"', "carry_terminal_portfolio_conservative_fixture_missing");
  requireText("webCarryBuilderTest", "real_value_verified: false", "carry_terminal_portfolio_unverified_fixture_missing");
  const portfolioValueCompiler = sourceSection(
    "coreCarry",
    "export function compileCarryPortfolioValueReport(",
    "export function evaluatePerpContractPairBasis(",
  );
  requireSectionText(portfolioValueCompiler, "finalized.filter((position) => position.value_boundary_authoritative === true)", "carry_portfolio_authoritative_finalized_filter_missing");
  requireSectionText(portfolioValueCompiler, 'authoritativeFinalized.length === finalized.length ? "finalized" : "finalized_unverified"', "carry_portfolio_finalized_status_provenance_missing");
  requireSectionText(portfolioValueCompiler, 'authoritativeFinalized.length === finalized.length ? "mixed" : "mixed_unverified"', "carry_portfolio_mixed_status_provenance_missing");
  requireSectionText(portfolioValueCompiler, "authoritative_finalized_position_count: authoritativeFinalized.length", "carry_portfolio_authoritative_count_output_missing");
  requireSectionText(portfolioValueCompiler, 'finalized_value_provenance: finalized.length > 0 && authoritativeFinalized.length === finalized.length', "carry_portfolio_authoritative_provenance_output_missing");
  requireSectionText(portfolioValueCompiler, ' ? "authoritative_exchange_fill_time"\n      : "unverified_or_conservative"', "carry_portfolio_provenance_value_missing");
  requireSectionText(portfolioValueCompiler, "real_value_verified: finalized.length > 0 && authoritativeFinalized.length === finalized.length", "carry_portfolio_real_value_verification_output_missing");
  requireSectionText(portfolioValueCompiler, "complete: finalized.length > 0 && authoritativeFinalized.length === finalized.length", "carry_portfolio_finalized_completeness_output_missing");
  const portfolioValuePosition = sourceSection(
    "coreCarry",
    "function normalizePortfolioValuePosition(",
    "function portfolioRealizedTotals(",
  );
  requireSectionText(portfolioValuePosition, "raw.value_boundary_authoritative === true", "carry_portfolio_position_authoritative_marker_missing");
  requireSectionText(portfolioValuePosition, 'raw.exposure_boundary_provenance === "authoritative_exchange_fill_time"', "carry_portfolio_position_authoritative_provenance_missing");
  requireSectionText(portfolioValuePosition, '(ledgerStatus === "finalized") !== (positionStatus === "reconciled")', "carry_portfolio_position_finalization_status_binding_missing");
  requireText("coreCarryTest", "portfolio value report separates finalized after-cost proof from accruing estimates", "carry_portfolio_authoritative_value_test_missing");
  requireText("coreCarryTest", "report.authoritative_finalized_position_count, 1", "carry_portfolio_authoritative_count_test_missing");
  requireText("coreCarryTest", 'report.finalized_value_provenance, "authoritative_exchange_fill_time"', "carry_portfolio_authoritative_provenance_test_missing");
  requireText("coreCarryTest", "report.real_value_verified, true", "carry_portfolio_real_value_test_missing");
  requireText("webCarryBuilderTest", "CAPITAL OFFSET · $15 NEW CASH AVOIDED · OWNER MOVE", "carry_terminal_capital_efficiency_test_missing");
  requireText("webCarryBuilder", "live_execution_leverage_unchanged !== true", "carry_terminal_stress_leverage_boundary_missing");
  requireText("webCarryBuilderTest", "UP TO 1× OWNER CONFIG", "carry_terminal_stress_capital_test_missing");
  requireText("webCarryBuilderTest", '$10 → LIGHTER · OWNER', "carry_terminal_capital_action_test_missing");
  requireText("webCarryBuilder", 'label="LEDGER"', "carry_terminal_value_ledger_missing");
  requireText("webCarryBuilder", 'label="EXEC Δ"', "carry_terminal_execution_attribution_missing");
  const terminalLedgerSummary = sourceSection(
    "webCarryBuilder",
    "function carryLedgerSummary(",
    "function formatRunway(",
  );
  requireSectionText(terminalLedgerSummary, 'ledger.status !== "finalized"', "carry_terminal_ledger_finalized_gate_missing");
  requireSectionText(terminalLedgerSummary, 'record?.position.status !== "reconciled"', "carry_terminal_ledger_reconciled_gate_missing");
  requireSectionText(terminalLedgerSummary, "record.value_boundary_authoritative !== true", "carry_terminal_ledger_authoritative_value_gate_missing");
  requireSectionText(terminalLedgerSummary, 'record.position.active_boundary_provenance !== "authoritative_exchange_fill_time"', "carry_terminal_ledger_authoritative_provenance_gate_missing");
  const terminalLedgerAuthoritativeGate = sourceSection(
    "webCarryBuilder",
    'if (record?.position.status !== "reconciled"',
    "  const realized = ledger.realized?.net_value_micro_usdc;",
  );
  requireSectionText(terminalLedgerAuthoritativeGate, 'return { value: "UNVERIFIED", execution: "UNVERIFIED", tone: "bad", executionTone: "bad" } as const;', "carry_terminal_ledger_unverified_fallback_missing");
  requireSectionText(terminalLedgerSummary, "Number.isSafeInteger(realized)", "carry_terminal_ledger_finite_realized_gate_missing");
  requireSectionText(terminalLedgerSummary, "Number.isSafeInteger(variance)", "carry_terminal_ledger_finite_variance_gate_missing");
  requireSectionText(terminalLedgerSummary, "REAL ·", "carry_terminal_ledger_real_value_missing");
  requireText("webCarryBuilderTest", "LEDGERUNVERIFIED", "carry_terminal_ledger_unverified_test_missing");
  requireText("webCarryBuilderTest", "EXEC ΔUNVERIFIED", "carry_terminal_execution_attribution_test_missing");
  requireText("webCarryBuilderTest", "labels a finalized ledger real only with authoritative exchange boundaries", "carry_terminal_ledger_authoritative_test_missing");
  requireText("webCarryBuilderTest", 'active_boundary_provenance: "authoritative_exchange_fill_time"', "carry_terminal_ledger_authoritative_fixture_missing");
  requireText("webCarryBuilderTest", 'active_boundary_provenance: "worker_observed_positive_fill_conservative"', "carry_terminal_ledger_conservative_fixture_missing");
  requireText("webCarryBuilderTest", "FEE +$0.5 · SLIP −$0.25", "carry_terminal_execution_attribution_verified_test_missing");
  const authoritativeStoredValueBoundary = sourceSection(
    "positions",
    "export function authoritativeStoredCarryValueBoundary(",
    "export async function runCarryMonitoringTick(",
  );
  requireSectionText(authoritativeStoredValueBoundary, 'record.value_ledger?.status === "finalized"', "carry_public_value_finalized_ledger_gate_missing");
  requireSectionText(authoritativeStoredValueBoundary, "venueIds.length === 2", "carry_public_value_two_venue_gate_missing");
  requireSectionText(authoritativeStoredValueBoundary, "Object.keys(value).length === venueIds.length", "carry_public_value_map_completeness_missing");
  requireSectionText(authoritativeStoredValueBoundary, "fundingBoundary[venueId] === positionBoundary[venueId]", "carry_public_value_funding_boundary_binding_missing");
  requireSectionText(authoritativeStoredValueBoundary, "realizedBoundary[venueId] === positionBoundary[venueId]", "carry_public_value_realized_boundary_binding_missing");
  requireSectionText(authoritativeStoredValueBoundary, 'positionProvenance[venueId] === "authoritative_exchange_fill_time"', "carry_public_value_position_provenance_missing");
  requireSectionText(authoritativeStoredValueBoundary, 'fundingProvenance[venueId] === "authoritative_exchange_fill_time"', "carry_public_value_funding_provenance_missing");
  requireSectionText(authoritativeStoredValueBoundary, 'realizedProvenance[venueId] === "authoritative_exchange_fill_time"', "carry_public_value_realized_provenance_missing");
  const publicCarryRecord = sourceSection(
    "positions",
    "function publicRecord(",
    "function opportunityAuthenticationMaterial(",
  );
  requireSectionText(publicCarryRecord, "value_boundary_authoritative: authoritativeStoredCarryValueBoundary(record)", "carry_public_value_authoritative_marker_computation_missing");
  requireText("webCarryBuilder", "const netUsd = opportunity ? proofNet : model.netUsd", "carry_terminal_proof_economics_fallback_missing");
  requireText("webCarryBuilder", '"CONNECT TO VERIFY · NO EDGE YET"', "carry_terminal_nonpositive_edge_cta_missing");
  requireText("webCarryBuilderTest", "does not invite trading when the public route has no modeled net edge", "carry_terminal_nonpositive_edge_cta_test_missing");
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
  requireText("qualification", 'entry: qualificationSubmissionAttempt("entry", entry)', "qualification_entry_attempt_derivation_missing");
  requireText("qualification", 'exit: qualificationSubmissionAttempt("exit", exit)', "qualification_exit_attempt_derivation_missing");
  requireText("qualification", "ambiguous_submission_retry_count: ambiguityRetryCount", "qualification_no_retry_proof_missing");
  requireText("qualification", "attempt?.ambiguity_retry_count", "qualification_durable_retry_evidence_missing");
  forbidText("qualification", "ambiguous_submission_retry_count: 0", "qualification_retry_evidence_hardcoded");
  requireText("qualification", "gross_exposure_micro_usdc: 0", "qualification_flat_proof_missing");
  requireText("qualification", "open_order_count: 0", "qualification_zero_orders_proof_missing");
  requireText("qualification", "qualification_account_binding_mismatch", "qualification_account_lineage_gate_missing");
  requireText("releaseMaterial", "buildCompletedCarryReleaseMaterial", "carry_release_material_builder_missing");
  requireText("workerState", "worker_carry_lifecycle_events", "carry_lifecycle_journal_table_missing");
  requireText("workerState", "INSERT INTO worker_carry_lifecycle_events", "carry_lifecycle_journal_postgres_transaction_missing");
  requireText("workerState", "const lifecycleEvent = input.lifecycle_event || null", "carry_lifecycle_journal_state_binding_missing");
  requireText("workerState", "finalizeCarryLifecycleEventRecord", "carry_lifecycle_journal_commitment_missing");
  requireText("workerState", "FOR UPDATE", "carry_lifecycle_postgres_row_lock_missing");
  requireText("workerState", "listCarryLifecycleEvents", "carry_lifecycle_journal_reader_missing");
  requireText("workerState", "bindCarryLifecycleJournalMetadata", "carry_lifecycle_legacy_anchor_missing");
  requireText("workerState", "canonicalStateJson(tail) !== canonicalStateJson(expectedTail)", "carry_lifecycle_tail_prefix_binding_missing");
  requireText("positions", "lifecycle_event: recordedEvent", "carry_lifecycle_journal_atomic_binding_missing");
  requireText("releaseMaterial", "readCompleteCarryLifecycleJournal", "carry_release_full_lifecycle_journal_missing");
  requireText("releaseMaterial", "carry_release_lifecycle_journal_unproven", "carry_release_lifecycle_journal_gate_missing");
  requireText("releaseMaterial", "record.lifecycle_journal.origin_sequence !== 1", "carry_release_lifecycle_origin_gate_missing");
  forbidText("releaseMaterial", "const events = Array.isArray(record.lifecycle_events)", "carry_release_truncated_lifecycle_source_forbidden");
  requireText("positionsTest", "beyond the 256-event UI tail and rejects stale CAS appends", "carry_lifecycle_journal_rollover_test_missing");
  requireText("positionsTest", "anchors legacy Carry journals without freezing positions or qualifying missing history", "carry_lifecycle_legacy_anchor_test_missing");
  requireText("server", "PRIVATE_AGENT_STATE_SINGLE_PROCESS_OK", "carry_json_single_process_assertion_missing");
  requireText("server", "carry_interprocess_state_not_ready", "carry_entry_interprocess_state_gate_missing");
  requireText("server", "const readSharedStateReadiness = options.sharedStateReadiness || sharedStateReady", "carry_state_readiness_provider_missing");
  requireText("server", "const stateMutationReady = readSharedStateReadiness().ready", "carry_autonomous_state_gate_missing");
  requireText("server", "STATE_INDEPENDENT_ROUTES", "carry_interprocess_state_allowlist_missing");
  requireText("server", "UNSAFE_STATE_EMERGENCY_ROUTES", "carry_emergency_state_allowlist_missing");
  requireText("server", "emergencyStateAccessCandidate", "carry_emergency_state_candidate_gate_missing");
  requireText("server", "stateAccessAllowedWithoutInterprocessSafety", "carry_global_state_route_gate_missing");
  requireText("server", "!requestStateReadiness.ready", "carry_request_state_readiness_gate_missing");
  requireText("server", "emergencyRiskReductionOnly: !requestStateReadiness.ready", "carry_emergency_execution_mode_binding_missing");
  requireText("privateExecution", "function enforceEmergencyRiskReductionInstruction", "carry_emergency_decrypted_instruction_gate_missing");
  requireText("privateExecution", "instruction?.order?.reduce_only === true", "carry_emergency_reduce_only_gate_missing");
  requireCount("privateExecution", "enforceEmergencyRiskReductionInstruction(instruction, emergencyRiskReductionOnly);", 4, "carry_emergency_adapter_gate_missing");
  requireText("serverTest", "blocks risk-increasing and non-emergency routes when interprocess state is unsafe", "carry_global_state_route_test_missing");
  requireText("serverTest", "blocks pause and kill when unsafe state cannot provide a durable execution fence", "carry_unsafe_control_fail_closed_test_missing");
  requireText("serverTest", "allows native reduce-only and reconcile but denies entry, cancel, and exit when state is unsafe", "carry_unsafe_execution_fail_closed_test_missing");
  requireText("serverTest", "unsafe_state_disguised_entry_work_order_123", "carry_emergency_disguised_entry_test_missing");
  requireText("serverTest", "blocks Phoenix and Backpack orders during unsafe state because native reduction is unproven", "carry_unsafe_solana_order_denial_test_missing");
  const emergencyRoutesStart = String(sources.server || "").indexOf("const UNSAFE_STATE_EMERGENCY_ROUTES");
  const emergencyRoutesEnd = String(sources.server || "").indexOf("]);", emergencyRoutesStart);
  const emergencyRoutesSource = emergencyRoutesStart >= 0 && emergencyRoutesEnd > emergencyRoutesStart
    ? String(sources.server || "").slice(emergencyRoutesStart, emergencyRoutesEnd)
    : "";
  if (emergencyRoutesSource.includes('"/venues/solana-perps/orders"')) {
    failures.push("carry_unsafe_solana_order_route_allowed");
  }
  for (const [route, code] of [
    ['"/venues/coinbase/orders"', "carry_unsafe_coinbase_order_route_allowed"],
    ['"/carry/positions/exit-request"', "carry_unsafe_exit_route_allowed"],
    ['"/autopilot/tri-venue/kill"', "carry_unsafe_tri_kill_route_allowed"],
  ]) {
    if (emergencyRoutesSource.includes(route)) failures.push(code);
  }
  requireText(
    "server",
    "return UNSAFE_STATE_EMERGENCY_ROUTES.has(path);",
    "carry_unsafe_state_exact_allowlist_gate_missing",
  );
  requireText("workerState", "carry_lifecycle_projection_write_requires_event", "carry_lifecycle_projection_guard_missing");
  requireText("positionsTest", "projectionMutation.error", "carry_lifecycle_projection_guard_test_missing");
  requireText("phalaCompose", "PRIVATE_AGENT_STATE_SINGLE_PROCESS_OK", "carry_phala_single_process_env_missing");
  requireText("phalaWorkerEnv", "JSON/file state requires PRIVATE_AGENT_STATE_SINGLE_PROCESS_OK=true", "carry_phala_single_process_validation_missing");
  requireText("phalaWorkerEnvTest", "SINGLE_PROCESS_OK=true", "carry_phala_single_process_validation_test_missing");
  requireText("workerImageWorkflow", "Test private-agent worker", "carry_worker_image_test_gate_missing");
  requireText("workerImageWorkflow", "run: npm ci", "carry_worker_image_test_install_missing");
  requireText("workerImageWorkflow", "run: node --test", "carry_worker_image_test_command_missing");
  requireText("releaseMaterialTest", "pre-tail monitoring failure from the full durable lifecycle journal", "carry_release_pre_tail_failure_test_missing");
  requireText("releaseMaterialTest", "refuses a tampered durable lifecycle journal", "carry_release_lifecycle_journal_tamper_test_missing");
  requireText("releaseMaterialTest", "refuses release proof for a legacy-anchored lifecycle journal", "carry_release_legacy_journal_denial_test_missing");
  requireText("releaseMaterial", "carry_release_monitoring_evidence_missing", "carry_release_monitoring_gate_missing");
  requireText("releaseMaterial", "carry_release_margin_runway_evidence_missing", "carry_release_runway_gate_missing");
  requireText("releaseMaterial", "carry_release_contract_equivalence_exceeded", "carry_release_contract_basis_gate_missing");
  requireText("releaseMaterial", "contract_equivalence: contractEquivalence.evidence", "carry_release_contract_basis_evidence_missing");
  requireText("releaseMaterial", "carry_release_signed_mandate_unproven", "carry_release_signed_mandate_gate_missing");
  requireText("releaseMaterial", "owner_signature", "carry_release_owner_signature_missing");
  requireText("releaseMaterial", "status: leg.status", "carry_release_runway_status_missing");
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
  requireText("releaseMaterial", "minimum_span_ms: shadowQualification.minimum_span_ms", "carry_release_shadow_duration_evidence_missing");
  requireText("releaseMaterial", "const fundingLegId = carryPositionLegId(record.position, sagaLeg.venue_id)", "carry_release_canonical_funding_leg_missing");
  requireText("releaseMaterial", 'funding_micro_usdc: sumSignedEntries(fundingLedgerEntries, "funding")', "carry_release_leg_funding_missing");
  requireText("releaseMaterialTest", "funding_micro_usdc), [60, -10]", "carry_release_leg_funding_test_missing");
  requireText("releaseMaterialTest", "carryPositionLegId({ position_id: positionId", "carry_release_canonical_funding_leg_test_missing");
  requireText("evidenceVerifier", "realized_funding_evidence_mismatch", "carry_release_funding_reconciliation_missing");
  requireText("evidenceVerifier", "shadow_qualification_image_mismatch", "carry_release_shadow_image_verifier_missing");
  requireText("evidenceVerifier", "shadow_qualification_samples_incomplete", "carry_release_shadow_soak_verifier_missing");
  requireText("evidenceVerifier", "shadow_qualification_source_observations_invalid", "carry_release_shadow_source_observation_verifier_missing");
  requireText("evidenceVerifier", "shadowMinimumSpanMs >= 120_000", "carry_release_shadow_duration_verifier_missing");
  requireText("evidenceVerifier", "shadowQualification.venues === CORE_PERP_VENUES.length", "carry_release_shadow_registry_coverage_missing");
  requireText("evidenceVerifier", "shadowQualification.assets === CARRY_SHADOW_ASSETS.length", "carry_release_shadow_asset_registry_missing");
  requireText("evidenceVerifier", "CORE_PERP_VENUES.length * CARRY_SHADOW_ASSETS.length", "carry_release_shadow_matrix_registry_missing");
  forbidText("evidenceVerifier", 'Object.freeze(["BTC", "ETH", "SOL"])', "carry_release_shadow_asset_policy_duplicated");
  requireText("evidenceVerifier", "venueAdapterCapability(venueId, \"carry_execution\")?.adapter_id", "carry_release_adapter_registry_binding_missing");
  requireText("evidenceVerifier", "CARRY_EXECUTION_VENUES.includes(venue)", "carry_release_pair_registry_binding_missing");
  forbidText("evidenceVerifier", "pair.includes(\"hyperliquid\")", "carry_release_hyperliquid_anchor_hardcoded");
  requireText("evidenceVerifierTest", "accepts a registry-qualified lifecycle without a hard-coded Hyperliquid anchor", "carry_release_registry_neutral_pair_test_missing");
  forbidText("evidenceVerifier", "shadowQualification.venues === 5", "carry_release_shadow_venue_count_hardcoded");
  forbidText("evidenceVerifier", "shadowQualification.expected_snapshots_per_sample === 15", "carry_release_shadow_snapshot_count_hardcoded");
  requireText("evidenceVerifierTest", "rejects funding not reconciled to exact venue legs", "carry_release_funding_reconciliation_test_missing");
  requireText("evidenceVerifierTest", "rejects missing, incomplete, or image-mismatched five-venue shadow qualification", "carry_release_shadow_qualification_test_missing");
  requireText("privateExecution", "ambiguity_retry_count: 0", "durable_retry_count_missing");
  requireText("privateExecution", "async function claimSubmissionAfterPolicyValidation({", "durable_atomic_policy_claim_helper_missing");
  requireCount("privateExecution", "= await claimSubmissionAfterPolicyValidation({", 6, "durable_atomic_policy_adapter_claim_missing");
  requireText("privateExecution", 'typeof state.claimExecutionAttemptWithPolicyUsage !== "function"', "durable_atomic_policy_fail_closed_missing");
  requireText("privateExecution", "const allowedAttempt = {", "durable_atomic_allowed_attempt_missing");
  requireText("privateExecution", "...attempt,\n    submit_count: 1,", "durable_atomic_allowed_submit_count_missing");
  requireText("privateExecution", "const deniedAttempt = {", "durable_atomic_denied_attempt_missing");
  requireText("privateExecution", 'status: "failed_no_submit",\n    submit_count: 0,', "durable_atomic_denied_attempt_status_missing");
  requireText("privateExecution", "state.claimExecutionAttemptWithPolicyUsage(body.work_order_commitment, {", "durable_atomic_policy_state_claim_missing");
  requireText("privateExecution", "allowed_attempt: allowedAttempt", "durable_atomic_policy_allowed_binding_missing");
  requireText("privateExecution", "denied_attempt: deniedAttempt", "durable_atomic_policy_denied_binding_missing");
  requireText("privateExecution", "counts: collector.counts", "durable_atomic_policy_count_binding_missing");
  requireText("privateExecution", "amounts: collector.amounts", "durable_atomic_policy_amount_binding_missing");
  forbidText("privateExecution", "persistPreSubmissionAttempt({", "durable_legacy_split_submit_claim_forbidden");
  forbidText("privateExecution", "state.claimExecutionAttempt(", "durable_legacy_attempt_only_claim_forbidden");
  const coinbaseSubmitSource = sourceSection(
    "privateExecution",
    "export async function executeCoinbaseOrder(",
    "export async function reconcileCoinbaseOrder(",
  );
  const solanaPerpsSubmitSource = sourceSection(
    "privateExecution",
    "export async function executeSolanaPerpsOrder(",
    "export async function executeJupiterSwapOrder(",
  );
  const jupiterSubmitSource = sourceSection(
    "privateExecution",
    "export async function executeJupiterSwapOrder(",
    "export async function executeAutopilotOrder(",
  );
  requireOrdered(
    coinbaseSubmitSource,
    "pending = await claimSubmissionAfterPolicyValidation({",
    "await state.reserveOmnibus({",
    "coinbase_pending_claim_before_reservation_missing",
  );
  requireOrdered(
    coinbaseSubmitSource,
    "pending = await claimSubmissionAfterPolicyValidation({",
    "adapterResult = await submitCoinbaseExecution({",
    "coinbase_pending_claim_before_network_missing",
  );
  requireOrdered(
    solanaPerpsSubmitSource,
    "pending = await claimSubmissionAfterPolicyValidation({",
    "adapterResult = await submitSolanaPerpsExecution({",
    "solana_perps_pending_claim_before_network_missing",
  );
  requireOrdered(
    jupiterSubmitSource,
    "pending = await claimSubmissionAfterPolicyValidation({",
    "adapterResult = await submitJupiterSwapExecution({",
    "jupiter_pending_claim_before_network_missing",
  );
  for (const [section, venue, code] of [
    [coinbaseSubmitSource, "coinbase", "coinbase_ambiguous_freeze_missing"],
    [solanaPerpsSubmitSource, "solana_perps", "solana_perps_ambiguous_freeze_missing"],
    [jupiterSubmitSource, "jupiter", "jupiter_ambiguous_freeze_missing"],
  ]) {
    if (!section.includes('status: "ambiguous"') || !section.includes('"submission_ambiguous"')) {
      failures.push(code);
    }
    if (!section.includes("already has a durable submission attempt; reconcile it instead of retrying")) {
      failures.push(`${venue}_durable_retry_guard_missing`);
    }
  }
  const coinbasePreReceiptSource = coinbaseSubmitSource.slice(
    0,
    coinbaseSubmitSource.indexOf("const receipt = executionReceipt({"),
  );
  if (coinbasePreReceiptSource.includes("releaseOmnibus")) {
    failures.push("coinbase_ambiguous_omnibus_release_present");
  }
  requireCount("workerState", "async claimExecutionAttemptWithPolicyUsage(workOrderCommitment, input = {}) {", 2, "durable_atomic_policy_state_implementations_missing");
  requireText("workerState", 'client.query("BEGIN ISOLATION LEVEL READ COMMITTED")', "durable_atomic_policy_postgres_transaction_missing");
  requireText("workerState", '"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))"', "durable_atomic_policy_postgres_lock_missing");
  requireText("workerState", "const selectedAttempt = denied\n          ? policyDeniedAttempt(deniedAttempt, denied)", "durable_atomic_policy_attempt_decision_missing");
  requireText("workerState", "const claimed = rearmExisting", "durable_atomic_policy_attempt_insert_missing");
  requireCount(
    "workerState",
    "input.rearm_failed_no_submit === true && isPolicyFailedNoSubmitAttempt(existing)",
    2,
    "durable_atomic_policy_rearm_predicate_missing",
  );
  requireText("workerState", 'attempt?.status === "failed_no_submit"', "durable_atomic_policy_rearm_status_missing");
  requireText("workerState", "attempt.submit_count === 0", "durable_atomic_policy_rearm_zero_submit_missing");
  requireText("workerState", "Number(attempt.ambiguity_retry_count || 0) === 0", "durable_atomic_policy_rearm_no_ambiguity_missing");
  requireText("workerState", "attempt.final_proof == null", "durable_atomic_policy_rearm_no_final_proof_missing");
  requireText("workerState", "/_policy_failed_no_submit$/.test", "durable_atomic_policy_rearm_policy_proof_missing");
  requireText("workerState", "AND attempt_json = $4::jsonb", "durable_atomic_policy_postgres_exact_prior_compare_missing");
  requireText("workerState", "jsonParam(existing)", "durable_atomic_policy_postgres_exact_prior_binding_missing");
  requireText("workerState", 'await client.query("ROLLBACK")', "durable_atomic_policy_postgres_rollback_missing");
  requireText("workerState", "const mutate = (state) => claimExecutionAttemptWithPolicyUsageInState(", "durable_atomic_policy_local_mutation_missing");
  requireText("workerState", "function atomicUpdate(mutator) {", "durable_atomic_policy_sqlite_transaction_missing");
  requireText("workerState", 'db.exec("BEGIN IMMEDIATE")', "durable_atomic_policy_sqlite_begin_missing");
  requireText("workerState", 'if (typeof atomicUpdate === "function") return atomicUpdate(mutator);', "durable_atomic_policy_sqlite_routing_missing");
  requireText("workerState", "return updateState(mutate)", "durable_atomic_policy_file_transaction_missing");
  requireText("privateStatePolicyClaimTest", "atomic policy claim rolls back every quota charge when a later quota denies", "durable_atomic_policy_rollback_test_missing");
  requireText("privateStatePolicyClaimTest", "duplicate concurrent atomic claims charge quota exactly once", "durable_atomic_policy_duplicate_test_missing");
  requireText("privateStatePolicyClaimTest", "a policy-proven no-submit attempt rearms once after quota permits and preserves lineage", "durable_atomic_policy_rearm_test_missing");
  requireText("privateStatePolicyClaimTest", "ambiguous attempts can never use the policy no-submit rearm", "durable_atomic_policy_rearm_ambiguity_test_missing");
  requireText("privateStatePolicyClaimTest", "SQLite serializes competing quota claims across adapter instances", "durable_atomic_policy_sqlite_concurrency_test_missing");
  requireText("asterTest", "atomically claims one Aster submission under concurrent identical requests", "durable_atomic_submit_concurrency_test_missing");
  requireText("serverTest", "atomically accepts one concurrent Hyperliquid submission", "hyperliquid_atomic_submit_concurrency_test_missing");
  requireText("lighterConcurrencyTest", "atomically permits exactly one Lighter submission under concurrent identical requests", "lighter_atomic_submit_concurrency_test_missing");
  requireText(
    "multiLegOrchestrator",
    "if (evidenceMicro === null || candidateMicro > evidenceMicro) {\n      evidenceMicro = candidateMicro;\n      evidenceBase = candidateBase;",
    "carry_recovery_highest_fill_selection_missing",
  );
  requireText(
    "multiLegOrchestrator",
    "terminal = proof?.final_venue_execution_proven === true\n        && proof?.target_fill_set_complete === true;\n      selectedEvidence = true;\n      terminalRegressed = false;",
    "carry_recovery_highest_fill_terminal_reset_missing",
  );
  requireText(
    "multiLegOrchestrator",
    "} else if (candidateMicro === evidenceMicro) {",
    "carry_recovery_equal_highest_fill_selection_missing",
  );
  requireText(
    "multiLegOrchestrator",
    "const candidateTerminal = proof?.final_venue_execution_proven === true\n        && proof?.target_fill_set_complete === true;",
    "carry_recovery_equal_fill_set_complete_gate_missing",
  );
  requireText(
    "multiLegOrchestrator",
    "if (selectedEvidence && terminal && !candidateTerminal) {\n        terminal = false;\n        terminalRegressed = true;",
    "carry_recovery_terminal_regression_fail_closed_missing",
  );
  requireText(
    "multiLegOrchestrator",
    "} else if (!terminalRegressed && candidateTerminal) {\n        terminal = true;",
    "carry_recovery_terminal_progression_missing",
  );
  const executorFillProgress = sourceSection("executor", "function fillProgress(", "function proportionalMicroForExactBase(");
  requireSectionText(executorFillProgress, "proof?.final_venue_execution_proven === true\n    && proof?.target_fill_set_complete === true", "carry_executor_fill_progress_fill_set_gate_missing");
  const executorTerminalAssessment = sourceSection("executor", "export function assessCarryTerminalExecutionReceipt({", "function exposureBoundaryEvent(");
  requireSectionText(executorTerminalAssessment, "proof.final_venue_execution_proven !== true\n    || proof.target_fill_set_complete !== true", "carry_executor_terminal_assessment_fill_set_gate_missing");
  const originalOrderAssessment = sourceSection("multiLegOrchestrator", "function assessOriginalOrderReconciliation({", "async function applyTimeout(");
  requireSectionText(originalOrderAssessment, "proof?.final_venue_execution_proven !== true\n    || proof?.target_fill_set_complete !== true", "carry_original_reconciliation_fill_set_gate_missing");
  const unwindProgress = sourceSection("multiLegOrchestrator", "function unwindProgress({", "function recoveryProofTargetsLeg(");
  requireSectionText(unwindProgress, "proof?.final_venue_execution_proven === true\n      && proof?.target_fill_set_complete === true", "carry_unwind_progress_fill_set_gate_missing");
  const arbitrageFillProgress = sourceSection("arbitrage", "function receiptFillProgress({", "export async function bestArbitrageOpportunity(");
  requireSectionText(arbitrageFillProgress, "proof?.final_venue_execution_proven === true\n    && proof?.target_fill_set_complete === true", "carry_arbitrage_fill_progress_fill_set_gate_missing");
  const qualificationAssessment = sourceSection("qualification", "export function assessCarryVenueQualification({", "function qualificationAdapters(");
  requireSectionText(qualificationAssessment, "entry.target_fill_set_complete !== true", "carry_qualification_entry_fill_set_gate_missing");
  requireSectionText(qualificationAssessment, "exit.target_fill_set_complete !== true", "carry_qualification_exit_fill_set_gate_missing");
  const releaseFillTiming = sourceSection("releaseMaterial", "function authoritativeReleaseFillTiming(", "async function materialLegs(");
  requireSectionText(releaseFillTiming, "proof?.final_venue_execution_proven === true\n    && proof?.target_fill_set_complete === true", "carry_release_fill_timing_fill_set_gate_missing");
  const hyperliquidReconciliation = sourceSection("hyperliquid", "async function reconcileHyperliquidExecution({", "function unresolvedHyperliquidReconciliation(");
  requireSectionCount(hyperliquidReconciliation, "target_fill_set_complete: targetFillSetComplete", 3, "hyperliquid_target_fill_set_producer_missing");
  const asterExactTrades = sourceSection("aster", "async function attachExactAsterTrades(", "async function readBoundedAsterUserTrades(");
  requireSectionText(asterExactTrades, "target_fill_set_complete: true", "aster_target_fill_set_producer_missing");
  const lighterReconciliationFillSet = sourceSection("lighter", "export async function reconcileLighterExecution({", "function submittedOrderMatchesCandidate(");
  requireSectionText(lighterReconciliationFillSet, "target_fill_set_complete: targetFillSetComplete", "lighter_target_fill_set_producer_missing");
  requireText(
    "multiLegOrchestrator",
    "let filledBase = evidenceMicro === filledMicro ? evidenceBase : null;",
    "carry_recovery_highest_fill_exact_base_binding_missing",
  );
  requireText(
    "multiLegOrchestrator",
    "if (evidenceMicro !== filledMicro) terminal = false;",
    "carry_recovery_terminal_fill_binding_missing",
  );
  requireText(
    "multiLegOrchestrator",
    "const applicableFilledMicro = !progress.terminal && progress.filledMicro === requestedMicro\n    ? appliedMicro\n    : progress.filledMicro;",
    "carry_recovery_nonterminal_full_fill_withhold_missing",
  );
  requireText("multiLegOrchestrator", "const applicableProgress = { ...progress, filledMicro: applicableFilledMicro };", "carry_recovery_applicable_progress_missing");
  requireText(
    "multiLegOrchestrator",
    'const startingCumulative = action === "unwind"\n    ? currentLeg.filled_micro_usdc - requestedMicro\n    : currentLeg.notional_micro_usdc - requestedMicro;',
    "carry_recovery_child_baseline_missing",
  );
  requireText(
    "multiLegOrchestrator",
    "const targetCumulative = Math.min(cumulativeLimit, startingCumulative + applicableFilledMicro);",
    "carry_recovery_replay_target_missing",
  );
  requireText("multiLegOrchestrator", "appliedFilledMicro: applicableFilledMicro", "carry_recovery_applicable_accounting_missing");
  requireText("multiLegOrchestrator", "positionFilledBase: execution.position_filled_base_size", "carry_recovery_position_evidence_persistence_missing");
  requireText("multiLegOrchestrator", "progress: applicableProgress", "carry_recovery_applicable_result_missing");
  requireText(
    "multiLegOrchestrator",
    'if (action === "unwind" && targetCumulative > currentCumulative) {',
    "carry_recovery_reconciled_unwind_position_sync_missing",
  );
  requireText(
    "multiLegOrchestrator",
    "leg: { ...currentLeg, unwind_filled_micro_usdc: targetCumulative },",
    "carry_recovery_reconciled_unwind_position_evidence_missing",
  );
  requireText("multiLegOrchestrator", "position_filled_base_size: evidence.filledBase", "carry_recovery_reconciled_unwind_exact_base_missing");
  const recoveryProgressSource = String(sources.multiLegOrchestrator || "");
  const recoveryProgressStart = recoveryProgressSource.indexOf("async function applyRecoveryExecutionProgress(");
  const recoveryProgressEnd = recoveryProgressSource.indexOf("\nasync function applyRecoveryFillIfNew(", recoveryProgressStart);
  const recoveryProgress = recoveryProgressStart >= 0 && recoveryProgressEnd > recoveryProgressStart
    ? recoveryProgressSource.slice(recoveryProgressStart, recoveryProgressEnd)
    : "";
  const recoveryAccountingWrite = recoveryProgress.indexOf("await storeRecoveryAccounting({");
  const recoveryPositionWrite = recoveryProgress.indexOf("await putRecoveryPosition({");
  const recoverySagaWrite = recoveryProgress.indexOf("await applyDurableMultiLegEvent({");
  if (recoveryAccountingWrite < 0 || recoverySagaWrite < 0 || recoveryAccountingWrite >= recoverySagaWrite) {
    failures.push("carry_recovery_accounting_before_terminal_missing");
  }
  if (recoveryPositionWrite < 0 || recoverySagaWrite < 0 || recoveryPositionWrite >= recoverySagaWrite) {
    failures.push("carry_recovery_position_before_terminal_missing");
  }
  const unwindSubmitStart = recoveryProgressSource.indexOf(
    'const workOrderCommitment = recoveryWorkOrder(current, leg, "unwind", remainingMicro);',
  );
  const unwindSubmitEnd = recoveryProgressSource.indexOf("\nasync function executeRiskReducingCompletion(", unwindSubmitStart);
  const unwindSubmit = unwindSubmitStart >= 0 && unwindSubmitEnd > unwindSubmitStart
    ? recoveryProgressSource.slice(unwindSubmitStart, unwindSubmitEnd)
    : "";
  const unwindIntentWrite = unwindSubmit.indexOf("await storeRecoveryAccounting({");
  const unwindBroadcast = unwindSubmit.indexOf("const receipt = await executeOrder(");
  if (unwindIntentWrite < 0 || unwindBroadcast < 0 || unwindIntentWrite >= unwindBroadcast) {
    failures.push("carry_recovery_unwind_intent_before_submit_missing");
  }
  const completionSubmitStart = recoveryProgressSource.indexOf(
    'const workOrderCommitment = recoveryWorkOrder(current, leg, "completion", remainingMicro);',
  );
  const completionSubmitEnd = recoveryProgressSource.indexOf("\nasync function settlePriorRecoveryExecutions(", completionSubmitStart);
  const completionSubmit = completionSubmitStart >= 0 && completionSubmitEnd > completionSubmitStart
    ? recoveryProgressSource.slice(completionSubmitStart, completionSubmitEnd)
    : "";
  const completionIntentWrite = completionSubmit.indexOf("await storeRecoveryAccounting({");
  const completionBroadcast = completionSubmit.indexOf("const receipt = await executeOrder(");
  if (completionIntentWrite < 0 || completionBroadcast < 0 || completionIntentWrite >= completionBroadcast) {
    failures.push("carry_recovery_completion_intent_before_submit_missing");
  }
  requireText("multiLegOrchestratorTest", "never pairs newer fill notional with stale exact base evidence", "carry_recovery_newer_fill_stale_base_test_missing");
  requireText("multiLegOrchestratorTest", "reconciles after a crash between recovery broadcast and receipt persistence without resubmitting", "carry_recovery_broadcast_crash_test_missing");
  requireText("multiLegOrchestratorTest", 'for (const boundary of ["applied-accounting", "flat-position"])', "carry_recovery_two_phase_crash_matrix_missing");
  requireText("multiLegOrchestratorTest", "replays a crash after ${boundary} persistence without resubmitting the unwind", "carry_recovery_two_phase_replay_test_missing");
  requireText("multiLegOrchestratorTest", "replays completion after applied accounting without resubmitting", "carry_recovery_completion_accounting_crash_test_missing");
  requireText("multiLegOrchestratorTest", "recovers a persisted terminal-zero unwind receipt without retrying the order", "carry_recovery_terminal_zero_crash_test_missing");
  requireText("multiLegOrchestratorTest", "persists unwind accounting and flat position before terminal saga advancement", "carry_recovery_terminal_side_effect_order_test_missing");
  requireText("multiLegOrchestratorTest", "keeps a full-base nonterminal completion compensating until exact reconciliation", "carry_recovery_full_nonterminal_completion_test_missing");
  requireText("multiLegOrchestratorTest", "[6_000_000, 0]", "carry_recovery_partial_nonterminal_accounting_test_missing");
  requireText("multiLegOrchestratorTest", 'assert.equal(positions[0].recovery_component_signed_base_size, "0")', "carry_recovery_reconciled_unwind_position_test_missing");
  requireText(
    "multiLegOrchestrator",
    "function samePositiveDecimal(left, right) {\n  const normalizedLeft = canonicalExactPositiveDecimal(left);\n  return normalizedLeft !== null && normalizedLeft === canonicalExactPositiveDecimal(right);\n}",
    "carry_recovery_exact_decimal_comparator_missing",
  );
  requireText("multiLegOrchestrator", "const MAX_EXACT_BASE_DIGITS = 80;", "carry_recovery_exact_decimal_digit_bound_missing");
  requireText("multiLegOrchestrator", "const MAX_EXACT_BASE_SCALE = 40;", "carry_recovery_exact_decimal_scale_bound_missing");
  requireText("multiLegOrchestrator", "if (text.length > MAX_EXACT_BASE_DIGITS + 1) return null;", "carry_recovery_exact_decimal_length_gate_missing");
  requireText(
    "multiLegOrchestrator",
    "if (match[1].length + fraction.length > MAX_EXACT_BASE_DIGITS || fraction.length > MAX_EXACT_BASE_SCALE) return null;",
    "carry_recovery_exact_decimal_bounds_missing",
  );
  requireText("multiLegOrchestratorTest", "restart rejects an oversized exact-base receipt before decimal expansion", "carry_recovery_exact_decimal_bounds_test_missing");
  requireText("privateExecution", 'venueAdapterCapability(venueId, capability)', "worker_carry_capability_registry_missing");
  requireText("privateExecution", 'registeredCarryAdapter(venue_id, "carry_execution")', "worker_carry_execution_registry_dispatch_missing");
  requireText("privateExecution", 'registeredCarryAdapter(venue_id, "no_submit_reconciliation")', "worker_carry_no_submit_registry_dispatch_missing");
  requireText("privateExecution", 'registeredCarryAdapterId(venueId, "carry_execution")', "worker_carry_funding_registry_dispatch_missing");
  requireText("privateExecution", "openAccountBoundExecutionVault", "carry_execution_vault_account_binding_missing");
  requireCount("privateExecution", 'deriveClientOrderId("gh",', 5, "aster_client_order_length_guard_missing");
  requireText("privateExecution", "opened.associatedDataText !== expectedAad", "carry_execution_vault_exact_aad_missing");
  requireText("privateExecution", "async function openContextBoundVenueExecutionVault({", "venue_execution_vault_context_binding_missing");
  requireText("privateExecution", "requestMode !== vaultMode", "venue_execution_vault_mode_binding_missing");
  requireText("privateExecution", '`mode:${vaultMode}`', "venue_execution_vault_mode_aad_missing");
  requireText("privateExecution", '`network:${network}`', "venue_execution_vault_network_aad_missing");
  requireText("privateExecution", 'aadParts.push(`venue:${venueId}`)', "venue_execution_vault_venue_aad_missing");
  requireText("privateExecution", 'opened.associatedDataText !== aadParts.join("|")', "venue_execution_vault_exact_context_aad_missing");
  requireCount("privateExecution", "openContextBoundVenueExecutionVault({", 11, "venue_execution_vault_context_callsites_missing");
  requireText(
    "privateExecution",
    "export function privateExecutionInstructionAssociatedDataMatches",
    "carry_execution_instruction_aad_matcher_missing",
  );
  requireText(
    "privateExecution",
    "return associatedDataText === expectedAad;",
    "carry_execution_instruction_exact_aad_missing",
  );
  requireText(
    "privateExecution",
    "if (!privateExecutionInstructionAssociatedDataMatches({",
    "carry_execution_instruction_aad_callsite_missing",
  );
  forbidText(
    "privateExecution",
    "opened.associatedDataText.includes(",
    "carry_execution_instruction_substring_aad_present",
  );
  requireText(
    "serverTest",
    "rejects prefix and field-injection instruction AAD replays across every private venue",
    "carry_execution_instruction_aad_replay_test_missing",
  );
  requireText(
    "serverTest",
    "rejects a valid encrypted instruction whose AAD only prefix-matches the submitted order",
    "carry_execution_instruction_aad_ingress_test_missing",
  );
  requireText("privateExecution", '`account:${accountCommitment}`', "carry_execution_vault_account_commitment_missing");
  forbidText("privateExecution", 'aadPrefix: "ghola/hyperliquid-execution-vault-v1"', "hyperliquid_prefix_only_vault_open_forbidden");
  forbidText("privateExecution", 'aadPrefix: "ghola/aster-execution-vault-v1"', "aster_prefix_only_vault_open_forbidden");
  requireText("adapterRegistryTest", "shadow-only candidates cannot enter worker Carry dispatch", "worker_carry_registry_fail_closed_test_missing");
  requireText("adapterRegistryTest", "adapter_missing:no_submit_reconciliation", "worker_carry_no_submit_registry_gate_missing");
  requireText("adapterRegistryTest", "Carry funding history dispatches through the registered Aster adapter", "worker_carry_funding_registry_test_missing");

  requireText("hyperliquid", "target_client_order_matched", "hyperliquid_target_match_proof_missing");
  requireText("hyperliquidRunner", 'return "submission_ambiguous" if broadcast_started else "pre_submit_failed"', "hyperliquid_post_broadcast_ambiguity_classification_missing");
  requireText("hyperliquidRunner", "assert_cancel_statuses_ok(result, 1)", "hyperliquid_cancel_acknowledgement_gate_missing");
  requireText("hyperliquidRunner", "explicit_order_acknowledgement(item, expected_cloids[index])", "hyperliquid_order_acknowledgement_shape_gate_missing");
  requireText("hyperliquidRunner", "value.lower() == expected.lower()", "hyperliquid_order_acknowledgement_cloid_binding_missing");
  requireText("hyperliquidRunner", 'not all(item == "success" for item in statuses)', "hyperliquid_cancel_acknowledgement_shape_gate_missing");
  requireText("hyperliquidRunner", 'fail(message, "submission_ambiguous")', "hyperliquid_post_broadcast_action_ambiguity_missing");
  forbidText("hyperliquidRunner", "compensate_failed_bracket", "hyperliquid_untracked_bracket_compensation_forbidden");
  requireCount("hyperliquidTurnkey", '"submission_ambiguous"', 2, "hyperliquid_turnkey_post_broadcast_ambiguity_missing");
  requireText("hyperliquidTurnkey", "let broadcastStarted = false;", "hyperliquid_turnkey_broadcast_stage_missing");
  requireCount("hyperliquidTurnkey", "markBroadcastStarted();", 2, "hyperliquid_turnkey_broadcast_boundary_missing");
  requireText("hyperliquidTurnkey", "explicitOrderAcknowledgement(item, expectedCloids[index])", "hyperliquid_turnkey_order_acknowledgement_shape_gate_missing");
  requireText("hyperliquidTurnkey", "value.toLowerCase() === expected.toLowerCase()", "hyperliquid_turnkey_order_acknowledgement_cloid_binding_missing");
  requireText("hyperliquidTurnkey", 'statuses.every((item) => item === "success")', "hyperliquid_turnkey_cancel_acknowledgement_shape_gate_missing");
  forbidText("hyperliquidTurnkey", "compensateUnprotectedEntry", "hyperliquid_turnkey_untracked_compensation_forbidden");
  requireText("privateExecution", 'return ["venue_access_required", "pre_submit_failed"].includes(error?.code);', "hyperliquid_no_submit_proof_whitelist_missing");
  requireText("privateExecution", '"submission_ambiguous",\n      { cause: error }', "hyperliquid_ambiguous_error_propagation_missing");
  requireText("serverTest", "persists an ambiguous Hyperliquid attempt before refusing any retry", "hyperliquid_ambiguous_retry_test_missing");
  requireText("serverTest", 'assert.equal(firstBody.error_code, "submission_ambiguous")', "hyperliquid_ambiguous_error_code_test_missing");
  requireText("hyperliquidReconcileTest", "classifies only post-broadcast runner failures as submission ambiguous", "hyperliquid_runner_ambiguity_test_missing");
  requireText("hyperliquidTurnkeyTest", "freezes an incomplete Turnkey bracket acknowledgement without an untracked compensation submit", "hyperliquid_turnkey_bracket_ambiguity_test_missing");
  requireText("hyperliquidTurnkeyTest", "never claims a Turnkey cancel when its post-broadcast acknowledgement is incomplete", "hyperliquid_turnkey_cancel_ambiguity_test_missing");
  requireText("hyperliquidTurnkeyTest", "never claims a Turnkey order from malformed acknowledgements", "hyperliquid_turnkey_order_shape_test_missing");
  requireText("hyperliquidTurnkeyTest", "never claims a Turnkey cancel from a malformed acknowledgement", "hyperliquid_turnkey_cancel_shape_test_missing");
  requireText("hyperliquidTurnkeyTest", "freezes a Turnkey transport failure after submission starts", "hyperliquid_turnkey_transport_ambiguity_test_missing");
  requireText("hyperliquid", "venueCloid === targetCloid", "hyperliquid_reconciliation_response_binding_missing");
  requireText("hyperliquid", "isTerminalHyperliquidOrderStatus(normalizedVenueOrderStatus)", "hyperliquid_reconciliation_terminal_gate_missing");
  requireText("hyperliquidReconcileTest", "rejects an orderStatus row that does not match the requested CLOID", "hyperliquid_reconciliation_response_binding_test_missing");
  requireText("hyperliquidReconcileTest", "keeps a matching open order non-terminal", "hyperliquid_reconciliation_terminal_test_missing");
  requireText("aster", "submitAndReconcileAsterExecution", "aster_exact_reconcile_missing");
  requireText("aster", "target_client_order_matched", "aster_target_match_proof_missing");
  requireText("lighter", "submitAndReconcileLighterExecution", "lighter_exact_reconcile_missing");
  requireText("lighter", "target_client_order_matched", "lighter_target_match_proof_missing");
  requireText("webConnectorReconciliation", 'if (venueId === "aster") return "/venues/aster/reconcile";', "web_aster_reconcile_route_binding_missing");
  requireText("webConnectorReconciliation", 'if (venueId === "lighter") return "/venues/lighter/reconcile";', "web_lighter_reconcile_route_binding_missing");
  requireText("webConnectorReconciliation", 'if (venueId === "coinbase_advanced") return "/venues/coinbase/reconcile";', "web_coinbase_reconcile_route_binding_missing");
  requireText("webConnectorReconciliation", 'return "/hyperliquid/reconcile";', "web_hyperliquid_reconcile_route_binding_missing");
  requireText("webConnectorReconciliation", "encrypted_execution_instruction_bundle: input.encrypted_execution_instruction_bundle", "web_sealed_reconcile_instruction_missing");
  requireText("webConnectorReconciliation", "proof.venue_id !== input.venueId", "web_reconcile_proof_venue_binding_missing");
  requireText("webConnectorReconciliationTest", "binds %s reconciliation route, vault, instruction, and proof", "web_reconcile_exact_venue_test_missing");
  requireText("webConnectorReconciliationTest", "rejects a cross-venue proof for an exact Lighter reconciliation", "web_reconcile_cross_venue_negative_test_missing");
  requireText("aster", "original_order_broadcast_proven: exactOriginalOrderObserved", "aster_original_broadcast_proof_missing");
  requireText("lighter", "original_order_broadcast_proven: exactOriginalOrderObserved", "lighter_original_broadcast_proof_missing");
  requireText("lighter", "unsignedDecimalIntegerText(order?.order_index) !== null", "lighter_original_order_id_proof_missing");
  requireText("lighterTest", "assert.equal(zeroWithoutOrderIndex.final_proof.original_order_target_matched, false)", "lighter_missing_order_id_negative_test_missing");
  requireText("multiLegOrchestrator", "proof?.original_order_broadcast_proven === true", "carry_recovery_original_broadcast_gate_missing");
  requireText("multiLegOrchestratorTest", "restart rejects a read-only query without explicit original-order broadcast proof", "carry_recovery_query_only_negative_test_missing");
  requireText("aster", "submission_outcome_ambiguous", "aster_ambiguity_freeze_missing");
  requireText("lighter", "submission_ambiguous", "lighter_ambiguity_freeze_missing");
  requireText("aster", "submission_retry_count: 0", "aster_ambiguous_submit_retry_guard_missing");
  requireText("lighter", "submission_retry_count: 0", "lighter_ambiguous_submit_retry_guard_missing");
  requireText("aster", "const maxAttempts = Math.max", "aster_reconciliation_bound_missing");
  requireText("lighter", "const maxAttempts = Math.max", "lighter_reconciliation_bound_missing");
  requireText("aster", "targetClientOrderId: reconciliationClientOrderId", "aster_reconciliation_target_drift_guard_missing");
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
  requireText("fundingPersistence", "const completedAtMs = now();", "carry_funding_post_fetch_clock_missing");
  requireText("server", "const observedAtMs = Math.max(fetchStartedAtMs, Date.now());", "carry_shadow_http_post_fetch_clock_missing");
  requireText("fundingPersistence", "observeCarryShadowQualification", "carry_shadow_qualification_observer_missing");
  requireText("fundingPersistence", "writeCarryShadowSnapshot", "carry_shadow_snapshot_observer_missing");
  requireText("shadowQualification", "verifyCarryShadowSoak", "carry_shadow_qualification_soak_missing");
  requireText("shadowQualification", "value?.venues === CORE_PERP_VENUES.length", "carry_shadow_qualification_registry_coverage_missing");
  forbidText("shadowQualification", "value?.venues === 5", "carry_shadow_qualification_venue_count_hardcoded");
  requireText("shadowQualification", "PHALA_CVM_IMAGE_DIGEST", "carry_shadow_qualification_image_binding_missing");
  requireText("shadowQualification", "sample_results: sampleResults", "carry_shadow_qualification_persistence_missing");
  requireText("shadowQualification", "source_observation_commitments", "carry_shadow_qualification_source_binding_missing");
  requireText("shadowQualification", "minimum_span_ms: REQUIRED_MINIMUM_SPAN_MS", "carry_shadow_qualification_duration_policy_missing");
  requireText("shadowQualification", "transaction_broadcast: false", "carry_shadow_qualification_no_broadcast_missing");
  requireText("shadowQualification", "export function verifyCarryShadowQualification", "carry_shadow_result_verifier_missing");
  requireText("shadowQualification", "qualification_commitment: qualificationResultCommitment(material)", "carry_shadow_result_commitment_missing");
  requireText("shadowQualificationTest", "rejects tampered qualification summaries", "carry_shadow_result_tamper_test_missing");
  requireText("shadowQualificationTest", "persists three consecutive complete five-venue samples without broadcasting", "carry_shadow_qualification_test_missing");
  requireText("shadowQualificationTest", "does not persist wrapper-only samples when venue source observations are unchanged", "carry_shadow_qualification_wrapper_reuse_test_missing");
  requireText("shadowQualificationTest", "does not qualify rapid source updates before the two-minute observation floor", "carry_shadow_qualification_duration_test_missing");
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
  requireText("fundingPersistenceTest", "post-fetch wall clock for newer Lighter WebSocket evidence", "carry_funding_post_fetch_clock_test_missing");
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
  requireText("server", "carry_supervision: carrySupervision", "carry_entry_private_prime_supervision_binding_missing");
  requireText("executor", "readCarryEntryPrivatePrimeReadiness({", "carry_entry_private_prime_gate_missing");
  requireText("executor", "carry_entry_private_prime_readiness_unproven", "carry_entry_private_prime_fail_closed_missing");
  requireText("executor", 'phase: "exit"', "carry_exit_exact_preflight_phase_missing");
  requireText("executor", "exit_base_size_by_venue", "carry_exit_exact_preflight_quantity_missing");
  requireText("executor", "shape.reduce_only !== true", "carry_exit_reduce_only_proof_missing");
  requireText("preflight", "assertExactExitOrderShape({", "carry_exit_order_shape_verification_missing");
  requireText("preflight", '? "paired_exit_no_submit"', "carry_exit_no_submit_mode_missing");
  requireText("preflightTest", "verifies the exact reduce-only exit sides and filled base quantities", "carry_exit_exact_preflight_test_missing");
  requireText("lighter", "reduce_only: order.reduce_only === true", "lighter_no_submit_reduce_only_binding_missing");
  requireText("hyperliquid", "reduce_only: instruction.order?.reduce_only === true", "hyperliquid_no_submit_reduce_only_binding_missing");
  requireText("privateExecution", 'reduce_only: result.order.reduceOnly === "true"', "aster_no_submit_reduce_only_binding_missing");
  requireText("executor", "readCarryExecutionReadiness({", "carry_entry_three_venue_readiness_missing");
  requireText("executor", "readCarryShadowQualification({ state", "carry_entry_five_venue_shadow_missing");
  requireText("executor", "loadCarryTransferRouteEvidence({", "carry_entry_collateral_route_readiness_missing");
  requireText("lifecycleTest", "private-prime readiness is not current", "carry_entry_private_prime_test_missing");
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
  requireCount("evidenceVerifier", "/^carry:account-state:[0-9a-f]{40}$/", 3, "carry_release_account_state_width_mismatch");
  requireText("evidenceVerifier", "three_venue_position_not_flat", "carry_release_flat_readiness_verifier_missing");
  requireText("evidenceVerifier", "three_venue_liquidation_binding_invalid", "carry_release_liquidation_verifier_missing");
  requireText("evidenceVerifierTest", "without all three execution venue bindings", "carry_release_three_venue_verifier_test_missing");
  requireText("evidenceVerifierTest", "rejects padded three-venue account-state commitments", "carry_release_account_state_width_test_missing");
  requireText("evidenceVerifierTest", "permits ambiguity retries", "carry_release_three_venue_recovery_test_missing");
  requireText("evidenceVerifierTest", "rejects fabricated liquidation distance for a flat readiness account", "carry_release_liquidation_verifier_test_missing");
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
  requireText("server", '"/carry/positions/release-evidence"].includes(url.pathname)', "carry_release_material_worker_no_submit_gate_missing");
  requireText("coreCarry", "export function carryReleaseMaterialAuthenticationMessage", "carry_release_material_auth_message_missing");
  requireText("server", "worker_authentication: authenticateCarryReleaseMaterial({", "carry_release_material_worker_response_binding_missing");
  requireText("releaseMaterialAuthentication", "material_replay_bound: true", "carry_release_material_worker_attestation_missing");
  requireText("releaseMaterialAuthentication", "carryReleaseMaterialResponseCommitment(material)", "carry_release_material_worker_exact_binding_missing");
  requireText("releaseMaterialAuthenticationTest", "attests exact release material and its owner-scoped position request", "carry_release_material_authentication_test_missing");
  requireText("server", '"/carry/positions/exit-request"', "carry_owner_exit_route_missing");
  requireText("server", "requestStoredCarryPositionExit", "carry_owner_exit_boundary_missing");
  requireText("positions", "type: \"manual_exit_requested\"", "carry_owner_exit_event_missing");
  requireText("positions", "if (read.cursor_ms > priorCursor) cursors[read.venue_id] = read.cursor_ms", "carry_funding_backfill_cursor_resume_missing");
  requireText("positionsTest", "authoritative funding backfill resumes across ticks for a year-long Carry Position", "carry_funding_backfill_resume_test_missing");
  const fundingSettlementReader = sourceSection(
    "positions",
    "async function readVenueFundingSettlements({",
    "function compareFundingEntries(",
  );
  requireSectionText(fundingSettlementReader, 'if (!Array.isArray(rows)) throw new Error("funding_settlement_history_invalid")', "carry_funding_history_shape_gate_missing");
  requireSectionText(fundingSettlementReader, 'throw new Error("funding_settlement_evidence_invalid")', "carry_funding_row_fatal_gate_missing");
  requireText("positionsTest", "malformed funding history fails closed without advancing venue completeness", "carry_funding_malformed_history_test_missing");
  requireText("positionsTest", 'result.funding.venue_status.hyperliquid, "funding_settlement_history_invalid"', "carry_funding_malformed_status_assertion_missing");
  requireText("positionsTest", "cursor_ms_by_venue.hyperliquid, NOW + 1", "carry_funding_malformed_cursor_assertion_missing");
  const hyperliquidFundingReader = sourceSection(
    "hyperliquid",
    "export async function readHyperliquidFundingSettlements({",
    "export async function createHyperliquidAccountStateStream({",
  );
  const hyperliquidFundingHistory = sourceSection(
    "hyperliquid",
    "async function readCompleteHyperliquidFundingHistory({",
    "function dedupeHyperliquidFundingSettlements(",
  );
  requireSectionText(hyperliquidFundingHistory, "HYPERLIQUID_FUNDING_MAX_PAGES", "hyperliquid_funding_pagination_bound_missing");
  requireSectionText(hyperliquidFundingHistory, "HYPERLIQUID_FUNDING_ROW_LIMIT", "hyperliquid_funding_row_bound_missing");
  requireSectionText(hyperliquidFundingHistory, "if (!Array.isArray(body)", "hyperliquid_funding_history_shape_gate_missing");
  requireSectionText(hyperliquidFundingHistory, 'type: "userFunding"', "hyperliquid_funding_history_type_binding_missing");
  requireSectionText(hyperliquidFundingHistory, "user: credential.account_address", "hyperliquid_funding_history_account_binding_missing");
  requireSectionText(hyperliquidFundingHistory, "startTime: cursor", "hyperliquid_funding_history_cursor_binding_missing");
  requireSectionText(hyperliquidFundingHistory, "endTime: end", "hyperliquid_funding_history_end_binding_missing");
  requireSectionText(hyperliquidFundingHistory, "distinctTimeCount < HYPERLIQUID_FUNDING_PAGE_LIMIT", "hyperliquid_funding_pagination_completeness_missing");
  requireSectionText(hyperliquidFundingHistory, "if (nextCursor <= cursor)", "hyperliquid_funding_pagination_progress_gate_missing");
  requireSectionText(hyperliquidFundingHistory, "hyperliquid funding history exceeded the bounded pagination window", "hyperliquid_funding_pagination_fail_closed_missing");
  requireSectionText(hyperliquidFundingReader, "readCompleteHyperliquidFundingHistory({", "hyperliquid_complete_funding_history_reader_missing");
  requireSectionText(hyperliquidFundingReader, "dedupeHyperliquidFundingSettlements(settlements)", "hyperliquid_funding_deduplication_missing");
  requireText("hyperliquid", "const HYPERLIQUID_FUNDING_PAGE_LIMIT = 500", "hyperliquid_funding_page_limit_missing");
  requireText("hyperliquid", "const HYPERLIQUID_FUNDING_MAX_PAGES = 64", "hyperliquid_funding_max_pages_missing");
  requireText("hyperliquid", "const HYPERLIQUID_FUNDING_ROW_LIMIT = 50_000", "hyperliquid_funding_row_limit_missing");
  requireText("hyperliquidMetricsTest", "paginates more than 500 Hyperliquid funding blocks with inclusive-boundary dedupe", "hyperliquid_funding_pagination_test_missing");
  requireText("hyperliquidMetricsTest", "fails closed when Hyperliquid funding pagination does not advance", "hyperliquid_funding_pagination_stall_test_missing");
  requireText("hyperliquidMetricsTest", "does not mistake a full cross-coin shared-timestamp page for complete funding", "hyperliquid_funding_shared_timestamp_test_missing");
  requireSectionText(hyperliquidFundingReader, "for (const row of rows)", "hyperliquid_funding_all_rows_validation_missing");
  requireSectionText(hyperliquidFundingReader, 'throw new HyperliquidExecutionError("hyperliquid funding history row asset is invalid"', "hyperliquid_funding_asset_row_fatal_gate_missing");
  requireSectionText(hyperliquidFundingReader, "if (rowCoin !== coin) continue", "hyperliquid_funding_target_asset_filter_missing");
  requireSectionText(hyperliquidFundingReader, 'throw new HyperliquidExecutionError("hyperliquid funding history row is invalid"', "hyperliquid_funding_target_row_fatal_gate_missing");
  requireOrdered(hyperliquidFundingReader, "funding history row asset is invalid", "if (rowCoin !== coin) continue", "hyperliquid_funding_asset_validation_before_filter_missing");
  requireText("hyperliquidMetricsTest", "rejects a malformed in-window Hyperliquid target settlement instead of omitting a debit", "hyperliquid_funding_malformed_target_test_missing");
  requireText("hyperliquidMetricsTest", 'error.message === "hyperliquid funding history row is invalid"', "hyperliquid_funding_malformed_target_assertion_missing");
  const lighterFundingReader = sourceSection(
    "lighter",
    "export async function readLighterFundingSettlements({",
    "function normalizeOrder(",
  );
  requireSectionText(lighterFundingReader, "!Array.isArray(result?.funding_rows)", "lighter_funding_history_shape_gate_missing");
  requireSectionText(lighterFundingReader, "returnedAccountIndex !== credential.account_index", "lighter_funding_history_account_binding_missing");
  requireSectionText(lighterFundingReader, "returnedMarketId === null", "lighter_funding_history_market_binding_missing");
  requireSectionText(lighterFundingReader, 'String(result?.symbol || "").toUpperCase() !== expectedMarket', "lighter_funding_history_symbol_binding_missing");
  requireSectionText(lighterFundingReader, "return rows.map((row) =>", "lighter_funding_all_rows_validation_missing");
  requireSectionText(lighterFundingReader, 'row.type !== "funding"', "lighter_funding_row_type_binding_missing");
  requireSectionText(lighterFundingReader, "nonnegativeIntegerOrNull(row.market_id ?? row.market_index) !== returnedMarketId", "lighter_funding_row_market_binding_missing");
  requireSectionText(lighterFundingReader, 'throw new LighterExecutionError("lighter funding history row is invalid"', "lighter_funding_row_fatal_gate_missing");
  const lighterRunnerFunding = sourceSection(
    "lighterRunner",
    'if action == "funding":',
    '        fail("unsupported lighter runner action")',
  );
  requireSectionText(lighterRunnerFunding, '"account_index": int(credential["account_index"])', "lighter_runner_funding_account_binding_missing");
  requireSectionText(lighterRunnerFunding, '"market_id": int(market.market_id)', "lighter_runner_funding_market_binding_missing");
  requireSectionText(lighterRunnerFunding, '"type": "funding"', "lighter_runner_funding_type_binding_missing");
  requireSectionText(lighterRunnerFunding, 'if row.get("type") != "funding":', "lighter_runner_funding_row_type_gate_missing");
  requireSectionText(lighterRunnerFunding, 'exact_integer(row.get("market_id"), "lighter funding market is invalid") != market_id', "lighter_runner_funding_row_market_gate_missing");
  requireSectionText(lighterRunnerFunding, '"account_index": int(credential["account_index"])', "lighter_runner_funding_account_output_missing");
  requireSectionText(lighterRunnerFunding, '"market_id": market_id', "lighter_runner_funding_market_output_missing");
  requireText("lighterTest", "rejects mixed-type or cross-account/market Lighter funding reads", "lighter_funding_binding_test_missing");
  requireText("lighterTest", "rejects a malformed in-window Lighter settlement instead of omitting a debit", "lighter_funding_malformed_target_test_missing");
  requireText("lighterTest", 'error.message === "lighter funding history row is invalid"', "lighter_funding_malformed_target_assertion_missing");
  requireText("positionsTest", "requestStoredCarryPositionExit", "carry_owner_exit_boundary_test_missing");
  forbidText("server", '"/carry/positions/events"', "carry_client_lifecycle_mutation_exposed");
  forbidText("server", '"/carry/positions/value-entries"', "carry_client_value_entry_mutation_exposed");
  forbidText("server", '"/carry/positions/finalize"', "carry_client_value_finalization_exposed");
  requireText("serverTest", '"/carry/positions/value-entries"', "carry_retired_value_mutation_route_test_missing");
  requireText("server", '"/carry/preflight-matrix"', "carry_three_venue_no_submit_worker_route_missing");
  requireText("serverTest", "proves the three-venue no-submit matrix and durable exact account state over HTTP", "carry_three_venue_no_submit_http_proof_missing");
  requireText("preflight", "matrix.readiness_evidence = stored.evidence", "carry_three_venue_raw_readiness_evidence_missing");
  requireText("readiness", "evidence: Object.freeze(structuredClone(evidence))", "carry_three_venue_raw_readiness_return_missing");
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
  requireText("privatePrimeAuthentication", "const context = Object.freeze({", "carry_private_prime_worker_signed_context_missing");
  requireText("privatePrimeAuthentication", "context,", "carry_private_prime_worker_context_evidence_missing");
  requireText("workerAttestedSigner", "export function signAttestedWorkerMessage", "carry_attested_worker_signer_missing");
  requireText("privatePrimeAuthenticationTest", "exact no-submit request", "carry_private_prime_worker_authentication_test_missing");
  requireText("privatePrimeAuthenticationTest", "context: proof.context", "carry_private_prime_worker_context_test_missing");
  requireText("noSubmitEvidenceVerifier", "assessCarryExecutionReadiness({", "carry_no_submit_independent_readiness_verifier_missing");
  requireText("noSubmitEvidenceVerifier", "attestedSignatureValid", "carry_no_submit_independent_signature_verifier_missing");
  requireText("noSubmitEvidenceVerifier", "expected_signer_public_keys_b64", "carry_no_submit_independent_signer_pin_missing");
  requireText("noSubmitEvidenceVerifier", "capturedAtMs >= privatePrimeCheckedAtMs", "carry_no_submit_historical_capture_binding_missing");
  requireText("noSubmitEvidenceVerifierTest", "tampered pair evidence, request context, signer identity, and candidate identity", "carry_no_submit_independent_tamper_test_missing");
  requireText("noSubmitEvidenceVerifierTest", "preserves historical proof after freshness expires", "carry_no_submit_historical_proof_test_missing");
  requireText("noSubmitEvidenceVerifier", "!containsCarryNoSubmitCredentialMaterial(response)", "carry_no_submit_independent_secret_gate_missing");
  requireText("noSubmitEvidenceVerifierTest", "no_submit_credential_material_present", "carry_no_submit_independent_secret_test_missing");
  requireText("noSubmitEvidenceAssembler", "sanitizeRequest", "carry_no_submit_assembler_sanitization_missing");
  requireText("noSubmitEvidenceAssembler", "containsCarryNoSubmitCredentialMaterial(response)", "carry_no_submit_assembler_response_secret_gate_missing");
  requireText("noSubmitEvidenceAssembler", "atomicWriteJson", "carry_no_submit_assembler_atomic_write_missing");
  requireText("noSubmitEvidenceAssembler", "policy_commitment", "carry_no_submit_assembler_policy_binding_missing");
  requireText("noSubmitEvidenceAssemblerTest", "sanitizes sealed access", "carry_no_submit_assembler_secret_redaction_test_missing");
  requireText("noSubmitEvidenceAssemblerTest", "never persists a matrix response containing credential material", "carry_no_submit_assembler_response_secret_test_missing");
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
  requireText("releaseMaterial", "material.position.position_id,\n    venueIds,", "carry_lifecycle_proof_position_pair_record_binding_missing");
  requireText("releaseMaterial", "carryLifecycleProofReferenceKey(\n        ownerCommitment,\n        imageDigest,\n        normalizedAsset,\n        positionId,", "carry_lifecycle_proof_position_reference_read_binding_missing");
  requireText("releaseMaterial", "reference.proof_key === carryLifecycleProofKey", "carry_lifecycle_proof_reference_integrity_missing");
  requireText("releaseMaterial", "state.claimIdempotency(proofKey", "carry_lifecycle_proof_body_atomic_claim_missing");
  requireText("releaseMaterial", "state.claimIdempotency(referenceKey", "carry_lifecycle_proof_reference_atomic_claim_missing");
  requireText("workerState", "async claimIdempotency(workOrderCommitment, receipt)", "carry_lifecycle_proof_reference_atomic_state_missing");
  requireText("releaseMaterial", "proof_evidence_commitment: proof.evidence_commitment", "carry_lifecycle_proof_reference_content_binding_missing");
  requireText("releaseMaterial", "carryLifecycleProofIndexKey(ownerCommitment, imageDigest, normalizedAsset)", "carry_lifecycle_proof_legacy_index_read_missing");
  requireText("releaseMaterial", "validLifecycleProofIndex(legacyIndex", "carry_lifecycle_proof_legacy_index_validation_missing");
  requireText("releaseMaterial", "validLegacyJsonLifecycleProofReference(reference, expected)", "carry_lifecycle_proof_86b_reference_validation_missing");
  requireText("releaseMaterial", "legacyJsonLifecycleProofReferenceMatchesProof", "carry_lifecycle_proof_86b_reference_binding_missing");
  requireText("releaseMaterial", "const derivedReference = (await state.getIdempotency(derivedReferenceKey))?.receipt", "carry_lifecycle_proof_unscoped_reference_read_missing");
  requireText("releaseMaterial", "const anyReference = await state.hasIdempotencyReceipt", "carry_lifecycle_proof_unscoped_reference_discovery_missing");
  requireText("workerState", "async hasIdempotencyReceipt", "carry_lifecycle_proof_reference_discovery_state_missing");
  requireText("releaseMaterial", "carry_lifecycle_proof_reference_missing", "carry_lifecycle_proof_orphaned_pair_gate_missing");
  requireText("releaseMaterial", "legacyIndexValid && positionId && !legacyEntry", "carry_lifecycle_proof_index_position_miss_gate_missing");
  requireText("releaseMaterial", "sameLifecycleProofSemantics(persistedProof, proof)", "carry_lifecycle_proof_retry_semantics_missing");
  requireText("releaseMaterial", "structuredClone(persistedProof)", "carry_lifecycle_proof_legacy_pointer_immutability_missing");
  requireText("releaseMaterial", "asset: normalizedAsset", "carry_lifecycle_proof_asset_assessment_binding_missing");
  requireCount("server", "readCompletedCarryLifecycleProof({\n            state,\n            owner_commitment: body.owner_commitment,\n            asset: body.asset,", 2, "carry_lifecycle_proof_asset_http_binding_missing");
  requireText("releaseMaterialTest", "keeps lifecycle proof storage isolated per asset, position, and venue pair", "carry_lifecycle_proof_pair_isolation_test_missing");
  requireText("releaseMaterialTest", "atomically claims immutable lifecycle references under concurrent writes", "carry_lifecycle_proof_reference_concurrency_test_missing");
  requireText("releaseMaterialTest", "returns the original immutable proof on a default fresh-timestamp retry without refreshing expiry", "carry_lifecycle_proof_body_immutability_test_missing");
  requireText("releaseMaterialTest", "returns one immutable proof when fresh-timestamp retries race", "carry_lifecycle_proof_body_concurrency_test_missing");
  requireText("releaseMaterialTest", "reads and atomically migrates a real pre-reference lifecycle proof index", "carry_lifecycle_proof_legacy_index_migration_test_missing");
  requireText("releaseMaterialTest", "reads exact 86b JSON-pair references with and without a position without overwriting them", "carry_lifecycle_proof_86b_compatibility_test_missing");
  requireText("releaseMaterialTest", "unscopedHybrid.error", "carry_lifecycle_proof_86b_unscoped_hybrid_test_missing");
  requireText("releaseMaterialTest", "redirectedAlias.position_id", "carry_lifecycle_proof_unscoped_locator_tamper_test_missing");
  requireText("releaseMaterialTest", "rejects tampered current references on unscoped reads", "carry_lifecycle_proof_current_unscoped_tamper_test_missing");
  requireText("releaseMaterialTest", "unscopedMigrated.proof_key", "carry_lifecycle_proof_pre86_unscoped_migration_test_missing");
  requireText("releaseMaterialTest", "indexedMiss.error", "carry_lifecycle_proof_index_position_miss_test_missing");
  requireText("releaseMaterialTest", "legacyLoaded.proof", "carry_lifecycle_proof_three_arg_compatibility_test_missing");
  requireText("releaseMaterialTest", "legacyPositionLoaded.proof", "carry_lifecycle_proof_three_arg_position_compatibility_test_missing");
  requireText("releaseMaterial", "final_flat_zero_orders: true", "carry_lifecycle_proof_flat_gate_missing");
  requireText("releaseMaterial", "proof?.broadcast_performed !== true", "carry_lifecycle_proof_live_broadcast_gate_missing");
  requireText("releaseMaterial", "proof.evidence_commitment === lifecycleProofCommitment(proof)", "carry_lifecycle_proof_integrity_gate_missing");
  requireText("releaseMaterial", "safeLifecycleValueAttribution(proof.value_attribution)", "carry_lifecycle_proof_value_attribution_gate_missing");
  requireText("releaseMaterial", "normalizeCarryLifecycleValueAttribution", "carry_lifecycle_proof_shared_value_attribution_missing");
  const lifecycleProofRecorder = sourceSection(
    "releaseMaterial",
    "export async function recordCompletedCarryLifecycleProof({",
    "export async function readCompletedCarryLifecycleProof({",
  );
  requireSectionText(lifecycleProofRecorder, "value_boundary_authoritative: true", "carry_lifecycle_proof_authoritative_value_marker_missing");
  requireSectionText(lifecycleProofRecorder, "exposure_boundary_provenance: AUTHORITATIVE_EXPOSURE_BOUNDARY_PROVENANCE", "carry_lifecycle_proof_authoritative_provenance_marker_missing");
  const lifecycleProofAssessment = sourceSection(
    "releaseMaterial",
    "export function assessCompletedCarryLifecycleProof({",
    "export function carryLifecycleProofKey(",
  );
  requireSectionText(lifecycleProofAssessment, "proof.value_boundary_authoritative === true", "carry_lifecycle_proof_authoritative_value_assessment_missing");
  requireSectionText(lifecycleProofAssessment, "proof.exposure_boundary_provenance === AUTHORITATIVE_EXPOSURE_BOUNDARY_PROVENANCE", "carry_lifecycle_proof_authoritative_provenance_assessment_missing");
  const authoritativeLifecycleBoundary = sourceSection(
    "releaseMaterial",
    "function authoritativeLifecycleExposureBoundary(",
    "export function carryLifecycleProofKey(",
  );
  requireSectionText(authoritativeLifecycleBoundary, "venueIds.length === 2", "carry_lifecycle_exposure_two_venue_gate_missing");
  requireSectionText(authoritativeLifecycleBoundary, "new Set(venueIds).size === 2", "carry_lifecycle_exposure_distinct_venue_gate_missing");
  requireSectionText(authoritativeLifecycleBoundary, "Object.keys(value).length === venueIds.length", "carry_lifecycle_exposure_map_completeness_missing");
  requireSectionText(authoritativeLifecycleBoundary, "Object.hasOwn(value, venueId)", "carry_lifecycle_exposure_map_membership_missing");
  requireSectionText(authoritativeLifecycleBoundary, "Number.isSafeInteger(boundaryByVenue[venueId])", "carry_lifecycle_exposure_time_shape_gate_missing");
  requireSectionText(authoritativeLifecycleBoundary, "provenanceByVenue[venueId] === AUTHORITATIVE_EXPOSURE_BOUNDARY_PROVENANCE", "carry_release_authoritative_venue_provenance_missing");
  requireSectionText(authoritativeLifecycleBoundary, "Math.min(...venueIds.map((venueId) => boundaryByVenue[venueId]))", "carry_lifecycle_exposure_global_minimum_binding_missing");
  const authoritativeReleaseBoundary = sourceSection(
    "releaseMaterial",
    "function authoritativeCarryExposureBoundary({",
    "function authoritativeReleaseFillTiming(",
  );
  requireSectionText(authoritativeReleaseBoundary, "record.position.active_boundary_provenance !== AUTHORITATIVE_EXPOSURE_BOUNDARY_PROVENANCE", "carry_release_authoritative_position_boundary_missing");
  requireSectionText(authoritativeReleaseBoundary, "Object.keys(boundaryByVenue).length !== 2", "carry_release_authoritative_venue_boundary_completeness_missing");
  requireSectionText(authoritativeReleaseBoundary, "provenanceByVenue[venueId] === AUTHORITATIVE_EXPOSURE_BOUNDARY_PROVENANCE", "carry_release_authoritative_venue_provenance_missing");
  requireSectionText(authoritativeReleaseBoundary, "leg.first_exposure_observed_at_ms === boundaryByVenue[venueId]", "carry_release_authoritative_saga_boundary_binding_missing");
  const authoritativeReleaseFillTiming = sourceSection(
    "releaseMaterial",
    "function authoritativeReleaseFillTiming(",
    "async function materialLegs(",
  );
  requireSectionText(authoritativeReleaseFillTiming, "proof?.fill_times_authoritative === true", "carry_release_authoritative_fill_time_marker_missing");
  requireSectionText(authoritativeReleaseFillTiming, "proof?.fill_time_provenance === sourceProvenance", "carry_release_authoritative_fill_time_source_missing");
  requireSectionText(authoritativeReleaseFillTiming, "Math.min(...fillTimes) === firstFillAtMs", "carry_release_authoritative_fill_time_minimum_missing");
  requireSectionText(authoritativeReleaseFillTiming, "Math.max(...fillTimes) === lastFillAtMs", "carry_release_authoritative_fill_time_maximum_missing");
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
  const webLifecycleReadiness = sourceSection(
    "webPrivatePrimeReadiness",
    "const lifecycleReady =",
    "const proofBoundaryValid =",
  );
  requireSectionText(webLifecycleReadiness, "pairedLifecycle.value_boundary_authoritative === true", "carry_private_prime_ui_authoritative_value_gate_missing");
  requireSectionText(webLifecycleReadiness, 'pairedLifecycle.exposure_boundary_provenance === "authoritative_exchange_fill_time"', "carry_private_prime_ui_authoritative_provenance_gate_missing");
  requireText("webPrivatePrimeReadinessTest", 'exposure_boundary_provenance: "worker_observed_positive_fill_conservative"', "carry_private_prime_ui_conservative_provenance_test_missing");
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
  requireText("privatePrimeReadiness", "complete_directed_coverage: completeDirectedCoverage", "carry_private_prime_route_coverage_output_missing");
  requireText("privatePrimeReadiness", 'technicalReasons.push("collateral_route_coverage_incomplete")', "carry_private_prime_route_coverage_gate_missing");
  requireText("webPrivatePrimeReadiness", "route.complete_directed_coverage === true", "carry_private_prime_ui_route_coverage_gate_missing");
  requireText("privatePrimeReadiness", "failure_recovery: failureRecovery", "carry_private_prime_recovery_output_missing");
  requireText("readiness", "qualification: recoveryQualificationRecord(item.qualification)", "carry_recovery_qualification_binding_missing");
  requireText("readiness", "carry_recovery_qualification_unproven", "carry_recovery_unproven_gate_missing");
  requireText("readiness", "capability?.status === \"implemented_unproven\"", "carry_recovery_lifecycle_qualification_gate_missing");
  requireText("readinessTest", "does not promote registered recovery adapters without deployment-bound lifecycle qualification", "carry_recovery_qualification_test_missing");
  requireText("privatePrimeReadiness", "reasons.length === 0", "carry_private_prime_recovery_reason_gate_missing");
  requireText("webPrivatePrimeReadiness", "recoveryReasons.length === 0", "carry_private_prime_ui_recovery_reason_gate_missing");
  requireText("webPrivatePrimeReadinessTest", "rejects recovery labels backed only by unproven adapter registration", "carry_private_prime_ui_recovery_qualification_test_missing");
  requireText("privatePrimeReadiness", 'technicalReasons.push("three_venue_recovery_unproven")', "carry_private_prime_recovery_gate_missing");
  requireText("privatePrimeReadiness", "const noSubmitReady = technicalReasons.length === 0", "carry_private_prime_capital_free_no_submit_gate_missing");
  requireText("privatePrimeReadiness", "noSubmitReady && capitalReady && pairedLifecycle.verified", "carry_private_prime_live_capital_gate_missing");
  requireText("privatePrimeReadinessTest", "refuses private-prime readiness without exact three-venue recovery policy", "carry_private_prime_recovery_test_missing");
  requireText("privatePrimeReadinessTest", "without overstating live proof", "carry_private_prime_proof_boundary_test_missing");
  requireText("privatePrimeReadinessTest", "durable paired lifecycle evidence", "carry_private_prime_live_proof_test_missing");
  requireText("privatePrimeReadinessTest", "lifecycle proof with a valid-looking but mismatched commitment", "carry_private_prime_lifecycle_commitment_test_missing");
  requireText("privatePrimeReadinessTest", "without fresh owner-bound route evidence", "carry_private_prime_route_evidence_test_missing");
  requireText("privatePrimeReadinessTest", "without complete directed collateral routes", "carry_private_prime_route_coverage_test_missing");
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
  requireText("webPrivatePrimeAuthentication", "context.work_order_commitment === workOrderCommitment", "carry_private_prime_gateway_signed_context_missing");
  requireText("webPrivatePrimeAuthentication", "MAX_AUTHENTICATED_RESPONSE_AGE_MS = 30_000", "carry_private_prime_gateway_response_age_bound_missing");
  requireText("webPrivatePrimeAuthentication", "checkedAtMs < now_ms - MAX_AUTHENTICATED_RESPONSE_AGE_MS", "carry_private_prime_gateway_response_freshness_missing");
  requireText("webPrivatePrimeAuthentication", "context.expires_at_ms === expiresAtMs", "carry_private_prime_gateway_readiness_expiry_binding_missing");
  forbidText("webPrivatePrimeAuthentication", "expiresAtMs > now_ms", "carry_private_prime_gateway_negative_readiness_rejected");
  requireText("webPrivatePrimeAuthenticationTest", "replay under another work order", "carry_private_prime_gateway_authentication_test_missing");
  requireText("webPrivatePrimeAuthenticationTest", "evidence is expired or has no expiry", "carry_private_prime_gateway_negative_readiness_test_missing");
  requireText("webPrivatePrimeAuthenticationTest", 'reason: "response_age"', "carry_private_prime_gateway_response_age_test_missing");
  requireText("webPrivatePrimeAuthenticationTest", "contextTampered", "carry_private_prime_gateway_context_tamper_test_missing");
  requireText("webPrivatePrimeAuthenticationTest", 'GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: "wrong-pin"', "carry_private_prime_gateway_signer_pin_test_missing");
  requireText("webRoute", "verifyCarryPrivatePrimeWorkerAuthentication({", "carry_private_prime_gateway_authentication_missing");
  requireText("webRoute", "workerCapabilitySecret(process.env) || worker.token", "carry_private_prime_gateway_authentication_secret_missing");
  requireText("webRoute", "authentication_reason: authenticated.reason", "carry_private_prime_gateway_diagnostic_missing");
  requireText("webRoute", "return response({ error: authenticated.error }, 502", "carry_private_prime_gateway_authentication_fail_closed_missing");
  requireText("webRoute", "verifyCarryReleaseMaterialWorkerAuthentication({", "carry_release_material_gateway_authentication_missing");
  requireText("webRoute", 'action === "release_evidence" ? { "x-ghola-no-submit-verify": "true" }', "carry_release_material_gateway_no_submit_gate_missing");
  requireText("webReleaseMaterialAuthentication", "carry:release-response:", "carry_release_material_gateway_exact_binding_missing");
  requireText("webReleaseMaterialAuthentication", "GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64", "carry_release_material_gateway_signer_pin_missing");
  requireText("webReleaseMaterialAuthentication", "ed25519.verify(", "carry_release_material_gateway_signature_missing");
  requireText("webReleaseMaterialAuthenticationTest", "accepts only exact fresh release material for the requested owner and position", "carry_release_material_gateway_test_missing");
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
  requireText("webCarryBuilder", "const canSave = routeQualified && actionableProof && creationProofFreshness.fresh", "carry_creation_stale_action_gate_missing");
  requireText(
    "webCarryBuilder",
    "if (!executionPair || !privateSessionReady || !routeQualified || autoRunNoSubmitConsumedRef.current) return;",
    "carry_terminal_stale_route_check_gate_missing",
  );
  requireText("webCarryBuilderTest", "hides retained route economics when the route is stale", "carry_terminal_stale_route_economics_test_missing");
  requireText("webCarryBuilder", "const canEnter = routeQualified && current?.position.status === \"draft\"", "carry_terminal_stale_route_entry_gate_missing");
  requireText("webCarryChart", "const terminalExecution = selectedExecution || retainedForDesiredRoute;", "carry_terminal_transient_route_retention_missing");
  requireText("webCarryChart", "key={carryRouteKey(terminalExecution.candidate)}", "carry_terminal_route_state_scope_missing");
  requireText("webCarryChartTest", "keeps the selected terminal mounted through a transient live-route gap", "carry_terminal_transient_route_retention_test_missing");
  requireText("webCarryChartTest", "remounts route-scoped state when a stale route is explicitly replaced", "carry_terminal_route_state_scope_test_missing");
  requireText("webCarryBuilderTest", "keeps an immediate pending receipt while a live route briefly loses qualification", "carry_terminal_pending_receipt_test_missing");
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
  requireText("webTradeWorkspace", "carryTerminalChrome(carryWorkspaceOpen)", "carry_venue_neutral_chrome_missing");
  requireText("webTradeWorkspace", "carryChrome.showVenueReadiness", "carry_venue_readiness_chrome_gate_missing");
  requireText("webTradeWorkspace", "carryChrome.showVenueMarketStats", "carry_venue_market_chrome_gate_missing");
  requireText("webTradeWorkspace", "carryChrome.showVenueActivity", "carry_venue_activity_chrome_gate_missing");
  requireText("webTradeWorkspace", "carryChrome.showVenueOrderTicket", "carry_venue_ticket_chrome_gate_missing");
  requireText("webTradeWorkspace", "carryChrome.showReferenceChart", "carry_reference_chart_gate_missing");
  requireText("webCarryTerminalChrome", "showVenueReadiness: false", "carry_venue_readiness_not_hidden");
  requireText("webCarryTerminalChrome", "showVenueMarketStats: false", "carry_venue_market_stats_not_hidden");
  requireText("webCarryTerminalChrome", "showVenueActivity: false", "carry_venue_activity_not_hidden");
  requireText("webCarryTerminalChrome", "showVenueOrderTicket: false", "carry_venue_ticket_not_hidden");
  requireText("webCarryTerminalChrome", "showReferenceChart: true", "carry_reference_chart_hidden");
  requireText("webCarryTerminalChromeTest", "keeps the reference chart while removing venue-owned terminal chrome", "carry_venue_neutral_chrome_test_missing");
  requireText("webTradeWorkspace", "{carryWorkspaceOpen ? <CarryPositionRail /> : null}", "carry_persistent_position_rail_missing");
  requireText("webCarryPositionRail", "listCarryPositions", "carry_position_rail_authoritative_sync_missing");
  forbidText("webCarryPositionRail", "executeCarryPositionEntry", "carry_position_rail_live_entry_exposed");
  forbidText("webCarryPositionRail", "requestCarryPositionExit", "carry_position_rail_live_exit_exposed");
  forbidText("webCarryPositionRail", "createCarryPosition", "carry_position_rail_live_creation_exposed");
  requireText("webCarryPositionRailTest", "keeps one authoritative Carry Position visible without a scanner candidate", "carry_position_rail_independence_test_missing");
  requireText("coreCarry", "active_observed_at_ms: null", "carry_active_observed_boundary_domain_missing");
  requireText("coreCarry", "active_boundary_provenance: null", "carry_active_boundary_provenance_domain_missing");
  const coreCarryEntryReconciliation = sourceSection(
    "coreCarry",
    'if (event.type === "entry_reconciled") {',
    'if (event.type === "entry_failed_no_fill") {',
  );
  requireSectionText(coreCarryEntryReconciliation, "event.first_exposure_observed_at_ms ?? event.first_exposure_at_ms", "carry_active_observed_event_binding_missing");
  requireSectionText(coreCarryEntryReconciliation, '"carry_first_exposure_observed_at_ms"', "carry_active_observed_validation_missing");
  requireSectionText(coreCarryEntryReconciliation, '"legacy_worker_observed_alias"', "carry_active_legacy_provenance_missing");
  requireSectionText(coreCarryEntryReconciliation, '"worker_observed_positive_fill"', "carry_active_observed_provenance_missing");
  requireSectionText(coreCarryEntryReconciliation, "enumValue(event.exposure_boundary_provenance", "carry_active_provenance_validation_missing");
  requireSectionText(coreCarryEntryReconciliation, "carry_active_boundary_already_set", "carry_active_boundary_immutability_missing");
  requireSectionText(coreCarryEntryReconciliation, "position.active_observed_at_ms = activeObservedAtMs", "carry_active_observed_assignment_missing");
  requireSectionText(coreCarryEntryReconciliation, "position.active_boundary_provenance = boundaryProvenance", "carry_active_provenance_assignment_missing");
  requireCount("coreMultiLeg", "first_exposure_observed_at_ms: null", 2, "carry_first_observed_exposure_domain_missing");
  requireCount("coreMultiLeg", "exposure_boundary_provenance: null", 2, "carry_first_exposure_provenance_domain_missing");
  requireText("coreMultiLeg", 'const AUTHORITATIVE_EXPOSURE_BOUNDARY_PROVENANCE = "authoritative_exchange_fill_time"', "carry_authoritative_exposure_provenance_missing");
  requireText("coreMultiLeg", 'const CONSERVATIVE_EXPOSURE_BOUNDARY_PROVENANCE = "worker_observed_positive_fill_conservative"', "carry_conservative_exposure_provenance_missing");
  const firstExposureCapture = sourceSection("coreMultiLeg", "function applyEntryFill(saga,", "function sagaLeg(saga,");
  requireSectionText(firstExposureCapture, "const previousLegFill = leg.filled_micro_usdc", "carry_first_exposure_transition_guard_missing");
  requireSectionText(firstExposureCapture, "previousLegFill === 0 && leg.filled_micro_usdc > 0", "carry_first_positive_fill_gate_missing");
  requireSectionText(firstExposureCapture, "const boundary = exposureBoundaryFromEvent(saga, event, nowMs)", "carry_first_exposure_event_boundary_missing");
  requireSectionText(firstExposureCapture, "leg.first_exposure_observed_at_ms = boundary.observed_at_ms", "carry_first_observed_exposure_capture_missing");
  requireSectionText(firstExposureCapture, "leg.exposure_boundary_provenance = boundary.provenance", "carry_first_exposure_provenance_capture_missing");
  requireSectionText(firstExposureCapture, "refreshExposureBoundary(saga)", "carry_first_exposure_refresh_missing");
  const exposureBoundaryFromEvent = sourceSection("coreMultiLeg", "function exposureBoundaryFromEvent(", "function refreshExposureBoundary(");
  requireSectionText(exposureBoundaryFromEvent, "provenance === undefined && observedAtMs === undefined", "carry_missing_fill_time_conservative_pair_gate_missing");
  requireSectionText(exposureBoundaryFromEvent, 'positiveInteger(saga.created_at_ms, "first_exposure_observed_at_ms")', "carry_missing_fill_time_conservative_boundary_missing");
  requireSectionText(exposureBoundaryFromEvent, "provenance: CONSERVATIVE_EXPOSURE_BOUNDARY_PROVENANCE", "carry_missing_fill_time_conservative_provenance_missing");
  requireSectionText(exposureBoundaryFromEvent, "provenance !== AUTHORITATIVE_EXPOSURE_BOUNDARY_PROVENANCE", "carry_fill_time_provenance_validation_missing");
  requireSectionText(exposureBoundaryFromEvent, 'positiveInteger(observedAtMs, "first_exposure_observed_at_ms")', "carry_authoritative_fill_time_validation_missing");
  requireSectionText(exposureBoundaryFromEvent, "authoritativeAtMs < saga.created_at_ms || authoritativeAtMs > nowMs", "carry_authoritative_fill_time_bounds_missing");
  const refreshExposureBoundary = sourceSection("coreMultiLeg", "function refreshExposureBoundary(", "function sagaLeg(");
  requireSectionText(refreshExposureBoundary, "saga.legs.filter((leg) => leg.filled_micro_usdc > 0)", "carry_exposed_leg_boundary_selection_missing");
  requireSectionText(refreshExposureBoundary, "exposed.every((leg) =>", "carry_all_exposed_legs_authoritative_gate_missing");
  requireSectionText(refreshExposureBoundary, "leg.exposure_boundary_provenance === AUTHORITATIVE_EXPOSURE_BOUNDARY_PROVENANCE", "carry_exposed_leg_authoritative_provenance_missing");
  requireSectionText(refreshExposureBoundary, "Number.isSafeInteger(leg.first_exposure_observed_at_ms)", "carry_exposed_leg_authoritative_time_validation_missing");
  requireSectionText(refreshExposureBoundary, "saga.first_exposure_observed_at_ms = saga.created_at_ms", "carry_incomplete_fill_time_conservative_boundary_missing");
  requireSectionText(refreshExposureBoundary, "saga.exposure_boundary_provenance = CONSERVATIVE_EXPOSURE_BOUNDARY_PROVENANCE", "carry_incomplete_fill_time_conservative_provenance_missing");
  requireSectionText(refreshExposureBoundary, "Math.min(...exposed.map((leg) => leg.first_exposure_observed_at_ms))", "carry_complete_fill_time_minimum_missing");
  requireSectionText(refreshExposureBoundary, "saga.exposure_boundary_provenance = AUTHORITATIVE_EXPOSURE_BOUNDARY_PROVENANCE", "carry_complete_fill_time_authoritative_provenance_missing");
  requireCount("coreMultiLeg", "applyEntryFill(saga,", 4, "carry_first_exposure_event_coverage_missing");
  const conservativeExposureBoundaryTest = sourceSection(
    "coreMultiLegTest",
    'test("missing exchange fill time uses an immutable conservative pre-submit boundary"',
    'test("authoritative per-leg fill boundaries use exchange time despite reversed processing"',
  );
  requireSectionText(conservativeExposureBoundaryTest, "filled.saga.first_exposure_observed_at_ms, NOW", "carry_conservative_exposure_boundary_test_missing");
  requireSectionText(conservativeExposureBoundaryTest, 'filled.saga.exposure_boundary_provenance, "worker_observed_positive_fill_conservative"', "carry_conservative_exposure_provenance_test_missing");
  requireSectionText(conservativeExposureBoundaryTest, "replay.saga.first_exposure_observed_at_ms, NOW", "carry_conservative_exposure_replay_test_missing");
  const authoritativeExposureBoundaryTest = sourceSection(
    "coreMultiLegTest",
    'test("authoritative per-leg fill boundaries use exchange time despite reversed processing"',
    'test("zero-fill terminal paths never claim exposure"',
  );
  requireSectionText(authoritativeExposureBoundaryTest, "saga.first_exposure_observed_at_ms, NOW + 4_000", "carry_authoritative_exposure_minimum_test_missing");
  requireSectionText(authoritativeExposureBoundaryTest, 'saga.exposure_boundary_provenance, "authoritative_exchange_fill_time"', "carry_authoritative_exposure_provenance_test_missing");
  requireSectionText(authoritativeExposureBoundaryTest, "saga.legs[0].first_exposure_observed_at_ms, NOW + 8_000", "carry_authoritative_exposure_leg_one_test_missing");
  requireSectionText(authoritativeExposureBoundaryTest, "saga.legs[1].first_exposure_observed_at_ms, NOW + 4_000", "carry_authoritative_exposure_leg_two_test_missing");
  requireText("coreMultiLegTest", "zero-fill terminal paths never claim exposure", "carry_zero_fill_exposure_test_missing");
  requireText("executor", 'hyperliquid: "hyperliquid_user_fills_time_v1"', "carry_hyperliquid_fill_time_source_missing");
  requireText("executor", 'lighter: "lighter_authenticated_order_trades_timestamp_v1"', "carry_lighter_fill_time_source_missing");
  requireText("executor", 'aster: "aster_fapi_v3_user_trades_time_v1"', "carry_aster_fill_time_source_missing");
  const exposureBoundaryEvent = sourceSection(
    "executor",
    "function exposureBoundaryEvent(",
    "function authoritativeReceiptExposureBoundary(",
  );
  requireSectionText(exposureBoundaryEvent, "boundary?.authoritative === true", "carry_authoritative_boundary_event_gate_missing");
  requireSectionText(exposureBoundaryEvent, "first_exposure_observed_at_ms: boundary.first_fill_at_ms", "carry_authoritative_boundary_event_time_missing");
  requireSectionText(exposureBoundaryEvent, "exposure_boundary_provenance: AUTHORITATIVE_EXPOSURE_BOUNDARY_PROVENANCE", "carry_authoritative_boundary_event_provenance_missing");
  requireSectionText(exposureBoundaryEvent, ": {}", "carry_unproven_boundary_event_conservative_fallback_missing");
  const authoritativeReceiptExposureBoundary = sourceSection(
    "executor",
    "function authoritativeReceiptExposureBoundary(",
    "function commitmentValue(",
  );
  requireSectionText(authoritativeReceiptExposureBoundary, "AUTHORITATIVE_FILL_TIME_PROVENANCE_BY_VENUE[venueId]", "carry_receipt_fill_time_venue_source_missing");
  requireSectionText(authoritativeReceiptExposureBoundary, "proof?.target_fill_set_complete !== true", "carry_receipt_target_fill_set_complete_missing");
  requireSectionText(authoritativeReceiptExposureBoundary, "proof?.fill_times_authoritative !== true", "carry_receipt_authoritative_fill_time_marker_missing");
  requireSectionText(authoritativeReceiptExposureBoundary, "proof?.fill_time_provenance !== expectedProvenance", "carry_receipt_authoritative_fill_time_source_missing");
  requireSectionText(authoritativeReceiptExposureBoundary, "lastFillAtMs < firstFillAtMs", "carry_receipt_authoritative_fill_time_bounds_missing");
  requireSectionText(authoritativeReceiptExposureBoundary, "positiveFills.length === 0", "carry_receipt_authoritative_positive_fill_missing");
  requireSectionText(authoritativeReceiptExposureBoundary, "Number(fill?.executed_at_ms)", "carry_receipt_fill_row_timestamp_missing");
  requireSectionText(authoritativeReceiptExposureBoundary, "Math.min(...fillTimes) !== firstFillAtMs", "carry_receipt_first_fill_minimum_missing");
  requireCount("executor", "...exposureBoundaryEvent(exposureBoundary)", 4, "carry_receipt_boundary_event_binding_missing");
  requireText("executor", "first_exposure_observed_at_ms: material.exposure_boundary.observed_at_ms", "carry_first_observed_exposure_binding_missing");
  requireText("executor", "exposure_boundary_provenance: material.exposure_boundary.provenance", "carry_first_exposure_provenance_binding_missing");
  requireText("executor", "first_exposure_observed_at_ms_by_venue: material.exposure_boundary.observed_at_ms_by_venue", "carry_first_observed_exposure_by_venue_binding_missing");
  requireText("executor", "exposure_boundary_provenance_by_venue: material.exposure_boundary.provenance_by_venue", "carry_first_exposure_provenance_by_venue_binding_missing");
  const reconciledEntryMaterial = sourceSection(
    "executor",
    "async function reconciledCarryEntryMaterial({",
    "function entryParentCanComplete(",
  );
  requireSectionText(reconciledEntryMaterial, "const exposureBoundary = resolveSagaExposureBoundary(saga);", "carry_reconciled_exposure_boundary_resolution_missing");
  requireSectionText(reconciledEntryMaterial, "!exposureBoundary.ok || exposureBoundary.observed_at_ms > saga.updated_at_ms", "carry_reconciled_exposure_boundary_gate_missing");
  requireSectionText(reconciledEntryMaterial, "exposure_boundary: exposureBoundary", "carry_reconciled_exposure_boundary_return_missing");
  const sagaExposureBoundary = sourceSection(
    "executor",
    "function resolveSagaExposureBoundary(",
    "function resolvePositionExposureBoundary(",
  );
  requireSectionText(sagaExposureBoundary, "filled_micro_usdc) > 0", "carry_saga_exposure_detection_missing");
  requireSectionText(sagaExposureBoundary, "saga?.first_exposure_observed_at_ms", "carry_saga_observed_boundary_missing");
  requireSectionText(sagaExposureBoundary, "saga?.first_exposure_at_ms", "carry_saga_legacy_boundary_alias_missing");
  requireSectionText(sagaExposureBoundary, 'provenance = "legacy_worker_observed_alias"', "carry_saga_legacy_alias_provenance_missing");
  requireSectionText(sagaExposureBoundary, "observedAtMs = createdAtMs", "carry_saga_legacy_conservative_boundary_missing");
  requireSectionText(sagaExposureBoundary, 'provenance = "legacy_conservative_saga_creation"', "carry_saga_legacy_conservative_provenance_missing");
  requireSectionText(sagaExposureBoundary, "updatedAtMs >= observedAtMs", "carry_saga_observed_boundary_validation_missing");
  const positionExposureBoundary = sourceSection(
    "executor",
    "function resolvePositionExposureBoundary(",
    "function rebaseAbortedFundingBoundary(",
  );
  requireSectionText(positionExposureBoundary, "position?.active_observed_at_ms", "carry_position_observed_boundary_missing");
  requireSectionText(positionExposureBoundary, "position?.active_at_ms", "carry_position_legacy_boundary_alias_missing");
  requireSectionText(positionExposureBoundary, 'provenance = "legacy_worker_observed_alias"', "carry_position_legacy_alias_provenance_missing");
  requireSectionText(positionExposureBoundary, "observedAtMs = createdAtMs", "carry_position_legacy_conservative_boundary_missing");
  requireSectionText(positionExposureBoundary, 'provenance = "legacy_conservative_position_creation"', "carry_position_legacy_conservative_provenance_missing");
  const storedEntryReconciliation = sourceSection(
    "positions",
    'if (event.type === "entry_reconciled") {',
    "return storeUpdate(state, next",
  );
  requireSectionText(storedEntryReconciliation, "rebaseFundingToObservedExposure({", "carry_funding_observed_rebase_missing");
  requireSectionText(storedEntryReconciliation, "observedAtMs: advanced.position.active_observed_at_ms", "carry_funding_observed_boundary_binding_missing");
  requireSectionText(storedEntryReconciliation, "provenance: advanced.position.active_boundary_provenance", "carry_funding_provenance_binding_missing");
  const fundingExposureRebase = sourceSection(
    "positions",
    "function rebaseFundingToObservedExposure(",
    "async function readVenueFundingSettlements(",
  );
  requireSectionText(fundingExposureRebase, "carry_funding_exposure_boundary_invalid", "carry_funding_observed_boundary_validation_missing");
  requireSectionText(fundingExposureRebase, "observedAtMsByVenue", "carry_funding_per_venue_observed_boundary_missing");
  requireSectionText(fundingExposureRebase, "provenanceByVenue", "carry_funding_per_venue_provenance_missing");
  requireSectionText(fundingExposureRebase, "Object.keys(boundaryByVenue).length !== venueIds.length", "carry_funding_per_venue_boundary_completeness_missing");
  requireSectionText(fundingExposureRebase, "Number.isSafeInteger(boundaryByVenue[venueId])", "carry_funding_per_venue_boundary_validation_missing");
  requireSectionText(fundingExposureRebase, "Math.min(...venueIds.map((venueId) => boundaryByVenue[venueId])) !== observedAtMs", "carry_funding_per_venue_minimum_binding_missing");
  requireSectionText(fundingExposureRebase, 'if (priorBoundary !== observedAtMs) return denied("carry_funding_exposure_boundary_conflict")', "carry_funding_observed_boundary_conflict_missing");
  requireSectionText(fundingExposureRebase, "priorByVenue[venueId] !== boundaryByVenue[venueId]", "carry_funding_per_venue_boundary_conflict_missing");
  requireSectionText(fundingExposureRebase, "cursor_ms_by_venue: Object.fromEntries(venueIds.map((venueId) => [venueId, boundaryByVenue[venueId]]))", "carry_funding_observed_cursor_rebase_missing");
  requireSectionText(fundingExposureRebase, "exposure_boundary_observed_at_ms: observedAtMs", "carry_funding_observed_boundary_persistence_missing");
  requireSectionText(fundingExposureRebase, "exposure_boundary_provenance: provenance", "carry_funding_observed_provenance_persistence_missing");
  requireSectionText(fundingExposureRebase, "exposure_boundary_observed_at_ms_by_venue: boundaryByVenue", "carry_funding_per_venue_boundary_persistence_missing");
  requireSectionText(fundingExposureRebase, "exposure_boundary_provenance_by_venue: boundaryProvenanceByVenue", "carry_funding_per_venue_provenance_persistence_missing");
  requireText("positionsTest", "funding begins at first observed exposure, excluding pre-fill settlements", "carry_funding_exposure_boundary_test_missing");
  const abortedFundingRebase = sourceSection(
    "executor",
    "function rebaseAbortedFundingBoundary(",
    "function provablyPreSubmitCarrySaga(",
  );
  requireSectionText(abortedFundingRebase, "priorBoundary !== target", "carry_aborted_funding_boundary_conflict_missing");
  requireSectionText(abortedFundingRebase, "const alreadyRebased =", "carry_aborted_funding_rebase_idempotence_missing");
  requireSectionText(abortedFundingRebase, "observedAtMsByVenue?.[venueId] ?? noExposureAtMs", "carry_aborted_funding_per_venue_target_missing");
  requireSectionText(abortedFundingRebase, "provenanceByVenue?.[venueId]", "carry_aborted_funding_per_venue_provenance_missing");
  requireSectionText(abortedFundingRebase, "cursor_ms_by_venue: targetsByVenue", "carry_aborted_funding_cursor_rebase_missing");
  requireSectionText(abortedFundingRebase, "exposure_boundary_observed_at_ms: target", "carry_aborted_observed_boundary_persistence_missing");
  requireSectionText(abortedFundingRebase, "exposure_boundary_provenance: current.exposure_boundary_provenance || provenance", "carry_aborted_boundary_provenance_missing");
  requireSectionText(abortedFundingRebase, "exposure_boundary_observed_at_ms_by_venue: current.exposure_boundary_observed_at_ms_by_venue || targetsByVenue", "carry_aborted_per_venue_boundary_persistence_missing");
  requireSectionText(abortedFundingRebase, "exposure_boundary_provenance_by_venue: current.exposure_boundary_provenance_by_venue || targetProvenanceByVenue", "carry_aborted_per_venue_provenance_persistence_missing");
  requireText("executor", "const exposureBoundary = resolveSagaExposureBoundary(saga, { allowNoExposure: true });", "carry_aborted_exposure_boundary_resolution_missing");
  requireText("executor", "const exposureObservedAtMs = hasExposure ? exposureBoundary.observed_at_ms : null;", "carry_aborted_observed_boundary_missing");
  requireText("executor", "const fundingBoundary = rebaseAbortedFundingBoundary({", "carry_aborted_funding_rebase_call_missing");
  requireText("executor", "const elapsedMs = hasExposure ? exitAtMs - exposureObservedAtMs : 0;", "carry_aborted_capital_boundary_missing");
  const legacySagaRestartTest = sourceSection(
    "lifecycleTest",
    'test("legacy reconciled saga without an exposure boundary restarts with conservative provenance"',
    'test("reconciled entry recovery retries after accounting without duplicating value"',
  );
  requireSectionText(legacySagaRestartTest, "delete legacySaga.first_exposure_observed_at_ms", "carry_legacy_saga_restart_fixture_missing");
  requireSectionText(legacySagaRestartTest, "delete legacySaga.first_exposure_at_ms", "carry_legacy_saga_alias_removal_missing");
  requireSectionText(legacySagaRestartTest, "active.position.active_observed_at_ms, legacySaga.created_at_ms", "carry_legacy_saga_conservative_boundary_assertion_missing");
  requireSectionText(legacySagaRestartTest, 'active.position.active_boundary_provenance, "legacy_conservative_saga_creation"', "carry_legacy_saga_conservative_provenance_assertion_missing");
  const legacyPositionFinalizationTest = sourceSection(
    "lifecycleTest",
    'test("legacy active position without an exposure boundary finalizes only with conservative provenance"',
    'test("converts each venue PnL independently before final settlement"',
  );
  requireSectionText(legacyPositionFinalizationTest, "delete legacyPosition.active_observed_at_ms", "carry_legacy_position_restart_fixture_missing");
  requireSectionText(legacyPositionFinalizationTest, "delete legacyPosition.active_at_ms", "carry_legacy_position_alias_removal_missing");
  requireSectionText(legacyPositionFinalizationTest, "legacyPosition.created_at_ms", "carry_legacy_position_conservative_boundary_assertion_missing");
  requireSectionText(legacyPositionFinalizationTest, '"legacy_conservative_position_creation"', "carry_legacy_position_conservative_provenance_assertion_missing");
  requireText("executor", "carry_account_asset_exposure_overlap", "carry_account_asset_overlap_guard_missing");
  requireText("workerState", "worker_carry_exposure_reservations", "carry_exposure_reservation_store_missing");
  requireCount("workerState", "async claimCarryExposureReservations", 2, "carry_exposure_reservation_adapter_parity_missing");
  requireCount("workerState", "async releaseCarryExposureReservations", 2, "carry_exposure_release_adapter_parity_missing");
  requireCount("workerState", "async releaseCarryExposureReservationsBeforeSubmit", 2, "carry_exposure_pre_submit_release_adapter_parity_missing");
  requireText("workerState", "exactFlatReservationRecord", "carry_exposure_exact_flat_release_missing");
  requireText("workerState", 'evidence.transaction_broadcast !== false || evidence.gross_exposure_micro_usdc !== 0', "carry_exposure_zero_broadcast_gate_missing");
  requireText("workerState", "evidence.open_order_count !== 0", "carry_exposure_zero_order_gate_missing");
  requireText("workerState", "evidence.owner_commitment !== expected?.owner_commitment", "carry_exposure_owner_release_binding_missing");
  requireText("workerState", "evidence.carry_position_id !== expected?.position_id", "carry_exposure_position_release_binding_missing");
  requireText("workerState", "item.account_commitment === expected.account_commitments?.[venueId]", "carry_exposure_account_release_binding_missing");
  requireText("workerState", "item.flat_zero_orders === true", "carry_exposure_venue_flat_release_missing");
  const postgresReservationClaim = sourceOccurrenceSection(
    "workerState",
    "async claimCarryExposureReservations(",
    "async releaseCarryExposureReservations(",
    0,
  );
  requireSectionText(postgresReservationClaim, 'await client.query("BEGIN")', "carry_exposure_claim_transaction_missing");
  requireSectionText(postgresReservationClaim, '"carry:exposure:claim:v2"', "carry_exposure_claim_global_lock_missing");
  requireSectionText(postgresReservationClaim, 'for (const item of ordered) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [item.reservation_key])', "carry_exposure_claim_atomic_lock_missing");
  requireSectionText(postgresReservationClaim, "SELECT position_id, record_json FROM worker_carry_positions FOR UPDATE", "carry_exposure_claim_position_snapshot_lock_missing");
  requireSectionText(postgresReservationClaim, "SELECT saga_id, saga_json FROM worker_multi_leg_sagas FOR UPDATE", "carry_exposure_claim_saga_snapshot_lock_missing");
  requireSectionText(postgresReservationClaim, "const persisted = assessCarryExposureClaim({", "carry_exposure_claim_persisted_overlap_assessment_missing");
  requireSectionText(postgresReservationClaim, "if (!persisted.ok)", "carry_exposure_claim_persisted_overlap_denial_missing");
  requireSectionText(postgresReservationClaim, "pg_advisory_xact_lock(hashtextextended", "carry_exposure_claim_atomic_lock_missing");
  requireSectionText(postgresReservationClaim, "FOR UPDATE", "carry_exposure_claim_row_lock_missing");
  requireSectionText(postgresReservationClaim, 'await client.query("ROLLBACK")', "carry_exposure_claim_rollback_missing");
  requireSectionText(postgresReservationClaim, 'await client.query("COMMIT")', "carry_exposure_claim_commit_missing");
  requireOrdered(postgresReservationClaim, '"carry:exposure:claim:v2"', "assessCarryExposureClaim({", "carry_exposure_claim_global_lock_before_assessment_missing");
  requireOrdered(postgresReservationClaim, "assessCarryExposureClaim({", "SELECT position_id, bindings_commitment, active FROM worker_carry_exposure_reservations", "carry_exposure_claim_legacy_assessment_before_reservation_rows_missing");
  const postgresReservationRelease = sourceOccurrenceSection(
    "workerState",
    "async releaseCarryExposureReservations(",
    "async releaseCarryExposureReservationsBeforeSubmit(",
    0,
  );
  requireSectionText(postgresReservationRelease, 'await client.query("BEGIN")', "carry_exposure_release_transaction_missing");
  requireSectionText(postgresReservationRelease, "pg_advisory_xact_lock(hashtextextended", "carry_exposure_release_atomic_lock_missing");
  requireSectionText(postgresReservationRelease, "FOR UPDATE", "carry_exposure_release_row_lock_missing");
  requireSectionText(postgresReservationRelease, "exactFlatReservationRecord(", "carry_exposure_release_flat_state_missing");
  requireOrdered(postgresReservationRelease, "exactFlatReservationRecord(", "SET active=FALSE", "carry_exposure_release_before_flat_proof");
  const fileReservationClaim = sourceOccurrenceSection(
    "workerState",
    "async claimCarryExposureReservations(",
    "async releaseCarryExposureReservations(",
    1,
  );
  requireSectionText(fileReservationClaim, "return updateState((state) =>", "carry_exposure_file_claim_atomic_update_missing");
  requireSectionText(fileReservationClaim, "const persisted = assessCarryExposureClaim({", "carry_exposure_file_claim_persisted_overlap_assessment_missing");
  requireSectionText(fileReservationClaim, "if (!persisted.ok) return persisted", "carry_exposure_file_claim_persisted_overlap_denial_missing");
  requireSectionText(fileReservationClaim, "existing?.active", "carry_exposure_file_claim_conflict_gate_missing");
  requireOrdered(fileReservationClaim, "assessCarryExposureClaim({", "existing?.active", "carry_exposure_file_claim_legacy_assessment_before_reservation_rows_missing");
  const fileReservationRelease = sourceOccurrenceSection(
    "workerState",
    "async releaseCarryExposureReservations(",
    "async releaseCarryExposureReservationsBeforeSubmit(",
    1,
  );
  requireSectionText(fileReservationRelease, "return updateState((state) =>", "carry_exposure_file_release_atomic_update_missing");
  requireSectionText(fileReservationRelease, "exactFlatReservationRecord(", "carry_exposure_file_release_flat_state_missing");
  requireOrdered(fileReservationRelease, "exactFlatReservationRecord(", ".active = false", "carry_exposure_file_release_before_flat_proof");
  const exactNoSubmitReservation = sourceSection(
    "workerState",
    "function exactNoSubmitReservationRecord(",
    "function normalizeState(",
  );
  requireSectionText(exactNoSubmitReservation, 'record.position.status === "reconciled"', "carry_exposure_pre_submit_reconciled_gate_missing");
  requireSectionText(exactNoSubmitReservation, 'record.position.terminal_reason === "entry_failed_no_fill"', "carry_exposure_pre_submit_no_fill_gate_missing");
  requireSectionText(exactNoSubmitReservation, "record.entry_saga_id === sagaId", "carry_exposure_pre_submit_saga_binding_missing");
  requireSectionText(exactNoSubmitReservation, "saga.terminal === true", "carry_exposure_pre_submit_terminal_gate_missing");
  requireSectionText(exactNoSubmitReservation, 'saga.status === "failed_no_submit"', "carry_exposure_pre_submit_status_gate_missing");
  requireSectionText(exactNoSubmitReservation, 'saga.terminal_reason === "cancelled_before_submit"', "carry_exposure_pre_submit_reason_gate_missing");
  requireSectionText(exactNoSubmitReservation, 'leg.submission_status === "pending"', "carry_exposure_pre_submit_pending_leg_gate_missing");
  requireSectionText(exactNoSubmitReservation, "leg.provider_ref_commitment === null", "carry_exposure_pre_submit_provider_ref_gate_missing");
  requireSectionText(exactNoSubmitReservation, "leg.filled_micro_usdc === 0", "carry_exposure_pre_submit_zero_fill_gate_missing");
  requireSectionText(exactNoSubmitReservation, "exactFlatReservationRecord(record, {", "carry_exposure_pre_submit_exact_flat_gate_missing");
  const postgresPreSubmitRelease = sourceOccurrenceSection(
    "workerState",
    "async releaseCarryExposureReservationsBeforeSubmit(",
    "async putExecutionAttempt(",
    0,
  );
  requireSectionText(postgresPreSubmitRelease, 'await client.query("BEGIN")', "carry_exposure_pre_submit_transaction_missing");
  requireSectionText(postgresPreSubmitRelease, "pg_advisory_xact_lock(hashtextextended", "carry_exposure_pre_submit_atomic_lock_missing");
  requireSectionText(postgresPreSubmitRelease, "SELECT record_json FROM worker_carry_positions WHERE position_id=$1 FOR UPDATE", "carry_exposure_pre_submit_position_lock_missing");
  requireSectionText(postgresPreSubmitRelease, "SELECT saga_json FROM worker_multi_leg_sagas WHERE saga_id=$1 FOR UPDATE", "carry_exposure_pre_submit_saga_lock_missing");
  requireSectionText(postgresPreSubmitRelease, "exactNoSubmitReservationRecord(", "carry_exposure_pre_submit_durable_proof_missing");
  requireSectionText(postgresPreSubmitRelease, 'reason: "durable_no_submit_proof_required"', "carry_exposure_pre_submit_proof_denial_missing");
  requireSectionText(postgresPreSubmitRelease, 'await client.query("ROLLBACK")', "carry_exposure_pre_submit_rollback_missing");
  requireSectionText(postgresPreSubmitRelease, 'await client.query("COMMIT")', "carry_exposure_pre_submit_commit_missing");
  requireOrdered(postgresPreSubmitRelease, "exactNoSubmitReservationRecord(", "SET active=FALSE", "carry_exposure_pre_submit_release_before_proof");
  const filePreSubmitRelease = sourceOccurrenceSection(
    "workerState",
    "async releaseCarryExposureReservationsBeforeSubmit(",
    "async putExecutionAttempt(",
    1,
  );
  requireSectionText(filePreSubmitRelease, "return updateState((state) =>", "carry_exposure_file_pre_submit_atomic_update_missing");
  requireSectionText(filePreSubmitRelease, "exactNoSubmitReservationRecord(", "carry_exposure_file_pre_submit_durable_proof_missing");
  requireSectionText(filePreSubmitRelease, "existing?.active", "carry_exposure_file_pre_submit_conflict_gate_missing");
  requireSectionText(filePreSubmitRelease, 'reason: "reservation_set_incomplete"', "carry_exposure_file_pre_submit_complete_set_gate_missing");
  requireOrdered(filePreSubmitRelease, "exactNoSubmitReservationRecord(", ".active = false", "carry_exposure_file_pre_submit_release_before_proof");
  const carryExposureClaimAssessment = sourceSection(
    "workerState",
    "function assessCarryExposureClaim({",
    "function durableCarryExposureBinding(",
  );
  requireSectionText(carryExposureClaimAssessment, "durableCarryExposureBinding(targetRecord, positionId)", "carry_exposure_target_durable_binding_missing");
  requireSectionText(carryExposureClaimAssessment, 'targetBinding.status !== "opening"', "carry_exposure_target_opening_gate_missing");
  requireSectionText(carryExposureClaimAssessment, "provablyPreSubmitCarryOpening(targetRecord, targetSaga, { readyOnly: true })", "carry_exposure_target_pre_submit_gate_missing");
  requireSectionText(carryExposureClaimAssessment, "exactCarryExposureClaimBinding(targetBinding, targetSaga, bindingsCommitment, reservations)", "carry_exposure_target_exact_binding_missing");
  requireSectionText(carryExposureClaimAssessment, "for (const [persistedId, record] of Object.entries(positions || {}))", "carry_exposure_legacy_full_position_scan_missing");
  requireSectionText(carryExposureClaimAssessment, 'if (status === "draft" || status === "reconciled") continue;', "carry_exposure_legacy_terminal_skip_scope_missing");
  requireSectionText(carryExposureClaimAssessment, "provablyPreSubmitCarryOpening(record, saga)", "carry_exposure_legacy_safe_opening_proof_missing");
  requireSectionText(carryExposureClaimAssessment, "CARRY_EXPOSURE_BEARING_STATUSES.has(status)", "carry_exposure_legacy_bearing_status_gate_missing");
  requireSectionText(carryExposureClaimAssessment, "carryExposureBindingsOverlap(targetBinding, persistedBinding)", "carry_exposure_legacy_overlap_check_missing");
  requireSectionText(carryExposureClaimAssessment, 'reason: "carry_legacy_exposure_overlap"', "carry_exposure_legacy_overlap_denial_missing");
  requireSectionText(carryExposureClaimAssessment, 'reason: "carry_legacy_exposure_binding_unverifiable"', "carry_exposure_legacy_malformed_denial_missing");
  const durableCarryExposureBinding = sourceSection(
    "workerState",
    "function durableCarryExposureBinding(",
    "function provablyPreSubmitCarryOpening(",
  );
  requireSectionText(durableCarryExposureBinding, "record?.owner_commitment", "carry_exposure_legacy_owner_binding_missing");
  requireSectionText(durableCarryExposureBinding, "position?.asset", "carry_exposure_legacy_asset_binding_missing");
  requireSectionText(durableCarryExposureBinding, "position?.long_venue_id", "carry_exposure_legacy_long_venue_binding_missing");
  requireSectionText(durableCarryExposureBinding, "position?.short_venue_id", "carry_exposure_legacy_short_venue_binding_missing");
  requireSectionText(durableCarryExposureBinding, "monitoring_context?.venue_access?.[venueId]?.account_commitment", "carry_exposure_legacy_account_binding_missing");
  const provablyPreSubmitOpening = sourceSection(
    "workerState",
    "function provablyPreSubmitCarryOpening(",
    "function exactCarryExposureClaimBinding(",
  );
  requireSectionText(provablyPreSubmitOpening, 'saga?.status === "ready" && saga?.terminal === false', "carry_exposure_target_ready_saga_gate_missing");
  requireSectionText(provablyPreSubmitOpening, 'saga?.status === "failed_no_submit" && saga?.terminal === true', "carry_exposure_legacy_failed_no_submit_gate_missing");
  requireSectionText(provablyPreSubmitOpening, "saga.first_exposure_observed_at_ms === null", "carry_exposure_legacy_zero_boundary_gate_missing");
  requireSectionText(provablyPreSubmitOpening, "Object.values(exposureByAsset).every((value) => value === 0)", "carry_exposure_legacy_zero_asset_exposure_gate_missing");
  requireSectionText(provablyPreSubmitOpening, 'leg?.submission_status === "pending"', "carry_exposure_legacy_pending_leg_gate_missing");
  requireSectionText(provablyPreSubmitOpening, "leg.provider_ref_commitment === null", "carry_exposure_legacy_provider_ref_gate_missing");
  requireSectionText(provablyPreSubmitOpening, "leg.filled_micro_usdc === 0", "carry_exposure_legacy_zero_fill_gate_missing");
  requireSectionText(provablyPreSubmitOpening, "leg.unwind_filled_micro_usdc === 0", "carry_exposure_legacy_zero_unwind_gate_missing");
  const exactCarryExposureClaimBinding = sourceSection(
    "workerState",
    "function exactCarryExposureClaimBinding(",
    "function carryExposureBindingsOverlap(",
  );
  requireSectionText(exactCarryExposureClaimBinding, "saga.execution_context.legs", "carry_exposure_claim_context_leg_binding_missing");
  requireSectionText(exactCarryExposureClaimBinding, "const expectedBindingsCommitment =", "carry_exposure_claim_commitment_recalculation_missing");
  requireSectionText(exactCarryExposureClaimBinding, "bindingsCommitment !== expectedBindingsCommitment", "carry_exposure_claim_commitment_comparison_missing");
  requireSectionText(exactCarryExposureClaimBinding, "carry:exposure:owner:", "carry_exposure_claim_owner_key_recalculation_missing");
  requireSectionText(exactCarryExposureClaimBinding, "carry:exposure:account:", "carry_exposure_claim_account_key_recalculation_missing");
  requireSectionText(exactCarryExposureClaimBinding, "new Set(reservations.map((item) => item?.reservation_key)).size !== reservations.length", "carry_exposure_claim_unique_key_gate_missing");
  const carryExposureOverlap = sourceSection(
    "workerState",
    "function carryExposureBindingsOverlap(",
    "function stateDigest(",
  );
  requireSectionText(carryExposureOverlap, "if (left.asset !== right.asset) return false", "carry_exposure_legacy_asset_overlap_scope_missing");
  requireSectionText(carryExposureOverlap, "if (left.owner_commitment === right.owner_commitment) return true", "carry_exposure_legacy_owner_overlap_missing");
  requireSectionText(carryExposureOverlap, "left.account_commitments.some((account) => rightAccounts.has(account))", "carry_exposure_legacy_account_overlap_missing");
  const carryEntrySection = sourceSection("executor", "export async function executeStoredCarryEntry({", "export async function executeStoredCarryExit({");
  requireSectionText(carryEntrySection, "proof = await preflight({", "carry_exposure_entry_preflight_missing");
  requireSectionText(carryEntrySection, "proof?.no_submit_ready !== true || proof?.transaction_broadcast !== false", "carry_exposure_entry_no_submit_gate_missing");
  requireSectionText(carryEntrySection, "const legs = buildLegs(record, proof, startedAt);", "carry_exposure_entry_leg_binding_missing");
  requireSectionText(carryEntrySection, "const reservationRecord = await state.getCarryPositionRecord(positionId);", "carry_exposure_durable_record_binding_missing");
  requireSectionText(carryEntrySection, "const exposureReservation = carryExposureReservation(reservationRecord, legs.legs);", "carry_exposure_actual_leg_reservation_missing");
  requireSectionText(carryEntrySection, "state.claimCarryExposureReservations(", "carry_exposure_entry_claim_missing");
  requireOrdered(carryEntrySection, "proof = await preflight({", "const legs = buildLegs(record, proof, startedAt);", "carry_exposure_preflight_before_leg_binding_missing");
  requireOrdered(carryEntrySection, "const legs = buildLegs(record, proof, startedAt);", "const exposureReservation = carryExposureReservation(reservationRecord, legs.legs);", "carry_exposure_bound_legs_before_claim_missing");
  requireOrdered(carryEntrySection, "state.claimCarryExposureReservations(", 'sagaEvent(state, sagaId, "submission_started"', "carry_exposure_claim_before_submission_missing");
  requireOrdered(carryEntrySection, "state.claimCarryExposureReservations(", "executeOrder(orderArgs({", "carry_exposure_claim_before_execute_missing");
  const carryReservationBinding = sourceSection("executor", "function carryExposureReservation(record, boundLegs = null) {", "async function releaseCarryExposureReservation({");
  requireSectionText(carryReservationBinding, "owner_commitment: record.owner_commitment", "carry_exposure_owner_claim_binding_missing");
  requireSectionText(carryReservationBinding, "asset: record.position.asset", "carry_exposure_asset_claim_binding_missing");
  requireSectionText(carryReservationBinding, "accounts_by_venue: accountsByVenue", "carry_exposure_account_claim_binding_missing");
  requireSectionText(carryReservationBinding, "[...new Set(Object.values(accountsByVenue).filter(Boolean))].sort()", "carry_exposure_shared_account_deduplication_missing");
  requireSectionText(carryReservationBinding, "legs,", "carry_exposure_leg_claim_binding_missing");
  requireSectionText(carryReservationBinding, "carry:exposure:owner:", "carry_exposure_owner_key_missing");
  requireSectionText(carryReservationBinding, "carry:exposure:account:", "carry_exposure_account_key_missing");
  const carryReservationRelease = sourceSection("executor", "async function releaseCarryExposureReservation({", "async function reconciledCarryEntryMaterial({");
  requireSectionText(carryReservationRelease, "hasExactCarryFlatReconciliation(", "carry_exposure_release_binding_missing");
  requireSectionText(carryReservationRelease, "state.releaseCarryExposureReservations(", "carry_exposure_release_call_missing");
  requireOrdered(carryReservationRelease, "hasExactCarryFlatReconciliation(", "state.releaseCarryExposureReservations(", "carry_exposure_flat_before_release_missing");
  const carryPreSubmitReservationRelease = sourceSection(
    "executor",
    "async function releaseCarryExposureReservationBeforeSubmit({",
    "async function reconciledCarryEntryMaterial({",
  );
  requireSectionText(carryPreSubmitReservationRelease, "await state.getCarryPositionRecord(record.position.position_id)", "carry_exposure_pre_submit_durable_refetch_missing");
  requireSectionText(carryPreSubmitReservationRelease, "state.releaseCarryExposureReservationsBeforeSubmit(", "carry_exposure_pre_submit_release_call_missing");
  requireSectionText(carryPreSubmitReservationRelease, "saga.saga_id", "carry_exposure_pre_submit_release_saga_binding_missing");
  const restartAudit = sourceSection(
    "executor",
    "export async function auditCarryPositionsAfterRestart({",
    "async function completeReconciledCarryEntry({",
  );
  requireSectionText(restartAudit, "provablyPreSubmitCarrySaga(saga, record, phase)", "carry_exposure_restart_pre_submit_proof_missing");
  requireSectionText(restartAudit, "!accountState.ok || !accountState.known_flat", "carry_exposure_restart_flat_gate_missing");
  requireSectionText(restartAudit, 'carryEvent(record.position, "entry_failed_no_fill"', "carry_exposure_restart_no_fill_reconciliation_missing");
  requireSectionText(restartAudit, "releaseCarryExposureReservationBeforeSubmit({", "carry_exposure_restart_pre_submit_release_missing");
  requireOrdered(restartAudit, 'carryEvent(record.position, "entry_failed_no_fill"', "releaseCarryExposureReservationBeforeSubmit({", "carry_exposure_restart_release_before_reconciliation");
  requireText("privateStatePolicyClaimTest", "Carry exposure reservations are atomic, durable, replay-safe", "carry_exposure_reservation_test_missing");
  requireText("privateStatePolicyClaimTest", "const simultaneous = await Promise.all([", "carry_exposure_concurrent_claim_test_missing");
  requireText("privateStatePolicyClaimTest", "const restarted = createWorkerState(dir);", "carry_exposure_restart_test_missing");
  requireText("privateStatePolicyClaimTest", '{ owner_commitment: "wrong" }', "carry_exposure_exact_flat_rejection_test_missing");
  requireText("privateStatePolicyClaimTest", "generation, 2", "carry_exposure_post_release_retry_test_missing");
  requireText("lifecycleTest", "denies a second Carry entry sharing an owner venue account and asset", "carry_exposure_executor_overlap_test_missing");
  const restartReservationReleaseTest = sourceSection(
    "lifecycleTest",
    'test("restart proves flat and releases exposure reserved before submission after a crash"',
    'test("restart completes an exactly reconciled entry orphan without resubmission"',
  );
  requireSectionText(restartReservationReleaseTest, "simulated crash after exposure reservation claim", "carry_exposure_restart_crash_fixture_missing");
  requireSectionText(restartReservationReleaseTest, "assert.equal(submissions, 0)", "carry_exposure_restart_no_submit_assertion_missing");
  requireSectionText(restartReservationReleaseTest, "createWorkerState(fixture.state_dir)", "carry_exposure_restart_durable_state_test_missing");
  requireSectionText(restartReservationReleaseTest, 'reconciled.position.terminal_reason, "entry_failed_no_fill"', "carry_exposure_restart_no_fill_assertion_missing");
  requireSectionText(restartReservationReleaseTest, "reconciled.final_reconciliation_evidence.open_order_count, 0", "carry_exposure_restart_zero_order_assertion_missing");
  requireSectionText(restartReservationReleaseTest, "await restarted.listActiveCarryExposureReservationPositionIds(), []", "carry_exposure_restart_release_assertion_missing");
  const legacyReservationlessOverlapTest = sourceSection(
    "lifecycleTest",
    'test("legacy active position without reservation rows blocks overlapping entry after restart"',
    'test("malformed legacy exposure fails closed instead of silently bypassing overlap"',
  );
  requireSectionText(legacyReservationlessOverlapTest, "persisted.carry_exposure_reservations = {}", "carry_exposure_legacy_reservationless_fixture_missing");
  requireSectionText(legacyReservationlessOverlapTest, "createWorkerState(fixture.state_dir)", "carry_exposure_legacy_restart_fixture_missing");
  requireSectionText(legacyReservationlessOverlapTest, 'deniedEntry.error, "carry_account_asset_exposure_overlap"', "carry_exposure_legacy_overlap_assertion_missing");
  requireSectionText(legacyReservationlessOverlapTest, "assert.equal(submitCalls, 0)", "carry_exposure_legacy_no_submit_assertion_missing");
  requireSectionText(legacyReservationlessOverlapTest, "listActiveCarryExposureReservationPositionIds()).length, 0", "carry_exposure_legacy_no_row_assertion_missing");
  const malformedLegacyExposureTest = sourceSection(
    "lifecycleTest",
    'test("malformed legacy exposure fails closed instead of silently bypassing overlap"',
    'test("restart audit freezes an in-flight opening without resubmission"',
  );
  requireSectionText(malformedLegacyExposureTest, "delete persisted.carry_positions[fixture.position_id].monitoring_context.venue_access.aster.account_commitment", "carry_exposure_legacy_malformed_fixture_missing");
  requireSectionText(malformedLegacyExposureTest, 'claimResult?.reason, "carry_legacy_exposure_binding_unverifiable"', "carry_exposure_legacy_malformed_reason_assertion_missing");
  requireSectionText(malformedLegacyExposureTest, "claimResult?.conflicting_position_id, fixture.position_id", "carry_exposure_legacy_malformed_conflict_assertion_missing");
  requireSectionText(malformedLegacyExposureTest, "assert.equal(submitCalls, 0)", "carry_exposure_legacy_malformed_no_submit_assertion_missing");
  const sharedAccountReservationTest = sourceSection(
    "lifecycleTest",
    'test("executes and claims safely when both venues reuse one account commitment"',
    'test("refuses entry when durable opportunity evidence was altered after owner approval"',
  );
  requireSectionText(sharedAccountReservationTest, 'sharedAccountCommitment: "account:shared:carry:0001"', "carry_exposure_shared_account_fixture_missing");
  requireSectionText(sharedAccountReservationTest, "result.record.position.status, \"active\"", "carry_exposure_shared_account_execution_assertion_missing");
  requireSectionText(sharedAccountReservationTest, "carry_exposure_reservations).filter((item) => item.active).length, 2", "carry_exposure_shared_account_deduplication_assertion_missing");
  requireText("executor", "const activeBoundary = resolvePositionExposureBoundary(record);", "carry_capital_observed_boundary_resolution_missing");
  requireText("executor", "activeBoundary.observed_at_ms > Number(record.final_reconciliation_evidence.checked_at_ms)", "carry_capital_observed_boundary_validation_missing");
  requireText("executor", "Number(record.final_reconciliation_evidence.checked_at_ms) - activeBoundary.observed_at_ms", "carry_capital_observed_elapsed_missing");
  requireText("executor", "active_observed_at_ms: activeBoundary.observed_at_ms", "carry_capital_observed_evidence_missing");
  requireText("executor", "exposure_boundary_provenance: activeBoundary.provenance", "carry_capital_observed_provenance_missing");
  const carryPositionLedgerMetric = sourceSection(
    "webCarryPositionRail",
    "function positionLedgerMetric(record:",
    "function RailMetric({",
  );
  requireSectionText(carryPositionLedgerMetric, 'positionStatus === "reconciled" && ledgerStatus === "finalized"', "carry_position_rail_finalized_predicate_missing");
  const finalizedLedgerMetric = sourceSection(
    "webCarryPositionRail",
    'if (positionStatus === "reconciled" && ledgerStatus === "finalized")',
    'if (positionStatus === "reconciled" && ledgerStatus === "open")',
  );
  requireSectionText(finalizedLedgerMetric, 'record.position.active_boundary_provenance === "authoritative_exchange_fill_time"', "carry_position_rail_authoritative_provenance_missing");
  requireSectionText(finalizedLedgerMetric, "record.value_boundary_authoritative === true", "carry_position_rail_authoritative_value_gate_missing");
  requireSectionText(finalizedLedgerMetric, "Number.isFinite(realized)", "carry_position_rail_finite_realized_gate_missing");
  requireSectionText(finalizedLedgerMetric, 'return { label: "REAL NET", value: microUsd(realized)', "carry_position_rail_realized_value_missing");
  requireSectionText(finalizedLedgerMetric, 'return { label: "VALUE", value: "UNVERIFIED", tone: "warn" }', "carry_position_rail_finalized_unverified_fallback_missing");
  requireOrdered(finalizedLedgerMetric, "Number.isFinite(realized)", 'return { label: "VALUE", value: "UNVERIFIED"', "carry_position_rail_finalized_fallback_order_missing");
  requireSectionText(carryPositionLedgerMetric, 'positionStatus === "reconciled" && ledgerStatus === "open"', "carry_position_rail_finalizing_predicate_missing");
  requireText("webCarryPositionRail", 'return { label: "VALUE", value: "FINALIZING"', "carry_position_rail_finalizing_state_missing");
  requireText("webCarryPositionRail", '["active", "rebalancing"].includes(positionStatus) && ledgerStatus === "open"', "carry_position_rail_accruing_predicate_missing");
  requireText("webCarryPositionRail", 'return { label: "VALUE", value: "ACCRUING"', "carry_position_rail_accruing_state_missing");
  requireText("webCarryPositionRailTest", "labels realized value only after the ledger is finalized", "carry_position_rail_finalized_test_missing");
  requireText("webCarryPositionRailTest", "never labels a conservative finalized ledger real net", "carry_position_rail_conservative_provenance_test_missing");
  requireText("webCarryPositionRailTest", "never labels a non-finite finalized ledger real net", "carry_position_rail_nonfinite_finalized_test_missing");
  requireText("webCarryPositionRailTest", 'active_boundary_provenance: "authoritative_exchange_fill_time"', "carry_position_rail_authoritative_fixture_missing");
  requireText("webCarryPositionRailTest", "realized_net_micro_usdc: Number.NaN", "carry_position_rail_nonfinite_fixture_missing");
  requireText("webCarryPositionRailTest", "keeps a reconciled position finalizing while its ledger remains open", "carry_position_rail_finalizing_test_missing");
  requireText("webCarryPositionRailTest", "keeps an open rebalancing ledger accruing", "carry_position_rail_accruing_test_missing");
  requireText("webCarryPositionRailTest", "never calls an impossible active finalized ledger real net", "carry_position_rail_impossible_state_test_missing");
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
  requireText("webCarryMarket", "qualification.venues === CORE_PERP_VENUES.length", "carry_market_qualification_registry_coverage_missing");
  requireText("webCarryMarket", "qualification.assets === CARRY_SHADOW_ASSETS.length", "carry_market_qualification_asset_registry_missing");
  requireText("webCarryMarket", "CORE_PERP_VENUES.length * CARRY_SHADOW_ASSETS.length", "carry_market_qualification_matrix_registry_missing");
  forbidText("webCarryMarket", 'Object.freeze(["BTC", "ETH", "SOL"])', "carry_market_shadow_asset_policy_duplicated");
  forbidText("webCarryMarket", "qualification.venues === 5", "carry_market_qualification_venue_count_hardcoded");
  requireText("webCarryMarket", "CORE_PERP_VENUES.map((venueId) => [venueId, executionVenueLabel(venueId)])", "carry_market_venue_label_registry_missing");
  requireText("webAccountSetup", "return executionVenueLabel(venueId);", "carry_setup_venue_label_registry_missing");
  requireText("webCarryMarket", "CARRY_SHADOW_QUALIFICATION_COMMITMENT", "carry_market_qualification_commitment_gate_missing");
  requireText("webCarryChart", "data-market-evidence={marketEvidence.status}", "carry_market_qualification_state_missing");
  requireText("webCarryChart", "{marketEvidence.value}", "carry_market_qualification_display_missing");
  requireText("webCarryMarket", "durability check required", "carry_point_in_time_edge_warning_missing");
  requireText("webCarryChart", 'data-modeled-net-positive={selectedHasPositiveNet ? "true" : "false"}', "carry_point_in_time_net_state_missing");
  forbidText("webCarryChart", 'data-route-qualified={selectedHasPositiveNet ? "true" : "false"}', "carry_single_tick_route_qualification_forbidden");
  requireText("webCarryMarket", "export function carryRoutingAdvantage", "carry_routing_advantage_model_missing");
  requireText("webCarryMarketTest", "refuses a routing-edge claim when another exact executable route is unavailable", "carry_routing_advantage_fail_closed_test_missing");
  requireText("routingAdvantage", "evaluateCarryOpportunity", "carry_routing_advantage_core_model_missing");
  requireText("routingAdvantage", 'benchmark_kind: "next_best_executable_route"', "carry_routing_advantage_neutral_benchmark_missing");
  requireText("routingAdvantage", "bestRoute(candidates.filter((route) => !sameRoute(route, selected)))", "carry_routing_advantage_next_best_route_missing");
  requireText("routingAdvantageTest", "keeps the routing benchmark venue-neutral", "carry_routing_advantage_venue_neutral_test_missing");
  requireText("routingAdvantageTest", "fails closed without a distinct comparison route", "carry_routing_advantage_comparison_test_missing");
  requireText("routingAdvantage", 'benchmark_kind: "no_trade"', "carry_routing_selected_value_benchmark_missing");
  requireText("routingAdvantage", 'unavailableRoute(asset, "comparison_route_unavailable", selected, notionalMicro)', "carry_routing_selected_value_binding_missing");
  requireText("routingAdvantageTest", "selected_value.benchmark_kind", "carry_routing_selected_value_test_missing");
  requireText("webCarryMarket", 'summary.benchmark_kind === "next_best_executable_route"', "carry_routing_advantage_web_neutral_benchmark_missing");
  requireText("webCarryMarket", "baselineDistinct", "carry_routing_advantage_distinct_baseline_gate_missing");
  forbidText("routingAdvantage", "anchor_venue_id", "carry_routing_advantage_anchor_forbidden");
  forbidText("webCarryMarket", "anchor_venue_id", "carry_routing_advantage_web_anchor_forbidden");
  forbidText("webCarryMarket", "Hyperliquid-anchored", "carry_routing_advantage_hyperliquid_copy_forbidden");
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
  requireText("webCarryMarket", 'label: "NET✓"', "carry_routing_selected_value_label_missing");
  requireText("webCarryMarket", "no second funding-qualified route exists", "carry_routing_selected_value_boundary_missing");
  requireText("webCarryMarket", "modeled_net_micro_usdc_per_day === route?.selected_modeled_net_micro_usdc_per_day", "carry_routing_selected_value_amount_binding_missing");
  requireText("webCarryMarket", "selectedNet: committedSelectedNet", "carry_routing_selected_value_result_missing");
  requireText("webCarryMarketTest", "shows worker-committed net value without inventing route savings", "carry_routing_selected_value_web_test_missing");
  requireText("webCarryChart", 'data-net-evidence={committedSelectedNet ? "committed" : "indicative"}', "carry_terminal_selected_net_state_missing");
  requireText("webCarryChart", 'committedSelectedNet ? "NET24H✓" : "NET24H*"', "carry_terminal_selected_net_display_missing");
  requireText("webCarryChartTest", "NET24H✓+3.50BP/D", "carry_terminal_selected_net_test_missing");
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
  requireText("webCarryBuilder", "selected_long_venue_id", "carry_terminal_selected_pair_matrix_binding_missing");
  requireText("webCarryBuilder", "const selectedResult = asRecord(selectedPair.result)", "carry_terminal_selected_pair_matrix_reuse_missing");
  requireText("webRoute", "carry_selected_pair_worker_binding_invalid", "carry_selected_pair_proxy_binding_missing");
  requireText("webPassportTest", "rejects a tampered selected-route proof before readiness", "carry_selected_pair_tamper_test_missing");
  requireText("webCarryBuilder", "getCarryExecutionReadiness", "carry_terminal_readiness_restore_missing");
  requireText("webCarryBuilder", "readyStoredReadiness", "carry_terminal_readiness_freshness_missing");
  requireText("webCarryBuilder", "CARRY_EXECUTION_VENUES.every", "carry_terminal_matrix_registry_missing");
  requireText("webCarryBuilder", "carryFleetGuardSummary", "carry_terminal_partial_fleet_evidence_missing");
  requireText("webCarryBuilder", "CONNECT FLEET", "carry_terminal_fleet_remediation_missing");
  requireText("webCarryBuilder", "/account?setup=carry&return_to=", "carry_terminal_fleet_setup_scope_missing");
  requireText("webCarryBuilderTest", 'item.textContent === "CONNECT FLEET"', "carry_terminal_fleet_remediation_test_missing");
  requireText("webCarryBuilder", "CONNECT PAIR", "carry_terminal_pair_remediation_missing");
  requireText("webCarryBuilder", "/account?setup=carry&long_venue=${encodeURIComponent(candidate.long.venue_id)}&short_venue=${encodeURIComponent(candidate.short.venue_id)}&return_to=", "carry_terminal_pair_setup_scope_missing");
  requireText("webCarryBuilderTest", 'item.textContent === "CONNECT PAIR"', "carry_terminal_pair_remediation_test_missing");
  requireText("webCarryBuilderTest", 'setup.searchParams.get("long_venue")', "carry_terminal_pair_setup_test_missing");
  requireText("webCarryBuilder", "useFleetSetup ? fleetSetupHref : pairSetupHref", "carry_terminal_setup_scope_switch_missing");
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
  requireText("webCarryMarket", "carryEvidenceResponseForEffectiveVenues", "carry_live_patch_evidence_invalidation_missing");
  requireText("webCarryChart", "committedEvidenceResponse", "carry_live_patch_evidence_downgrade_missing");
  requireText("webCarryMarketTest", "invalidates committed evidence when a live patch changes its snapshot", "carry_live_patch_evidence_invalidation_test_missing");
  requireText("webCarryChartTest", "downgrades every committed economic claim after a live funding patch", "carry_live_patch_evidence_ui_test_missing");
  requireText("webCarryChartTest", "downgrades committed worker economics after a live orderbook patch", "carry_live_orderbook_evidence_ui_test_missing");
  requireText("webCarryMarket", "orderbookInvalidated", "carry_live_orderbook_quarantine_missing");
  requireText("webCarryMarket", "bestBid = orderbookInvalidated ? null", "carry_live_orderbook_bbo_clear_missing");
  requireText("webCarryMarket", "orderbookInvalidated ? { orderbook: 0 }", "carry_live_orderbook_persistent_quarantine_missing");
  requireText("webCarryMarketTest", "does not let an orderbook patch revive stale funding", "carry_partial_patch_staleness_test_missing");
  requireText("webCarryMarketTest", "keeps an invalidated orderbook quarantined until a complete replacement arrives", "carry_live_orderbook_persistent_quarantine_test_missing");
  requireText("webCarryMarketTest", "excludes same-ticker contracts when equivalence, basis, or synchronization evidence fails", "carry_terminal_contract_equivalence_test_missing");
  requireText("webCarryMarketTest", "charges capital, latency, and cross-collateral basis buffers before ranking net value", "carry_terminal_complete_net_cost_test_missing");
  requireText("webCarryMarket", "export function buildPairCandidates", "carry_pair_enumeration_missing");
  requireText("webCarryMarket", "export function rankCarryCandidatesByNet", "carry_net_ranking_engine_missing");
  requireText("webCarryLiveMarket", "wss://mainnet.zklighter.elliot.ai", "lighter_live_feed_missing");
  requireText("webCarryLiveMarket", "CARRY_BROWSER_STREAM_VENUES", "carry_browser_stream_registry_missing");
  forbidText("webCarryLiveMarket", '["lighter", "aster", "dydx", "edgex"]', "carry_browser_stream_registry_duplicated");
  requireText("webCarryLiveMarket", "UNCHANGED_PATCH_HEARTBEAT_MS", "carry_live_patch_dedupe_missing");
  requireText(
    "webCarryLiveMarket",
    "const batch = [...patches.values()];\n    patches.clear();",
    "carry_live_publisher_sticky_patch_forbidden",
  );
  requireText("webCarryLiveMarket", "wss://fstream.asterdex.com", "aster_live_feed_missing");
  requireText("webCarryLiveMarket", "@depth20@100ms", "aster_live_depth_feed_missing");
  requireText("webCarryLiveMarket", "wss://indexer.dydx.trade", "dydx_live_feed_missing");
  requireText("webCarryLiveMarket", "wss://edgex-quote-prod-v2.edgex.exchange", "edgex_live_feed_missing");
  requireText("webCarryLiveMarket", "sequenceValue(message.message_id)", "dydx_live_depth_sequence_gate_missing");
  requireText("webCarryLiveMarket", "sequence !== state.sequence + BigInt(1)", "dydx_live_depth_gap_gate_missing");
  requireText("webCarryLiveMarket", "state.subscribed", "dydx_live_depth_handshake_buffer_missing");
  requireText("webCarryLiveMarket", "state.subscriptionFrames", "dydx_live_depth_snapshot_buffer_missing");
  requireText("webCarryLiveMarket", "[...subscriptionFrames, ...state.pending]", "dydx_live_depth_interleaved_handshake_missing");
  requireText("webCarryLiveMarket", "state.connectionId !== connectionId", "dydx_live_depth_connection_binding_missing");
  requireText("webCarryLiveMarket", "connectionId !== state.connectionId", "dydx_live_depth_frame_connection_binding_missing");
  requireText("webCarryLiveMarket", "state.protocolVersion !== version", "dydx_live_depth_version_binding_missing");
  requireText("webCarryLiveMarket", "size < 0", "carry_live_depth_malformed_level_gate_missing");
  requireText("webCarryLiveMarket", "CARRY_STREAM_HANDSHAKE_TIMEOUT_MS", "carry_live_depth_handshake_timeout_missing");
  requireText("webCarryLiveMarket", "CARRY_STREAM_SILENCE_TIMEOUT_MS", "carry_live_depth_silence_timeout_missing");
  requireText("webCarryLiveMarket", "uncrossDydxBook", "dydx_live_depth_uncross_missing");
  requireText("webCarryLiveMarket", "bookWatchdogs", "carry_live_depth_per_book_watchdog_missing");
  requireText("webCarryLiveMarket", "existingBook.sequence", "edgex_live_depth_backward_snapshot_gate_missing");
  requireText("webCarryLiveMarket", "startVersion > existingBook.sequence + BigInt(1)", "edgex_live_depth_gap_gate_missing");
  requireText("webCarryLiveMarket", "bookIsCrossed(book)", "edgex_live_depth_crossed_book_gate_missing");
  requireText("webCarryLiveMarket", "invalidateVenueOrderBooks", "carry_live_depth_recovery_missing");
  requireText("webCarryLiveMarketTest", "inside one 16ms UI frame", "carry_hot_path_benchmark_missing");
  requireText("webCarryLiveMarketTest", "buildPairCandidates", "carry_pair_hot_path_benchmark_missing");
  requireText("webCarryLiveMarketTest", "rankCarryCandidatesByNet", "carry_net_rank_hot_path_benchmark_missing");
  requireText("webCarryLiveMarketTest", "coalesces later ticks within one frame", "carry_ui_publication_test_missing");
  forbidText("webCarryLiveMarketTest", "below one millisecond", "carry_unrealistic_sub_ms_claim_forbidden");
  forbidText("webCarryLiveMarketTest", "sub-ms", "carry_unrealistic_sub_ms_claim_forbidden");
  requireText("webCarryLiveMarketTest", "suppresses non-BBO dYdX depth churn", "carry_depth_churn_test_missing");
  requireText("webCarryLiveMarketTest", "buffers out-of-order dYdX handshakes", "dydx_live_depth_gap_test_missing");
  requireText("webCarryLiveMarketTest", "missing connection ID", "dydx_live_depth_frame_connection_test_missing");
  requireText("webCarryLiveMarketTest", "duplicate sequence", "dydx_live_depth_duplicate_test_missing");
  requireText("webCarryLiveMarketTest", "replaces edgeX absolute depth, deletes zero", "edgex_live_depth_gap_test_missing");
  requireText("webCarryLiveMarketTest", "quarantines malformed edgeX depth", "carry_live_depth_malformed_level_test_missing");
  requireText("webCarryLiveMarketTest", "quarantines stalled handshakes and silent dYdX sockets", "carry_live_depth_watchdog_test_missing");
  requireText("webCarryLiveMarketTest", "does not let one active dYdX asset mask a silent book", "carry_live_depth_per_book_watchdog_test_missing");
  requireText("webCarryLiveMarketTest", "uncrosses dYdX depth by logical offset", "dydx_live_depth_uncross_test_missing");
  requireText("webCarryLiveMarketTest", "quarantines a backward edgeX replacement snapshot", "edgex_live_depth_backward_snapshot_test_missing");
  requireText("webCarryLiveMarketTest", "keeps Aster slippage depth live", "aster_live_depth_test_missing");
  requireText("webCarryLiveMarketTest", "assertPatchOmitsDepth", "aster_live_depth_isolation_test_missing");
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
  requireText("webAccountSetup", "data-carry-account-readiness", "carry_setup_account_readiness_status_missing");
  requireText("webAccountSetup", "No wallet action was enabled.", "carry_setup_account_readiness_fail_closed_missing");
  requireText("webAccountSetup", "getHyperliquidExecutionVaultStatus(),", "carry_setup_vault_status_fail_closed_missing");
  forbidText("webAccountSetup", "getHyperliquidExecutionVaultStatus().catch", "carry_setup_vault_status_soft_fail_forbidden");
  requireText("webAccountSetup", "accountReadinessGenerationRef.current", "carry_setup_readiness_generation_gate_missing");
  requireText("webAccountSetup", "accountReadinessResolvedScope === recoveryUserScope", "carry_setup_readiness_user_scope_gate_missing");
  requireText("webAccountSetup", "accountReadinessReady && scopedActivationNeeded", "carry_setup_account_readiness_activation_gate_missing");
  requireText("webAccountSetupTest", "blocks wallet preparation on vault-status failure and unlocks only after a successful retry", "carry_setup_vault_status_retry_test_missing");
  requireText("webAccountSetupTest", "ignores a readiness response that resolves after logout", "carry_setup_readiness_logout_race_test_missing");
  requireText("webAccountSetupTest", "rechecks a switched user and ignores the prior user's late response", "carry_setup_readiness_user_switch_test_missing");
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
  requireText("webAccountSetup", "hyperliquidMarketFromTradeReturn(safeReturnTo)", "hyperliquid_setup_carry_return_binding_missing");
  requireText("webAccountSetup", "<TurnkeyPerpsManager", "hyperliquid_setup_inline_manager_missing");
  requireText("webAccountSetup", 'setHyperliquid("connected")', "hyperliquid_setup_carry_resume_missing");
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
  requireText(
    "webPrivateAccountStore",
    "export async function claimConnectorWorkOrderForPreview(",
    "connector_preview_atomic_claim_missing",
  );
  requireText(
    "webPrivateAccountStore",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_private_account_connector_work_orders_preview_unique",
    "connector_preview_unique_index_missing",
  );
  requireText(
    "webPrivateAccountStore",
    "ON CONFLICT DO NOTHING\n    RETURNING *",
    "connector_preview_insert_if_absent_missing",
  );
  requireCount(
    "webPrivateAccountRouteLib",
    "claimConnectorWorkOrderForPreview",
    2,
    "connector_preview_claim_route_binding_missing",
  );
  requireText(
    "webPrivateAccountRouteLib",
    "workOrderRecord.approval_commitment !== input.approval_commitment",
    "connector_preview_approval_binding_missing",
  );
  requireText(
    "webPrivateAccountRouteLib",
    "A preview is a one-shot authorization envelope.",
    "connector_preview_one_shot_fail_closed_missing",
  );
  requireText(
    "webPrivateAccountStoreTest",
    "atomically binds one connector work order to each preview",
    "connector_preview_atomic_claim_test_missing",
  );
  requireText("webConnectorReconciliation", 'if (venueId === "aster") return "/venues/aster/reconcile";', "connector_aster_reconcile_route_missing");
  requireText("webConnectorReconciliation", 'if (venueId === "lighter") return "/venues/lighter/reconcile";', "connector_lighter_reconcile_route_missing");
  requireText("webConnectorReconciliation", 'if (venueId === "coinbase_advanced") return "/venues/coinbase/reconcile";', "connector_coinbase_reconcile_route_missing");
  requireText(
    "webConnectorReconciliation",
    'venueId === "hyperliquid" || venueId === "aster" || venueId === "lighter"',
    "connector_perp_reconcile_venue_binding_missing",
  );
  requireText(
    "webConnectorReconciliation",
    'platformClass === "coinbase_style_provider" && venueId === "coinbase_advanced"',
    "connector_coinbase_reconcile_venue_binding_missing",
  );
  requireText("webConnectorReconciliation", 'proof.proof_kind === "aster_client_order_reconciliation_v1"', "connector_aster_exact_proof_missing");
  requireText("webConnectorReconciliation", 'proof.proof_kind === "lighter_client_order_index_reconciliation_v1"', "connector_lighter_exact_proof_missing");
  requireText("webConnectorReconciliation", 'proof.proof_kind === "coinbase_advanced_order_state_v1"', "connector_coinbase_exact_proof_missing");
  requireText("webConnectorReconciliation", "proof.target_order_matched === true", "connector_coinbase_target_order_gate_missing");
  requireText("webConnectorReconciliation", "proof.target_product_matched === true", "connector_coinbase_target_product_gate_missing");
  requireText("webConnectorReconciliation", "proof.original_order_target_matched === true", "connector_original_order_target_gate_missing");
  requireText("webConnectorReconciliationTest", "binds %s reconciliation route, vault, instruction, and proof", "connector_dedicated_perp_reconcile_test_missing");
  requireText("webConnectorReconciliationTest", "rejects a cross-venue proof for an exact Lighter reconciliation", "connector_cross_venue_proof_rejection_test_missing");
  requireText("webConnectorReconciliationTest", "fails closed before fetch when the venue does not match the platform", "connector_reconcile_platform_gate_test_missing");
  requireText("webConnectorReconciliationTest", "rejects generic Coinbase 2xx reconciliation", "connector_coinbase_generic_proof_rejection_test_missing");
  requireText("webConnectorReconciliationTest", "accepts only exact terminal Coinbase order proof", "connector_coinbase_exact_proof_test_missing");
  requireText("privateExecution", "export async function reconcileAsterOrder(", "worker_aster_dedicated_reconcile_missing");
  requireText("privateExecution", "const result = await reconcileAsterExecution({", "worker_aster_reconcile_adapter_missing");
  requireText("privateExecution", "export async function reconcileLighterOrder(", "worker_lighter_dedicated_reconcile_missing");
  requireText("privateExecution", "const result = await reconcileLighterExecution({", "worker_lighter_reconcile_adapter_missing");
  requireText("privateExecution", "export async function reconcileCoinbaseOrder(", "worker_coinbase_dedicated_reconcile_missing");
  requireText("privateExecution", "const result = await reconcileCoinbaseExecution({", "worker_coinbase_reconcile_adapter_missing");
  requireText("server", 'url.pathname === "/venues/aster/reconcile"', "worker_aster_reconcile_route_missing");
  requireText("server", 'url.pathname === "/venues/lighter/reconcile"', "worker_lighter_reconcile_route_missing");
  requireText("server", 'url.pathname === "/venues/coinbase/reconcile"', "worker_coinbase_reconcile_route_missing");
  requireText("coinbase", "export async function reconcileCoinbaseExecution({", "coinbase_exact_reconcile_adapter_missing");
  requireText("coinbase", "target_client_order_matched: targetClientOrderMatched", "coinbase_exact_client_order_proof_missing");
  requireText("coinbase", "target_product_matched: targetProductMatched", "coinbase_exact_product_proof_missing");
  requireText("coinbase", "original_order_target_matched: exactTargetMatched", "coinbase_exact_target_proof_missing");
  requireText("coinbase", "async function locateCoinbaseOrderByClientOrderId({", "coinbase_targeted_reconcile_lookup_missing");
  requireText("coinbase", "for (let page = 0; page < 3; page += 1)", "coinbase_targeted_reconcile_lookup_unbounded");
  requireText(
    "coinbase",
    "order?.client_order_id === clientOrderId && order?.product_id === productId",
    "coinbase_targeted_reconcile_lookup_not_exact",
  );
  requireText(
    "coinbase",
    'matches.length === 1 && typeof matches[0]?.order_id === "string"',
    "coinbase_targeted_reconcile_lookup_not_unique",
  );
  requireText(
    "coinbase",
    "if (instruction.reconcile?.target_work_order_commitment && !targetOrderId)",
    "coinbase_targeted_reconcile_fallback_missing",
  );
  requireText("coinbase", "targetOrderId = located?.order_id || null", "coinbase_targeted_reconcile_fallback_order_binding_missing");
  requireText(
    "coinbase",
    "const exactTargetMatched = targetOrderMatched && targetClientOrderMatched && targetProductMatched;",
    "coinbase_exact_target_conjunction_missing",
  );
  requireText("coinbase", "const terminal = exactTargetMatched && coinbaseOrderTerminal(order);", "coinbase_terminal_exact_target_gate_missing");
  requireText("coinbaseTest", "rejects a terminal Coinbase row that does not match the exact submitted order", "coinbase_mismatched_target_test_missing");
  requireText(
    "coinbaseTest",
    "recovers an ambiguous Coinbase response by locating the exact client order once",
    "coinbase_targeted_reconcile_fallback_test_missing",
  );
  requireText(
    "coinbaseTest",
    "keeps Coinbase ambiguous when the exact client order cannot be found",
    "coinbase_targeted_reconcile_not_found_test_missing",
  );
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
  requireText("lifecycleTest", "restart-frozen reconciled entry resumes active or exiting without resubmission", "carry_restart_frozen_entry_reconciliation_test_missing");
  requireText("lifecycleTest", "restart recovery closes only the failed leg of a symmetric partial entry", "carry_partial_exit_missing_leg_recovery_test_missing");
  requireText("lifecycleTest", "restart closes a symmetric partial entry once and remains proven flat with zero orders", "carry_partial_restart_flat_zero_test_missing");
  requireText("evidenceVerifier", "ghola_cross_venue_carry_mainnet_release_proof", "carry_release_evidence_kind_missing");
  requireText("evidenceVerifier", 'lifecycles.length >= 2', "carry_release_lifecycle_floor_missing");
  requireText("evidenceVerifier", "unique_position_count_insufficient", "carry_release_unique_position_gate_missing");
  requireText("evidenceVerifier", "distinct_venue_pair_count_insufficient", "carry_release_distinct_pair_gate_missing");
  requireText("evidenceVerifier", "cross_lifecycle_client_order_commitments_not_unique", "carry_release_execution_uniqueness_gate_missing");
  requireText("evidenceVerifier", "lifecycle_worker_commitments_not_unique", "carry_release_lifecycle_uniqueness_gate_missing");
  requireText("evidenceVerifier", "aggregate_realized_net_value_mismatch", "carry_release_aggregate_value_gate_missing");
  requireText("evidenceVerifier", "exact_exit_quantity_required", "carry_release_exact_exit_gate_missing");
  requireText("evidenceVerifier", "final_open_orders_not_zero", "carry_release_zero_orders_gate_missing");
  requireText("evidenceVerifier", "realized_net_value_mismatch", "carry_release_value_reconciliation_missing");
  requireText("evidenceVerifier", "owner_signature_mismatch", "carry_release_signature_verifier_missing");
  requireText("evidenceVerifierTest", "rejects an ambiguous resubmission", "carry_release_ambiguity_test_missing");
  requireText("evidenceVerifierTest", "rejects a mutated or replayed owner mandate", "carry_release_mandate_tamper_test_missing");
  requireText("evidenceVerifierTest", "accepts two unique flat lifecycles across two venue pairs and aggregates exact net value", "carry_release_portfolio_acceptance_test_missing");
  requireText("evidenceVerifierTest", "rejects execution and lifecycle commitments reused across otherwise distinct lifecycles", "carry_release_portfolio_uniqueness_test_missing");
  requireText("evidenceVerifierTest", "rejects any non-flat lifecycle and an inexact aggregate realized net value", "carry_release_portfolio_rejection_test_missing");
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
  const attestation = attestCarryReleaseSourceTree({
    repoRoot: REPO_ROOT,
    releaseFiles: Object.values(CARRY_RELEASE_FILES),
  });
  console.log(`[carry-execution-contract] attested ${result.required_file_count} clean release-critical sources ${attestation.source_tree_digest}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
