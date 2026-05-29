import {
  DEFAULT_ANONYMITY_SET_POLICY,
  containsForbiddenPublicPrivateAccountField,
  getPlatformPrivacyProfile,
  gholaCommitment,
  venueIdForPlatformClass,
  type GholaConnectorPreviewContext,
  type GholaPlatformClass,
  type GholaPrivateAccountActionClass,
  type GholaPrivacyPreview,
  type GholaRailKind,
  type GholaVenueExecutionMode,
} from "./private-account";
import {
  pilotEnabled,
  sealedRuntimeHealth,
  type GholaRuntimeHealth,
} from "./private-account-runtime";

export type GholaConnectorStatus = "ready" | "missing" | "stale" | "blocked";
export type GholaConnectorMode = "http" | "local_test";
export type GholaConnectorSubmitError =
  | "connector_not_ready"
  | "connector_submit_failed"
  | "connector_submit_blocked"
  | "venue_access_required"
  | "needs_funds"
  | "venue_rejected";
export type GholaLinkabilityRisk = "low" | "medium" | "high";
export type GholaLinkabilityDecision =
  | "proceed"
  | "degraded_acceptance_required"
  | "wait_for_batch"
  | "rotate_or_block"
  | "blocked";

export type GholaConnectorWorkOrderStatus =
  | "prepared"
  | "submitted"
  | "reconciled"
  | "failed"
  | "cancelled"
  | "blocked";

export interface GholaConnectorManifest {
  version: 1;
  manifest_id: string;
  platform_class: GholaPlatformClass;
  label: string;
  supported_actions: GholaPrivateAccountActionClass[];
  pilot_stage: "disabled" | "local_test" | "live_pilot";
  supported_operation_classes: string[];
  sealed_runtime_required: boolean;
  blocked_action_classes: GholaPrivateAccountActionClass[];
  platform_sees: "none" | "minimal" | "order_visible" | "account_visible";
  public_chain_sees: "hidden" | "bucketed" | "visible" | "blocked";
  source_wallet_hidden: boolean;
  order_details_visible: boolean;
  supported_rails: GholaRailKind[];
  minimum_anonymity_set: number;
  minimum_solver_count: number;
  requires_omnibus_funding: boolean;
  allow_live_submit: boolean;
  degraded_conditions: string[];
  blocked_conditions: string[];
  expires_at: string;
  signing_key_id: string;
  manifest_commitment: string;
  signature: string;
}

export interface GholaConnectorReadiness {
  version: 1;
  platform_class: GholaPlatformClass;
  status: GholaConnectorStatus;
  mode: GholaConnectorMode;
  manifest_commitment: string;
  readiness_commitment: string;
  live_submit_enabled: boolean;
  reason_codes: string[];
  checked_at: string;
}

export interface GholaCompiledPrivateIntent {
  version: 1;
  compiler_version: "ghola-intent-compiler-v1";
  compiler_commitment: string;
  ticket_commitment: string;
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  action_class: GholaPrivateAccountActionClass;
  platform_class: GholaPlatformClass;
  product_bucket: string;
  amount_bucket: string;
  asset_bucket: string;
  destination_class: string;
  urgency_bucket: string;
  solver_count_bucket: string;
  manifest_commitment: string;
  runtime_payload_policy: "sealed_runtime_only";
  created_at: string;
}

export interface GholaConnectorSandboxPolicy {
  version: 1;
  policy_commitment: string;
  platform_class: GholaPlatformClass;
  allowed_actions: GholaPrivateAccountActionClass[];
  blocked_actions: GholaPrivateAccountActionClass[];
  allowed_rails: GholaRailKind[];
  requires_degraded_acceptance: boolean;
  ok: boolean;
  reason_codes: string[];
}

export interface GholaLinkabilityScore {
  version: 1;
  score_commitment: string;
  account_commitment: string;
  platform_class: GholaPlatformClass;
  score_bps: number;
  risk: GholaLinkabilityRisk;
  decision: GholaLinkabilityDecision;
  components: {
    repeated_venue_bps: number;
    repeated_size_bucket_bps: number;
    repeated_timing_bps: number;
    reused_platform_funding_account_bps: number;
    same_solver_bps: number;
    withdrawal_destination_reuse_bps: number;
    asset_cadence_bps: number;
  };
  reason_codes: string[];
  created_at: string;
}

export interface GholaConnectorWorkOrder {
  version: 1;
  work_order_commitment: string;
  owner_commitment: string;
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  preview_commitment: string;
  approval_commitment: string | null;
  execution_plan_commitment: string | null;
  platform_class: GholaPlatformClass;
  selected_rail: GholaRailKind;
  manifest_commitment: string;
  connector_readiness_commitment: string;
  compiler_commitment: string;
  linkability_score_commitment: string;
  platform_funding_account_commitment: string;
  rotation_commitment: string;
  status: GholaConnectorWorkOrderStatus;
  created_at: string;
  updated_at: string;
}

