import {
  DEFAULT_ANONYMITY_SET_POLICY,
  containsForbiddenPublicPrivateAccountField,
  getPlatformPrivacyProfile,
  gholaCommitment,
  isFundingAmountBucket,
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
import {
  connectorSdkPlatformClasses,
  connectorSdkSpecForPlatform,
} from "./connector-sdk";
import {
  workerAuthorizationHeader,
  workerCapabilityExpectedFromBody,
} from "./private-agent-capability";

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

export interface GholaConnectorPlatformFeePolicy {
  version: 1;
  policy_kind: "ghola_connector_platform_fee_policy_v1";
  fee_policy_commitment: string;
  fee_bps: number;
  min_fee_micro_usdc: number;
  estimated_notional_micro_usdc: number;
  fee_micro_usdc: number;
  fee_recipient: string;
  quote_asset: "USDC";
  collection_mode: "paid_private_agent_plan_and_worker_bound_fee";
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
  platform_fee_policy_commitment: string | null;
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
  final_proof: GholaConnectorFinalProof | null;
  fill_commitments: string[];
  fill_summary: GholaConnectorFillSummary;
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
  platform_fee_policy_commitment?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GholaConnectorFillSummary {
  fill_count: number;
  filled_base_size: string;
  filled_notional_usd: number;
  average_fill_price: number | null;
  fee_usd: number;
  fee_status: string;
}

export interface GholaConnectorFinalProof {
  version: 1;
  proof_kind: string;
  status: string;
  venue_id: string;
  routing_mode?: string | null;
  broadcast_performed: boolean;
  final_venue_execution_proven: boolean;
  final_fill_proven: boolean;
  signature_commitment?: string | null;
  request_commitment?: string | null;
  checked_at: string;
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
    api_wallet_loaded: boolean;
    hyperliquid_api_reachable: boolean;
    hyperliquid_sdk_ready: boolean;
    account_read_checked: boolean;
    order_request_built: boolean;
    jupiter_api_reachable?: boolean;
    jupiter_token_allowlist_passed?: boolean;
    jupiter_order_built?: boolean;
    jupiter_transaction_built?: boolean;
    coinbase_api_reachable?: boolean;
    coinbase_order_request_built?: boolean;
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
  venue_id: "phoenix" | "hyperliquid" | "jupiter" | "coinbase_advanced";
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
    hyperliquid_api_reachable: boolean;
    hyperliquid_sdk_ready: boolean;
    account_read_checked: boolean;
    order_request_built: boolean;
    jupiter_api_reachable?: boolean;
    jupiter_token_allowlist_passed?: boolean;
    jupiter_order_built?: boolean;
    jupiter_transaction_built?: boolean;
    coinbase_api_reachable?: boolean;
    coinbase_order_request_built?: boolean;
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
  pooled_allocation_ready?: boolean;
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
    pooled_allocation_ready: input.pooled_allocation_ready === true,
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
  if (!cfg.token) reasonCodes.push("connector_token_missing");
  if (!cfg.readiness) reasonCodes.push("connector_readiness_missing");
  if (cfg.readiness === "stale") reasonCodes.push("connector_readiness_stale");
  if (cfg.readiness === "blocked") reasonCodes.push("connector_readiness_blocked");
  const status: GholaConnectorStatus = !verification.ok || cfg.readiness === "blocked"
    || !venueGate.ok
    ? "blocked"
    : cfg.readiness === "stale"
      ? "stale"
      : cfg.url && cfg.token && cfg.readiness === "ready" && input.manifest.allow_live_submit
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
  execution_mode?: GholaVenueExecutionMode;
}): GholaConnectorPreviewContext {
  const accessContext = connectorAccessContext(input.manifest, input.execution_mode);
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

const MICRO_USDC_PER_USD = 1_000_000;

function amountBucketMicroUsdc(bucket: string): number {
  if (!isFundingAmountBucket(bucket)) return 0;
  return Number.parseInt(bucket, 10) * MICRO_USDC_PER_USD;
}

export function connectorPlatformFeePolicy(input: {
  owner_commitment: string;
  intent_id: string;
  account_commitment: string;
  action_commitment: string;
  manifest_commitment: string;
  compiler_commitment: string;
  amount_bucket: string;
  asset_bucket: string;
  fee_recipient: string;
  fee_bps: number;
  min_fee_micro_usdc: number;
}): GholaConnectorPlatformFeePolicy {
  const estimatedNotional = amountBucketMicroUsdc(input.amount_bucket);
  const proportionalFee = Math.ceil((estimatedNotional * input.fee_bps) / 10_000);
  const feeMicroUsdc = Math.max(input.min_fee_micro_usdc, proportionalFee);
  const seed = {
    policy_kind: "ghola_connector_platform_fee_policy_v1",
    owner_commitment: input.owner_commitment,
    intent_id: input.intent_id,
    account_commitment: input.account_commitment,
    action_commitment: input.action_commitment,
    manifest_commitment: input.manifest_commitment,
    compiler_commitment: input.compiler_commitment,
    amount_bucket: input.amount_bucket,
    asset_bucket: input.asset_bucket,
    fee_recipient: input.fee_recipient,
    fee_bps: input.fee_bps,
    min_fee_micro_usdc: input.min_fee_micro_usdc,
    estimated_notional_micro_usdc: estimatedNotional,
    fee_micro_usdc: feeMicroUsdc,
    quote_asset: "USDC",
    collection_mode: "paid_private_agent_plan_and_worker_bound_fee",
  };
  return {
    version: 1,
    policy_kind: "ghola_connector_platform_fee_policy_v1",
    fee_policy_commitment: gholaCommitment("connector_platform_fee_policy", seed),
    fee_bps: input.fee_bps,
    min_fee_micro_usdc: input.min_fee_micro_usdc,
    estimated_notional_micro_usdc: estimatedNotional,
    fee_micro_usdc: feeMicroUsdc,
    fee_recipient: input.fee_recipient,
    quote_asset: "USDC",
    collection_mode: "paid_private_agent_plan_and_worker_bound_fee",
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
  platform_fee_policy?: GholaConnectorPlatformFeePolicy | null;
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
      platform_fee_policy_commitment: input.platform_fee_policy?.fee_policy_commitment ?? null,
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
    platform_fee_policy_commitment: input.platform_fee_policy?.fee_policy_commitment ?? null,
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
  platform_fee_policy?: GholaConnectorPlatformFeePolicy | null;
  hyperliquid_execution_vault?: {
    vault_commitment: string;
    encrypted_vault_commitment: string;
    policy_commitment: string;
    encrypted_execution_vault: unknown;
  } | null;
  hyperliquid_managed_allocation?: {
    allocation_commitment: string;
    execution_mode?: GholaVenueExecutionMode | string;
    policy_commitment: string;
    pool_commitment: string;
    pool_share_commitment?: string | null;
    subledger_account_commitment: string;
    vault_address?: string | null;
    vault_controller_address?: string | null;
    agent_wallet_commitment?: string | null;
    deposit_evidence_commitment?: string | null;
    deposit_status?: string | null;
    funding_routes?: string[];
    eligibility_commitment?: string | null;
    funding_evidence_commitment?: string | null;
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
  pooled_venue_allocation?: {
    pooled_allocation_commitment: string;
    pool_commitment: string;
    pool_share_commitment?: string | null;
    subledger_account_commitment: string;
    eligibility_commitment?: string | null;
    funding_evidence_commitment?: string | null;
    settlement_evidence_commitment?: string | null;
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
    const payload = redactedConnectorPayload(input);
    const authorization = workerAuthorizationHeader({
      env: input.env ?? process.env,
      fallbackToken: cfg.token,
      method: "POST",
      path: submitPath,
      scope: "order:submit",
      body: payload,
      expected: workerCapabilityExpectedFromBody(payload, {
        venue_id: payload.venue_id || venueIdForPlatformClass(input.manifest.platform_class),
      }),
    });
    const res = await fetch(new URL(submitPath, cfg.url), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(payload),
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
        final_proof: connectorFinalProof(body.final_proof),
        fill_commitments: stringArray(body.fill_commitments),
        fill_summary: connectorFillSummary(body.fill_summary),
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
    vault_commitment?: string;
    encrypted_vault_commitment?: string;
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
  if (![
    "solana_perps_market",
    "hyperliquid_style_market",
    "solana_swap_aggregator",
    "coinbase_style_provider",
  ].includes(input.platform_class)) {
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
    const verifyPath = connectorNoSubmitVerifyPath(input.platform_class);
    const payload = {
      version: 1,
      platform_class: input.platform_class,
      venue_id: input.venue_execution_vault.venue_id || venueIdForPlatformClass(input.platform_class) || "phoenix",
      execution_mode: input.venue_execution_vault.execution_mode ||
        (input.platform_class === "hyperliquid_style_market" ? "byo_api_key" : "user_stealth"),
      work_order_commitment: input.work_order_commitment,
      manifest_commitment: input.manifest.manifest_commitment,
      operation_class: input.operation_class,
      vault_commitment: input.venue_execution_vault.vault_commitment,
      encrypted_vault_commitment: input.venue_execution_vault.encrypted_vault_commitment,
      policy_commitment: input.venue_execution_vault.policy_commitment,
      allocation_commitment: input.venue_execution_vault.allocation_commitment ?? null,
      ...(input.venue_execution_vault.encrypted_execution_vault
        ? { encrypted_execution_vault: input.venue_execution_vault.encrypted_execution_vault }
        : {}),
      encrypted_execution_instruction_bundle: input.encrypted_execution_instruction_bundle,
      session_policy: {
        market_allowlist: input.session_policy?.market_allowlist || (
          input.platform_class === "hyperliquid_style_market" ? ["BTC", "ETH", "SOL", "HYPE"] : []
        ),
        max_notional_bucket: input.session_policy?.max_notional_bucket || "5",
        max_order_count: input.session_policy?.max_order_count ?? 5,
        kill_switch: input.session_policy?.kill_switch === true,
      },
    };
    const authorization = workerAuthorizationHeader({
      env: input.env ?? process.env,
      fallbackToken: cfg.token,
      method: "POST",
      path: verifyPath,
      scope: "order:verify",
      body: payload,
      expected: workerCapabilityExpectedFromBody(payload),
    });
    const res = await fetch(new URL(verifyPath, cfg.url), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        "x-ghola-no-submit-verify": "true",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(payload),
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
    const payload = {
      version: 1,
      work_order_commitment: input.work_order.work_order_commitment,
      provider_ref_commitment: input.existing_result?.provider_ref_commitment ?? null,
    };
    const authorization = workerAuthorizationHeader({
      env: input.env ?? process.env,
      fallbackToken: cfg.token,
      method: "POST",
      path: reconcilePath,
      scope: "reconcile:read",
      body: payload,
      expected: workerCapabilityExpectedFromBody(payload, {
        venue_id: venueIdForPlatformClass(input.manifest.platform_class),
        platform_class: input.manifest.platform_class,
        operation_class: "reconcile",
      }),
    });
    const res = await fetch(new URL(reconcilePath, cfg.url), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(payload),
    });
    const body = asRecord(await res.json().catch(() => null));
    return connectorResult({
      work_order: input.work_order,
      manifest: input.manifest,
      status: res.ok && body.status !== "failed" ? "reconciled" : "failed",
      provider_ref_seed: stringValue(body.provider_ref_commitment) ||
        input.existing_result?.provider_ref_commitment ||
        input.work_order.work_order_commitment,
      final_proof: connectorFinalProof(body.final_proof),
      fill_commitments: stringArray(body.fill_commitments),
      fill_summary: connectorFillSummary(body.fill_summary),
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
  const spec = connectorSdkSpecForPlatform(platformClass);
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
    sealed_runtime_required: spec.requires_sealed_runtime,
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
    requires_omnibus_funding: spec.requires_omnibus_funding,
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
  return connectorSdkSpecForPlatform(platformClass).operation_classes;
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
  if (platformClass !== "partner_tokenized_assets") return connectorSdkSpecForPlatform(platformClass).blocked_actions;
  if (platformClass === "partner_tokenized_assets" && process.env.GHOLA_PARTNER_ASSETS_READY !== "true") {
    return ["pay", "transfer", "fund_platform", "trade_on_platform", "rebalance", "maintain_allocation", "withdraw"];
  }
  return connectorSdkSpecForPlatform(platformClass).blocked_actions;
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
  final_proof?: GholaConnectorFinalProof | null;
  fill_commitments?: string[];
  fill_summary?: GholaConnectorFillSummary;
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
    platform_fee_policy_commitment: input.work_order.platform_fee_policy_commitment ?? null,
    reason: input.reason,
    fill_commitments: input.fill_commitments ?? [],
  };
  return {
    version: 1,
    connector_result_commitment: gholaCommitment("connector_result", resultSeed),
    work_order_commitment: input.work_order.work_order_commitment,
    platform_class: input.manifest.platform_class,
    status: input.status,
    provider_ref_commitment: providerRefCommitment,
    result_commitment: gholaCommitment("connector_result_body", resultSeed),
    final_proof: input.final_proof ?? null,
    fill_commitments: input.fill_commitments ?? [],
    fill_summary: input.fill_summary ?? connectorFillSummary(null),
    visibility_summary: {
      main_wallet_exposed: !input.manifest.source_wallet_hidden,
      venue_saw_order_class: input.manifest.order_details_visible,
      public_chain_settlement: input.manifest.public_chain_sees,
    },
    venue_access_summary: connectorAccessContext(input.manifest),
    reason: input.reason,
    platform_fee_policy_commitment: input.work_order.platform_fee_policy_commitment ?? null,
    created_at: input.now.toISOString(),
    updated_at: input.now.toISOString(),
  };
}

function connectorAccessContext(
  manifest: GholaConnectorManifest,
  executionMode?: GholaVenueExecutionMode,
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
      venue_access_source: executionMode === "ghola_pooled"
        ? "ghola_pooled_venue_account"
        : executionMode === "hyperliquid_native_vault"
          ? "hyperliquid_native_vault"
        : executionMode === "managed_testnet"
          ? "ghola_managed_testnet"
          : "user_provided_credentials",
      ghola_access_role: "private_execution_router",
      venue_gate: "venue_accepts_or_rejects_credentials",
      venue_visibility: "execution_account_and_order_activity",
      source_wallet_visibility: "not_exposed_to_public_chain_by_ghola",
      privacy_claim: "venue_visible_order_degraded",
    };
  }
  if (manifest.platform_class === "solana_perps_market") {
    return {
      venue_access_source: executionMode === "ghola_pooled"
        ? "ghola_pooled_venue_account"
        : "user_provided_credentials",
      ghola_access_role: "private_execution_router",
      venue_gate: "venue_accepts_or_rejects_credentials",
      venue_visibility: "execution_account_and_order_activity",
      source_wallet_visibility: "not_exposed_to_public_chain_by_ghola",
      privacy_claim: "venue_visible_order_degraded",
    };
  }
  if (manifest.platform_class === "solana_swap_aggregator") {
    return {
      venue_access_source: executionMode === "ghola_pooled"
        ? "ghola_pooled_venue_account"
        : executionMode === "byo_api_key" || executionMode === "user_stealth"
          ? "user_provided_credentials"
          : "none",
      ghola_access_role: "private_execution_router",
      venue_gate: executionMode === "ghola_pooled" || executionMode === "byo_api_key" || executionMode === "user_stealth"
        ? "venue_accepts_or_rejects_credentials"
        : "not_applicable",
      venue_visibility: "ticket_only",
      source_wallet_visibility: "not_exposed_to_public_chain_by_ghola",
      privacy_claim: "private_mode_available",
    };
  }
  if (manifest.platform_class === "coinbase_style_provider") {
    return {
      venue_access_source: executionMode === "byo_api_key"
        ? "user_provided_credentials"
        : "partner_omnibus",
      ghola_access_role: "private_execution_router",
      venue_gate: executionMode === "byo_api_key"
        ? "venue_accepts_or_rejects_credentials"
        : "partner_accepts_or_rejects_order",
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
  platform_fee_policy?: GholaConnectorPlatformFeePolicy | null;
  hyperliquid_execution_vault?: {
    vault_commitment: string;
    encrypted_vault_commitment: string;
    policy_commitment: string;
    encrypted_execution_vault: unknown;
  } | null;
  hyperliquid_managed_allocation?: {
    allocation_commitment: string;
    execution_mode?: GholaVenueExecutionMode | string;
    policy_commitment: string;
    pool_commitment: string;
    pool_share_commitment?: string | null;
    subledger_account_commitment: string;
    vault_address?: string | null;
    vault_controller_address?: string | null;
    agent_wallet_commitment?: string | null;
    deposit_evidence_commitment?: string | null;
    deposit_status?: string | null;
    funding_routes?: string[];
    eligibility_commitment?: string | null;
    funding_evidence_commitment?: string | null;
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
  pooled_venue_allocation?: {
    pooled_allocation_commitment: string;
    pool_commitment: string;
    pool_share_commitment?: string | null;
    subledger_account_commitment: string;
    eligibility_commitment?: string | null;
    funding_evidence_commitment?: string | null;
    settlement_evidence_commitment?: string | null;
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
    ...(input.platform_fee_policy
      ? {
          platform_fee_policy: input.platform_fee_policy,
          platform_fee_policy_commitment: input.platform_fee_policy.fee_policy_commitment,
        }
      : {}),
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
          execution_mode: hyperliquidManagedExecutionMode(input.hyperliquid_managed_allocation.execution_mode),
          managed_allocation_commitment: input.hyperliquid_managed_allocation.allocation_commitment,
          allocation_commitment: input.hyperliquid_managed_allocation.allocation_commitment,
          policy_commitment: input.hyperliquid_managed_allocation.policy_commitment,
          managed_allocation: {
            allocation_commitment: input.hyperliquid_managed_allocation.allocation_commitment,
            execution_mode: hyperliquidManagedExecutionMode(input.hyperliquid_managed_allocation.execution_mode),
            policy_commitment: input.hyperliquid_managed_allocation.policy_commitment,
            pool_commitment: input.hyperliquid_managed_allocation.pool_commitment,
            pool_share_commitment: input.hyperliquid_managed_allocation.pool_share_commitment ?? null,
            subledger_account_commitment: input.hyperliquid_managed_allocation.subledger_account_commitment,
            vault_address: input.hyperliquid_managed_allocation.vault_address ?? null,
            vault_controller_address: input.hyperliquid_managed_allocation.vault_controller_address ?? null,
            agent_wallet_commitment: input.hyperliquid_managed_allocation.agent_wallet_commitment ?? null,
            deposit_evidence_commitment: input.hyperliquid_managed_allocation.deposit_evidence_commitment ?? null,
            deposit_status: input.hyperliquid_managed_allocation.deposit_status ?? null,
            funding_routes: input.hyperliquid_managed_allocation.funding_routes ?? [],
            eligibility_commitment: input.hyperliquid_managed_allocation.eligibility_commitment ?? null,
            funding_evidence_commitment: input.hyperliquid_managed_allocation.funding_evidence_commitment ?? null,
            status: input.hyperliquid_managed_allocation.status ?? "allocated",
          },
          pooled_allocation: input.hyperliquid_managed_allocation.execution_mode === "ghola_pooled"
            ? {
                allocation_commitment: input.hyperliquid_managed_allocation.allocation_commitment,
                pool_commitment: input.hyperliquid_managed_allocation.pool_commitment,
                pool_share_commitment: input.hyperliquid_managed_allocation.pool_share_commitment ?? null,
                subledger_account_commitment: input.hyperliquid_managed_allocation.subledger_account_commitment,
                eligibility_commitment: input.hyperliquid_managed_allocation.eligibility_commitment ?? null,
                funding_evidence_commitment: input.hyperliquid_managed_allocation.funding_evidence_commitment ?? null,
              }
            : null,
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
          execution_mode: input.pooled_venue_allocation
            ? "ghola_pooled"
            : input.venue_execution_vault?.execution_mode ?? "user_stealth",
          vault_commitment: input.venue_execution_vault?.vault_commitment ?? null,
          encrypted_vault_commitment: input.venue_execution_vault?.encrypted_vault_commitment ?? null,
          policy_commitment: input.venue_execution_vault?.policy_commitment ?? null,
          allocation_commitment: input.venue_execution_vault?.allocation_commitment ??
            input.pooled_venue_allocation?.pooled_allocation_commitment ??
            null,
          ...(input.venue_execution_vault?.encrypted_execution_vault
            ? { encrypted_execution_vault: input.venue_execution_vault.encrypted_execution_vault }
            : {}),
          pooled_allocation: input.pooled_venue_allocation
            ? {
                allocation_commitment: input.pooled_venue_allocation.pooled_allocation_commitment,
                pool_commitment: input.pooled_venue_allocation.pool_commitment,
                pool_share_commitment: input.pooled_venue_allocation.pool_share_commitment ?? null,
                subledger_account_commitment: input.pooled_venue_allocation.subledger_account_commitment,
                eligibility_commitment: input.pooled_venue_allocation.eligibility_commitment ?? null,
                funding_evidence_commitment: input.pooled_venue_allocation.funding_evidence_commitment ?? null,
                settlement_evidence_commitment: input.pooled_venue_allocation.settlement_evidence_commitment ?? null,
                utilization_bucket: input.pooled_venue_allocation.utilization_bucket ?? "0",
                status: input.pooled_venue_allocation.status ?? "allocated",
              }
            : null,
        }
      : {}),
    ...(input.manifest.platform_class === "solana_swap_aggregator"
      ? {
          venue_id: input.venue_execution_vault?.venue_id ?? "jupiter",
          execution_mode: input.pooled_venue_allocation
            ? "ghola_pooled"
            : input.venue_execution_vault?.execution_mode ?? "user_stealth",
          vault_commitment: input.venue_execution_vault?.vault_commitment ?? null,
          encrypted_vault_commitment: input.venue_execution_vault?.encrypted_vault_commitment ?? null,
          policy_commitment: input.venue_execution_vault?.policy_commitment ?? null,
          allocation_commitment: input.venue_execution_vault?.allocation_commitment ??
            input.pooled_venue_allocation?.pooled_allocation_commitment ??
            null,
          ...(input.venue_execution_vault?.encrypted_execution_vault
            ? { encrypted_execution_vault: input.venue_execution_vault.encrypted_execution_vault }
            : {}),
          pooled_allocation: input.pooled_venue_allocation
            ? {
                allocation_commitment: input.pooled_venue_allocation.pooled_allocation_commitment,
                pool_commitment: input.pooled_venue_allocation.pool_commitment,
                pool_share_commitment: input.pooled_venue_allocation.pool_share_commitment ?? null,
                subledger_account_commitment: input.pooled_venue_allocation.subledger_account_commitment,
                eligibility_commitment: input.pooled_venue_allocation.eligibility_commitment ?? null,
                funding_evidence_commitment: input.pooled_venue_allocation.funding_evidence_commitment ?? null,
                settlement_evidence_commitment: input.pooled_venue_allocation.settlement_evidence_commitment ?? null,
                utilization_bucket: input.pooled_venue_allocation.utilization_bucket ?? "0",
                status: input.pooled_venue_allocation.status ?? "allocated",
              }
            : null,
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
  pooled_allocation_ready: boolean;
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
    if (input.execution_mode === "ghola_pooled") {
      if (!input.pooled_allocation_ready) reasonCodes.push("solana_perps_pooled_allocation_not_ready");
    } else if (!input.execution_vault_ready) {
      reasonCodes.push("solana_perps_execution_vault_not_ready");
    }
  }
  if (input.manifest.platform_class === "solana_swap_aggregator") {
    const localAllowed = input.env.NODE_ENV === "test" ||
      input.env.GHOLA_CONNECTOR_MODE === "local_test" ||
      input.env.GHOLA_SHIELDED_POOL_MODE === "local_test";
    if (input.env.GHOLA_VENUE_JUPITER_PILOT_ENABLED !== "true" && !localAllowed) {
      reasonCodes.push("jupiter_pilot_disabled");
    }
    if (input.env.GHOLA_JUPITER_LIVE_MODE !== "full" &&
      input.env.PRIVATE_AGENT_JUPITER_LIVE_MODE !== "full" &&
      !localAllowed) {
      reasonCodes.push("jupiter_live_mode_disabled");
    }
    const inputMints = input.env.GHOLA_JUPITER_ALLOWED_INPUT_MINTS?.trim() ||
      input.env.PRIVATE_AGENT_JUPITER_ALLOWED_INPUT_MINTS?.trim() ||
      "";
    const outputMints = input.env.GHOLA_JUPITER_ALLOWED_OUTPUT_MINTS?.trim() ||
      input.env.PRIVATE_AGENT_JUPITER_ALLOWED_OUTPUT_MINTS?.trim() ||
      "";
    const maxSlippageBps = Number.parseInt(
      input.env.GHOLA_JUPITER_MAX_SLIPPAGE_BPS ||
        input.env.PRIVATE_AGENT_JUPITER_MAX_SLIPPAGE_BPS ||
        "",
      10,
    );
    const maxNotionalUsd = Number.parseFloat(
      input.env.GHOLA_JUPITER_LIVE_MAX_NOTIONAL_USD ||
        input.env.PRIVATE_AGENT_JUPITER_LIVE_MAX_NOTIONAL_USD ||
        "",
    );
    if (!localAllowed && !inputMints) reasonCodes.push("jupiter_input_mint_allowlist_missing");
    if (!localAllowed && !outputMints) reasonCodes.push("jupiter_output_mint_allowlist_missing");
    if (!localAllowed && (!Number.isFinite(maxSlippageBps) || maxSlippageBps <= 0)) {
      reasonCodes.push("jupiter_slippage_cap_missing");
    }
    if (!localAllowed && (!Number.isFinite(maxNotionalUsd) || maxNotionalUsd <= 0)) {
      reasonCodes.push("jupiter_notional_cap_missing");
    }
    if (input.execution_mode === "ghola_pooled") {
      if (!input.pooled_allocation_ready) reasonCodes.push("jupiter_pooled_allocation_not_ready");
    } else if (!input.execution_vault_ready) {
      reasonCodes.push("jupiter_execution_vault_not_ready");
    }
  }
  if (venueId === "hyperliquid" && input.execution_mode === "ghola_pooled") {
    if (!input.pooled_allocation_ready) {
      reasonCodes.push("venue_access_required", "hyperliquid_pooled_allocation_not_ready");
    }
  } else if (venueId === "hyperliquid" && input.execution_mode === "hyperliquid_native_vault") {
    if (!input.execution_vault_ready) {
      reasonCodes.push("venue_access_required", "hyperliquid_native_vault_not_ready");
    }
  } else if (venueId === "hyperliquid" && !input.execution_vault_ready) {
    reasonCodes.push("venue_access_required", "hyperliquid_execution_vault_not_ready");
  }
  if (venueId === "coinbase_advanced") {
    const mode = input.execution_mode ?? "partner_omnibus";
    if (mode === "partner_omnibus") {
      if (input.env.GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED !== "true") {
        reasonCodes.push("coinbase_partner_omnibus_disabled");
      }
      if (input.env.GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY !== "true") {
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
  const fundingRequired = operationClass !== "read" &&
    operationClass !== "preview_order" &&
    operationClass !== "reconcile";
  const hyperliquidByoTinyFill =
    venueId === "hyperliquid" &&
    input.execution_mode === "byo_api_key" &&
    (input.env.GHOLA_HYPERLIQUID_LIVE_MODE === "tiny_fill" ||
      input.env.GHOLA_HYPERLIQUID_LIVE_MODE === "full_ticket");
  const solanaPerpsStealthTinyFill =
    venueId === "phoenix" &&
    input.execution_mode === "user_stealth" &&
    (input.env.GHOLA_SOLANA_PERPS_LIVE_MODE === "sdk_runner" ||
      input.env.GHOLA_SOLANA_PERPS_LIVE_MODE === "full_ticket" ||
      input.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE === "full_ticket" ||
      input.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE === "sdk_runner");
  const hyperliquidPooledTinyFill =
    venueId === "hyperliquid" &&
    input.execution_mode === "ghola_pooled" &&
    (input.env.GHOLA_HYPERLIQUID_LIVE_MODE === "tiny_fill" ||
      input.env.GHOLA_HYPERLIQUID_LIVE_MODE === "full_ticket");
  const hyperliquidNativeVaultLive =
    venueId === "hyperliquid" &&
    input.execution_mode === "hyperliquid_native_vault" &&
    input.execution_vault_ready &&
    (input.env.GHOLA_HYPERLIQUID_LIVE_MODE === "tiny_fill" ||
      input.env.GHOLA_HYPERLIQUID_LIVE_MODE === "full_ticket");
  const solanaPerpsPooledTinyFill =
    venueId === "phoenix" &&
    input.execution_mode === "ghola_pooled" &&
    (input.env.GHOLA_SOLANA_PERPS_LIVE_MODE === "sdk_runner" ||
      input.env.GHOLA_SOLANA_PERPS_LIVE_MODE === "full_ticket" ||
      input.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE === "full_ticket" ||
      input.env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE === "sdk_runner");
  const jupiterFullPilot =
    venueId === "jupiter" &&
    (input.env.GHOLA_JUPITER_LIVE_MODE === "full" ||
      input.env.PRIVATE_AGENT_JUPITER_LIVE_MODE === "full" ||
      input.env.GHOLA_CONNECTOR_MODE === "local_test" ||
      input.env.NODE_ENV === "test");
  if (
    !input.shielded_funding_ready &&
    fundingRequired &&
    !hyperliquidByoTinyFill &&
    !hyperliquidPooledTinyFill &&
    !hyperliquidNativeVaultLive &&
    !solanaPerpsStealthTinyFill &&
    !solanaPerpsPooledTinyFill &&
    !jupiterFullPilot
  ) {
    reasonCodes.push("shielded_funding_evidence_required");
  }
  if (requiresSealedRuntime(input.execution_mode)) {
    if (input.runtime_health?.status !== "green") reasonCodes.push("sealed_runtime_unhealthy");
    if (!input.runtime_health?.runtime_attestation_commitment) {
      reasonCodes.push("sealed_runtime_attestation_required");
    }
    if (!input.runtime_health?.runtime_measurement_commitment) {
      reasonCodes.push("sealed_runtime_measurement_required");
    }
  }
  return {
    ok: reasonCodes.length === 0,
    reason_codes: reasonCodes,
  };
}

function requiresSealedRuntime(executionMode?: GholaVenueExecutionMode): boolean {
  if (executionMode === "byo_api_key" || executionMode === "user_stealth") return false;
  return true;
}

function hyperliquidManagedExecutionMode(value: unknown): "managed_testnet" | "ghola_pooled" | "hyperliquid_native_vault" {
  if (value === "ghola_pooled") return "ghola_pooled";
  if (value === "hyperliquid_native_vault") return "hyperliquid_native_vault";
  return "managed_testnet";
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
  if (platformClass === "rfq_solver_network") return action === "trade_on_platform" || action === "rebalance" ? "preview_order" : "read";
  return hyperliquidOperationForAction(action);
}

function connectorSubmitPath(platformClass: GholaPlatformClass): string {
  return connectorSdkSpecForPlatform(platformClass).http_paths.submit;
}

function connectorReconcilePath(platformClass: GholaPlatformClass): string {
  return connectorSdkSpecForPlatform(platformClass).http_paths.reconcile;
}

function connectorNoSubmitVerifyPath(platformClass: GholaPlatformClass): string {
  return connectorSdkSpecForPlatform(platformClass).http_paths.verify_no_submit;
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
  const venueId = certificateVenueId(input.base.platform_class);
  const checks = {
    production_site_reachable: Boolean(siteOrigin),
    private_agent_worker_reachable: Boolean(
      input.checks.sealed_vault_opened ||
      input.checks.rpc_reachable ||
      input.checks.hyperliquid_api_reachable ||
      input.checks.jupiter_api_reachable
    ),
    sealed_vault_opened: input.checks.sealed_vault_opened,
    sealed_instruction_opened: input.checks.sealed_instruction_opened,
    authority_derived: input.checks.authority_derived,
    policy_enforced: input.checks.policy_enforced,
    live_gate_enforced: input.checks.live_gate_enforced,
    solana_rpc_reachable: input.checks.rpc_reachable,
    phoenix_sdk_ready: input.checks.phoenix_sdk_ready,
    order_packet_built: input.checks.order_packet_built,
    hyperliquid_api_reachable: input.checks.hyperliquid_api_reachable,
    hyperliquid_sdk_ready: input.checks.hyperliquid_sdk_ready,
    account_read_checked: input.checks.account_read_checked,
    order_request_built: input.checks.order_request_built,
    jupiter_api_reachable: input.checks.jupiter_api_reachable,
    jupiter_token_allowlist_passed: input.checks.jupiter_token_allowlist_passed,
    jupiter_order_built: input.checks.jupiter_order_built,
    jupiter_transaction_built: input.checks.jupiter_transaction_built,
    coinbase_api_reachable: input.checks.coinbase_api_reachable,
    coinbase_order_request_built: input.checks.coinbase_order_request_built,
    transaction_broadcast: false as const,
  };
  const seed = {
    certificate_kind: "ghola_live_readiness_certificate_v1",
    status: input.status,
    platform_class: input.base.platform_class,
    venue_id: venueId,
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
    venue_id: venueId,
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
      ? provenNoSubmitClaims(input.base.platform_class)
      : [
          "ghola produced a commitment-safe failed readiness artifact",
          "no transaction was broadcast",
        ],
    what_is_not_proven: [
      "the venue accepted a broadcast transaction",
      "the venue account has approved the API wallet",
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
    api_wallet_loaded: ok,
    hyperliquid_api_reachable: ok,
    hyperliquid_sdk_ready: ok,
    account_read_checked: ok,
    order_request_built: ok,
    jupiter_api_reachable: ok,
    jupiter_token_allowlist_passed: ok,
    jupiter_order_built: ok,
    jupiter_transaction_built: ok,
    coinbase_api_reachable: ok,
    coinbase_order_request_built: ok,
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
    api_wallet_loaded: body.api_wallet_loaded === true || body.authority_derived === true,
    hyperliquid_api_reachable: body.hyperliquid_api_reachable === true,
    hyperliquid_sdk_ready: body.hyperliquid_sdk_ready === true,
    account_read_checked: body.account_read_checked === true,
    order_request_built: body.order_request_built === true || body.order_packet_built === true,
    jupiter_api_reachable: body.jupiter_api_reachable === true,
    jupiter_token_allowlist_passed: body.jupiter_token_allowlist_passed === true,
    jupiter_order_built: body.jupiter_order_built === true,
    jupiter_transaction_built: body.jupiter_transaction_built === true,
    coinbase_api_reachable: body.coinbase_api_reachable === true || body.provider_api_reachable === true,
    coinbase_order_request_built: body.coinbase_order_request_built === true || body.order_request_built === true,
    transaction_broadcast: false,
  };
}

function certificateVenueId(platformClass: GholaPlatformClass): "phoenix" | "hyperliquid" | "jupiter" | "coinbase_advanced" {
  if (platformClass === "hyperliquid_style_market") return "hyperliquid";
  if (platformClass === "solana_swap_aggregator") return "jupiter";
  if (platformClass === "coinbase_style_provider") return "coinbase_advanced";
  return "phoenix";
}

function provenNoSubmitClaims(platformClass: GholaPlatformClass): string[] {
  if (platformClass === "hyperliquid_style_market") {
    return [
      "ghola production route answered this request",
      "private-agent worker accepted sealed vault and instruction bundles",
      "Hyperliquid live gates and capped IOC policy passed",
      "Hyperliquid API was reachable for market and account state",
      "Hyperliquid Python SDK was reachable",
      "Hyperliquid order request was built without broadcasting",
    ];
  }
  if (platformClass === "solana_swap_aggregator") {
    return [
      "ghola production route answered this request",
      "private-agent worker accepted sealed vault and instruction bundles",
      "Jupiter live gates and mint allowlists passed",
      "Jupiter Swap API was reachable",
      "Jupiter swap transaction was built without broadcasting",
    ];
  }
  if (platformClass === "coinbase_style_provider") {
    return [
      "ghola production route answered this request",
      "private-agent worker accepted sealed venue access and instruction bundles",
      "Coinbase provider gates and capped policy passed",
      "Coinbase order request was built without submitting",
    ];
  }
  return [
    "ghola production route answered this request",
    "private-agent worker accepted sealed vault and instruction bundles",
    "Phoenix live gates and capped IOC policy passed",
    "Solana RPC was reachable",
    "Phoenix Rise SDK was reachable",
    "Phoenix order packet was built without broadcasting",
  ];
}

function noFundsReason(body: Record<string, unknown>, status: number): string {
  const code = stringValue(body.error_code) || stringValue(body.code) || stringValue(body.error);
  const text = `${code} ${stringValue(body.error)}`.toLowerCase();
  if (/insufficient|needs funds|not enough|collateral|account value|margin/.test(text)) return "needs_funds";
  if (code.includes("access") || code === "venue_access_required") return "invalid_authority_or_access";
  if (code === "venue_rejected") return "venue_rejected";
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
  const prefix = connectorSdkSpecForPlatform(platformClass).env_prefix;
  const token = env[`${prefix}_TOKEN`]?.trim() ||
    ([
      "hyperliquid_style_market",
      "coinbase_style_provider",
      "solana_perps_market",
      "solana_swap_aggregator",
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
  return connectorSdkPlatformClasses();
}

function connectorFinalProof(value: unknown): GholaConnectorFinalProof | null {
  const body = asRecord(value);
  const proofKind = stringValue(body.proof_kind);
  const status = stringValue(body.status);
  const venueId = stringValue(body.venue_id);
  const checkedAt = stringValue(body.checked_at);
  if (!proofKind || !status || !venueId || !checkedAt) return null;
  return {
    version: 1,
    proof_kind: proofKind,
    status,
    venue_id: venueId,
    routing_mode: stringValue(body.routing_mode) || null,
    broadcast_performed: body.broadcast_performed === true,
    final_venue_execution_proven: body.final_venue_execution_proven === true,
    final_fill_proven: body.final_fill_proven === true,
    signature_commitment: stringValue(body.signature_commitment) || null,
    request_commitment: stringValue(body.request_commitment) || null,
    checked_at: checkedAt,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter(Boolean).slice(0, 25)
    : [];
}

function connectorFillSummary(value: unknown): GholaConnectorFillSummary {
  const body = asRecord(value);
  const fillCount = Number(body.fill_count ?? 0);
  const filledNotionalUsd = Number(body.filled_notional_usd ?? 0);
  const averageFillPrice = Number(body.average_fill_price);
  const feeUsd = Number(body.fee_usd ?? 0);
  return {
    fill_count: Number.isInteger(fillCount) && fillCount > 0 ? Math.min(fillCount, 25) : 0,
    filled_base_size: stringValue(body.filled_base_size) || "0",
    filled_notional_usd: Number.isFinite(filledNotionalUsd) && filledNotionalUsd > 0
      ? filledNotionalUsd
      : 0,
    average_fill_price: Number.isFinite(averageFillPrice) && averageFillPrice > 0
      ? averageFillPrice
      : null,
    fee_usd: Number.isFinite(feeUsd) && feeUsd > 0 ? feeUsd : 0,
    fee_status: stringValue(body.fee_status) || "not_applicable",
  };
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
