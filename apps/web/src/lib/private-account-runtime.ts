import {
  containsForbiddenPublicPrivateAccountField,
  gholaCommitment,
  type GholaAdversarialLinkabilitySimulation,
  type GholaPlatformClass,
  type GholaPlatformFundingRotation,
  type GholaPrivacyScheduleDecision,
  type GholaPrivateAccountReceipt,
  type GholaPrivateModeEvidenceChain,
  type GholaRailKind,
  type GholaSealedRuntimeContext,
} from "./private-account";
import type {
  ConnectorSafeIntentInput,
  GholaCompiledPrivateIntent,
  GholaConnectorManifest,
  GholaLinkabilityScore,
} from "./private-account-connectors";

export type GholaSealedRuntimeMode = "http" | "local_test";
export type GholaSealedRuntimeStatus = "green" | "red";

export interface GholaRuntimeHealth {
  version: 1;
  status: GholaSealedRuntimeStatus;
  mode: GholaSealedRuntimeMode;
  runtime_health_commitment: string;
  runtime_attestation_commitment: string | null;
  runtime_measurement_commitment: string | null;
  runtime_policy_commitment: string | null;
  observed_at: string;
  reason: string | null;
}

export interface GholaRuntimeEnvelope {
  version: 1;
  runtime_envelope_commitment: string;
  owner_commitment: string;
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  platform_class: GholaPlatformClass;
  encrypted_payload_commitment: string;
  payload_policy_commitment: string;
  created_at: string;
  expires_at: string;
}

