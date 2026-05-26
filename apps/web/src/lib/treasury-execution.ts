import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import {
  containsPrivateExecutionPlaintextLeak,
  type PrivateExecutionEncryptedBundleV1,
} from "./private-execution";

export type TreasuryIntentObjective =
  | "maintain_runway"
  | "optimize_idle_cash"
  | "fund_payment_schedule"
  | "rebalance_treasury_risk";

export type TreasuryRailKind =
  | "bank_cash"
  | "treasury_bills"
  | "bond_ladder"
  | "broker_cash_sweep"
  | "stablecoin_public"
  | "stablecoin_shielded"
  | "ach"
  | "wire"
  | "rtp";

export type TreasuryAsset =
  | "USD"
  | "USDC"
  | "USDT"
  | "T_BILL"
  | "BOND_FUND"
  | "BROKER_SWEEP";

export interface TreasuryIntentV1 {
  version: 1;
  intent_id: string;
  owner_did: string;
  objective: TreasuryIntentObjective;
  horizon_days: number;
  amount_micro_usd?: number;
  constraints: {
    min_operating_cash_micro_usd: number;
    min_instant_liquidity_micro_usd: number;
    min_runway_months: number;
    max_single_bank_exposure_bps: number;
    max_stablecoin_issuer_exposure_bps: number;
    max_duration_days: number;
    approved_rails: TreasuryRailKind[];
    approval_required_above_micro_usd: number;
    public_fallback_allowed: false;
  };
  encrypted_context_bundle: PrivateExecutionEncryptedBundleV1;
}

export interface TreasuryPolicyV1 {
  version: 1;
  policy_id: string;
  owner_did: string;
  allowed_assets: TreasuryAsset[];
  allowed_payment_rails: TreasuryRailKind[];
  allowed_rails?: TreasuryRailKind[];
  allowed_partners: string[];
  max_action_micro_usd: number;
  daily_action_micro_usd: number;
  approval_required_above_micro_usd: number;
  public_fallback_allowed: false;
}

export interface TreasuryAgentConfig {
  agent_id: string;
  label: string;
}

export type TreasuryRouteAction =
  | "reserve_operating_cash"
  | "sweep_broker_cash"
  | "ladder_t_bills"
  | "ladder_bonds"
  | "hold_stablecoin_buffer"
  | "prepare_payment_buffer";

export interface TreasuryRouteCandidateV1 {
  version: 1;
  route_id: string;
  rail: TreasuryRailKind;
  action: TreasuryRouteAction;
  asset: TreasuryAsset;
  amount_micro_usd: number;
  partner_id: string;
  settlement_eta: "instant" | "same_day" | "next_day" | "scheduled";
  liquidity_class: "instant" | "same_day" | "scheduled" | "term";
  max_duration_days?: number;
  expected_yield_bps?: number;
  leakage_score_bps: number;
  route_score_bps: number;
  score_components: TreasuryRouteScoreComponentsV1;
  privacy:
    | "private_context_partner_instruction"
    | "shielded_settlement_subject_to_timing"
    | "public_settlement_amount_timing_visible";
  risk_flags: string[];
}

export interface TreasuryRouteScoreComponentsV1 {
  yield_bps: number;
  liquidity_bps: number;
  leakage_penalty_bps: number;
  risk_penalty_bps: number;
  duration_penalty_bps: number;
}

export interface TreasuryProposalV1 {
  version: 1;
  proposal_id: string;
  intent_id: string;
  owner_did: string;
  objective: TreasuryIntentObjective;
  created_at: string;
  horizon_days: number;
  amount_micro_usd: number;
  routes: TreasuryRouteCandidateV1[];
  approval_required: boolean;
  public_fallback_allowed: false;
}

export interface TreasuryApprovalV1 {
  version: 1;
  approval_hash: string;
  expires_at: string;
  scope: "treasury_proposal";
}

export type TreasuryGuardReason =
  | "owner_mismatch"
  | "invalid_amount"
  | "public_fallback_denied"
  | "rail_not_allowed"
  | "asset_not_allowed"
  | "partner_not_allowed"
  | "amount_over_cap"
  | "daily_cap_exceeded"
  | "operating_cash_below_min"
  | "instant_liquidity_below_min"
  | "duration_too_long";

export type TreasuryGuardResult =
  | {
      ok: true;
      policy_hash: string;
      intent_hash: string;
      proposal_hash: string;
      approval_required: boolean;
      explanation: string;
    }
  | {
      ok: false;
      reason: TreasuryGuardReason;
      policy_hash: string;
      intent_hash: string;
      proposal_hash: string;
      explanation: string;
    };

export interface TreasurySimulationResponseV1 {
  version: 1;
  ok: boolean;
  policy_hash: string;
  intent_hash: string;
  proposal_hash: string;
  proposal: TreasuryProposalV1;
  approval?: TreasuryApprovalV1;
  guard: TreasuryGuardResult;
  exposure_report: {
    public_fallback_allowed: false;
    expected_public_leakage:
      | "sealed_context_partner_instructions_only"
      | "blocked_before_execution";
    leakage_score_bps: number;
    blocked_reason?: TreasuryGuardReason;
  };
}

export interface TreasuryExecuteRequestV1 {
  version: 1;
  intent_id: string;
  owner_did: string;
  policy_hash: string;
  proposal_hash: string;
  approval_hash: string;
  approval_expires_at: string;
  amount_micro_usd: number;
  rails: TreasuryRailKind[];
  encrypted_context_bundle: PrivateExecutionEncryptedBundleV1;
}