export interface GholaConnectorResult {
  version: 1;
  connector_result_commitment: string;
  work_order_commitment: string;
  platform_class: GholaPlatformClass;
  status: "submitted" | "reconciled" | "failed" | "cancelled" | "blocked";
  provider_ref_commitment: string | null;
  result_commitment: string;
  visibility_summary: {
    main_wallet_exposed: boolean;
    venue_saw_order_class: boolean;
    public_chain_settlement: "hidden" | "bucketed" | "visible" | "blocked";
  };
  venue_access_summary: Pick<
    GholaConnectorPreviewContext,
    | "venue_access_source"
    | "ghola_access_role"
    | "venue_gate"
    | "venue_visibility"
    | "source_wallet_visibility"
    | "privacy_claim"
  >;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface GholaConnectorNoFundsVerification {
  version: 1;
  platform_class: GholaPlatformClass;
  status: "verified_no_funds" | "failed" | "worker_unavailable";
  verification_commitment: string;
  work_order_commitment: string;
  manifest_commitment: string;
  connector_readiness_commitment: string;
  result_commitment: string | null;
  provider_ref_commitment: string | null;
  reason: string | null;
  checks: {
    sealed_vault_opened: boolean;
    sealed_instruction_opened: boolean;
    authority_derived: boolean;
    policy_enforced: boolean;
    live_gate_enforced: boolean;
    rpc_reachable: boolean;
    phoenix_sdk_ready: boolean;
    order_packet_built: boolean;
    transaction_broadcast: false;
  };
  visibility_summary: {
    main_wallet_exposed: boolean;
    venue_saw_order_class: boolean;
    public_chain_settlement: "hidden" | "bucketed" | "visible" | "blocked";
  };
  live_readiness_certificate: GholaLiveReadinessCertificate;
  created_at: string;
}

export interface GholaLiveReadinessCertificate {
  version: 1;
  certificate_kind: "ghola_live_readiness_certificate_v1";
  certificate_commitment: string;
  status: "ready_to_attempt_broadcast" | "not_ready" | "worker_unavailable";
  proof_level: "pre_broadcast_live_readiness";
  platform_class: GholaPlatformClass;
  venue_id: "phoenix";
  work_order_commitment: string;
  manifest_commitment: string;
  connector_readiness_commitment: string;
  verification_commitment: string;
  result_commitment: string | null;
  provider_ref_commitment: string | null;
  site_origin_commitment: string | null;
  issued_at: string;
  expires_at: string;
  broadcast_performed: false;
  final_venue_execution_proven: false;
  final_fill_proven: false;
  transaction_simulation_status: "not_performed" | "passed" | "failed";
  checks: {
    production_site_reachable: boolean;
    private_agent_worker_reachable: boolean;
    sealed_vault_opened: boolean;
    sealed_instruction_opened: boolean;
    authority_derived: boolean;
    policy_enforced: boolean;
    live_gate_enforced: boolean;
    solana_rpc_reachable: boolean;
    phoenix_sdk_ready: boolean;
    order_packet_built: boolean;
    transaction_broadcast: false;
  };
  what_is_proven: string[];
  what_is_not_proven: string[];
  next_step: string;
}

export interface ConnectorSafeIntentInput {
  product_bucket?: string;
  amount_bucket?: string;
  asset_bucket?: string;
  destination_class?: string;
  urgency?: string;
  solver_count_bucket?: string;
}

export function listConnectorManifests(now: Date = new Date()): GholaConnectorManifest[] {
  return platformClasses().map((platformClass) => connectorManifest(platformClass, now));
}

export function getConnectorManifest(
  platformClass: GholaPlatformClass,
  now: Date = new Date(),
): GholaConnectorManifest {
  return connectorManifest(platformClass, now);
}

export function verifyConnectorManifest(
  manifest: GholaConnectorManifest,
  now: Date = new Date(),
): { ok: true } | { ok: false; error: "manifest_expired" | "manifest_signature_invalid" | "manifest_profile_mismatch" } {
  if (new Date(manifest.expires_at).getTime() <= now.getTime()) {
    return { ok: false, error: "manifest_expired" };
  }
  const expectedProfile = getPlatformPrivacyProfile(manifest.platform_class);
  if (
    manifest.platform_sees !== expectedProfile.platform_sees ||
    manifest.public_chain_sees !== expectedProfile.public_chain_sees
  ) {
    return { ok: false, error: "manifest_profile_mismatch" };
  }
  const expected = signManifest(manifest.manifest_commitment, manifest.signing_key_id);
  return expected === manifest.signature
    ? { ok: true }
    : { ok: false, error: "manifest_signature_invalid" };
}

export function compilePrivateConnectorIntent(input: {
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  action_class: GholaPrivateAccountActionClass;
  platform_class: GholaPlatformClass;
  product_bucket: string;
  manifest: GholaConnectorManifest;
  safe_input?: ConnectorSafeIntentInput | null;
  now?: Date;
}): { ok: true; compiled_intent: GholaCompiledPrivateIntent } | { ok: false; error: "forbidden_raw_connector_field" } {
  if (containsForbiddenPublicPrivateAccountField(input.safe_input ?? {})) {
    return { ok: false, error: "forbidden_raw_connector_field" };
  }
  const now = input.now ?? new Date();
  const safe = input.safe_input ?? {};
  const ticket = {
    intent_id: input.intent_id,
    account_commitment: input.account_commitment,
    action_commitment: input.action_commitment,
    action_class: input.action_class,
    platform_class: input.platform_class,
    product_bucket: input.product_bucket,
    amount_bucket: bucket(safe.amount_bucket, "25"),
    asset_bucket: bucket(safe.asset_bucket, "stablecoin"),
    destination_class: bucket(safe.destination_class, "ghola_user"),
    urgency_bucket: bucket(safe.urgency, "maximum_privacy"),
    solver_count_bucket: bucket(safe.solver_count_bucket, "5+"),
    manifest_commitment: input.manifest.manifest_commitment,
  };
  return {
    ok: true,
    compiled_intent: {
      version: 1,
      compiler_version: "ghola-intent-compiler-v1",
      compiler_commitment: gholaCommitment("intent_compiler", ticket),
      ticket_commitment: gholaCommitment("connector_ticket", ticket),
      intent_id: input.intent_id,
      account_commitment: input.account_commitment,
      action_commitment: input.action_commitment,
      action_class: input.action_class,
      platform_class: input.platform_class,
      product_bucket: input.product_bucket,
      amount_bucket: ticket.amount_bucket,
      asset_bucket: ticket.asset_bucket,
      destination_class: ticket.destination_class,
      urgency_bucket: ticket.urgency_bucket,
      solver_count_bucket: ticket.solver_count_bucket,
      manifest_commitment: input.manifest.manifest_commitment,
      runtime_payload_policy: "sealed_runtime_only",
      created_at: now.toISOString(),
    },
  };
}

export async function connectorReadiness(input: {
  manifest: GholaConnectorManifest;
  now?: Date;
  env?: Record<string, string | undefined>;
  execution_vault_ready?: boolean;
  shielded_funding_ready?: boolean;
  runtime_health?: GholaRuntimeHealth | null;
  execution_mode?: GholaVenueExecutionMode;
  action_class?: GholaPrivateAccountActionClass;
  operation_class?: string;
  omnibus_allocation_ready?: boolean;
}): Promise<GholaConnectorReadiness> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const mode = connectorMode(env);
  const verification = verifyConnectorManifest(input.manifest, now);
  const reasonCodes: string[] = [];
  if (!verification.ok) reasonCodes.push(verification.error);
  if (!input.manifest.allow_live_submit) reasonCodes.push("connector_live_submit_blocked");
  const venueGate = venueReadinessGate({
    manifest: input.manifest,
    env,
    execution_vault_ready: input.execution_vault_ready === true,
    shielded_funding_ready: input.shielded_funding_ready === true,
    omnibus_allocation_ready: input.omnibus_allocation_ready === true,
    execution_mode: input.execution_mode,
    operation_class: input.operation_class ||
      (input.action_class ? operationForAction(input.manifest.platform_class, input.action_class) : undefined),
    runtime_health: input.runtime_health ?? sealedRuntimeHealth(now, env),
  });
  reasonCodes.push(...venueGate.reason_codes);
  if (mode === "local_test") {
    const localAllowed = process.env.NODE_ENV !== "production";
    const ready = verification.ok && localAllowed && input.manifest.allow_live_submit && venueGate.ok;
    return readiness({
      manifest: input.manifest,
      mode,
      status: ready ? "ready" : "blocked",
      live_submit_enabled: ready,
      reason_codes: localAllowed ? reasonCodes : [...reasonCodes, "local_test_connector_disabled_in_production"],
      now,
    });
  }

  const cfg = connectorEnvConfig(input.manifest.platform_class, env);
  if (!cfg.url) reasonCodes.push("connector_endpoint_missing");
  if (cfg.readiness === "stale") reasonCodes.push("connector_readiness_stale");
  if (cfg.readiness === "blocked") reasonCodes.push("connector_readiness_blocked");
  const status: GholaConnectorStatus = !verification.ok || cfg.readiness === "blocked"
    || !venueGate.ok
    ? "blocked"
    : cfg.readiness === "stale"
      ? "stale"
      : cfg.url && input.manifest.allow_live_submit
        ? "ready"
        : "missing";
  return readiness({
    manifest: input.manifest,
    mode,
    status,
    live_submit_enabled: status === "ready",
    reason_codes: reasonCodes,
    now,
  });
}

export function connectorSandboxPolicy(input: {
  manifest: GholaConnectorManifest;
  compiled_intent: GholaCompiledPrivateIntent;
  selected_rail: GholaRailKind;
}): GholaConnectorSandboxPolicy {
  const reasonCodes: string[] = [];
  if (!input.manifest.supported_actions.includes(input.compiled_intent.action_class)) {
    reasonCodes.push("connector_action_not_supported");
  }
  if (input.manifest.blocked_action_classes.includes(input.compiled_intent.action_class)) {
    reasonCodes.push("connector_action_blocked");
  }
  if (!input.manifest.supported_rails.includes(input.selected_rail)) {
    reasonCodes.push("connector_rail_not_supported");
  }
  if (input.manifest.platform_class === "rfq_solver_network" && input.compiled_intent.solver_count_bucket !== "5+") {
    reasonCodes.push("rfq_single_or_small_solver_set_blocked");
  }
  return {
    version: 1,
    policy_commitment: gholaCommitment("connector_sandbox_policy", {
      manifest: input.manifest.manifest_commitment,
      compiler: input.compiled_intent.compiler_commitment,
      rail: input.selected_rail,
      reasonCodes,
    }),
    platform_class: input.manifest.platform_class,
    allowed_actions: input.manifest.supported_actions,
    blocked_actions: input.manifest.blocked_action_classes,
    allowed_rails: input.manifest.supported_rails,
    requires_degraded_acceptance:
      input.manifest.order_details_visible ||
      input.manifest.public_chain_sees === "visible" ||
      !input.manifest.source_wallet_hidden,
    ok: reasonCodes.length === 0,
    reason_codes: reasonCodes,
  };
}