export interface GholaViewKey {
  version: 1;
  view_key_commitment: string;
  owner_commitment: string;
  scope: "user_private_receipt" | "auditor_selective_disclosure";
  audience_commitment: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface GholaPrivateReceiptExport {
  version: 1;
  private_export_commitment: string;
  receipt_commitment: string;
  view_key_commitment: string;
  encrypted_receipt_ciphertext: string;
  encrypted_receipt_commitment: string;
  runtime_envelope_commitment: string | null;
  runtime_attestation_commitment: string | null;
  revocation_commitment: string;
  created_at: string;
  revoked_at: string | null;
}

export interface GholaAuditorExportRevocation {
  version: 1;
  revocation_commitment: string;
  private_export_commitment: string;
  view_key_commitment: string;
  revoked_at: string;
}

export function sealedRuntimeHealth(
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): GholaRuntimeHealth {
  const mode = runtimeMode(env);
  if (mode === "local_test") {
    const status = env.NODE_ENV === "production" ? "red" : "green";
    return runtimeHealth({
      status,
      mode,
      now,
      runtime_attestation_commitment: status === "green"
        ? gholaCommitment("runtime_attestation", "local_test")
        : null,
      runtime_measurement_commitment: status === "green"
        ? gholaCommitment("runtime_measurement", "local_test")
        : null,
      runtime_policy_commitment: status === "green"
        ? gholaCommitment("runtime_policy", "sealed_runtime_only")
        : null,
      reason: status === "green" ? null : "local_test sealed runtime disabled in production",
    });
  }
  const configured = Boolean(env.GHOLA_PRIVATE_RUNTIME_URL?.trim());
  const measurement = env.GHOLA_PRIVATE_RUNTIME_MEASUREMENT || "configured";
  const expectedMeasurement = env.GHOLA_PRIVATE_RUNTIME_EXPECTED_MEASUREMENT?.trim();
  const measurementMatches = !expectedMeasurement || expectedMeasurement === measurement;
  return runtimeHealth({
    status: configured && measurementMatches ? "green" : "red",
    mode,
    now,
    runtime_attestation_commitment: configured && measurementMatches
      ? gholaCommitment("runtime_attestation", env.GHOLA_PRIVATE_RUNTIME_URL)
      : null,
    runtime_measurement_commitment: configured && measurementMatches
      ? gholaCommitment("runtime_measurement", measurement)
      : null,
    runtime_policy_commitment: configured && measurementMatches
      ? gholaCommitment("runtime_policy", "sealed_runtime_only")
      : null,
    reason: configured
      ? measurementMatches ? null : "sealed runtime measurement does not match expected value"
      : "sealed runtime URL is not configured",
  });
}

export async function freshSealedRuntimeHealth(
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<GholaRuntimeHealth> {
  const mode = runtimeMode(env);
  if (mode === "local_test") return sealedRuntimeHealth(now, env);

  const runtimeUrl = env.GHOLA_PRIVATE_RUNTIME_URL?.trim();
  if (!runtimeUrl) {
    return runtimeHealth({
      status: "red",
      mode,
      now,
      runtime_attestation_commitment: null,
      runtime_measurement_commitment: null,
      runtime_policy_commitment: null,
      reason: "sealed runtime URL is not configured",
    });
  }

  let url: URL;
  try {
    url = new URL(runtimeUrl);
  } catch {
    return runtimeHealth({
      status: "red",
      mode,
      now,
      runtime_attestation_commitment: null,
      runtime_measurement_commitment: null,
      runtime_policy_commitment: null,
      reason: "sealed runtime URL is invalid",
    });
  }
  if (url.protocol !== "https:" && env.NODE_ENV === "production") {
    return runtimeHealth({
      status: "red",
      mode,
      now,
      runtime_attestation_commitment: null,
      runtime_measurement_commitment: null,
      runtime_policy_commitment: null,
      reason: "sealed runtime health must use https in production",
    });
  }
  const healthUrl = new URL("/health", url);
  const headers = new Headers({ accept: "application/json" });
  const token = env.GHOLA_PRIVATE_RUNTIME_TOKEN?.trim();
  if (token) headers.set("authorization", `Bearer ${token}`);

  try {
    const controller = new AbortController();
    const timeoutMs = positiveIntegerEnv(env, "GHOLA_PRIVATE_RUNTIME_HEALTH_TIMEOUT_MS", 2_500);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(healthUrl, {
        method: "GET",
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      return unhealthyFreshRuntime(now, mode, "sealed runtime health endpoint is not ready");
    }
    const body = await response.json() as Record<string, unknown>;
    return healthFromRuntimeBody({
      now,
      env,
      body,
    });
  } catch {
    return unhealthyFreshRuntime(now, mode, "sealed runtime health endpoint is unreachable");
  }
}

function unhealthyFreshRuntime(
  now: Date,
  mode: GholaSealedRuntimeMode,
  reason: string,
): GholaRuntimeHealth {
  return runtimeHealth({
    status: "red",
    mode,
    now,
    runtime_attestation_commitment: null,
    runtime_measurement_commitment: null,
    runtime_policy_commitment: null,
    reason,
  });
}

function healthFromRuntimeBody(input: {
  now: Date;
  env: Record<string, string | undefined>;
  body: Record<string, unknown>;
}): GholaRuntimeHealth {
  const mode: GholaSealedRuntimeMode = "http";
  const body = nestedRuntimeHealthBody(input.body);
  const statusValue = stringField(body, "status") || stringField(input.body, "status");
  const ok = statusValue === "green" ||
    statusValue === "ready" ||
    statusValue === "ok" ||
    input.body.ok === true ||
    body.ok === true;
  const observedAt = dateField(body, "observed_at") ||
    dateField(body, "checked_at") ||
    dateField(input.body, "observed_at") ||
    dateField(input.body, "checked_at");
  const maxStaleMs = positiveIntegerEnv(input.env, "GHOLA_PRIVATE_RUNTIME_MAX_STALE_MS", 5 * 60_000);
  if (!observedAt || input.now.getTime() - observedAt.getTime() > maxStaleMs) {
    return unhealthyFreshRuntime(input.now, mode, "sealed runtime health evidence is stale");
  }

  const attestationCommitment =
    stringField(body, "runtime_attestation_commitment") ||
    stringField(body, "attestation_commitment");
  const measurementCommitment =
    stringField(body, "runtime_measurement_commitment") ||
    stringField(body, "measurement_commitment") ||
    (stringField(body, "measurement")
      ? gholaCommitment("runtime_measurement", stringField(body, "measurement"))
      : null);
  const policyCommitment =
    stringField(body, "runtime_policy_commitment") ||
    stringField(body, "policy_commitment");
  if (!ok || !attestationCommitment || !measurementCommitment || !policyCommitment) {
    return unhealthyFreshRuntime(input.now, mode, "sealed runtime health evidence is incomplete");
  }
  const expectedMeasurement = input.env.GHOLA_PRIVATE_RUNTIME_EXPECTED_MEASUREMENT?.trim();
  if (expectedMeasurement && !measurementMatchesExpected(body, expectedMeasurement, measurementCommitment)) {
    return unhealthyFreshRuntime(input.now, mode, "sealed runtime measurement does not match expected value");
  }
  return runtimeHealth({
    status: "green",
    mode,
    now: observedAt,
    runtime_attestation_commitment: attestationCommitment,
    runtime_measurement_commitment: measurementCommitment,
    runtime_policy_commitment: policyCommitment,
    reason: null,
  });
}

function nestedRuntimeHealthBody(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body.sealed_runtime || body.runtime_health || body.health;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : body;
}

function measurementMatchesExpected(
  body: Record<string, unknown>,
  expectedMeasurement: string,
  observedCommitment: string,
): boolean {
  const observedRaw = stringField(body, "runtime_measurement") ||
    stringField(body, "measurement") ||
    stringField(body, "measurement_hex");
  return expectedMeasurement === observedRaw ||
    expectedMeasurement === observedCommitment ||
    gholaCommitment("runtime_measurement", expectedMeasurement) === observedCommitment;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function dateField(body: Record<string, unknown>, key: string): Date | null {
  const value = stringField(body, key);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function positiveIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createRuntimeEnvelope(input: {
  owner_commitment: string;
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  platform_class: GholaPlatformClass;
  safe_input?: ConnectorSafeIntentInput | null;
  encrypted_payload_commitment?: string | null;
  runtime_envelope_seed?: unknown;
  now?: Date;
}): { ok: true; envelope: GholaRuntimeEnvelope } | { ok: false; error: "forbidden_raw_runtime_field" } {
  if (containsForbiddenPublicPrivateAccountField(input.safe_input ?? {})) {
    return { ok: false, error: "forbidden_raw_runtime_field" };
  }
  const now = input.now ?? new Date();
  const encryptedPayloadCommitment = input.encrypted_payload_commitment?.trim() ||
    gholaCommitment("runtime_encrypted_payload", {
      owner_commitment: input.owner_commitment,
      intent_id: input.intent_id,
      action_commitment: input.action_commitment,
      platform_class: input.platform_class,
      safe_input: input.safe_input ?? null,
      seed: input.runtime_envelope_seed ?? "commitment_only",
    });
  const seed = {
    owner_commitment: input.owner_commitment,
    intent_id: input.intent_id,
    account_commitment: input.account_commitment,
    action_commitment: input.action_commitment,
    platform_class: input.platform_class,
    encrypted_payload_commitment: encryptedPayloadCommitment,
  };
  return {
    ok: true,
    envelope: {
      version: 1,
      runtime_envelope_commitment: gholaCommitment("runtime_envelope", seed),
      owner_commitment: input.owner_commitment,
      intent_id: input.intent_id,
      account_commitment: input.account_commitment,
      action_commitment: input.action_commitment,
      platform_class: input.platform_class,
      encrypted_payload_commitment: encryptedPayloadCommitment,
      payload_policy_commitment: gholaCommitment("runtime_payload_policy", "sealed_runtime_only"),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    },
  };
}

export function sealedRuntimeContext(input: {
  envelope: GholaRuntimeEnvelope;
  health: GholaRuntimeHealth;
}): GholaSealedRuntimeContext {
  const reasonCodes = input.health.status === "green"
    ? []
    : [input.health.reason || "sealed_runtime_unhealthy"];
  return {
    version: 1,
    runtime_status: input.health.status === "green" ? "ready" : "unhealthy",
    runtime_mode: input.health.mode,
    runtime_envelope_commitment: input.envelope.runtime_envelope_commitment,
    runtime_attestation_commitment: input.health.runtime_attestation_commitment,
    runtime_measurement_commitment: input.health.runtime_measurement_commitment,
    runtime_policy_commitment: input.health.runtime_policy_commitment,
    runtime_health_commitment: input.health.runtime_health_commitment,
    runtime_observed_at: input.health.observed_at,
    reason_codes: reasonCodes,
  };
}

export function privacyScheduleDecision(input: {
  compiled_intent: GholaCompiledPrivateIntent;
  evidence_ready: boolean;
  runtime_ready: boolean;
  rotation_status: GholaPlatformFundingRotation["status"];
  simulator_decision: GholaAdversarialLinkabilitySimulation["decision"];
  now?: Date;
}): GholaPrivacyScheduleDecision {
  const now = input.now ?? new Date();
  const fast = input.compiled_intent.urgency_bucket === "fast_degraded";
  const reasonCodes: string[] = [];
  if (fast) reasonCodes.push("fast_degraded_path");
  if (!input.evidence_ready && !fast) reasonCodes.push("waiting_for_batch_evidence");
  if (!input.runtime_ready) reasonCodes.push("waiting_for_sealed_runtime");
  if (input.rotation_status !== "ready") reasonCodes.push("waiting_for_platform_rotation");
  if (input.simulator_decision === "wait_for_batch") reasonCodes.push("simulator_wait_for_batch");
  if (input.simulator_decision === "rotate") reasonCodes.push("simulator_rotate_required");
  if (input.simulator_decision === "blocked") reasonCodes.push("simulator_blocked");
  const status: GholaPrivacyScheduleDecision["status"] = input.simulator_decision === "blocked"
    ? "blocked"
    : fast
      ? "degraded"
      : input.evidence_ready && input.runtime_ready && input.rotation_status === "ready" && input.simulator_decision === "proceed"
        ? "ready"
        : "waiting";
  const mode: GholaPrivacyScheduleDecision["mode"] = fast
    ? "immediate_degraded"
    : status === "ready"
      ? "ready_now"
      : "scheduled_private_window";
  return {
    version: 1,
    schedule_commitment: gholaCommitment("privacy_schedule", {
      compiler_commitment: input.compiled_intent.compiler_commitment,
      status,
      mode,
      reasonCodes,
    }),
    mode,
    status,
    privacy_window_commitment: gholaCommitment("privacy_window", {
      account_commitment: input.compiled_intent.account_commitment,
      platform_class: input.compiled_intent.platform_class,
      asset_bucket: input.compiled_intent.asset_bucket,
      amount_bucket: input.compiled_intent.amount_bucket,
      day: now.toISOString().slice(0, 10),
    }),
    execute_after: status === "waiting"
      ? new Date(now.getTime() + 10 * 60 * 1000).toISOString()
      : null,
    reason_codes: reasonCodes,
  };
}

export function platformFundingRotation(input: {
  owner_commitment: string;
  account_commitment: string;
  platform_class: GholaPlatformClass;
  manifest: GholaConnectorManifest;
  reuse_count?: number;
  withdrawal_destination_reuse_count?: number;
  now?: Date;
}): GholaPlatformFundingRotation {
  const now = input.now ?? new Date();
  const reuse = Math.max(0, Math.floor(input.reuse_count ?? 0));
  const withdrawalReuse = Math.max(0, Math.floor(input.withdrawal_destination_reuse_count ?? 0));
  const reasonCodes: string[] = [];
  if (reuse > 0 && input.manifest.requires_omnibus_funding) reasonCodes.push("platform_funding_account_reuse");
  if (withdrawalReuse > 0) reasonCodes.push("withdrawal_destination_reuse");
  const status: GholaPlatformFundingRotation["status"] = withdrawalReuse >= 3
    ? "blocked"
    : reuse >= 3
      ? "rotate_required"
      : "ready";
  const epochCommitment = gholaCommitment("platform_rotation_epoch", {
    platform_class: input.platform_class,
    day: now.toISOString().slice(0, 10),
    reuse,
  });
  return {
    version: 1,
    rotation_commitment: gholaCommitment("platform_rotation", {
      owner_commitment: input.owner_commitment,
      account_commitment: input.account_commitment,
      platform_class: input.platform_class,
      epochCommitment,
      status,
    }),
    platform_funding_account_commitment: gholaCommitment("platform_funding_account", {
      owner_commitment: input.owner_commitment,
      platform_class: input.platform_class,
      epochCommitment,
    }),
    rotation_epoch_commitment: epochCommitment,
    reuse_count: reuse,
    withdrawal_destination_reuse_count: withdrawalReuse,
    status,
    reason_codes: reasonCodes,
  };
}

export function adversarialLinkabilitySimulation(input: {
  platform_class: GholaPlatformClass;
  selected_rail: GholaRailKind;
  linkability_score: GholaLinkabilityScore;
  rotation: GholaPlatformFundingRotation;
  public_chain_visible: boolean;
  platform_order_visible: boolean;
  provider_account_visible: boolean;
  now?: Date;
}): GholaAdversarialLinkabilitySimulation {
  const now = input.now ?? new Date();
  const actors = {
    chain_observer: input.public_chain_visible ? 2_000 : 0,
    venue: input.platform_order_visible ? 1_500 : 0,
    solver: input.platform_class === "rfq_solver_network" ? 1_000 : 0,
    provider: input.provider_account_visible ? 1_500 : 0,
    colluding_platforms: Math.min(2_000, Math.floor(input.linkability_score.score_bps / 2)),
  };
  const rotationPenalty = input.rotation.status === "blocked"
    ? 3_000
    : input.rotation.status === "rotate_required"
      ? 1_500
      : 0;
  const scoreBps = Math.min(
    10_000,
    Object.values(actors).reduce((sum, value) => sum + value, 0) +
      Math.floor(input.linkability_score.score_bps / 2) +
      rotationPenalty,
  );
  const decision: GholaAdversarialLinkabilitySimulation["decision"] = scoreBps >= 7_500
    ? "blocked"
    : input.rotation.status !== "ready" || scoreBps >= 5_000
      ? "rotate"
      : scoreBps >= 2_500
        ? "wait_for_batch"
        : "proceed";
  const reasonCodes: string[] = [];
  if (input.public_chain_visible) reasonCodes.push("chain_observer_visibility");
  if (input.platform_order_visible) reasonCodes.push("venue_order_visibility");
  if (input.provider_account_visible) reasonCodes.push("provider_account_visibility");
  if (input.rotation.status !== "ready") reasonCodes.push("rotation_not_ready");
  if (decision === "blocked") reasonCodes.push("simulator_threshold_blocked");
  return {
    version: 1,
    simulator_commitment: gholaCommitment("adversarial_linkability_simulator", {
      platform_class: input.platform_class,
      selected_rail: input.selected_rail,
      linkability_score_commitment: input.linkability_score.score_commitment,
      rotation_commitment: input.rotation.rotation_commitment,
      actors,
      scoreBps,
      decision,
    }),
    score_bps: scoreBps,
    decision,
    actors,
    reason_codes: reasonCodes,
    simulated_at: now.toISOString(),
  };
}

export function createViewKey(input: {
  owner_commitment: string;
  scope: GholaViewKey["scope"];
  audience_seed?: string;
  ttl_ms?: number | null;
  now?: Date;
}): GholaViewKey {
  const now = input.now ?? new Date();
  const audienceCommitment = gholaCommitment("view_key_audience", input.audience_seed || input.owner_commitment);
  return {
    version: 1,
    view_key_commitment: gholaCommitment("view_key", {
      owner_commitment: input.owner_commitment,
      scope: input.scope,
      audienceCommitment,
      created_at: now.toISOString(),
    }),
    owner_commitment: input.owner_commitment,
    scope: input.scope,
    audience_commitment: audienceCommitment,
    created_at: now.toISOString(),
    expires_at: input.ttl_ms ? new Date(now.getTime() + input.ttl_ms).toISOString() : null,
    revoked_at: null,
  };
}

export function createPrivateReceiptExport(input: {
  receipt: GholaPrivateAccountReceipt;
  view_key: GholaViewKey;
  evidence_chain: GholaPrivateModeEvidenceChain | null;
  now?: Date;
}): GholaPrivateReceiptExport {
  const now = input.now ?? new Date();
  const ciphertextSeed = {
    receipt_commitment: input.receipt.receipt_commitment,
    view_key_commitment: input.view_key.view_key_commitment,
    claim_levels_achieved: input.receipt.claim_levels_achieved,
    evidence_chain: input.evidence_chain,
  };
  const ciphertext = Buffer.from(JSON.stringify(ciphertextSeed)).toString("base64url");
  const encryptedReceiptCommitment = gholaCommitment("encrypted_private_receipt", ciphertext);
  return {
    version: 1,
    private_export_commitment: gholaCommitment("private_receipt_export", {
      receipt_commitment: input.receipt.receipt_commitment,
      view_key_commitment: input.view_key.view_key_commitment,
      encryptedReceiptCommitment,
    }),
    receipt_commitment: input.receipt.receipt_commitment,
    view_key_commitment: input.view_key.view_key_commitment,
    encrypted_receipt_ciphertext: ciphertext,
    encrypted_receipt_commitment: encryptedReceiptCommitment,
    runtime_envelope_commitment: input.receipt.runtime_envelope_commitment,
    runtime_attestation_commitment: input.receipt.runtime_attestation_commitment,
    revocation_commitment: gholaCommitment("private_receipt_export_revocation", {
      receipt_commitment: input.receipt.receipt_commitment,
      view_key_commitment: input.view_key.view_key_commitment,
    }),
    created_at: now.toISOString(),
    revoked_at: null,
  };
}

export function revokePrivateReceiptExport(input: {
  private_export_commitment: string;
  view_key_commitment: string;
  now?: Date;
}): GholaAuditorExportRevocation {
  const now = input.now ?? new Date();
  return {
    version: 1,
    revocation_commitment: gholaCommitment("private_receipt_export_revoked", {
      private_export_commitment: input.private_export_commitment,
      view_key_commitment: input.view_key_commitment,
      revoked_at: now.toISOString(),
    }),
    private_export_commitment: input.private_export_commitment,
    view_key_commitment: input.view_key_commitment,
    revoked_at: now.toISOString(),
  };
}

export function v6ProductionGateStatus(input: {
  verifier_green: boolean;
  shielded_pool_green: boolean;
  canaries_green: boolean;
  manifests_current: boolean;
  sealed_runtime_attested: boolean;
  batch_coordinator_green: boolean;
  simulator_passed: boolean;
  forbidden_field_tests_passed: boolean;
}) {
  const failures = Object.entries(input)
    .filter(([, passed]) => !passed)
    .map(([key]) => key);
  return {
    version: 1 as const,
    status: failures.length === 0 ? "green" as const : "red" as const,
    private_mode_enabled: failures.length === 0,
    failures,
    gate_commitment: gholaCommitment("v6_production_gates", input),
  };
}

export function pilotEnabled(platformClass: GholaPlatformClass, env: Record<string, string | undefined> = process.env): boolean {
  if (platformClass === "hyperliquid_style_market") {
    return env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED === "true";
  }
  if (env.NODE_ENV === "test") return true;
  if (env.GHOLA_CONNECTOR_MODE === "local_test" || env.GHOLA_SHIELDED_POOL_MODE === "local_test") return true;
  if (platformClass === "solana_private_balance") return env.GHOLA_V6_SOLANA_PILOT_ENABLED === "true";
  if (platformClass === "solana_perps_market") {
    return env.GHOLA_VENUE_PHOENIX_PILOT_ENABLED === "true" ||
      env.GHOLA_VENUE_DRIFT_PILOT_ENABLED === "true" ||
      env.GHOLA_VENUE_BACKPACK_PILOT_ENABLED === "true";
  }
  if (platformClass === "solana_swap_aggregator") return env.GHOLA_VENUE_JUPITER_PILOT_ENABLED === "true";
  if (platformClass === "coinbase_style_provider") return env.GHOLA_V6_COINBASE_PILOT_ENABLED === "true";
  return false;
}

function runtimeHealth(input: {
  status: GholaSealedRuntimeStatus;
  mode: GholaSealedRuntimeMode;
  now: Date;
  runtime_attestation_commitment: string | null;
  runtime_measurement_commitment: string | null;
  runtime_policy_commitment: string | null;
  reason: string | null;
}): GholaRuntimeHealth {
  return {
    version: 1,
    status: input.status,
    mode: input.mode,
    runtime_health_commitment: gholaCommitment("runtime_health", {
      status: input.status,
      mode: input.mode,
      runtime_attestation_commitment: input.runtime_attestation_commitment,
      runtime_measurement_commitment: input.runtime_measurement_commitment,
      runtime_policy_commitment: input.runtime_policy_commitment,
      observed_at: input.now.toISOString(),
    }),
    runtime_attestation_commitment: input.runtime_attestation_commitment,
    runtime_measurement_commitment: input.runtime_measurement_commitment,
    runtime_policy_commitment: input.runtime_policy_commitment,
    observed_at: input.now.toISOString(),
    reason: input.reason,
  };
}

function runtimeMode(env: Record<string, string | undefined>): GholaSealedRuntimeMode {
  if (
    env.GHOLA_PRIVATE_RUNTIME_MODE === "local_test" ||
    env.GHOLA_CONNECTOR_MODE === "local_test" ||
    env.GHOLA_SHIELDED_POOL_MODE === "local_test" ||
    env.NODE_ENV === "test"
  ) {
    return "local_test";
  }
  return "http";
}