export interface TreasuryPartnerPreparedInstructionV1 {
  version: 1;
  rail: TreasuryRailKind;
  instruction_ref: string;
  provider_id: string;
  redacted: true;
}

export interface TreasuryPartnerSubmissionV1 {
  version: 1;
  rail: TreasuryRailKind;
  partner_ref: string;
  provider_id: string;
  reconciliation_state: "submitted";
}

export interface TreasuryPartnerReconciliationV1 {
  version: 1;
  rail: TreasuryRailKind;
  partner_ref: string;
  reconciliation_state: "submitted" | "settled" | "failed" | "cancelled";
}

export interface TreasuryPartnerAdapter {
  rail: TreasuryRailKind;
  prepare(input: TreasuryPartnerAdapterInput): MaybePromise<TreasuryPartnerPreparedInstructionV1>;
  submit(input: TreasuryPartnerAdapterInput): MaybePromise<TreasuryPartnerSubmissionV1>;
  reconcile(
    input: TreasuryPartnerReconciliationInput,
  ): MaybePromise<TreasuryPartnerReconciliationV1>;
  cancel(input: TreasuryPartnerReconciliationInput): MaybePromise<TreasuryPartnerReconciliationV1>;
}

export interface TreasuryPartnerAdapterInput {
  request: TreasuryExecuteRequestV1;
  provider_id: string;
}

export interface TreasuryPartnerReconciliationInput {
  partner_ref: string;
  provider_id: string;
}

export interface TreasuryHttpPartnerAdapterConfig {
  rail: TreasuryRailKind;
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
}

type MaybePromise<T> = T | Promise<T>;

export interface TreasuryExecutionReceiptV1 {
  version: 1;
  receipt_id: string;
  intent_id: string;
  owner_did: string;
  agent_id: string;
  policy_hash: string;
  proposal_hash: string;
  approval_hash: string;
  approval_expires_at: string;
  amount_micro_usd: number;
  rails: TreasuryRailKind[];
  provider_id: string;
  partner_refs: string[];
  reconciliation_state: "submitted";
  executed_at: string;
  public_fallback_used: false;
  signature: string;
}

export interface TreasuryExecutionStatusV1 {
  version: 1;
  ready: boolean;
  supported_rails: TreasuryRailKind[];
  partner_rail_ready: boolean;
  sealed_provider_ready: boolean;
  blocking_reasons: string[];
}

const TREASURY_RAILS: TreasuryRailKind[] = [
  "bank_cash",
  "treasury_bills",
  "bond_ladder",
  "broker_cash_sweep",
  "stablecoin_public",
  "stablecoin_shielded",
  "ach",
  "wire",
  "rtp",
];

const TREASURY_PLAINTEXT_LEAK_KEYS = new Set([
  "account_number",
  "balance",
  "balances",
  "bank_account",
  "cash_balance",
  "counterparties",
  "counterparty_list",
  "invoice",
  "invoices",
  "payroll",
  "payroll_details",
  "portfolio",
  "strategy",
  "vendor",
  "vendors",
]);

const DEFAULT_TREASURY_PROVIDER_ID = "mock_treasury_partner";

export function containsTreasuryPlaintextLeak(value: unknown): boolean {
  if (containsPrivateExecutionPlaintextLeak(value)) return true;
  if (!isObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (TREASURY_PLAINTEXT_LEAK_KEYS.has(key)) return true;
    if (Array.isArray(child)) {
      if (child.some(containsTreasuryPlaintextLeak)) return true;
    } else if (containsTreasuryPlaintextLeak(child)) {
      return true;
    }
  }
  return false;
}

export function simulateTreasuryIntent(input: {
  policy: TreasuryPolicyV1;
  intent: TreasuryIntentV1;
  now?: Date;
}): TreasurySimulationResponseV1 {
  const now = input.now ?? new Date();
  const proposal = buildTreasuryProposal(input);
  const guard = evaluateTreasuryProposal(input.policy, input.intent, proposal);
  const approval = guard.ok
    ? buildTreasuryApproval({
        ownerDid: input.intent.owner_did,
        policyHash: guard.policy_hash,
        proposalHash: guard.proposal_hash,
        amountMicroUsd: proposal.amount_micro_usd,
        rails: proposal.routes.map((route) => route.rail),
        expiresAt: addMinutes(now, 15).toISOString(),
      })
    : undefined;
  const leakageScore = guard.ok
    ? Math.max(...proposal.routes.map((route) => route.leakage_score_bps), 0)
    : 0;
  return {
    version: 1,
    ok: guard.ok,
    policy_hash: guard.policy_hash,
    intent_hash: guard.intent_hash,
    proposal_hash: guard.proposal_hash,
    proposal,
    ...(approval ? { approval } : {}),
    guard,
    exposure_report: {
      public_fallback_allowed: false,
      expected_public_leakage: guard.ok
        ? "sealed_context_partner_instructions_only"
        : "blocked_before_execution",
      leakage_score_bps: leakageScore,
      ...(!guard.ok ? { blocked_reason: guard.reason } : {}),
    },
  };
}

export function buildTreasuryProposal(input: {
  policy: TreasuryPolicyV1;
  intent: TreasuryIntentV1;
  now?: Date;
}): TreasuryProposalV1 {
  const amount = input.intent.amount_micro_usd ?? input.policy.max_action_micro_usd;
  const routes = routeTreasuryIntent(input.policy, input.intent, amount);
  return {
    version: 1,
    proposal_id: randomId("treasury_proposal"),
    intent_id: input.intent.intent_id,
    owner_did: input.intent.owner_did,
    objective: input.intent.objective,
    created_at: (input.now ?? new Date()).toISOString(),
    horizon_days: input.intent.horizon_days,
    amount_micro_usd: amount,
    routes,
    approval_required:
      amount >
      Math.min(
        input.policy.approval_required_above_micro_usd,
        input.intent.constraints.approval_required_above_micro_usd,
      ),
    public_fallback_allowed: false,
  };
}