export function scoreConnectorLinkability(input: {
  account_commitment: string;
  platform_class: GholaPlatformClass;
  compiled_intent: GholaCompiledPrivateIntent;
  prior_platform_actions?: number;
  same_amount_bucket_actions?: number;
  same_asset_bucket_actions?: number;
  reused_platform_funding_account?: boolean;
  same_solver_actions?: number;
  withdrawal_destination_reuse?: number;
  repeated_timing_actions?: number;
  now?: Date;
}): GholaLinkabilityScore {
  const now = input.now ?? new Date();
  const components = {
    repeated_venue_bps: Math.min(2_000, (input.prior_platform_actions ?? 0) * 500),
    repeated_size_bucket_bps: Math.min(1_500, (input.same_amount_bucket_actions ?? 0) * 375),
    repeated_timing_bps: Math.min(1_500, (input.repeated_timing_actions ?? 0) * 500),
    reused_platform_funding_account_bps: input.reused_platform_funding_account ? 2_000 : 0,
    same_solver_bps: Math.min(1_000, (input.same_solver_actions ?? 0) * 500),
    withdrawal_destination_reuse_bps: Math.min(1_000, (input.withdrawal_destination_reuse ?? 0) * 500),
    asset_cadence_bps: Math.min(1_000, (input.same_asset_bucket_actions ?? 0) * 250),
  };
  const scoreBps = Math.min(10_000, Object.values(components).reduce((sum, value) => sum + value, 0));
  const reasonCodes = linkabilityReasons(components);
  const decision: GholaLinkabilityDecision = scoreBps >= 7_500
    ? "blocked"
    : scoreBps >= 5_000
      ? "rotate_or_block"
      : scoreBps >= 2_500
        ? "degraded_acceptance_required"
        : "proceed";
  const risk: GholaLinkabilityRisk = scoreBps >= 5_000 ? "high" : scoreBps >= 2_500 ? "medium" : "low";
  return {
    version: 1,
    score_commitment: gholaCommitment("connector_linkability_score", {
      account_commitment: input.account_commitment,
      platform_class: input.platform_class,
      compiler_commitment: input.compiled_intent.compiler_commitment,
      components,
      scoreBps,
      decision,
    }),
    account_commitment: input.account_commitment,
    platform_class: input.platform_class,
    score_bps: scoreBps,
    risk,
    decision,
    components,
    reason_codes: reasonCodes,
    created_at: now.toISOString(),
  };
}

export function connectorPreviewContext(input: {
  manifest: GholaConnectorManifest;
  readiness: GholaConnectorReadiness;
  compiled_intent: GholaCompiledPrivateIntent;
  sandbox_policy: GholaConnectorSandboxPolicy;
  linkability_score: GholaLinkabilityScore;
}): GholaConnectorPreviewContext {
  const accessContext = connectorAccessContext(input.manifest);
  return {
    version: 1,
    manifest_commitment: input.manifest.manifest_commitment,
    connector_readiness_commitment: input.readiness.readiness_commitment,
    compiler_commitment: input.compiled_intent.compiler_commitment,
    linkability_score_commitment: input.linkability_score.score_commitment,
    sandbox_policy_commitment: input.sandbox_policy.policy_commitment,
    connector_status: input.sandbox_policy.ok ? input.readiness.status : "blocked",
    linkability_decision: input.linkability_score.decision,
    main_wallet_exposed: !input.manifest.source_wallet_hidden,
    venue_order_visibility: input.manifest.order_details_visible
      ? input.manifest.platform_sees === "account_visible"
        ? "account_visible"
        : "order_visible"
      : input.manifest.platform_sees === "minimal"
        ? "ticket_only"
        : "hidden",
    public_chain_settlement_visibility: input.manifest.public_chain_sees,
    ...accessContext,
    reason_codes: [
      ...input.readiness.reason_codes,
      ...input.sandbox_policy.reason_codes,
      ...input.linkability_score.reason_codes,
    ],
  };
}

