#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

export const CARRY_RELEASE_FILES = Object.freeze({
  coreIndex: "packages/execution-core/index.js",
  coreCarry: "packages/execution-core/carry.js",
  coreCarryTest: "packages/execution-core/test/carry.test.js",
  registry: "packages/execution-core/venues.js",
  registryTest: "packages/execution-core/test/venues.test.js",
  server: "apps/private-agent-worker/src/server.js",
  preflight: "apps/private-agent-worker/src/execution/carry-preflight.js",
  positions: "apps/private-agent-worker/src/execution/carry-positions.js",
  executor: "apps/private-agent-worker/src/execution/carry-executor.js",
  privateExecution: "apps/private-agent-worker/src/execution/private-execution.js",
  qualification: "apps/private-agent-worker/src/execution/carry-qualification.js",
  releaseMaterial: "apps/private-agent-worker/src/execution/carry-release-evidence.js",
  shadow: "apps/private-agent-worker/src/execution/perp-shadow-adapters.js",
  hyperliquid: "apps/private-agent-worker/src/venues/hyperliquid.js",
  aster: "apps/private-agent-worker/src/venues/aster.js",
  lighter: "apps/private-agent-worker/src/venues/lighter.js",
  lighterRunner: "apps/private-agent-worker/src/venues/lighter_runner.py",
  webRoute: "apps/web/src/app/v1/private-account/carry/route.ts",
  webClient: "apps/web/src/lib/private-account-client.ts",
  webRegistry: "apps/web/src/lib/carry-venues.ts",
  webPage: "apps/web/src/app/carry/page.tsx",
  webAccountPage: "apps/web/src/app/app/account/page.tsx",
  webAccountSetup: "apps/web/src/components/carry/CarryAccountSetup.tsx",
  webPassport: "apps/web/src/lib/private-agent-passport.ts",
  webPassportTest: "apps/web/src/lib/private-agent-passport.test.ts",
  webPlatformLinkRoute: "apps/web/src/app/v1/private-account/platforms/link/route.ts",
  webWorkspace: "apps/web/src/components/carry/CarryWorkspace.tsx",
  webWorkspaceTest: "apps/web/src/components/carry/CarryWorkspace.test.ts",
  asterVaultSeal: "apps/web/src/lib/aster-vault-seal.ts",
  asterVaultSealTest: "apps/web/src/lib/aster-vault-seal.test.ts",
  lighterVaultSeal: "apps/web/src/lib/lighter-vault-seal.ts",
  lighterVaultSealTest: "apps/web/src/lib/lighter-vault-seal.test.ts",
  lifecycleTest: "apps/private-agent-worker/test/carry-executor.test.js",
  positionsTest: "apps/private-agent-worker/test/carry-positions.test.js",
  preflightTest: "apps/private-agent-worker/test/carry-preflight.test.js",
  qualificationTest: "apps/private-agent-worker/test/carry-qualification.test.js",
  releaseMaterialTest: "apps/private-agent-worker/test/carry-release-evidence.test.js",
  shadowTest: "apps/private-agent-worker/test/perp-shadow-adapters.test.js",
  asterTest: "apps/private-agent-worker/test/aster.test.js",
  lighterTest: "apps/private-agent-worker/test/lighter.test.js",
  hyperliquidMetricsTest: "apps/private-agent-worker/test/hyperliquid-account-metrics.test.js",
  evidenceVerifier: "apps/web/scripts/verify-carry-release-evidence.mjs",
  evidenceVerifierTest: "apps/web/scripts/verify-carry-release-evidence.test.mjs",
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

  for (const venue of ["hyperliquid", "lighter", "aster", "edgex", "dydx"]) {
    requireText("registry", `venue("${venue}"`, `registry_venue_missing:${venue}`);
    requireText("shadow", `${venue}: Object.freeze`, `shadow_adapter_missing:${venue}`);
  }
  requireText("registry", "export const CARRY_EXECUTION_VENUES", "capability_registry_missing");
  requireText("registry", "exact_quantity_recovery_adapter !== null", "recovery_capability_filter_missing");
  requireText("coreIndex", 'from "./venues.js"', "registry_export_missing");
  requireText("coreIndex", 'from "./carry.js"', "carry_domain_export_missing");
  requireText("webRegistry", 'from "@ghola/execution-core"', "web_registry_bridge_missing");
  requireText("webRegistry", "EXECUTION_CORE_CARRY_VENUES", "web_execution_registry_missing");
  requireText("webRegistry", "EXECUTION_CORE_PERP_VENUES", "web_shadow_registry_missing");
  forbidText("webRegistry", '["hyperliquid", "lighter", "aster"]', "web_execution_registry_duplicated");

  requireText("shadow", "CORE_PERP_VENUES.map", "shadow_registry_iteration_missing");
  requireText("shadow", "max_age_ms", "shadow_staleness_gate_missing");
  requireText("preflight", "carry_shadow_unavailable", "stale_shadow_quarantine_missing");
  requireText("preflight", "collateral_basis", "collateral_basis_model_missing");
  requireText("coreCarry", "collateral_basis_risk_bps", "collateral_basis_stress_missing");
  requireText("coreCarry", "calculateMarginRunway", "margin_runway_model_missing");

  requireText("qualification", "adapter_id: spec.exact_quantity_recovery_adapter", "qualification_adapter_binding_missing");
  requireText("qualification", "image_digest: imageDigest", "qualification_image_binding_missing");
  requireText("qualification", 'network: "mainnet"', "qualification_mainnet_proof_missing");
  requireText("qualification", "ambiguous_submission_retry_count: 0", "qualification_no_retry_proof_missing");
  requireText("qualification", "gross_exposure_micro_usdc: 0", "qualification_flat_proof_missing");
  requireText("qualification", "open_order_count: 0", "qualification_zero_orders_proof_missing");
  requireText("releaseMaterial", "buildCompletedCarryReleaseMaterial", "carry_release_material_builder_missing");
  requireText("releaseMaterial", "carry_release_monitoring_evidence_missing", "carry_release_monitoring_gate_missing");
  requireText("releaseMaterial", "attempt?.submit_count !== 1", "carry_release_submit_count_gate_missing");
  requireText("releaseMaterial", "attempt?.ambiguity_retry_count !== 0", "carry_release_retry_count_gate_missing");
  requireText("releaseMaterial", "worker_material_commitment", "carry_release_material_commitment_missing");
  requireText("privateExecution", "submit_count: 1", "durable_submit_count_missing");
  requireText("privateExecution", "ambiguity_retry_count: 0", "durable_retry_count_missing");

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
  requireText("executor", "carry_qualification_pilot_confirmation_required", "pilot_confirmation_gate_missing");
  requireText("executor", "submission_ambiguous", "carry_ambiguity_freeze_missing");
  requireText("executor", "carry_exit_not_flat_or_open_orders_nonzero", "carry_final_flat_gate_missing");
  requireText("server", 'req.headers["x-ghola-carry-qualification-confirmed"] === "true"', "worker_confirmation_header_missing");
  requireText("server", '"/carry/positions/release-evidence"', "worker_release_evidence_route_missing");
  requireText("webRoute", '"x-ghola-carry-qualification-confirmed": "true"', "web_confirmation_header_missing");
  requireText("webClient", "qualification_pilot_confirmed", "web_confirmation_input_missing");
  requireText("webPage", "CarryWorkspace", "carry_page_missing");
  requireText("webAccountPage", "focusedCarrySetup", "carry_account_route_missing");
  requireText("webAccountSetup", "buildAsterExecutionVaultBundle", "aster_account_setup_missing");
  requireText("webAccountSetup", "buildLighterExecutionVaultBundle", "lighter_account_setup_missing");
  requireText("webPlatformLinkRoute", "linkAgentPlatformFromBody", "carry_platform_link_route_missing");
  requireText("webPassportTest", "does not persist an encrypted venue vault before worker verification succeeds", "carry_transactional_vault_test_missing");
  requireText("webPassportTest", "links two Carry venues through authenticated routes", "carry_onboarding_route_test_missing");
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

  requireText("lifecycleTest", "bootstraps one capped candidate only after separate qualification confirmation", "qualification_lifecycle_test_missing");
  requireText("lifecycleTest", "carry_qualification_pilot_confirmation_required", "qualification_denial_test_missing");
  requireText("lifecycleTest", "const restarted = createWorkerState(dir)", "qualification_restart_test_missing");
  requireText("lifecycleTest", "restored.proven", "qualification_restore_assertion_missing");
  requireText("evidenceVerifier", "ghola_cross_venue_carry_mainnet_lifecycle_proof", "carry_release_evidence_kind_missing");
  requireText("evidenceVerifier", "exact_exit_quantity_required", "carry_release_exact_exit_gate_missing");
  requireText("evidenceVerifier", "final_open_orders_not_zero", "carry_release_zero_orders_gate_missing");
  requireText("evidenceVerifier", "realized_net_value_mismatch", "carry_release_value_reconciliation_missing");
  requireText("evidenceVerifierTest", "rejects an ambiguous resubmission", "carry_release_ambiguity_test_missing");
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