export function evaluateTreasuryProposal(
  policy: TreasuryPolicyV1,
  intent: TreasuryIntentV1,
  proposal: TreasuryProposalV1,
): TreasuryGuardResult {
  const policyHash = hashTreasuryValue(policy);
  const intentHash = hashTreasuryValue(intent);
  const proposalHash = hashTreasuryValue(proposal);
  const deny = (
    reason: TreasuryGuardReason,
    explanation: string,
  ): TreasuryGuardResult => ({
    ok: false,
    reason,
    policy_hash: policyHash,
    intent_hash: intentHash,
    proposal_hash: proposalHash,
    explanation,
  });

  if (policy.owner_did !== intent.owner_did || proposal.owner_did !== intent.owner_did) {
    return deny("owner_mismatch", "Treasury policy, intent, and proposal owners must match.");
  }
  if (!isPositiveNumber(proposal.amount_micro_usd)) {
    return deny("invalid_amount", "Treasury intent amount must be positive.");
  }
  if (policy.public_fallback_allowed || intent.constraints.public_fallback_allowed) {
    return deny("public_fallback_denied", "Treasury execution cannot fall back to public rails.");
  }
  if (proposal.amount_micro_usd > policy.max_action_micro_usd) {
    return deny("amount_over_cap", "Treasury action exceeds the per-action policy cap.");
  }
  if (proposal.amount_micro_usd > policy.daily_action_micro_usd) {
    return deny("daily_cap_exceeded", "Treasury action exceeds the daily policy cap.");
  }

  const allowedRails = allowedRailsForPolicy(policy);
  for (const route of proposal.routes) {
    if (!allowedRails.includes(route.rail) || !intent.constraints.approved_rails.includes(route.rail)) {
      return deny("rail_not_allowed", `${route.rail} is not approved for this treasury policy.`);
    }
    if (!policy.allowed_assets.includes(route.asset)) {
      return deny("asset_not_allowed", `${route.asset} is not approved for this treasury policy.`);
    }
    if (!policy.allowed_partners.includes(route.partner_id)) {
      return deny("partner_not_allowed", `${route.partner_id} is not an approved partner.`);
    }
    if (
      route.max_duration_days &&
      route.max_duration_days > intent.constraints.max_duration_days
    ) {
      return deny("duration_too_long", "Treasury route duration exceeds the intent limit.");
    }
  }

  const operatingCash = sumRouteAmounts(proposal.routes, ["reserve_operating_cash"]);
  if (operatingCash < intent.constraints.min_operating_cash_micro_usd) {
    return deny("operating_cash_below_min", "Plan does not preserve required operating cash.");
  }
  const instantLiquidity = sumRouteAmounts(proposal.routes, [
    "reserve_operating_cash",
    "sweep_broker_cash",
    "hold_stablecoin_buffer",
  ]);
  if (instantLiquidity < intent.constraints.min_instant_liquidity_micro_usd) {
    return deny("instant_liquidity_below_min", "Plan does not preserve required instant liquidity.");
  }

  return {
    ok: true,
    policy_hash: policyHash,
    intent_hash: intentHash,
    proposal_hash: proposalHash,
    approval_required: proposal.approval_required,
    explanation: "Treasury proposal satisfies private routing and policy constraints.",
  };
}

export function validateTreasurySimulationRequest(body: unknown): {
  ok: boolean;
  policy?: TreasuryPolicyV1;
  intent?: TreasuryIntentV1;
  error?: string;
} {
  if (!isObject(body)) return { ok: false, error: "request body must be an object" };
  if (containsTreasuryPlaintextLeak(body)) {
    return {
      ok: false,
      error: "request must not contain plaintext balances, payroll details, counterparties, portfolio, or strategy",
    };
  }
  if (body.version !== 1) return { ok: false, error: "version must be 1" };
  if (!isObject(body.policy)) return { ok: false, error: "policy is required" };
  if (!isObject(body.intent)) return { ok: false, error: "intent is required" };
  const policyError = validateTreasuryPolicy(body.policy);
  if (policyError) return { ok: false, error: policyError };
  const intentError = validateTreasuryIntent(body.intent);
  if (intentError) return { ok: false, error: intentError };
  return {
    ok: true,
    policy: body.policy as unknown as TreasuryPolicyV1,
    intent: body.intent as unknown as TreasuryIntentV1,
  };
}