export function buildConnectorWorkOrder(input: {
  owner_commitment: string;
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  preview: GholaPrivacyPreview;
  approval_commitment?: string | null;
  execution_plan_commitment?: string | null;
  compiled_intent: GholaCompiledPrivateIntent;
  manifest: GholaConnectorManifest;
  readiness: GholaConnectorReadiness;
  linkability_score: GholaLinkabilityScore;
  now?: Date;
}): GholaConnectorWorkOrder {
  const now = input.now ?? new Date();
  const platformFundingAccountCommitment = input.preview.rotation?.platform_funding_account_commitment ??
    gholaCommitment("platform_funding_account", {
      owner_commitment: input.owner_commitment,
      platform_class: input.manifest.platform_class,
      manifest_commitment: input.manifest.manifest_commitment,
    });
  const rotationCommitment = input.preview.rotation?.rotation_commitment ??
    gholaCommitment("platform_funding_rotation", {
      platformFundingAccountCommitment,
      amount_bucket: input.compiled_intent.amount_bucket,
      asset_bucket: input.compiled_intent.asset_bucket,
      day: input.compiled_intent.created_at.slice(0, 10),
    });
  return {
    version: 1,
    work_order_commitment: gholaCommitment("connector_work_order", {
      owner_commitment: input.owner_commitment,
      intent_id: input.intent_id,
      preview_commitment: input.preview.preview_commitment,
      approval_commitment: input.approval_commitment ?? null,
      execution_plan_commitment: input.execution_plan_commitment ?? null,
      compiler_commitment: input.compiled_intent.compiler_commitment,
      readiness_commitment: input.readiness.readiness_commitment,
      linkability_score_commitment: input.linkability_score.score_commitment,
    }),
    owner_commitment: input.owner_commitment,
    intent_id: input.intent_id,
    account_commitment: input.account_commitment,
    action_commitment: input.action_commitment,
    preview_commitment: input.preview.preview_commitment,
    approval_commitment: input.approval_commitment ?? null,
    execution_plan_commitment: input.execution_plan_commitment ?? null,
    platform_class: input.manifest.platform_class,
    selected_rail: input.preview.selected_rail,
    manifest_commitment: input.manifest.manifest_commitment,
    connector_readiness_commitment: input.readiness.readiness_commitment,
    compiler_commitment: input.compiled_intent.compiler_commitment,
    linkability_score_commitment: input.linkability_score.score_commitment,
    platform_funding_account_commitment: platformFundingAccountCommitment,
    rotation_commitment: rotationCommitment,
    status: "prepared",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export async function submitConnectorWorkOrder(input: {
  work_order: GholaConnectorWorkOrder;
  manifest: GholaConnectorManifest;
  compiled_intent: GholaCompiledPrivateIntent;
  preview: GholaPrivacyPreview;
  readiness: GholaConnectorReadiness;
  hyperliquid_execution_vault?: {
    vault_commitment: string;
    encrypted_vault_commitment: string;
    policy_commitment: string;
    encrypted_execution_vault: unknown;
  } | null;
  hyperliquid_managed_allocation?: {
    allocation_commitment: string;
    policy_commitment: string;
    pool_commitment: string;
    subledger_account_commitment: string;
    status?: string;
  } | null;
  venue_execution_vault?: {
    venue_id: string;
    execution_mode: string;
    vault_commitment: string;
    encrypted_vault_commitment: string;
    policy_commitment: string;
    allocation_commitment?: string | null;
    encrypted_execution_vault: unknown;
  } | null;
  omnibus_allocation?: {
    allocation_commitment: string;
    pool_commitment: string;
    partner_commitment: string;
    subledger_account_commitment: string;
    settlement_funding_commitment?: string | null;
    utilization_bucket?: string;
    status?: string;
  } | null;
  encrypted_execution_instruction_bundle?: unknown;
  now?: Date;
  env?: Record<string, string | undefined>;
}): Promise<
  | { ok: true; result: GholaConnectorResult }
  | { ok: false; error: GholaConnectorSubmitError }
> {
  const now = input.now ?? new Date();
  if (input.readiness.status !== "ready" || !input.readiness.live_submit_enabled) {
    return { ok: false, error: "connector_not_ready" };
  }
  if (input.preview.claim_status === "blocked_leaky_path") {
    return { ok: false, error: "connector_submit_blocked" };
  }
  const mode = connectorMode(input.env ?? process.env);
  if (mode === "local_test") {
    return {
      ok: true,
      result: connectorResult({
        work_order: input.work_order,
        manifest: input.manifest,
        status: "submitted",
        provider_ref_seed: `local:${input.work_order.work_order_commitment}`,
        reason: null,
        now,
      }),
    };
  }
  const cfg = connectorEnvConfig(input.manifest.platform_class, input.env ?? process.env);
  if (!cfg.url) return { ok: false, error: "connector_not_ready" };
  try {
    const submitPath = connectorSubmitPath(input.manifest.platform_class);
    const res = await fetch(new URL(submitPath, cfg.url), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify(redactedConnectorPayload(input)),
    });
    const body = asRecord(await res.json().catch(() => null));
    if (!res.ok || body.ok === false) {
      return { ok: false, error: connectorSubmitError(body, res.status) };
    }
    return {
      ok: true,
      result: connectorResult({
        work_order: input.work_order,
        manifest: input.manifest,
        status: "submitted",
        provider_ref_seed: stringValue(body.provider_ref_commitment) ||
          stringValue(body.result_commitment) ||
          input.work_order.work_order_commitment,
        reason: null,
        now,
      }),
    };
  } catch {
    return { ok: false, error: "connector_submit_failed" };
  }
}

export async function verifyConnectorNoSubmit(input: {
  platform_class: GholaPlatformClass;
  manifest: GholaConnectorManifest;
  readiness: GholaConnectorReadiness;
  work_order_commitment: string;
  operation_class: string;
  venue_execution_vault: {
    venue_id: string;
    execution_mode: GholaVenueExecutionMode | string;
    vault_commitment: string;
    encrypted_vault_commitment: string;
    policy_commitment: string;
    allocation_commitment?: string | null;
    encrypted_execution_vault?: unknown;
  };
  encrypted_execution_instruction_bundle: unknown;
  session_policy?: {
    market_allowlist?: string[];
    max_notional_bucket?: string;
    max_order_count?: number;
    kill_switch?: boolean;
  };
  site_origin?: string | null;
  now?: Date;
  env?: Record<string, string | undefined>;
}): Promise<GholaConnectorNoFundsVerification> {
  const now = input.now ?? new Date();
  const base = {
    version: 1 as const,
    platform_class: input.platform_class,
    work_order_commitment: input.work_order_commitment,
    manifest_commitment: input.manifest.manifest_commitment,
    connector_readiness_commitment: input.readiness.readiness_commitment,
    created_at: now.toISOString(),
  };
  if (input.platform_class !== "solana_perps_market") {
    return failedNoFundsVerification(base, "unsupported_platform", "failed", input.site_origin);
  }
  if (input.readiness.status !== "ready" || !input.readiness.live_submit_enabled) {
    return failedNoFundsVerification(base, "connector_not_ready", "failed", input.site_origin);
  }
  const mode = connectorMode(input.env ?? process.env);
  if (mode === "local_test") {
    return verifiedNoFundsVerification(base, {
      result_commitment: gholaCommitment("no_submit_local_result", base),
      provider_ref_commitment: gholaCommitment("no_submit_local_provider_ref", base),
      checks: defaultNoFundsChecks(true),
      site_origin: input.site_origin,
    });
  }
  const cfg = connectorEnvConfig(input.platform_class, input.env ?? process.env);
  if (!cfg.url) return failedNoFundsVerification(base, "connector_endpoint_missing", "failed", input.site_origin);
  try {
    const res = await fetch(new URL(connectorNoSubmitVerifyPath(input.platform_class), cfg.url), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify({
        version: 1,
        platform_class: input.platform_class,
        venue_id: input.venue_execution_vault.venue_id || "phoenix",
        execution_mode: input.venue_execution_vault.execution_mode || "user_stealth",
        work_order_commitment: input.work_order_commitment,
        manifest_commitment: input.manifest.manifest_commitment,
        operation_class: input.operation_class,
        vault_commitment: input.venue_execution_vault.vault_commitment,
        encrypted_vault_commitment: input.venue_execution_vault.encrypted_vault_commitment,
        policy_commitment: input.venue_execution_vault.policy_commitment,
        allocation_commitment: input.venue_execution_vault.allocation_commitment ?? null,
        encrypted_execution_vault: input.venue_execution_vault.encrypted_execution_vault,
        encrypted_execution_instruction_bundle: input.encrypted_execution_instruction_bundle,
        session_policy: {
          market_allowlist: input.session_policy?.market_allowlist || ["SOL"],
          max_notional_bucket: input.session_policy?.max_notional_bucket || "5",
          max_order_count: input.session_policy?.max_order_count ?? 5,
          kill_switch: input.session_policy?.kill_switch === true,
        },
      }),
    });
    const body = asRecord(await res.json().catch(() => null));
    if (!res.ok || body.status !== "verified_no_funds") {
      return failedNoFundsVerification(base, noFundsReason(body, res.status), "failed", input.site_origin);
    }
    return verifiedNoFundsVerification(base, {
      result_commitment: stringValue(body.result_commitment) || null,
      provider_ref_commitment: stringValue(body.provider_ref_commitment) || null,
      verification_commitment: stringValue(body.verification_commitment) || undefined,
      checks: noFundsChecks(body.checks),
      site_origin: input.site_origin,
    });
  } catch {
    return failedNoFundsVerification(base, "worker_unavailable", "worker_unavailable", input.site_origin);
  }
}

export async function reconcileConnectorResult(input: {
  work_order: GholaConnectorWorkOrder;
  manifest: GholaConnectorManifest;
  existing_result?: GholaConnectorResult | null;
  now?: Date;
  env?: Record<string, string | undefined>;
}): Promise<GholaConnectorResult> {
  const now = input.now ?? new Date();
  const mode = connectorMode(input.env ?? process.env);
  if (mode === "local_test") {
    return connectorResult({
      work_order: input.work_order,
      manifest: input.manifest,
      status: "reconciled",
      provider_ref_seed: input.existing_result?.provider_ref_commitment ?? input.work_order.work_order_commitment,
      reason: null,
      now,
    });
  }
  const cfg = connectorEnvConfig(input.manifest.platform_class, input.env ?? process.env);
  if (!cfg.url) {
    return connectorResult({
      work_order: input.work_order,
      manifest: input.manifest,
      status: "failed",
      provider_ref_seed: input.existing_result?.provider_ref_commitment ?? input.work_order.work_order_commitment,
      reason: "connector_endpoint_missing",
      now,
    });
  }
  try {
    const reconcilePath = connectorReconcilePath(input.manifest.platform_class);
    const res = await fetch(new URL(reconcilePath, cfg.url), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify({
        version: 1,
        work_order_commitment: input.work_order.work_order_commitment,
        provider_ref_commitment: input.existing_result?.provider_ref_commitment ?? null,
      }),
    });
    const body = asRecord(await res.json().catch(() => null));
    return connectorResult({
      work_order: input.work_order,
      manifest: input.manifest,
      status: res.ok && body.status !== "failed" ? "reconciled" : "failed",
      provider_ref_seed: stringValue(body.provider_ref_commitment) ||
        input.existing_result?.provider_ref_commitment ||
        input.work_order.work_order_commitment,
      reason: res.ok ? null : "connector_reconcile_failed",
      now,
    });
  } catch {
    return connectorResult({
      work_order: input.work_order,
      manifest: input.manifest,
      status: "failed",
      provider_ref_seed: input.existing_result?.provider_ref_commitment ?? input.work_order.work_order_commitment,
      reason: "connector_reconcile_failed",
      now,
    });
  }
}

export function publicConnectorManifest(manifest: GholaConnectorManifest) {
  const { signature: _signature, ...safe } = manifest;
  return {
    ...safe,
    manifest_auth_commitment: gholaCommitment("connector_manifest_auth", _signature),
  };
}

