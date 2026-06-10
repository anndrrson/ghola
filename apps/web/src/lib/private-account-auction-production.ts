import { existsSync } from "node:fs";
import path from "node:path";
import { gholaCommitment } from "./private-account";
import { enterpriseGateStatus, type GholaEnterpriseGateStatus } from "./enterprise-gate-status";

export type GholaInstitutionalAuctionMode = "local_test" | "pilot" | "full_production";
export type GholaInstitutionalAuctionReadinessStatus = "ready" | "degraded" | "not_configured" | "blocked";
export type GholaInstitutionalAuctionCheckStatus = "ready" | "missing" | "informational" | "blocked";

export interface GholaInstitutionalAuctionReadinessCheck {
  check: string;
  status: GholaInstitutionalAuctionCheckStatus;
  blocking: boolean;
  reason: string | null;
}

export interface GholaInstitutionalAuctionReadiness {
  version: 1;
  mode: GholaInstitutionalAuctionMode;
  status: GholaInstitutionalAuctionReadinessStatus;
  production_required: boolean;
  full_enterprise_ready: boolean;
  on_chain_routes_implemented: boolean;
  auction_prover_artifacts: GholaAuctionProverArtifactStatus;
  enterprise_gate: GholaEnterpriseGateStatus;
  checks: GholaInstitutionalAuctionReadinessCheck[];
  readiness_commitment: string;
  checked_at: string;
}

export interface GholaAuctionProverArtifactStatus {
  version: 1;
  artifacts_dir: string;
  zkey_path: string;
  wasm_path: string;
  verification_key_path: string;
  zkey_present: boolean;
  wasm_present: boolean;
  verification_key_present: boolean;
  ready: boolean;
  missing: string[];
}

const ON_CHAIN_AUCTION_ROUTES_IMPLEMENTED = true;
const DEFAULT_AUCTION_ZKEY = "auctionClearing_final.zkey";
const DEFAULT_AUCTION_WASM = "auctionClearing_js/auctionClearing.wasm";
const DEFAULT_AUCTION_VERIFICATION_KEY = "auctionClearing_verification_key.json";

export function institutionalAuctionProductionRequired(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.GHOLA_INSTITUTIONAL_FULL_PRODUCTION_ENABLED === "true" || env.NODE_ENV === "production";
}

export function institutionalAuctionOnChainPrepareRequired(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return institutionalAuctionProductionRequired(env) || env.GHOLA_AUCTION_ON_CHAIN_PREPARE === "true";
}

export function institutionalAuctionReadinessStatus(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): GholaInstitutionalAuctionReadiness {
  const productionRequired = institutionalAuctionProductionRequired(env);
  const mode: GholaInstitutionalAuctionMode = productionRequired
    ? "full_production"
    : env.GHOLA_INSTITUTIONAL_AUCTION_PILOT_ENABLED === "true"
      ? "pilot"
      : "local_test";
  const technicalConfigured = Boolean(trimmed(env.GHOLA_SHIELDED_POOL_PROGRAM_ID)) &&
    Boolean(trimmed(env.GHOLA_SHIELDED_POOL_MINT));
  const auctionProverArtifacts = auctionClearingProverArtifactStatus(env);
  const enterpriseGate = enterpriseGateStatus(env, now);
  const checks: GholaInstitutionalAuctionReadinessCheck[] = [
    check(
      "auction_program_configured",
      technicalConfigured ? "ready" : "missing",
      technicalConfigured ? null : "auction_program_or_mint_missing",
    ),
    check(
      "web_on_chain_routes_wired",
      ON_CHAIN_AUCTION_ROUTES_IMPLEMENTED ? "ready" : "missing",
      ON_CHAIN_AUCTION_ROUTES_IMPLEMENTED ? null : "web_routes_still_use_local_store",
    ),
    advisory(
      "auction_clearing_prover_artifacts",
      auctionProverArtifacts.ready,
      auctionProverArtifacts.missing.length > 0
        ? `auction_prover_artifacts_missing:${auctionProverArtifacts.missing.join(",")}`
        : "auction_prover_artifacts_missing",
    ),
    advisory(
      "auction_clearing_verifier_review",
      env.GHOLA_AUCTION_CLEARING_VERIFIER_READY === "true" &&
        Boolean(trimmed(env.GHOLA_AUCTION_CLEARING_VK_HASH)),
      "auction_clearing_vk_or_ceremony_missing",
    ),
    advisory(
      "self_custody_policy",
      env.GHOLA_INSTITUTIONAL_CUSTODY_MODE === "self_custody" &&
        env.GHOLA_SELF_CUSTODY_POLICY_READY === "true",
      "self_custody_policy_missing",
    ),
    advisory(
      "permissions_and_compliance",
      env.GHOLA_INSTITUTIONAL_PERMISSIONS_READY === "true" &&
        env.GHOLA_INSTITUTIONAL_COMPLIANCE_READY === "true",
      "permissions_or_compliance_missing",
    ),
    advisory(
      "audit_exports",
      env.GHOLA_AUCTION_AUDIT_EXPORTS_READY === "true",
      "audit_exports_not_attested",
    ),
    advisory(
      "external_security_review",
      env.GHOLA_EXTERNAL_SECURITY_REVIEW_PASSED === "true" &&
        env.GHOLA_AUCTION_ADVERSARIAL_TESTS_PASSED === "true",
      "security_review_or_adversarial_tests_missing",
    ),
    advisory(
      "rfq_connector_live_ready",
      env.GHOLA_CONNECTOR_MODE !== "local_test" &&
        Boolean(trimmed(env.GHOLA_CONNECTOR_RFQ_SOLVER_NETWORK_URL)) &&
        env.GHOLA_CONNECTOR_RFQ_SOLVER_NETWORK_READINESS === "ready",
      "rfq_connector_not_live_ready",
    ),
    advisory(
      "operations_controls",
      env.GHOLA_AUCTION_OPERATIONS_CONTROLS_READY === "true" &&
        trimmed(env.PRIVATE_AGENT_GLOBAL_KILL_SWITCH) !== "" &&
        Number.parseInt(env.PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE || "", 10) > 0,
      "operations_controls_missing",
    ),
    advisory(
      "runbooks",
      env.GHOLA_INSTITUTIONAL_RUNBOOKS_READY === "true" &&
        env.GHOLA_AUCTION_DISPUTE_RUNBOOK_READY === "true",
      "auction_runbooks_not_accepted",
    ),
    productionGate(
      "enterprise_external_gate",
      !productionRequired || enterpriseGate.status === "ready",
      "enterprise_external_gate_not_ready",
      productionRequired,
    ),
  ];
  const blockingFailure = checks.some((item) => item.blocking && item.status !== "ready");
  const status: GholaInstitutionalAuctionReadinessStatus = !technicalConfigured
    ? "not_configured"
    : blockingFailure
      ? "blocked"
    : checks.some((item) => item.status === "informational")
      ? "degraded"
      : "ready";
  return {
    version: 1,
    mode,
    status,
    production_required: productionRequired,
    full_enterprise_ready: enterpriseGate.status === "ready",
    on_chain_routes_implemented: ON_CHAIN_AUCTION_ROUTES_IMPLEMENTED,
    auction_prover_artifacts: auctionProverArtifacts,
    enterprise_gate: enterpriseGate,
    checks,
    readiness_commitment: gholaCommitment("institutional_auction_readiness", {
      mode,
      status,
      production_required: productionRequired,
      full_enterprise_ready: enterpriseGate.status === "ready",
      auction_prover_artifacts: auctionProverArtifacts,
      enterprise_gate_status: enterpriseGate.status,
      checks,
    }),
    checked_at: now.toISOString(),
  };
}