export function validateTreasuryExecuteRequest(body: unknown): {
  ok: boolean;
  request?: TreasuryExecuteRequestV1;
  error?: string;
} {
  if (!isObject(body)) return { ok: false, error: "request body must be an object" };
  if (containsTreasuryPlaintextLeak(body)) {
    return {
      ok: false,
      error: "request must not contain plaintext balances, payroll details, counterparties, portfolio, or strategy",
    };
  }
  if (body.version !== 1) return { ok: false, error: "version must be 1" };
  for (const key of [
    "intent_id",
    "owner_did",
    "policy_hash",
    "proposal_hash",
    "approval_hash",
    "approval_expires_at",
  ] as const) {
    if (typeof body[key] !== "string" || !body[key].trim()) {
      return { ok: false, error: `${key} is required` };
    }
  }
  if (!isPositiveNumber(body.amount_micro_usd)) {
    return { ok: false, error: "amount_micro_usd must be positive" };
  }
  if (!Array.isArray(body.rails) || body.rails.length === 0) {
    return { ok: false, error: "rails must be a non-empty array" };
  }
  if (!body.rails.every(isTreasuryRailKind)) {
    return { ok: false, error: "rails contains an unsupported rail" };
  }
  const approvalError = validateTreasuryApprovalFields({
    ownerDid: body.owner_did,
    policyHash: body.policy_hash,
    proposalHash: body.proposal_hash,
    approvalHash: body.approval_hash,
    approvalExpiresAt: body.approval_expires_at,
    amountMicroUsd: body.amount_micro_usd,
    rails: body.rails,
    now: new Date(),
  });
  if (approvalError) return { ok: false, error: approvalError };
  const bundleError = validateEncryptedBundle(body.encrypted_context_bundle);
  if (bundleError) return { ok: false, error: bundleError };
  return { ok: true, request: body as unknown as TreasuryExecuteRequestV1 };
}

export function treasuryExecutionStatus(input: {
  supportedRails?: TreasuryRailKind[];
  partnerRailReady?: boolean;
  sealedProviderReady?: boolean;
} = {}): TreasuryExecutionStatusV1 {
  const supportedRails = input.supportedRails?.length ? input.supportedRails : TREASURY_RAILS;
  const partnerRailReady = input.partnerRailReady ?? true;
  const sealedProviderReady = input.sealedProviderReady ?? true;
  const blockingReasons = [
    partnerRailReady ? null : "partner_rail_unavailable",
    sealedProviderReady ? null : "sealed_provider_unavailable",
  ].filter((item): item is string => Boolean(item));
  return {
    version: 1,
    ready: blockingReasons.length === 0,
    supported_rails: supportedRails,
    partner_rail_ready: partnerRailReady,
    sealed_provider_ready: sealedProviderReady,
    blocking_reasons: blockingReasons,
  };
}

export function buildTreasuryExecutionReceipt(input: {
  request: TreasuryExecuteRequestV1;
  agentId: string;
  providerId?: string;
  partnerRefs?: string[];
  signingSecret: string;
  now?: Date;
}): TreasuryExecutionReceiptV1 {
  const unsigned = {
    version: 1 as const,
    receipt_id: randomId("tex"),
    intent_id: input.request.intent_id,
    owner_did: input.request.owner_did,
    agent_id: input.agentId,
    policy_hash: input.request.policy_hash,
    proposal_hash: input.request.proposal_hash,
    approval_hash: input.request.approval_hash,
    approval_expires_at: input.request.approval_expires_at,
    amount_micro_usd: input.request.amount_micro_usd,
    rails: input.request.rails,
    provider_id: input.providerId ?? DEFAULT_TREASURY_PROVIDER_ID,
    partner_refs:
      input.partnerRefs ??
      input.request.rails.map((rail) => `partner:${rail}:${input.request.intent_id}`),
    reconciliation_state: "submitted" as const,
    executed_at: (input.now ?? new Date()).toISOString(),
    public_fallback_used: false as const,
  };
  return {
    ...unsigned,
    signature: signTreasuryExecutionReceipt(unsigned, input.signingSecret),
  };
}

export function signTreasuryExecutionReceipt(
  receipt: Omit<TreasuryExecutionReceiptV1, "signature">,
  secret: string,
): string {
  return bytesToHex(
    hmac(
      sha256,
      new TextEncoder().encode(secret),
      new TextEncoder().encode(stableJson(receipt)),
    ),
  );
}

export function verifyTreasuryExecutionReceiptSignature(
  receipt: TreasuryExecutionReceiptV1,
  secret: string,
): boolean {
  const { signature, ...unsigned } = receipt;
  return signature === signTreasuryExecutionReceipt(unsigned, secret);
}

export function buildTreasuryApproval(input: {
  ownerDid: string;
  policyHash: string;
  proposalHash: string;
  amountMicroUsd: number;
  rails: TreasuryRailKind[];
  expiresAt: string;
}): TreasuryApprovalV1 {
  return {
    version: 1,
    approval_hash: buildTreasuryApprovalHash(input),
    expires_at: input.expiresAt,
    scope: "treasury_proposal",
  };
}

export function buildTreasuryApprovalHash(input: {
  ownerDid: string;
  policyHash: string;
  proposalHash: string;
  amountMicroUsd: number;
  rails: TreasuryRailKind[];
  expiresAt: string;
}): string {
  return hashTreasuryValue({
    version: 1,
    scope: "treasury_proposal",
    owner_did: input.ownerDid,
    policy_hash: input.policyHash,
    proposal_hash: input.proposalHash,
    amount_micro_usd: input.amountMicroUsd,
    rails: [...input.rails].sort(),
    expires_at: input.expiresAt,
  });
}