function connectorManifest(
  platformClass: GholaPlatformClass,
  now: Date,
): GholaConnectorManifest {
  const profile = getPlatformPrivacyProfile(platformClass);
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
  const blocked = blockedActionsFor(platformClass);
  const unsigned = {
    version: 1 as const,
    manifest_id: `manifest_${platformClass}`,
    platform_class: platformClass,
    label: profile.label,
    supported_actions: profile.supported_products.filter((item) => !blocked.includes(item)),
    pilot_stage: pilotStage(platformClass),
    supported_operation_classes: supportedOperationClasses(platformClass),
    sealed_runtime_required: platformClass === "solana_private_balance" ||
      platformClass === "hyperliquid_style_market" ||
      platformClass === "coinbase_style_provider",
    blocked_action_classes: blocked,
    platform_sees: profile.platform_sees,
    public_chain_sees: profile.public_chain_sees,
    source_wallet_hidden: platformClass !== "solana_public_wallet",
    order_details_visible: profile.platform_sees === "order_visible" || profile.platform_sees === "account_visible",
    supported_rails: supportedRailsFor(platformClass, profile.privacy_runnable_rails),
    minimum_anonymity_set: DEFAULT_ANONYMITY_SET_POLICY.consumer_min_effective_set,
    minimum_solver_count: platformClass === "rfq_solver_network"
      ? DEFAULT_ANONYMITY_SET_POLICY.rfq_min_solver_count
      : 0,
    requires_omnibus_funding:
      platformClass === "hyperliquid_style_market" ||
      platformClass === "coinbase_style_provider" ||
      platformClass === "partner_tokenized_assets",
    allow_live_submit: (platformClass !== "partner_tokenized_assets" || process.env.GHOLA_PARTNER_ASSETS_READY === "true") &&
      pilotEnabled(platformClass),
    degraded_conditions: profile.degraded_conditions,
    blocked_conditions: profile.blocked_conditions,
    expires_at: expiresAt,
    signing_key_id: process.env.GHOLA_CONNECTOR_MANIFEST_KEY_ID?.trim() || "ghola-dev-manifest-key",
  };
  const manifestCommitment = gholaCommitment("connector_manifest", unsigned);
  return {
    ...unsigned,
    manifest_commitment: manifestCommitment,
    signature: signManifest(manifestCommitment, unsigned.signing_key_id),
  };
}

function pilotStage(platformClass: GholaPlatformClass): GholaConnectorManifest["pilot_stage"] {
  if (pilotEnabled(platformClass)) {
    return process.env.NODE_ENV === "test" ||
      process.env.GHOLA_CONNECTOR_MODE === "local_test" ||
      process.env.GHOLA_SHIELDED_POOL_MODE === "local_test"
      ? "local_test"
      : "live_pilot";
  }
  return "disabled";
}

function supportedOperationClasses(platformClass: GholaPlatformClass): string[] {
  if (platformClass === "solana_private_balance") return ["solana_private_payment"];
  if (platformClass === "solana_perps_market") return ["read", "perp_limit_order", "cancel", "fills", "reconcile"];
  if (platformClass === "solana_swap_aggregator") return ["read", "preview_order", "swap", "reconcile"];
  if (platformClass === "rfq_solver_network") return ["auction_commit", "auction_clear", "auction_settle"];
  if (platformClass === "hyperliquid_style_market") {
    return ["read", "limit_order", "cancel", "reconcile"];
  }
  if (platformClass === "coinbase_style_provider") {
    return ["read", "preview_order", "spot_limit_order", "spot_market_order", "cancel", "fills", "reconcile"];
  }
  return [];
}

function supportedRailsFor(
  platformClass: GholaPlatformClass,
  rails: GholaRailKind[],
): GholaRailKind[] {
  if (platformClass === "solana_public_wallet") return ["direct_public_fallback", "private_relayer"];
  if (
    platformClass === "rfq_solver_network" ||
    platformClass === "hyperliquid_style_market" ||
    platformClass === "solana_perps_market" ||
    platformClass === "solana_swap_aggregator" ||
    platformClass === "coinbase_style_provider"
  ) {
    return Array.from(new Set([
      "shielded_batch_auction" as GholaRailKind,
      "direct_public_fallback" as GholaRailKind,
      ...rails,
    ]));
  }
  return rails.length ? rails : ["provider_omnibus_subaccount"];
}

function blockedActionsFor(platformClass: GholaPlatformClass): GholaPrivateAccountActionClass[] {
  if (platformClass === "hyperliquid_style_market") return ["withdraw", "maintain_allocation"];
  if (platformClass === "solana_perps_market") return ["withdraw", "maintain_allocation"];
  if (platformClass === "solana_swap_aggregator") return ["withdraw", "maintain_allocation", "fund_platform"];
  if (platformClass === "coinbase_style_provider") return ["withdraw", "maintain_allocation"];
  if (platformClass === "rfq_solver_network") return ["withdraw", "fund_platform", "pay"];
  if (platformClass === "partner_tokenized_assets" && process.env.GHOLA_PARTNER_ASSETS_READY !== "true") {
    return ["pay", "transfer", "fund_platform", "trade_on_platform", "rebalance", "maintain_allocation", "withdraw"];
  }
  return [];
}

function readiness(input: {
  manifest: GholaConnectorManifest;
  mode: GholaConnectorMode;
  status: GholaConnectorStatus;
  live_submit_enabled: boolean;
  reason_codes: string[];
  now: Date;
}): GholaConnectorReadiness {
  return {
    version: 1,
    platform_class: input.manifest.platform_class,
    status: input.status,
    mode: input.mode,
    manifest_commitment: input.manifest.manifest_commitment,
    readiness_commitment: gholaCommitment("connector_readiness", {
      platform_class: input.manifest.platform_class,
      manifest_commitment: input.manifest.manifest_commitment,
      status: input.status,
      mode: input.mode,
      live_submit_enabled: input.live_submit_enabled,
      reason_codes: input.reason_codes,
    }),
    live_submit_enabled: input.live_submit_enabled,
    reason_codes: Array.from(new Set(input.reason_codes)),
    checked_at: input.now.toISOString(),
  };
}

function connectorResult(input: {
  work_order: GholaConnectorWorkOrder;
  manifest: GholaConnectorManifest;
  status: GholaConnectorResult["status"];
  provider_ref_seed: string;
  reason: string | null;
  now: Date;
}): GholaConnectorResult {
  const providerRefCommitment = input.provider_ref_seed
    ? gholaCommitment("connector_provider_ref", input.provider_ref_seed)
    : null;
  const resultSeed = {
    work_order_commitment: input.work_order.work_order_commitment,
    status: input.status,
    provider_ref_commitment: providerRefCommitment,
    reason: input.reason,
  };
  return {
    version: 1,
    connector_result_commitment: gholaCommitment("connector_result", resultSeed),
    work_order_commitment: input.work_order.work_order_commitment,
    platform_class: input.manifest.platform_class,
    status: input.status,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: gholaCommitment("connector_result_body", resultSeed),
    visibility_summary: {
      main_wallet_exposed: !input.manifest.source_wallet_hidden,
      venue_saw_order_class: input.manifest.order_details_visible,
      public_chain_settlement: input.manifest.public_chain_sees,
    },
    venue_access_summary: connectorAccessContext(input.manifest),
    reason: input.reason,
    created_at: input.now.toISOString(),
    updated_at: input.now.toISOString(),
  };
}

function connectorAccessContext(
  manifest: GholaConnectorManifest,
): Pick<
  GholaConnectorPreviewContext,
  | "venue_access_source"
  | "ghola_access_role"
  | "venue_gate"
  | "venue_visibility"
  | "source_wallet_visibility"
  | "privacy_claim"