export function auctionClearingProverArtifactStatus(
  env: Record<string, string | undefined> = process.env,
): GholaAuctionProverArtifactStatus {
  const artifactsDir = resolveConfiguredPath(
    env.GHOLA_AUCTION_PROVER_ARTIFACTS_DIR,
    defaultAuctionArtifactsDir(),
  );
  const zkeyPath = resolveConfiguredPath(
    env.GHOLA_AUCTION_CLEARING_ZKEY_PATH,
    path.join(artifactsDir, DEFAULT_AUCTION_ZKEY),
  );
  const wasmPath = resolveConfiguredPath(
    env.GHOLA_AUCTION_CLEARING_WASM_PATH,
    path.join(artifactsDir, DEFAULT_AUCTION_WASM),
  );
  const verificationKeyPath = resolveConfiguredPath(
    env.GHOLA_AUCTION_CLEARING_VKEY_PATH,
    path.join(artifactsDir, DEFAULT_AUCTION_VERIFICATION_KEY),
  );
  const zkeyPresent = fileExists(zkeyPath);
  const wasmPresent = fileExists(wasmPath);
  const verificationKeyPresent = fileExists(verificationKeyPath);
  const missing = [
    zkeyPresent ? null : "zkey",
    wasmPresent ? null : "wasm",
    verificationKeyPresent ? null : "verification_key",
  ].filter((item): item is string => Boolean(item));

  return {
    version: 1,
    artifacts_dir: artifactsDir,
    zkey_path: zkeyPath,
    wasm_path: wasmPath,
    verification_key_path: verificationKeyPath,
    zkey_present: zkeyPresent,
    wasm_present: wasmPresent,
    verification_key_present: verificationKeyPresent,
    ready: missing.length === 0,
    missing,
  };
}

function advisory(
  checkName: string,
  passed: boolean,
  reason: string,
): GholaInstitutionalAuctionReadinessCheck {
  return check(checkName, passed ? "ready" : "informational", passed ? null : reason);
}

function productionGate(
  checkName: string,
  passed: boolean,
  reason: string,
  blocking: boolean,
): GholaInstitutionalAuctionReadinessCheck {
  return check(checkName, passed ? "ready" : "blocked", passed ? null : reason, blocking);
}

function check(
  checkName: string,
  status: GholaInstitutionalAuctionCheckStatus,
  reason: string | null,
  blocking = false,
): GholaInstitutionalAuctionReadinessCheck {
  return {
    check: checkName,
    status,
    blocking,
    reason,
  };
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

function resolveConfiguredPath(value: string | undefined, fallback: string): string {
  const configured = trimmed(value);
  if (!configured) return fallback;
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function defaultAuctionArtifactsDir(): string {
  const appRelative = path.resolve(process.cwd(), "../../crates/said-shielded-pool-circuits/artifacts");
  if (fileExists(appRelative) || process.cwd().endsWith(path.join("apps", "web"))) return appRelative;
  return path.resolve(process.cwd(), "crates/said-shielded-pool-circuits/artifacts");
}

function fileExists(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}