export function validateTreasuryApprovalFields(input: {
  ownerDid: unknown;
  policyHash: unknown;
  proposalHash: unknown;
  approvalHash: unknown;
  approvalExpiresAt: unknown;
  amountMicroUsd: unknown;
  rails: unknown;
  now?: Date;
}): string | null {
  if (typeof input.approvalExpiresAt !== "string" || !input.approvalExpiresAt.trim()) {
    return "approval_expires_at is required";
  }
  const expiresAtMs = new Date(input.approvalExpiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return "approval_expires_at is invalid";
  if (expiresAtMs <= (input.now ?? new Date()).getTime()) {
    return "approval_hash has expired";
  }
  if (
    typeof input.ownerDid !== "string" ||
    typeof input.policyHash !== "string" ||
    typeof input.proposalHash !== "string" ||
    typeof input.approvalHash !== "string" ||
    !isPositiveNumber(input.amountMicroUsd) ||
    !isTreasuryRailArray(input.rails)
  ) {
    return "approval fields are invalid";
  }
  const expected = buildTreasuryApprovalHash({
    ownerDid: input.ownerDid,
    policyHash: input.policyHash,
    proposalHash: input.proposalHash,
    amountMicroUsd: input.amountMicroUsd,
    rails: input.rails,
    expiresAt: input.approvalExpiresAt,
  });
  return input.approvalHash === expected ? null : "approval_hash does not match proposal scope";
}

export function createMockTreasuryAdapters(
  providerId = DEFAULT_TREASURY_PROVIDER_ID,
): Map<TreasuryRailKind, TreasuryPartnerAdapter> {
  return new Map(
    TREASURY_RAILS.map((rail) => [
      rail,
      {
        rail,
        prepare: (input) => ({
          version: 1,
          rail,
          instruction_ref: `mock-prepare:${providerId}:${rail}:${input.request.intent_id}`,
          provider_id: providerId,
          redacted: true,
        }),
        submit: (input) => ({
          version: 1,
          rail,
          partner_ref: `mock-submit:${providerId}:${rail}:${input.request.intent_id}`,
          provider_id: providerId,
          reconciliation_state: "submitted",
        }),
        reconcile: (input) => ({
          version: 1,
          rail,
          partner_ref: input.partner_ref,
          reconciliation_state: "submitted",
        }),
        cancel: (input) => ({
          version: 1,
          rail,
          partner_ref: input.partner_ref,
          reconciliation_state: "cancelled",
        }),
      } satisfies TreasuryPartnerAdapter,
    ]),
  );
}

export function createHttpTreasuryAdapter(
  config: TreasuryHttpPartnerAdapterConfig,
): TreasuryPartnerAdapter {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 15_000;
  return {
    rail: config.rail,
    prepare: async (input) => {
      const response = await callTreasuryPartner<TreasuryPartnerPreparedInstructionV1>({
        endpoint,
        action: "prepare",
        rail: config.rail,
        apiKey: config.apiKey,
        timeoutMs,
        body: redactedPartnerPayload(input, config.rail),
      });
      return {
        version: 1,
        rail: config.rail,
        instruction_ref: response.instruction_ref,
        provider_id: response.provider_id || input.provider_id,
        redacted: true,
      };
    },
    submit: async (input) => {
      const response = await callTreasuryPartner<TreasuryPartnerSubmissionV1>({
        endpoint,
        action: "submit",
        rail: config.rail,
        apiKey: config.apiKey,
        timeoutMs,
        body: redactedPartnerPayload(input, config.rail),
      });
      return {
        version: 1,
        rail: config.rail,
        partner_ref: response.partner_ref,
        provider_id: response.provider_id || input.provider_id,
        reconciliation_state: "submitted",
      };
    },
    reconcile: async (input) => {
      const response = await callTreasuryPartner<TreasuryPartnerReconciliationV1>({
        endpoint,
        action: "reconcile",
        rail: config.rail,
        apiKey: config.apiKey,
        timeoutMs,
        body: {
          version: 1,
          rail: config.rail,
          partner_ref: input.partner_ref,
          provider_id: input.provider_id,
        },
      });
      return {
        version: 1,
        rail: config.rail,
        partner_ref: response.partner_ref || input.partner_ref,
        reconciliation_state: response.reconciliation_state || "submitted",
      };
    },
    cancel: async (input) => {
      const response = await callTreasuryPartner<TreasuryPartnerReconciliationV1>({
        endpoint,
        action: "cancel",
        rail: config.rail,
        apiKey: config.apiKey,
        timeoutMs,
        body: {
          version: 1,
          rail: config.rail,
          partner_ref: input.partner_ref,
          provider_id: input.provider_id,
        },
      });
      return {
        version: 1,
        rail: config.rail,
        partner_ref: response.partner_ref || input.partner_ref,
        reconciliation_state: response.reconciliation_state || "cancelled",
      };
    },
  };
}

export async function submitTreasuryExecutionToAdapters(input: {
  request: TreasuryExecuteRequestV1;
  providerId?: string;
  adapters?: Map<TreasuryRailKind, TreasuryPartnerAdapter>;
}): Promise<{
  prepared: TreasuryPartnerPreparedInstructionV1[];
  submissions: TreasuryPartnerSubmissionV1[];
  partner_refs: string[];
}> {
  const providerId = input.providerId ?? DEFAULT_TREASURY_PROVIDER_ID;
  const adapters = input.adapters ?? createMockTreasuryAdapters(providerId);
  const prepared: TreasuryPartnerPreparedInstructionV1[] = [];
  const submissions: TreasuryPartnerSubmissionV1[] = [];
  for (const rail of input.request.rails) {
    const adapter = adapters.get(rail);
    if (!adapter) throw new Error(`missing treasury adapter for ${rail}`);
    prepared.push(await adapter.prepare({ request: input.request, provider_id: providerId }));
    submissions.push(await adapter.submit({ request: input.request, provider_id: providerId }));
  }
  return {
    prepared,
    submissions,
    partner_refs: submissions.map((submission) => submission.partner_ref),
  };
}

export async function reconcileTreasuryPartnerRefs(input: {
  submissions: TreasuryPartnerSubmissionV1[];
  providerId?: string;
  adapters?: Map<TreasuryRailKind, TreasuryPartnerAdapter>;
}): Promise<TreasuryPartnerReconciliationV1[]> {
  const providerId = input.providerId ?? DEFAULT_TREASURY_PROVIDER_ID;
  const adapters = input.adapters ?? createMockTreasuryAdapters(providerId);
  const results: TreasuryPartnerReconciliationV1[] = [];
  for (const submission of input.submissions) {
    const adapter = adapters.get(submission.rail);
    if (!adapter) throw new Error(`missing treasury adapter for ${submission.rail}`);
    results.push(
      await adapter.reconcile({
        partner_ref: submission.partner_ref,
        provider_id: providerId,
      }),
    );
  }
  return results;
}

export async function cancelTreasuryPartnerRefs(input: {
  submissions: TreasuryPartnerSubmissionV1[];
  providerId?: string;
  adapters?: Map<TreasuryRailKind, TreasuryPartnerAdapter>;
}): Promise<TreasuryPartnerReconciliationV1[]> {
  const providerId = input.providerId ?? DEFAULT_TREASURY_PROVIDER_ID;
  const adapters = input.adapters ?? createMockTreasuryAdapters(providerId);
  const results: TreasuryPartnerReconciliationV1[] = [];
  for (const submission of input.submissions) {
    const adapter = adapters.get(submission.rail);
    if (!adapter) throw new Error(`missing treasury adapter for ${submission.rail}`);
    results.push(
      await adapter.cancel({
        partner_ref: submission.partner_ref,
        provider_id: providerId,
      }),
    );
  }
  return results;
}

export function hashTreasuryValue(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(stableJson(value))));
}