> {
  if (manifest.platform_class === "hyperliquid_style_market") {
    return {
      venue_access_source: "user_provided_credentials",
      ghola_access_role: "private_execution_router",
      venue_gate: "venue_accepts_or_rejects_credentials",
      venue_visibility: "execution_account_and_order_activity",
      source_wallet_visibility: "not_exposed_to_public_chain_by_ghola",
      privacy_claim: "venue_visible_order_degraded",
    };
  }
  if (manifest.platform_class === "solana_perps_market") {
    return {
      venue_access_source: "user_provided_credentials",
      ghola_access_role: "private_execution_router",
      venue_gate: "venue_accepts_or_rejects_credentials",
      venue_visibility: "execution_account_and_order_activity",
      source_wallet_visibility: "not_exposed_to_public_chain_by_ghola",
      privacy_claim: "venue_visible_order_degraded",
    };
  }
  if (manifest.platform_class === "solana_swap_aggregator") {
    return {
      venue_access_source: "none",
      ghola_access_role: "private_execution_router",
      venue_gate: "not_applicable",
      venue_visibility: "ticket_only",
      source_wallet_visibility: "not_exposed_to_public_chain_by_ghola",
      privacy_claim: "private_mode_available",
    };
  }
  if (manifest.platform_class === "coinbase_style_provider") {
    return {
      venue_access_source: "partner_omnibus",
      ghola_access_role: "private_execution_router",
      venue_gate: "partner_accepts_or_rejects_order",
      venue_visibility: "provider_account_and_order_activity",
      source_wallet_visibility: "not_exposed_to_public_chain_by_ghola",
      privacy_claim: "venue_visible_order_degraded",
    };
  }
  if (manifest.platform_class === "solana_public_wallet") {
    return {
      venue_access_source: "none",
      ghola_access_role: "connector_only",
      venue_gate: "not_applicable",
      venue_visibility: "none",
      source_wallet_visibility: "visible_on_public_chain",
      privacy_claim: "public_chain_visible_degraded",
    };
  }
  if (manifest.platform_class === "rfq_solver_network") {
    return {
      venue_access_source: "none",
      ghola_access_role: "private_execution_router",
      venue_gate: "not_applicable",
      venue_visibility: "ticket_only",
      source_wallet_visibility: "not_exposed_to_public_chain_by_ghola",
      privacy_claim: "private_mode_available",
    };
  }
  return {
    venue_access_source: "none",
    ghola_access_role: manifest.platform_class === "solana_private_balance"
      ? "private_state_operator"
      : "connector_only",
    venue_gate: "not_applicable",
    venue_visibility: "none",
    source_wallet_visibility: "not_applicable",
    privacy_claim: "private_mode_available",
  };
}

function connectorSubmitError(body: Record<string, unknown>, status: number): GholaConnectorSubmitError {
  const code = stringValue(body.error_code) || stringValue(body.code) || stringValue(body.error);
  const text = `${code} ${stringValue(body.error)}`;
  if (code === "needs_funds" || /needs funds|insufficient|not enough|balance/i.test(text)) {
    return "needs_funds";
  }
  if (code === "venue_access_required" || code === "hyperliquid_execution_vault_not_ready") {
    return "venue_access_required";
  }
  if (code === "venue_rejected" || code.includes("venue rejected") || code.includes("hyperliquid request failed")) {
    return "venue_rejected";
  }
  if (status === 409 || status === 422) return "venue_rejected";
  return "connector_submit_failed";
}

function redactedConnectorPayload(input: {
  work_order: GholaConnectorWorkOrder;
  manifest: GholaConnectorManifest;
  compiled_intent: GholaCompiledPrivateIntent;
  preview: GholaPrivacyPreview;
  hyperliquid_execution_vault?: {
    vault_commitment: string;
    encrypted_vault_commitment: string;
    policy_commitment: string;
    encrypted_execution_vault: unknown;
  } | null;
  hyperliquid_managed_allocation?: {
    allocation_commitment: string;
    policy_commitment: string;
    pool_commitment: string;
    subledger_account_commitment: string;
    status?: string;
  } | null;
  venue_execution_vault?: {
    venue_id: string;
    execution_mode: GholaVenueExecutionMode | string;
    vault_commitment: string;
    encrypted_vault_commitment: string;
    policy_commitment: string;
    allocation_commitment?: string | null;
    encrypted_execution_vault?: unknown;
  } | null;
  omnibus_allocation?: {
    allocation_commitment: string;
    pool_commitment: string;
    partner_commitment: string;
    subledger_account_commitment: string;
    settlement_funding_commitment?: string | null;
    utilization_bucket?: string;
    status?: string;
  } | null;
  encrypted_execution_instruction_bundle?: unknown;
}) {
  return {
    version: 1,
    platform_class: input.manifest.platform_class,
    work_order_commitment: input.work_order.work_order_commitment,
    manifest_commitment: input.manifest.manifest_commitment,
    compiler_commitment: input.compiled_intent.compiler_commitment,
    ticket_commitment: input.compiled_intent.ticket_commitment,
    preview_commitment: input.preview.preview_commitment,
    selected_rail: input.preview.selected_rail,
    claim_status: input.preview.claim_status,
    operation_class: operationForAction(input.manifest.platform_class, input.compiled_intent.action_class),
    ...(input.encrypted_execution_instruction_bundle
      ? { encrypted_execution_instruction_bundle: input.encrypted_execution_instruction_bundle }
      : {}),
    ...(input.manifest.platform_class === "hyperliquid_style_market" && input.hyperliquid_execution_vault
      ? {
          execution_mode: "byo_api_key",
          vault_commitment: input.hyperliquid_execution_vault.vault_commitment,
          encrypted_vault_commitment: input.hyperliquid_execution_vault.encrypted_vault_commitment,
          policy_commitment: input.hyperliquid_execution_vault.policy_commitment,
          encrypted_execution_vault: input.hyperliquid_execution_vault.encrypted_execution_vault,
        }
      : {}),
    ...(input.manifest.platform_class === "hyperliquid_style_market" && input.hyperliquid_managed_allocation
      ? {
          execution_mode: "managed_testnet",
          managed_allocation_commitment: input.hyperliquid_managed_allocation.allocation_commitment,
          allocation_commitment: input.hyperliquid_managed_allocation.allocation_commitment,
          policy_commitment: input.hyperliquid_managed_allocation.policy_commitment,
        }
      : {}),
    ...(input.manifest.platform_class === "coinbase_style_provider"
      ? {
          venue_id: input.venue_execution_vault?.venue_id ?? "coinbase_advanced",
          execution_mode: input.venue_execution_vault?.execution_mode ??
            (input.omnibus_allocation ? "partner_omnibus" : "byo_api_key"),
          vault_commitment: input.venue_execution_vault?.vault_commitment ?? null,
          encrypted_vault_commitment: input.venue_execution_vault?.encrypted_vault_commitment ?? null,
          policy_commitment: input.venue_execution_vault?.policy_commitment ?? null,
          allocation_commitment: input.venue_execution_vault?.allocation_commitment ??
            input.omnibus_allocation?.allocation_commitment ??
            null,
          ...(input.venue_execution_vault?.encrypted_execution_vault
            ? { encrypted_execution_vault: input.venue_execution_vault.encrypted_execution_vault }
            : {}),
          omnibus_allocation: input.omnibus_allocation
            ? {
                allocation_commitment: input.omnibus_allocation.allocation_commitment,
                pool_commitment: input.omnibus_allocation.pool_commitment,
                partner_commitment: input.omnibus_allocation.partner_commitment,
                subledger_account_commitment: input.omnibus_allocation.subledger_account_commitment,
                settlement_funding_commitment: input.omnibus_allocation.settlement_funding_commitment ?? null,
                utilization_bucket: input.omnibus_allocation.utilization_bucket ?? "0",
                status: input.omnibus_allocation.status ?? "allocated",
              }
            : null,
        }
      : {}),
    ...(input.manifest.platform_class === "solana_perps_market"
      ? {
          venue_id: input.venue_execution_vault?.venue_id ?? "phoenix",
          execution_mode: input.venue_execution_vault?.execution_mode ?? "user_stealth",
          vault_commitment: input.venue_execution_vault?.vault_commitment ?? null,
          encrypted_vault_commitment: input.venue_execution_vault?.encrypted_vault_commitment ?? null,
          policy_commitment: input.venue_execution_vault?.policy_commitment ?? null,
          allocation_commitment: input.venue_execution_vault?.allocation_commitment ?? null,
          ...(input.venue_execution_vault?.encrypted_execution_vault
            ? { encrypted_execution_vault: input.venue_execution_vault.encrypted_execution_vault }
            : {}),
        }
      : {}),
  };
}