function routeTreasuryIntent(
  policy: TreasuryPolicyV1,
  intent: TreasuryIntentV1,
  amount: number,
): TreasuryRouteCandidateV1[] {
  if (!isPositiveNumber(amount)) return [];
  const allowedRails = allowedRailsForPolicy(policy).filter((rail) =>
    intent.constraints.approved_rails.includes(rail),
  );
  const partnerId = policy.allowed_partners[0] ?? "mock_treasury_partner";
  const routes: TreasuryRouteCandidateV1[] = [];
  const bankCap = capByBps(amount, intent.constraints.max_single_bank_exposure_bps);
  const stablecoinCap = capByBps(
    amount,
    intent.constraints.max_stablecoin_issuer_exposure_bps,
  );
  const operatingTarget = Math.min(
    amount,
    intent.constraints.min_operating_cash_micro_usd,
  );
  const bankCashAmount = Math.min(operatingTarget, bankCap || operatingTarget);

  if (bankCashAmount > 0 && allowedRails.includes("bank_cash")) {
    const riskFlags = bankCashAmount >= bankCap && bankCap > 0 ? ["single_bank_cap"] : [];
    routes.push({
      version: 1,
      route_id: "route_operating_cash",
      rail: "bank_cash",
      action: "reserve_operating_cash",
      asset: "USD",
      amount_micro_usd: bankCashAmount,
      partner_id: partnerId,
      settlement_eta: "instant",
      liquidity_class: "instant",
      leakage_score_bps: 20,
      route_score_bps: 100,
      score_components: {
        yield_bps: 0,
        liquidity_bps: 120,
        leakage_penalty_bps: 20,
        risk_penalty_bps: 0,
        duration_penalty_bps: 0,
      },
      privacy: "private_context_partner_instruction",
      risk_flags: riskFlags,
    });
  }

  const reserveShortfall = Math.max(0, operatingTarget - bankCashAmount);
  if (reserveShortfall > 0 && allowedRails.includes("broker_cash_sweep")) {
    routes.push({
      version: 1,
      route_id: "route_broker_sweep_reserve",
      rail: "broker_cash_sweep",
      action: "sweep_broker_cash",
      asset: "BROKER_SWEEP",
      amount_micro_usd: reserveShortfall,
      partner_id: partnerId,
      settlement_eta: "same_day",
      liquidity_class: "same_day",
      expected_yield_bps: 425,
      leakage_score_bps: 25,
      route_score_bps: 440,
      score_components: {
        yield_bps: 425,
        liquidity_bps: 80,
        leakage_penalty_bps: 25,
        risk_penalty_bps: 40,
        duration_penalty_bps: 0,
      },
      privacy: "private_context_partner_instruction",
      risk_flags: ["broker_custody"],
    });
  }

  const instantTarget = Math.min(
    amount,
    Math.max(
      intent.constraints.min_instant_liquidity_micro_usd,
      intent.constraints.min_operating_cash_micro_usd,
    ),
  );
  const currentInstant = sumRouteAmounts(routes, [
    "reserve_operating_cash",
    "sweep_broker_cash",
    "hold_stablecoin_buffer",
  ]);
  const instantShortfall = Math.max(0, instantTarget - currentInstant);
  const stablecoinAmount = Math.min(instantShortfall, stablecoinCap || instantShortfall);

  if (stablecoinAmount > 0) {
    const shielded = allowedRails.includes("stablecoin_shielded");
    const publicStable = allowedRails.includes("stablecoin_public");
    if (shielded || publicStable) {
      const leakageScore = shielded ? 35 : 80;
      routes.push({
        version: 1,
        route_id: "route_stablecoin_buffer",
        rail: shielded ? "stablecoin_shielded" : "stablecoin_public",
        action: "hold_stablecoin_buffer",
        asset: policy.allowed_assets.includes("USDC") ? "USDC" : "USDT",
        amount_micro_usd: stablecoinAmount,
        partner_id: partnerId,
        settlement_eta: shielded ? "same_day" : "instant",
        liquidity_class: "instant",
        expected_yield_bps: 0,
        leakage_score_bps: leakageScore,
        route_score_bps: shielded ? 45 : -30,
        score_components: {
          yield_bps: 0,
          liquidity_bps: 120,
          leakage_penalty_bps: leakageScore,
          risk_penalty_bps: shielded ? 40 : 70,
          duration_penalty_bps: 0,
        },
        privacy: shielded
          ? "shielded_settlement_subject_to_timing"
          : "public_settlement_amount_timing_visible",
        risk_flags: shielded ? ["shielded_pool_liquidity"] : ["public_amount_timing"],
      });
    }
  }

  const allocated = routes.reduce((sum, route) => sum + route.amount_micro_usd, 0);
  const remaining = Math.max(0, amount - allocated);
  if (remaining > 0) {
    const useTbills = allowedRails.includes("treasury_bills");
    const useBonds = !useTbills && allowedRails.includes("bond_ladder");
    const useSweep = !useTbills && !useBonds && allowedRails.includes("broker_cash_sweep");
    if (useTbills || useBonds || useSweep) {
      const routeScore = useTbills ? 450 : useBonds ? 245 : 440;
      routes.push({
        version: 1,
        route_id: useTbills
          ? "route_t_bill_ladder"
          : useBonds
            ? "route_bond_ladder"
            : "route_broker_sweep_idle",
        rail: useTbills
          ? "treasury_bills"
          : useBonds
            ? "bond_ladder"
            : "broker_cash_sweep",
        action: useTbills
          ? "ladder_t_bills"
          : useBonds
            ? "ladder_bonds"
            : "sweep_broker_cash",
        asset: useTbills ? "T_BILL" : useBonds ? "BOND_FUND" : "BROKER_SWEEP",
        amount_micro_usd: remaining,
        partner_id: partnerId,
        settlement_eta: "next_day",
        liquidity_class: useSweep ? "same_day" : "term",
        max_duration_days: useSweep
          ? undefined
          : Math.min(intent.horizon_days, intent.constraints.max_duration_days),
        expected_yield_bps: useTbills ? 480 : useBonds ? 430 : 425,
        leakage_score_bps: useTbills ? 30 : useBonds ? 45 : 25,
        route_score_bps: routeScore,
        score_components: {
          yield_bps: useTbills ? 480 : useBonds ? 430 : 425,
          liquidity_bps: useSweep ? 80 : useTbills ? 20 : 10,
          leakage_penalty_bps: useTbills ? 30 : useBonds ? 45 : 25,
          risk_penalty_bps: useTbills ? 20 : useBonds ? 120 : 40,
          duration_penalty_bps: useSweep ? 0 : useTbills ? 0 : 30,
        },
        privacy: "private_context_partner_instruction",
        risk_flags: useBonds ? ["duration_risk", "credit_risk"] : [],
      });
    }
  }

  if (
    intent.objective === "fund_payment_schedule" &&
    routes.length > 0 &&
    ["ach", "wire", "rtp"].some((rail) => allowedRails.includes(rail as TreasuryRailKind))
  ) {
    const rail = (["rtp", "ach", "wire"] as TreasuryRailKind[]).find((item) =>
      allowedRails.includes(item),
    ) as "rtp" | "ach" | "wire";
    const leakageScore = rail === "wire" ? 70 : 55;
    routes.push({
      version: 1,
      route_id: "route_payment_buffer",
      rail,
      action: "prepare_payment_buffer",
      asset: "USD",
      amount_micro_usd: 0,
      partner_id: partnerId,
      settlement_eta: rail === "ach" ? "next_day" : "same_day",
      liquidity_class: "scheduled",
      leakage_score_bps: leakageScore,
      route_score_bps: rail === "wire" ? -40 : -25,
      score_components: {
        yield_bps: 0,
        liquidity_bps: 60,
        leakage_penalty_bps: leakageScore,
        risk_penalty_bps: 30,
        duration_penalty_bps: 0,
      },
      privacy: "private_context_partner_instruction",
      risk_flags: ["counterparty_hidden_in_sealed_bundle"],
    });
  }

  return routes;
}

function allowedRailsForPolicy(policy: TreasuryPolicyV1): TreasuryRailKind[] {
  if (policy.allowed_rails?.length) return policy.allowed_rails;
  const rails = new Set<TreasuryRailKind>(policy.allowed_payment_rails);
  if (policy.allowed_assets.includes("USD")) rails.add("bank_cash");
  if (policy.allowed_assets.includes("T_BILL")) rails.add("treasury_bills");
  if (policy.allowed_assets.includes("BOND_FUND")) rails.add("bond_ladder");
  if (policy.allowed_assets.includes("BROKER_SWEEP")) rails.add("broker_cash_sweep");
  if (policy.allowed_assets.includes("USDC") || policy.allowed_assets.includes("USDT")) {
    rails.add("stablecoin_public");
    rails.add("stablecoin_shielded");
  }
  return Array.from(rails);
}

function validateTreasuryPolicy(policy: Record<string, unknown>): string | null {
  if (policy.version !== 1) return "policy.version must be 1";
  for (const key of ["policy_id", "owner_did"] as const) {
    if (typeof policy[key] !== "string" || !policy[key].trim()) return `policy.${key} is required`;
  }
  if (!isTreasuryAssetArray(policy.allowed_assets)) {
    return "policy.allowed_assets must contain supported assets";
  }
  if (!isTreasuryRailArray(policy.allowed_payment_rails)) {
    return "policy.allowed_payment_rails must contain supported rails";
  }
  if (
    policy.allowed_rails !== undefined &&
    !isTreasuryRailArray(policy.allowed_rails)
  ) {
    return "policy.allowed_rails must contain supported rails";
  }
  if (!isStringArray(policy.allowed_partners) || policy.allowed_partners.length === 0) {
    return "policy.allowed_partners must be a non-empty array";
  }
  for (const key of [
    "max_action_micro_usd",
    "daily_action_micro_usd",
    "approval_required_above_micro_usd",
  ] as const) {
    if (!isPositiveNumber(policy[key])) return `policy.${key} must be positive`;
  }
  if (policy.public_fallback_allowed !== false) {
    return "policy.public_fallback_allowed must be false";
  }
  return null;
}