function venueReadinessGate(input: {
  manifest: GholaConnectorManifest;
  env: Record<string, string | undefined>;
  execution_vault_ready: boolean;
  shielded_funding_ready: boolean;
  omnibus_allocation_ready: boolean;
  execution_mode?: GholaVenueExecutionMode;
  operation_class?: string;
  runtime_health: GholaRuntimeHealth | null;
}): { ok: boolean; reason_codes: string[] } {
  const venueId = venueIdForPlatformClass(input.manifest.platform_class);
  if (!venueId) {
    return { ok: true, reason_codes: [] };
  }
  const reasonCodes: string[] = [];
  if (venueId === "hyperliquid" && input.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED !== "true") {
    reasonCodes.push("hyperliquid_pilot_disabled");
  }
  if (venueId === "coinbase_advanced" && input.env.GHOLA_V6_COINBASE_PILOT_ENABLED !== "true") {
    reasonCodes.push("coinbase_pilot_disabled");
  }
  if (input.manifest.platform_class === "solana_perps_market") {
    const localAllowed = input.env.NODE_ENV === "test" ||
      input.env.GHOLA_CONNECTOR_MODE === "local_test" ||
      input.env.GHOLA_SHIELDED_POOL_MODE === "local_test";
    const enabled = input.env.GHOLA_VENUE_PHOENIX_PILOT_ENABLED === "true" ||
      input.env.GHOLA_VENUE_DRIFT_PILOT_ENABLED === "true" ||
      input.env.GHOLA_VENUE_BACKPACK_PILOT_ENABLED === "true";
    if (!enabled && !localAllowed) reasonCodes.push("solana_perps_pilot_disabled");
    if (!input.execution_vault_ready) reasonCodes.push("solana_perps_execution_vault_not_ready");
  }
  if (venueId === "hyperliquid" && !input.execution_vault_ready) {
    reasonCodes.push("venue_access_required", "hyperliquid_execution_vault_not_ready");
  }
  if (venueId === "coinbase_advanced") {
    const mode = input.execution_mode ?? "partner_omnibus";
    if (mode === "partner_omnibus") {
      if (input.env.GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED !== "true") {
        reasonCodes.push("coinbase_partner_omnibus_disabled");
      }
      if (input.env.GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY === "false") {
        reasonCodes.push("coinbase_partner_omnibus_pool_not_ready");
      }
      if (!input.omnibus_allocation_ready) {
        reasonCodes.push("coinbase_omnibus_allocation_not_ready");
      }
    } else if (!input.execution_vault_ready) {
      reasonCodes.push("coinbase_execution_vault_not_ready");
    }
  }
  const operationClass = input.operation_class || "";
  const fundingRequired = operationClass !== "read" && operationClass !== "reconcile";
  const hyperliquidByoTinyFill =
    venueId === "hyperliquid" &&
    input.execution_mode === "byo_api_key" &&
    input.env.GHOLA_HYPERLIQUID_LIVE_MODE === "tiny_fill";
  const solanaPerpsStealthTinyFill =
    venueId === "phoenix" &&
    input.execution_mode === "user_stealth" &&
    (input.env.GHOLA_SOLANA_PERPS_LIVE_MODE === "sdk_runner" ||
      input.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE === "sdk_runner");
  if (!input.shielded_funding_ready && fundingRequired && !hyperliquidByoTinyFill && !solanaPerpsStealthTinyFill) {
    reasonCodes.push("shielded_funding_evidence_required");
  }
  if (input.runtime_health?.status !== "green") reasonCodes.push("sealed_runtime_unhealthy");
  if (!input.runtime_health?.runtime_attestation_commitment) {
    reasonCodes.push("sealed_runtime_attestation_required");
  }
  if (!input.runtime_health?.runtime_measurement_commitment) {
    reasonCodes.push("sealed_runtime_measurement_required");
  }
  return {
    ok: reasonCodes.length === 0,
    reason_codes: reasonCodes,
  };
}

function hyperliquidOperationForAction(action: GholaPrivateAccountActionClass): string {
  if (action === "fund_platform") return "read";
  if (action === "rebalance" || action === "trade_on_platform") return "limit_order";
  if (action === "withdraw" || action === "maintain_allocation") return "blocked";
  return "read";
}

function coinbaseOperationForAction(action: GholaPrivateAccountActionClass): string {
  if (action === "fund_platform") return "read";
  if (action === "rebalance" || action === "trade_on_platform") return "spot_limit_order";
  if (action === "withdraw" || action === "maintain_allocation") return "blocked";
  return "read";
}

function operationForAction(platformClass: GholaPlatformClass, action: GholaPrivateAccountActionClass): string {
  if (platformClass === "coinbase_style_provider") return coinbaseOperationForAction(action);
  if (platformClass === "solana_perps_market") return action === "trade_on_platform" || action === "rebalance" ? "perp_limit_order" : "read";
  if (platformClass === "solana_swap_aggregator") return action === "trade_on_platform" || action === "rebalance" ? "swap" : "read";
  return hyperliquidOperationForAction(action);
}

function connectorSubmitPath(platformClass: GholaPlatformClass): string {
  if (platformClass === "hyperliquid_style_market") return "/hyperliquid/orders";
  if (platformClass === "coinbase_style_provider") return "/venues/coinbase/orders";
  if (platformClass === "solana_perps_market") return "/venues/solana-perps/orders";
  if (platformClass === "solana_swap_aggregator") return "/venues/solana-swap/orders";
  return "/submit";
}

function connectorReconcilePath(platformClass: GholaPlatformClass): string {
  if (platformClass === "hyperliquid_style_market") return "/hyperliquid/reconcile";
  if (platformClass === "coinbase_style_provider") return "/venues/coinbase/reconcile";
  if (platformClass === "solana_perps_market") return "/venues/solana-perps/reconcile";
  if (platformClass === "solana_swap_aggregator") return "/venues/solana-swap/reconcile";
  return "/reconcile";
}

function connectorNoSubmitVerifyPath(platformClass: GholaPlatformClass): string {
  if (platformClass === "solana_perps_market") return "/venues/solana-perps/verify";
  return "/verify";
}

function verifiedNoFundsVerification(
  base: {
    version: 1;
    platform_class: GholaPlatformClass;
    work_order_commitment: string;
    manifest_commitment: string;
    connector_readiness_commitment: string;
    created_at: string;
  },
  input: {
    result_commitment: string | null;
    provider_ref_commitment: string | null;
    verification_commitment?: string;
    checks: GholaConnectorNoFundsVerification["checks"];
    site_origin?: string | null;
  },
): GholaConnectorNoFundsVerification {
  const verificationCommitment = input.verification_commitment ||
    gholaCommitment("connector_no_submit_verification", {
      work_order_commitment: base.work_order_commitment,
      manifest_commitment: base.manifest_commitment,
      checks: input.checks,
    });
  const visibilitySummary = {
    main_wallet_exposed: false,
    venue_saw_order_class: false,
    public_chain_settlement: "hidden" as const,
  };
  return {
    ...base,
    status: "verified_no_funds",
    verification_commitment: verificationCommitment,
    result_commitment: input.result_commitment,
    provider_ref_commitment: input.provider_ref_commitment,
    reason: null,
    checks: input.checks,
    visibility_summary: visibilitySummary,
    live_readiness_certificate: liveReadinessCertificate({
      base,
      status: "ready_to_attempt_broadcast",
      verification_commitment: verificationCommitment,
      result_commitment: input.result_commitment,
      provider_ref_commitment: input.provider_ref_commitment,
      checks: input.checks,
      site_origin: input.site_origin,
    }),
  };
}

function failedNoFundsVerification(
  base: {
    version: 1;
    platform_class: GholaPlatformClass;
    work_order_commitment: string;
    manifest_commitment: string;
    connector_readiness_commitment: string;
    created_at: string;
  },
  reason: string,
  status: "failed" | "worker_unavailable" = "failed",
  siteOrigin?: string | null,
): GholaConnectorNoFundsVerification {
  const checks = defaultNoFundsChecks(false);
  const verificationCommitment = gholaCommitment("connector_no_submit_verification_failed", {
    work_order_commitment: base.work_order_commitment,
    manifest_commitment: base.manifest_commitment,
    reason,
  });
  const visibilitySummary = {
    main_wallet_exposed: false,
    venue_saw_order_class: false,
    public_chain_settlement: "blocked" as const,
  };
  return {
    ...base,
    status,
    verification_commitment: verificationCommitment,
    result_commitment: null,
    provider_ref_commitment: null,
    reason,
    checks,
    visibility_summary: visibilitySummary,
    live_readiness_certificate: liveReadinessCertificate({
      base,
      status: status === "worker_unavailable" ? "worker_unavailable" : "not_ready",
      verification_commitment: verificationCommitment,
      result_commitment: null,
      provider_ref_commitment: null,
      checks,
      site_origin: siteOrigin,
    }),
  };
}