function validateTreasuryIntent(intent: Record<string, unknown>): string | null {
  if (intent.version !== 1) return "intent.version must be 1";
  for (const key of ["intent_id", "owner_did", "objective"] as const) {
    if (typeof intent[key] !== "string" || !intent[key].trim()) return `intent.${key} is required`;
  }
  if (!isTreasuryObjective(intent.objective)) return "intent.objective is unsupported";
  if (!isPositiveNumber(intent.horizon_days)) return "intent.horizon_days must be positive";
  if (
    intent.amount_micro_usd !== undefined &&
    !isPositiveNumber(intent.amount_micro_usd)
  ) {
    return "intent.amount_micro_usd must be positive";
  }
  if (!isObject(intent.constraints)) return "intent.constraints is required";
  const constraints = intent.constraints;
  for (const key of [
    "min_operating_cash_micro_usd",
    "min_instant_liquidity_micro_usd",
    "min_runway_months",
    "max_single_bank_exposure_bps",
    "max_stablecoin_issuer_exposure_bps",
    "max_duration_days",
    "approval_required_above_micro_usd",
  ] as const) {
    if (!isPositiveNumber(constraints[key])) return `intent.constraints.${key} must be positive`;
  }
  if (!isTreasuryRailArray(constraints.approved_rails)) {
    return "intent.constraints.approved_rails must contain supported rails";
  }
  if (constraints.public_fallback_allowed !== false) {
    return "intent.constraints.public_fallback_allowed must be false";
  }
  const bundleError = validateEncryptedBundle(intent.encrypted_context_bundle);
  if (bundleError) return `intent.${bundleError}`;
  return null;
}

function validateEncryptedBundle(value: unknown): string | null {
  if (!isObject(value)) return "encrypted_context_bundle is required";
  if (
    value.alg !== "sealed-provider-v1" &&
    value.alg !== "hpke-x25519-aes256gcm"
  ) {
    return "encrypted_context_bundle.alg is unsupported";
  }
  for (const key of ["ciphertext", "recipient", "aad"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) {
      return `encrypted_context_bundle.${key} is required`;
    }
  }
  return null;
}

function sumRouteAmounts(
  routes: TreasuryRouteCandidateV1[],
  actions: TreasuryRouteAction[],
): number {
  return routes
    .filter((route) => actions.includes(route.action))
    .reduce((sum, route) => sum + route.amount_micro_usd, 0);
}

function capByBps(amount: number, bps: number): number {
  if (!isPositiveNumber(bps)) return amount;
  return Math.floor((amount * bps) / 10_000);
}

function redactedPartnerPayload(
  input: TreasuryPartnerAdapterInput,
  rail: TreasuryRailKind,
) {
  return {
    version: 1,
    rail,
    provider_id: input.provider_id,
    intent_id: input.request.intent_id,
    owner_did: input.request.owner_did,
    policy_hash: input.request.policy_hash,
    proposal_hash: input.request.proposal_hash,
    approval_hash: input.request.approval_hash,
    approval_expires_at: input.request.approval_expires_at,
    amount_micro_usd: input.request.amount_micro_usd,
    encrypted_context_bundle: input.request.encrypted_context_bundle,
  };
}

async function callTreasuryPartner<T>(input: {
  endpoint: string;
  action: "prepare" | "submit" | "reconcile" | "cancel";
  rail: TreasuryRailKind;
  apiKey?: string;
  timeoutMs: number;
  body: unknown;
}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Ghola-Treasury-Rail": input.rail,
    };
    if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
    const response = await fetch(`${input.endpoint}/${input.action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `treasury partner ${input.action} failed for ${input.rail}: HTTP ${response.status}${text ? ` ${text}` : ""}`,
      );
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

function isTreasuryObjective(value: unknown): value is TreasuryIntentObjective {
  return (
    value === "maintain_runway" ||
    value === "optimize_idle_cash" ||
    value === "fund_payment_schedule" ||
    value === "rebalance_treasury_risk"
  );
}

function isTreasuryRailKind(value: unknown): value is TreasuryRailKind {
  return typeof value === "string" && TREASURY_RAILS.includes(value as TreasuryRailKind);
}

function isTreasuryRailArray(value: unknown): value is TreasuryRailKind[] {
  return Array.isArray(value) && value.length > 0 && value.every(isTreasuryRailKind);
}

function isTreasuryAssetArray(value: unknown): value is TreasuryAsset[] {
  const assets: TreasuryAsset[] = [
    "USD",
    "USDC",
    "USDT",
    "T_BILL",
    "BOND_FUND",
    "BROKER_SWEEP",
  ];
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => assets.includes(item as TreasuryAsset))
  );
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