function liveReadinessCertificate(input: {
  base: {
    version: 1;
    platform_class: GholaPlatformClass;
    work_order_commitment: string;
    manifest_commitment: string;
    connector_readiness_commitment: string;
    created_at: string;
  };
  status: GholaLiveReadinessCertificate["status"];
  verification_commitment: string;
  result_commitment: string | null;
  provider_ref_commitment: string | null;
  checks: GholaConnectorNoFundsVerification["checks"];
  site_origin?: string | null;
}): GholaLiveReadinessCertificate {
  const siteOrigin = stringValue(input.site_origin);
  const expiresAt = new Date(new Date(input.base.created_at).getTime() + 10 * 60_000).toISOString();
  const checks = {
    production_site_reachable: Boolean(siteOrigin),
    private_agent_worker_reachable: input.checks.sealed_vault_opened || input.checks.rpc_reachable,
    sealed_vault_opened: input.checks.sealed_vault_opened,
    sealed_instruction_opened: input.checks.sealed_instruction_opened,
    authority_derived: input.checks.authority_derived,
    policy_enforced: input.checks.policy_enforced,
    live_gate_enforced: input.checks.live_gate_enforced,
    solana_rpc_reachable: input.checks.rpc_reachable,
    phoenix_sdk_ready: input.checks.phoenix_sdk_ready,
    order_packet_built: input.checks.order_packet_built,
    transaction_broadcast: false as const,
  };
  const seed = {
    certificate_kind: "ghola_live_readiness_certificate_v1",
    status: input.status,
    platform_class: input.base.platform_class,
    venue_id: "phoenix",
    work_order_commitment: input.base.work_order_commitment,
    manifest_commitment: input.base.manifest_commitment,
    connector_readiness_commitment: input.base.connector_readiness_commitment,
    verification_commitment: input.verification_commitment,
    result_commitment: input.result_commitment,
    provider_ref_commitment: input.provider_ref_commitment,
    site_origin_commitment: siteOrigin ? gholaCommitment("site_origin", siteOrigin) : null,
    checks,
    broadcast_performed: false,
    final_venue_execution_proven: false,
    final_fill_proven: false,
    issued_at: input.base.created_at,
    expires_at: expiresAt,
  };
  return {
    version: 1,
    certificate_kind: "ghola_live_readiness_certificate_v1",
    certificate_commitment: gholaCommitment("live_readiness_certificate", seed),
    status: input.status,
    proof_level: "pre_broadcast_live_readiness",
    platform_class: input.base.platform_class,
    venue_id: "phoenix",
    work_order_commitment: input.base.work_order_commitment,
    manifest_commitment: input.base.manifest_commitment,
    connector_readiness_commitment: input.base.connector_readiness_commitment,
    verification_commitment: input.verification_commitment,
    result_commitment: input.result_commitment,
    provider_ref_commitment: input.provider_ref_commitment,
    site_origin_commitment: seed.site_origin_commitment,
    issued_at: input.base.created_at,
    expires_at: expiresAt,
    broadcast_performed: false,
    final_venue_execution_proven: false,
    final_fill_proven: false,
    transaction_simulation_status: "not_performed",
    checks,
    what_is_proven: input.status === "ready_to_attempt_broadcast"
      ? [
          "ghola production route answered this request",
          "private-agent worker accepted sealed vault and instruction bundles",
          "Phoenix live gates and capped IOC policy passed",
          "Solana RPC was reachable",
          "Phoenix Rise SDK was reachable",
          "Phoenix order packet was built without broadcasting",
        ]
      : [
          "ghola produced a commitment-safe failed readiness artifact",
          "no transaction was broadcast",
        ],
    what_is_not_proven: [
      "the venue accepted a broadcast transaction",
      "the order filled",
      "post-trade reconciliation succeeded",
    ],
    next_step: input.status === "ready_to_attempt_broadcast"
      ? "Connect a funded venue authority and explicitly approve broadcast to prove final venue execution."
      : "Fix the failed readiness check, then run Verify live path again.",
  };
}

function defaultNoFundsChecks(ok: boolean): GholaConnectorNoFundsVerification["checks"] {
  return {
    sealed_vault_opened: ok,
    sealed_instruction_opened: ok,
    authority_derived: ok,
    policy_enforced: ok,
    live_gate_enforced: ok,
    rpc_reachable: ok,
    phoenix_sdk_ready: ok,
    order_packet_built: ok,
    transaction_broadcast: false,
  };
}

function noFundsChecks(value: unknown): GholaConnectorNoFundsVerification["checks"] {
  const body = asRecord(value);
  return {
    sealed_vault_opened: body.sealed_vault_opened === true,
    sealed_instruction_opened: body.sealed_instruction_opened === true,
    authority_derived: body.authority_derived === true,
    policy_enforced: body.policy_enforced === true,
    live_gate_enforced: body.live_gate_enforced === true,
    rpc_reachable: body.rpc_reachable === true,
    phoenix_sdk_ready: body.phoenix_sdk_ready === true,
    order_packet_built: body.order_packet_built === true,
    transaction_broadcast: false,
  };
}

function noFundsReason(body: Record<string, unknown>, status: number): string {
  const code = stringValue(body.error_code) || stringValue(body.code) || stringValue(body.error);
  if (code.includes("access") || code === "venue_access_required") return "invalid_authority_or_access";
  if (code.includes("rpc")) return "rpc_unreachable";
  if (code.includes("live submit is disabled")) return "live_gate_disabled";
  if (code.includes("notional cap")) return "policy_blocked";
  if (status === 503) return "worker_unavailable";
  if (status === 401) return "worker_unauthorized";
  return code || "verification_failed";
}

function linkabilityReasons(components: GholaLinkabilityScore["components"]): string[] {
  const reasons: string[] = [];
  if (components.repeated_venue_bps) reasons.push("repeated_venue");
  if (components.repeated_size_bucket_bps) reasons.push("repeated_size_bucket");
  if (components.repeated_timing_bps) reasons.push("repeated_timing");
  if (components.reused_platform_funding_account_bps) reasons.push("reused_platform_funding_account");
  if (components.same_solver_bps) reasons.push("same_solver");
  if (components.withdrawal_destination_reuse_bps) reasons.push("withdrawal_destination_reuse");
  if (components.asset_cadence_bps) reasons.push("asset_cadence");
  return reasons;
}

function connectorEnvConfig(platformClass: GholaPlatformClass, env: Record<string, string | undefined>) {
  const prefix = `GHOLA_CONNECTOR_${platformClass.toUpperCase()}`;
  const token = env[`${prefix}_TOKEN`]?.trim() ||
    ([
      "hyperliquid_style_market",
      "coinbase_style_provider",
      "solana_perps_market",
    ].includes(platformClass)
      ? env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
        env.PRIVATE_AGENT_EXECUTION_TOKEN?.trim() ||
        ""
      : "");
  return {
    url: env[`${prefix}_URL`]?.trim() || "",
    token,
    readiness: env[`${prefix}_READINESS`]?.trim() || "",
  };
}

function connectorMode(env: Record<string, string | undefined>): GholaConnectorMode {
  if (env.GHOLA_CONNECTOR_MODE === "local_test" || env.GHOLA_SHIELDED_POOL_MODE === "local_test") {
    return "local_test";
  }
  if (env.NODE_ENV === "test") return "local_test";
  return "http";
}

function signManifest(manifestCommitment: string, signingKeyId: string): string {
  return gholaCommitment("connector_manifest_signature", {
    manifest_commitment: manifestCommitment,
    signing_key_id: signingKeyId,
    secret: process.env.GHOLA_CONNECTOR_MANIFEST_SECRET || "ghola-dev-connector-manifests",
  });
}

function platformClasses(): GholaPlatformClass[] {
  return [
    "solana_public_wallet",
    "solana_private_balance",
    "solana_perps_market",
    "solana_swap_aggregator",
    "hyperliquid_style_market",
    "coinbase_style_provider",
    "rfq_solver_network",
    "partner_tokenized_assets",
  ];
}

function bucket(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
