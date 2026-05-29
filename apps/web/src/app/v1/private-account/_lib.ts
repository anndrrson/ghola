import { NextResponse } from "next/server";
import {
  fetchSessionUser,
  SESSION_COOKIE_NAME,
  userFromToken,
  type SessionUser,
} from "@/app/api/auth/session/_lib";
import {
  approvePrivateAccountAction,
  buildPrivateAccountReceipt,
  canApprovePreview,
  canExecutePrivateAccountAction,
  containsForbiddenPublicPrivateAccountField,
  createHyperliquidExecutionVault,
  createHyperliquidManagedAllocation,
  createHyperliquidSessionPolicy,
  createOmnibusAllocation,
  createPooledVenueAllocation,
  createPrivateAccountAction,
  createPrivateExecutionAccount,
  createSecretHandle,
  createStealthVenueAccount,
  createVenueExecutionVault,
  createVenueSessionPolicy,
  getPlatformPrivacyProfile,
  getVenueManifest,
  gholaCommitment,
  isPrivateModeAvailableStatus,
  isPrivateAccountRecordExpired,
  assertPublicSafePrivateAccountArtifact,
  listPlatformPrivacyProfiles,
  listVenueManifests,
  PRIVATE_ACCOUNT_INTENT_TTL_MS,
  previewPrivateAccountAction,
  venueIdForPlatformClass,
  DEFAULT_ANONYMITY_SET_POLICY,
  type GholaAnonymitySetSummary,
  type GholaPrivateModeEvidenceChain,
  type GholaPrivateModeEvidenceStatus,
  type GholaPrivateExecutionPlan,
  type GholaReceiptVerificationResult,
  type GholaConnectorPreviewContext,
  type GholaAdversarialLinkabilitySimulation,
  type GholaAuctionOrderSide,
  type GholaPlatformClass,
  type GholaPlatformFundingRotation,
  type GholaPrivateAccountActionClass,
  type GholaPrivacyPreview,
  type GholaPrivacyScheduleDecision,
  type GholaRailKind,
  type GholaSealedRuntimeContext,
  type GholaHyperliquidSessionPolicy,
  type GholaHyperliquidManagedAllocation,
  type GholaOmnibusAllocation,
  type GholaVenueAccountMode,
  type GholaVenueExecutionMode,
  type GholaVenueId,
  type GholaVenueSessionPolicy,
} from "@/lib/private-account";
import {
  buildConnectorWorkOrder,
  compilePrivateConnectorIntent,
  connectorPreviewContext,
  connectorReadiness,
  connectorSandboxPolicy,
  getConnectorManifest,
  listConnectorManifests,
  publicConnectorManifest,
  reconcileConnectorResult,
  scoreConnectorLinkability,
  submitConnectorWorkOrder,
  verifyConnectorNoSubmit,
  type ConnectorSafeIntentInput,
  type GholaCompiledPrivateIntent,
  type GholaConnectorManifest,
  type GholaConnectorReadiness,
  type GholaConnectorResult,
  type GholaConnectorWorkOrder,
  type GholaLinkabilityScore,
} from "@/lib/private-account-connectors";
import {
  adversarialLinkabilitySimulation,
  createPrivateReceiptExport,
  createRuntimeEnvelope,
  createViewKey,
  platformFundingRotation,
  privacyScheduleDecision,
  revokePrivateReceiptExport,
  sealedRuntimeContext,
  sealedRuntimeHealth,
  v6ProductionGateStatus,
  type GholaPrivateReceiptExport,
  type GholaRuntimeEnvelope,
  type GholaRuntimeHealth,
  type GholaViewKey,
} from "@/lib/private-account-runtime";
import {
  buildPrivateExecutionPlan,
  refreshShieldedSettlementEvidence,
  settlePrivateExecutionPlan,
} from "@/lib/private-account-execution-plan";
import {
  privateAccountReadiness,
  type PrivateAccountReadinessResponse,
} from "@/lib/private-account-readiness";
import {
  institutionalAuctionOnChainPrepareRequired,
  institutionalAuctionReadinessStatus,
} from "@/lib/private-account-auction-production";
import {
  consumePrivateAccountApproval,
  consumePrivateExecutionPlan,
  consumePrivateAccountPreview,
  getPrivateAccountApproval,
  getPrivateAccountExecutionByApproval,
  getPrivateExecutionPlan,
  getPrivateExecutionPlanByPreview,
  getPrivateAccountIntent,
  getPrivateAccountPreview,
  getPrivateAccountReceipt,
  getPrivateAccountReceiptByIntent,
  getPrivateSettlement,
  getPrivateSettlementByExecution,
  getPrivateAuctionClearing,
  getPrivateAuctionClearingByEpoch,
  getPrivateAuctionEpoch,
  getPrivateAuctionOrderByQueue,
  getPrivateAuctionPreparedTransaction,
  getOpenPrivateAuctionEpoch,
  listPrivateModeCanaries,
  getCompiledIntent,
  getConnectorManifestRecord,
  getConnectorResult,
  getConnectorResultByWorkOrder,
  getConnectorWorkOrder,
  getConnectorWorkOrderByPreview,
  getRuntimeEnvelope,
  getRuntimeEnvelopeByIntent,
  getPlatformRotation,
  getLinkabilitySimulation,
  getScheduleDecision,
  getViewKey,
  getPrivateReceiptExport,
  getLinkabilityScore,
  getPrivateAccountByOwner,
  getPrivateAccountByCommitment,
  getPrivateVaultState,
  getHyperliquidExecutionVaultByAccount,
  getHyperliquidManagedAllocationByAccount,
  getOmnibusAllocation,
  getOmnibusAllocationByAccount,
  getVenueExecutionVaultByAccount,
  getLatestPooledVenueAllocationByAccount,
  getLatestStealthVenueAccountByAccount,
  getLatestVenueSecretHandleByAccount,
  getVenueSecretHandle,
  getLatestAnonymityEvidence,
  getPrivateFundingBatchByEvidence,
  getPrivacyBudget,
  getQueuedAction,
  getPrivateFundingImportByNullifier,
  getPrivateFundingInstruction,
  listAllPrivateFundingImports,
  listPrivateFundingBatches,
  listPrivateFundingImports,
  listPrivateFundingInstructions,
  listPrivateAuctionClearings,
  listPrivateAuctionEpochs,
  listPrivateAuctionOrders,
  listPrivateAuctionOrdersByEpoch,
  listPrivateSettlements,
  listConnectorResults,
  listConnectorWorkOrders,
  listLinkabilitySimulations,
  listLinkabilityScores,
  listPlatformRotations,
  listQueuedActions,
  listPrivateAccountReceipts,
  putPrivateAccountRecord,
  putPrivateAccountApproval,
  putPrivateAccountExecution,
  putPrivateExecutionPlan,
  putPrivateSettlement,
  putCompiledIntent,
  putConnectorManifest,
  putConnectorResult,
  putConnectorWorkOrder,
  putLinkabilityScore,
  putLinkabilitySimulation,
  putPlatformRotation,
  putPrivateReceiptExport,
  putPrivateReceiptExportRevocation,
  putRuntimeEnvelope,
  putRuntimeHealth,
  putScheduleDecision,
  putViewKey,
  putPrivateAccountIntent,
  putPrivateAccountPreview,
  putPrivateAccountReceipt,
  putPrivateVaultState,
  putHyperliquidExecutionVault,
  putHyperliquidManagedAllocation,
  putOmnibusAllocation,
  putPooledVenueAllocation,
  putStealthVenueAccount,
  putVenueSecretHandle,
  putVenueExecutionVault,
  putPrivacyBudget,
  putAnonymityEvidence,
  putPrivateFundingImport,
  putPrivateFundingInstruction,
  putPrivateAuctionClearing,
  putPrivateAuctionEpoch,
  putPrivateAuctionOrder,
  putPrivateAuctionPreparedTransaction,
  putQueuedAction,
  recordPrivacyBudgetEvent,
  updatePrivateAccountIntentStatus,
  updateQueuedActionStatus,
  type PrivateAccountIntentRecordV1,
  type PrivateAccountRecordV1,
  type PrivateAnonymityEvidenceRecordV1,
  type PrivateFundingBatchRecordV1,
  type PrivateFundingImportRecordV1,
  type PrivateFundingInstructionRecordV1,
  type PrivateAuctionClearingRecordV1,
  type PrivateAuctionEpochRecordV1,
  type PrivateAuctionOrderRecordV1,
  type PrivateAuctionPreparedTransactionRecordV1,
  type PrivateHyperliquidVaultRecordV1,
  type PrivateHyperliquidManagedAllocationRecordV1,
  type PrivateOmnibusAllocationRecordV1,
  type PrivatePooledVenueAllocationRecordV1,
  type PrivateStealthVenueAccountRecordV1,
  type PrivateVenueSecretHandleRecordV1,
  type PrivateVenueExecutionVaultRecordV1,
  type PrivateExecutionPlanRecordV1,
  type PrivateSettlementRecordV1,
  type PrivateConnectorResultRecordV1,
  type PrivateConnectorWorkOrderRecordV1,
  type PrivateLinkabilityScoreRecordV1,
  type PrivateQueuedActionRecordV1,
  type PrivateVaultStateRecordV1,
} from "@/lib/private-account-store";
import {
  evidenceChainFromBatch,
  privateModeCoordinatorHealth,
  runPrivateFundingBatchCoordinator,
} from "@/lib/private-account-coordinator";
import {
  privateModeCanaryStatus,
  runPrivateModeCanaries,
} from "@/lib/private-account-canary";
import {
  customShieldedVerifierHealth,
  verifyCustomShieldedDepositReceipt,
  verifierConfig,
  type PrivateShieldedVerifierError,
} from "@/lib/private-account-verifier";
import { shieldedPoolHealth } from "@/lib/private-account-shielded-pool";
import {
  AuctionOnChainError,
  prepareAuctionCloseEpochTransaction,
  prepareAuctionCommitOrderTransaction,
  prepareAuctionInitMarketTransaction,
  prepareAuctionOpenEpochTransaction,
  prepareAuctionSettleClearingTransaction,
  verifyAuctionPreparedTransaction,
  type GholaAuctionOnChainOperation,
  type GholaPreparedAuctionTransaction,
} from "@/lib/private-account-auction-onchain";
import { getPrivateAgentRuntimeStatus } from "@/lib/private-agent-runtime-server";
import { providerReadyForPrivateAgents } from "@/lib/private-agent-runtime";
import { enterpriseGateStatus } from "@/lib/enterprise-gate-status";

export const PRIVATE_ACCOUNT_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: PRIVATE_ACCOUNT_HEADERS,
  });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export function rejectForbiddenFields(body: unknown) {
  return containsForbiddenPublicPrivateAccountField(body)
    ? json({ error: "request contains forbidden raw private-account fields" }, 400)
    : null;
}

export function rejectUnsafeArtifact(body: unknown) {
  const safe = assertPublicSafePrivateAccountArtifact(body);
  return safe.ok ? null : json({ error: safe.error }, 500);
}

export interface PrivateAccountRequestOwner {
  user: SessionUser;
  owner_commitment: string;
}

export async function privateAccountOwnerFromRequest(
  req: Request,
): Promise<PrivateAccountRequestOwner | null> {
  const bearer = bearerToken(req);
  const cookieToken = sessionCookie(req);
  const sessionToken = bearer || cookieToken;
  if (sessionToken) {
    if (localPrivateAccountAuthBypassAllowed()) {
      const user = userFromToken(sessionToken);
      if (user) {
        return {
          user,
          owner_commitment: gholaCommitment("owner", user.id),
        };
      }
    }
    try {
      const session = await fetchSessionUser(sessionToken);
      if (session.ok) {
        return {
          user: session.user,
          owner_commitment: gholaCommitment("owner", session.user.id),
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function localPrivateAccountAuthBypassAllowed(): boolean {
  return process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS === "true" &&
    process.env.NODE_ENV !== "production";
}

export function unauthorized() {
  return json({ error: "private_account_auth_required" }, 401);
}

export function internalUnauthorized() {
  return json({ error: "internal_auth_required" }, 401);
}

export function privateAccountInternalAuth(req: Request): boolean {
  const expected = process.env.GHOLA_PRIVATE_ACCOUNT_INTERNAL_TOKEN?.trim();
  if (!expected) return false;
  const bearer = bearerToken(req);
  const headerToken = req.headers.get("x-ghola-internal-token")?.trim() || "";
  return bearer === expected || headerToken === expected;
}

export function privateAccountCronAuth(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret && bearerToken(req) === cronSecret) return true;
  return privateAccountInternalAuth(req);
}

export function privateAccountProducts() {
  return {
    version: 1,
    products: [
      {
        product_id: "ghola_account",
        label: "Ghola Account",
        default_privacy_mode: "private_mode",
        claim_boundary: "engine_gated_full_anonymity",
      },
      {
        product_id: "ghola_control_room",
        label: "Ghola Control Room",
        default_privacy_mode: "private_mode",
        claim_boundary: "engine_gated_full_anonymity",
      },
    ],
  };
}

export function buildAccountFromBody(body: unknown) {
  const value = objectBody(body);
  return createPrivateExecutionAccount({
    sessionId: stringValue(value.session_commitment_seed) || stringValue(value.session_id),
    turnkeyWalletId:
      stringValue(value.turnkey_wallet_commitment_seed) || stringValue(value.turnkey_wallet_id),
    vaultSeed: stringValue(value.vault_commitment_seed),
    policySeed: stringValue(value.policy_commitment_seed),
    platformSeed: stringValue(value.platform_link_seed),
    vaultReady: value.vault_ready === true,
  });
}

export async function createOrGetStoredPrivateAccount(
  owner: PrivateAccountRequestOwner,
): Promise<PrivateAccountRecordV1> {
  const existing = await getPrivateAccountByOwner(owner.owner_commitment);
  if (existing) return existing;
  const now = new Date().toISOString();
  const account = createPrivateExecutionAccount({
    sessionId: owner.owner_commitment,
    turnkeyWalletId: `turnkey:${owner.owner_commitment}`,
    vaultSeed: `vault:${owner.owner_commitment}`,
    policySeed: "private-mode-default",
    platformSeed: `platforms:${owner.owner_commitment}`,
    vaultReady: false,
  });
  const record: PrivateAccountRecordV1 = {
    version: 1,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    session_commitment: account.session_commitment,
    turnkey_wallet_commitment: account.turnkey_wallet_commitment,
    vault_root_commitment: account.vault_root_commitment,
    note_root_commitment: gholaCommitment("note_root", account.vault_root_commitment),
    nullifier_root_commitment: gholaCommitment("nullifier_root", account.vault_root_commitment),
    platform_link_root: account.platform_link_root,
    policy_commitment: account.policy_commitment,
    privacy_mode: "private_mode",
    claim_boundary: account.claim_boundary,
    vault_ready: false,
    account,
    created_at: now,
    updated_at: now,
  };
  await putPrivateAccountRecord(record);
  await putPrivateVaultState({
    version: 1,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    vault_root_commitment: account.vault_root_commitment,
    note_root_commitment: record.note_root_commitment,
    nullifier_root_commitment: record.nullifier_root_commitment,
    balance_bucket_summary: [],
    ready_rails: [],
    last_import_commitment: null,
    created_at: now,
    updated_at: now,
  });
  await putPrivacyBudget({
    version: 1,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    budget: {
      version: 1,
      degraded_action_count: 0,
      repeated_withdrawal_count: 0,
      repeated_cadence_count: 0,
      platform_concentration_bps: 0,
      solver_concentration_bps: 0,
    },
    updated_at: now,
  });
  return record;
}

export async function privateAccountCreateBody(owner: PrivateAccountRequestOwner) {
  const account = await createOrGetStoredPrivateAccount(owner);
  return privateAccountStatusBody(owner, account);
}

export async function privateAccountStatusBody(
  owner: PrivateAccountRequestOwner,
  accountRecord?: PrivateAccountRecordV1,
) {
  const account = accountRecord ?? await createOrGetStoredPrivateAccount(owner);
  const vault = await getPrivateVaultState(account.account_commitment);
  const budget = await getPrivacyBudget(account.account_commitment);
  return {
    version: 1,
    account: publicAccountSummary(account, vault ?? undefined),
    vault: vault ? publicVaultSummary(vault) : null,
    privacy_budget: budget?.budget ?? null,
  };
}

export function buildActionFromBody(body: unknown) {
  const value = objectBody(body);
  const actionClass = stringValue(value.action_class);
  if (!isActionClass(actionClass)) return null;
  return createPrivateAccountAction({
    action_class: actionClass,
    product_bucket: stringValue(value.product_bucket) || "general",
    policy_commitment: stringValue(value.policy_commitment) || undefined,
    intent_seed: value.intent_seed || value.intent_commitment_seed || "commitment-only",
  });
}

export async function createIntentFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const action = buildActionFromBody(body);
  if (!action) return null;
  const now = new Date();
  const accountRecord = await createOrGetStoredPrivateAccount(owner);
  const intentId = `pact_intent_${crypto.randomUUID()}`;
  const record: PrivateAccountIntentRecordV1 = {
    version: 1,
    owner_commitment: owner.owner_commitment,
    intent_id: intentId,
    account_commitment: accountRecord.account_commitment,
    action_commitment: action.action_commitment,
    action_class: action.action_class,
    product_bucket: action.product_bucket,
    policy_commitment: action.policy_commitment,
    intent_commitment: action.intent_commitment,
    status: "created",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + PRIVATE_ACCOUNT_INTENT_TTL_MS).toISOString(),
  };
  await putPrivateAccountIntent(record);
  return {
    version: 1,
    intent_id: intentId,
    action,
    status: record.status,
    expires_at: record.expires_at,
    account_commitment: record.account_commitment,
    vault_ready: accountRecord.vault_ready,
  };
}

export function buildPreviewFromBody(body: unknown) {
  const value = objectBody(body);
  const action = value.action && typeof value.action === "object"
    ? value.action as Record<string, unknown>
    : null;
  const actionClass = stringValue(action?.action_class) || stringValue(value.action_class);
  const platformClass = stringValue(value.platform_class);
  const rail = stringValue(value.requested_rail);
  if (!isActionClass(actionClass) || !isPlatformClass(platformClass)) return null;
  if (rail && !isRailKind(rail)) return null;
  const requestedRail = rail ? rail as GholaRailKind : undefined;
  const actionArtifact = action && stringValue(action.action_commitment)
    ? {
        action_class: actionClass,
        action_commitment: stringValue(action.action_commitment),
        intent_commitment: stringValue(action.intent_commitment) || "intent_missing",
        policy_commitment: stringValue(action.policy_commitment) || "policy_missing",
        product_bucket: stringValue(action.product_bucket) || "general",
      }
    : createPrivateAccountAction({
        action_class: actionClass,
        product_bucket: stringValue(value.product_bucket) || "general",
        intent_seed: value.intent_seed || "preview",
      });
  return previewPrivateAccountAction({
    account: {
      account_commitment: stringValue(value.account_commitment),
      vault_ready: false,
    },
    action: actionArtifact,
    platform_class: platformClass,
    requested_rail: requestedRail,
    actor: value.actor === "institution" ? "institution" : "consumer",
  });
}

export async function createStoredPreviewFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const intentId = stringValue(value.intent_id);
  if (!intentId) return { error: "intent_not_found" as const };
  const intent = await getPrivateAccountIntent(intentId);
  if (!intent) return { error: "intent_not_found" as const };
  if (intent.owner_commitment !== owner.owner_commitment) return { error: "intent_not_found" as const };
  if (intent.status === "executed" || intent.status === "cancelled" || intent.status === "blocked") {
    return { error: `intent_${intent.status}` as const };
  }
  if (isPrivateAccountRecordExpired(intent)) {
    await updatePrivateAccountIntentStatus(intent.intent_id, "expired");
    return { error: "intent_expired" as const };
  }
  const platformClass = stringValue(value.platform_class);
  const rail = stringValue(value.requested_rail);
  if (!isPlatformClass(platformClass)) return { error: "valid action and platform_class are required" as const };
  if (rail && !isRailKind(rail)) return { error: "valid requested_rail is required" as const };
  const account = await createOrGetStoredPrivateAccount(owner);
  if (intent.account_commitment !== account.account_commitment) return { error: "intent_not_found" as const };
  const vault = await getPrivateVaultState(account.account_commitment);
  const budget = await getPrivacyBudget(account.account_commitment);
  const evidence = await getLatestAnonymityEvidence({
    account_commitment: intent.account_commitment,
    action_commitment: intent.action_commitment,
  });
  const evidenceContext = await evidenceContextForPreview({
    preview_commitment: "pending",
    evidence_commitment: evidence?.evidence_commitment ?? null,
  });
  const connectorContext = await connectorContextForIntent({
    owner,
    intent,
    platform_class: platformClass,
    selected_rail: rail ? rail as GholaRailKind : undefined,
    evidence_ready: Boolean(evidenceContext.chain?.batch_evidence_commitment),
    runtime_envelope_commitment: stringValue(value.runtime_envelope_commitment),
    safe_input: safeConnectorInput(value.safe_input),
  });
  if ("error" in connectorContext) return connectorContext;
  const preview = previewPrivateAccountAction({
    account: {
      account_commitment: intent.account_commitment,
      vault_ready: account.vault_ready || Boolean(vault?.ready_rails.length),
    },
    action: {
      action_class: intent.action_class,
      action_commitment: intent.action_commitment,
      intent_commitment: intent.intent_commitment,
      policy_commitment: intent.policy_commitment,
      product_bucket: intent.product_bucket,
    },
    platform_class: platformClass,
    requested_rail: rail ? rail as GholaRailKind : undefined,
    actor: value.actor === "institution" ? "institution" : "consumer",
    anonymity_set: evidence?.anonymity_set,
    privacy_budget: budget?.budget,
    evidence_status: evidenceContext.status,
    evidence_chain: evidenceContext.chain,
    connector_context: connectorContext.context,
    sealed_runtime_context: connectorContext.sealed_runtime_context,
    schedule_decision: connectorContext.schedule_decision,
    rotation: connectorContext.rotation,
    linkability_simulation: connectorContext.linkability_simulation,
    require_private_mode_evidence: true,
  });
  if (preview.evidence_chain) preview.evidence_chain.preview_commitment = preview.preview_commitment;
  const record = await putPrivateAccountPreview({
    version: 1,
    owner_commitment: owner.owner_commitment,
    preview_commitment: preview.preview_commitment,
    intent_id: intent.intent_id,
    account_commitment: preview.account_commitment,
    action_commitment: preview.action_commitment,
    platform_class: preview.platform_class,
    selected_rail: preview.selected_rail,
    claim_status: preview.claim_status,
    anonymity_level: preview.anonymity_level,
    preview,
    created_at: new Date().toISOString(),
    expires_at: preview.expires_at,
    consumed_at: null,
  });
  await updatePrivateAccountIntentStatus(intent.intent_id, "previewed");
  return {
    version: 1,
    intent_id: intent.intent_id,
    preview: record.preview,
    status: "previewed" as const,
  };
}

export async function createStoredExecutionPlanFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const previewCommitment = stringValue(value.preview_commitment);
  if (!previewCommitment) return { error: "preview_not_found" as const };
  const previewRecord = await getPrivateAccountPreview(previewCommitment);
  if (!previewRecord || previewRecord.owner_commitment !== owner.owner_commitment) {
    return { error: "preview_not_found" as const };
  }
  if (isPrivateAccountRecordExpired(previewRecord)) return { error: "preview_expired" as const };
  const intent = await getPrivateAccountIntent(previewRecord.intent_id);
  if (!intent || intent.owner_commitment !== owner.owner_commitment) return { error: "intent_not_found" as const };
  const plan = await buildExecutionPlanForPreview(previewRecord.preview);
  const stored = await putPrivateExecutionPlan({
    version: 1,
    owner_commitment: owner.owner_commitment,
    plan_commitment: plan.plan_commitment,
    intent_id: intent.intent_id,
    preview_commitment: previewRecord.preview_commitment,
    account_commitment: previewRecord.account_commitment,
    action_commitment: previewRecord.action_commitment,
    status: plan.status,
    selected_rail: plan.selected_rail,
    plan,
    created_at: plan.created_at,
    expires_at: plan.expires_at,
    consumed_at: null,
  });
  return {
    version: 1,
    intent_id: intent.intent_id,
    plan: publicExecutionPlan(stored),
  };
}

export function platformProfilesBody() {
  return {
    version: 1,
    profiles: listPlatformPrivacyProfiles(),
  };
}

export function platformStatusBody(body: unknown) {
  const value = objectBody(body);
  const platformClass = stringValue(value.platform_class);
  if (!isPlatformClass(platformClass)) return null;
  const profile = getPlatformPrivacyProfile(platformClass);
  return {
    version: 1,
    platform_class: platformClass,
    connector_readiness_commitment: profile.connector_readiness_commitment,
    privacy_runnable_rails: profile.privacy_runnable_rails,
    degraded_conditions: profile.degraded_conditions,
    blocked_conditions: profile.blocked_conditions,
  };
}

export function approveBody(body: unknown) {
  const value = objectBody(body);
  const previewCommitment = stringValue(value.preview_commitment);
  if (!previewCommitment) return null;
  return approvePrivateAccountAction({
    preview_commitment: previewCommitment,
    degraded_accepted: value.degraded_accepted === true,
  });
}

export async function approveStoredPreviewFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const intentId = stringValue(value.intent_id);
  const previewCommitment = stringValue(value.preview_commitment);
  if (!intentId) return { error: "intent_not_found" as const };
  if (!previewCommitment) return { error: "preview_not_found" as const };
  const intent = await getPrivateAccountIntent(intentId);
  if (!intent) return { error: "intent_not_found" as const };
  if (intent.owner_commitment !== owner.owner_commitment) return { error: "intent_not_found" as const };
  const previewRecord = await getPrivateAccountPreview(previewCommitment);
  if (!previewRecord) return { error: "preview_not_found" as const };
  if (previewRecord.owner_commitment !== owner.owner_commitment) return { error: "preview_not_found" as const };
  if (isPrivateAccountRecordExpired(intent)) return { error: "intent_expired" as const };
  if (isPrivateAccountRecordExpired(previewRecord)) return { error: "preview_expired" as const };
  if (previewRecord.consumed_at) return { error: "preview_already_consumed" as const };
  if (
    previewRecord.intent_id !== intent.intent_id ||
    previewRecord.account_commitment !== intent.account_commitment ||
    previewRecord.action_commitment !== intent.action_commitment
  ) {
    return { error: "preview_mismatch" as const };
  }
  const degradedAccepted = value.degraded_accepted === true;
  const approvalCheck = canApprovePreview(previewRecord.preview, degradedAccepted);
  if (!approvalCheck.ok) return { error: approvalCheck.error };
  const planResult = await planForApproval({
    owner,
    intent,
    preview: previewRecord.preview,
    requested_plan_commitment: stringValue(value.execution_plan_commitment) ||
      stringValue(value.plan_commitment),
  });
  if ("error" in planResult) return planResult;
  const approval = approvePrivateAccountAction({
    preview_commitment: previewCommitment,
    degraded_accepted: degradedAccepted,
  });
  const record = await putPrivateAccountApproval({
    version: 1,
    owner_commitment: owner.owner_commitment,
    approval_commitment: approval.approval_commitment,
    preview_commitment: approval.preview_commitment,
    intent_id: intent.intent_id,
    execution_plan_commitment: planResult.execution_plan_commitment,
    degraded_accepted: approval.degraded_accepted,
    approved_at: approval.approved_at,
    expires_at: previewRecord.expires_at,
    consumed_at: null,
  });
  await updatePrivateAccountIntentStatus(intent.intent_id, "approved");
  return {
    version: 1,
    intent_id: intent.intent_id,
    approval: {
      version: 1,
      approval_commitment: record.approval_commitment,
      preview_commitment: record.preview_commitment,
      execution_plan_commitment: record.execution_plan_commitment,
      degraded_accepted: record.degraded_accepted,
      approved_at: record.approved_at,
      expires_at: record.expires_at,
    },
    status: "approved" as const,
  };
}

export function executeBody(body: unknown) {
  const value = objectBody(body);
  const approvalCommitment = stringValue(value.approval_commitment);
  const preview = value.preview && typeof value.preview === "object"
    ? value.preview as never
    : buildPreviewFromBody(body);
  if (!approvalCommitment || !preview) return null;
  if (preview.claim_status === "blocked_leaky_path") {
    return { error: "blocked_leaky_path", preview };
  }
  if (preview.claim_status === "degraded_user_accepted_required" && value.degraded_accepted !== true) {
    return { error: "degraded acceptance required", preview };
  }
  const executionCommitment = `exec_${preview.preview_commitment.slice(-32)}`;
  return {
    version: 1,
    ok: true,
    execution_commitment: executionCommitment,
    receipt: buildPrivateAccountReceipt({
      preview,
      approval_commitment: approvalCommitment,
      execution_commitment: executionCommitment,
      evidence_chain: preview.evidence_chain,
      secret: process.env.GHOLA_PRIVATE_ACCOUNT_RECEIPT_SECRET,
    }),
  };
}

export async function executeStoredActionFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const intentId = stringValue(value.intent_id);
  const previewCommitment = stringValue(value.preview_commitment);
  const approvalCommitment = stringValue(value.approval_commitment);
  if (!intentId) return { error: "intent_not_found" as const };
  if (!previewCommitment) return { error: "preview_not_found" as const };
  if (!approvalCommitment) return { error: "approval_not_found" as const };
  const existing = await getPrivateAccountExecutionByApproval(approvalCommitment);
  if (existing && existing.owner_commitment === owner.owner_commitment) {
    const receipt = await getPrivateAccountReceipt(existing.receipt_commitment);
    return receipt
      ? {
          version: 1,
          ok: true,
          intent_id: existing.intent_id,
          execution_commitment: existing.execution_commitment,
          receipt: receipt.receipt,
        }
      : { error: "receipt_not_found" as const };
  }
  const intent = await getPrivateAccountIntent(intentId);
  if (!intent) return { error: "intent_not_found" as const };
  if (intent.owner_commitment !== owner.owner_commitment) return { error: "intent_not_found" as const };
  const previewRecord = await getPrivateAccountPreview(previewCommitment);
  if (!previewRecord) return { error: "preview_not_found" as const };
  if (previewRecord.owner_commitment !== owner.owner_commitment) return { error: "preview_not_found" as const };
  const approval = await getPrivateAccountApproval(approvalCommitment);
  if (!approval) return { error: "approval_not_found" as const };
  if (approval.owner_commitment !== owner.owner_commitment) return { error: "approval_not_found" as const };
  if (previewRecord.consumed_at) return { error: "preview_already_consumed" as const };
  if (approval.consumed_at) return { error: "approval_already_consumed" as const };
  const canExecute = canExecutePrivateAccountAction({
    intent,
    preview: previewRecord.preview,
    approval,
  });
  if (!canExecute.ok) return { error: canExecute.error };
  const now = new Date().toISOString();
  const evidenceChain = await evidenceChainForExecution({
    preview: previewRecord.preview,
    approval_commitment: approval.approval_commitment,
  });
  if (isPrivateModeAvailableStatus(previewRecord.claim_status) && !evidenceChain) {
    return { error: "private_mode_evidence_required" as const };
  }
  const planResult = await planForExecution({
    owner,
    intent,
    preview: previewRecord.preview,
    approval,
  });
  if ("error" in planResult) return planResult;
  const executionCommitment = privateActionExecutionCommitment({
    intent_id: intent.intent_id,
    preview_commitment: previewRecord.preview_commitment,
    approval_commitment: approval.approval_commitment,
    evidence_chain: evidenceChain,
    execution_plan_commitment: planResult.plan?.plan_commitment ?? null,
  });
  const settlementResult = await settlementForExecution({
    owner,
    plan: planResult.plan,
    approval_commitment: approval.approval_commitment,
    execution_commitment: executionCommitment,
  });
  if ("error" in settlementResult) return settlementResult;
  const connectorSubmission = await connectorForExecution({
    owner,
    intent,
    preview: previewRecord.preview,
    approval_commitment: approval.approval_commitment,
    execution_plan_commitment: planResult.plan?.plan_commitment ?? null,
    encrypted_execution_instruction_bundle: value.encrypted_execution_instruction_bundle,
  });
  if ("error" in connectorSubmission) return connectorSubmission;
  const boundEvidenceChain = evidenceChain
    ? {
        ...evidenceChain,
        manifest_commitment: previewRecord.preview.connector_context?.manifest_commitment ?? null,
        connector_readiness_commitment: previewRecord.preview.connector_context?.connector_readiness_commitment ?? null,
        compiler_commitment: previewRecord.preview.connector_context?.compiler_commitment ?? null,
        linkability_score_commitment: previewRecord.preview.connector_context?.linkability_score_commitment ?? null,
        work_order_commitment: connectorSubmission.work_order?.work_order_commitment ?? null,
        connector_result_commitment: connectorSubmission.result?.connector_result_commitment ?? null,
        runtime_envelope_commitment: previewRecord.preview.sealed_runtime_context?.runtime_envelope_commitment ?? null,
        runtime_attestation_commitment: previewRecord.preview.sealed_runtime_context?.runtime_attestation_commitment ?? null,
        runtime_health_commitment: previewRecord.preview.sealed_runtime_context?.runtime_health_commitment ?? null,
        schedule_commitment: previewRecord.preview.schedule_decision?.schedule_commitment ?? null,
        rotation_commitment: previewRecord.preview.rotation?.rotation_commitment ?? null,
        simulator_commitment: previewRecord.preview.linkability_simulation?.simulator_commitment ?? null,
        execution_plan_commitment: planResult.plan?.plan_commitment ?? null,
        execution_commitment: executionCommitment,
        settlement_commitment: settlementResult.settlement?.settlement_commitment ?? null,
        root_commitment: settlementResult.settlement?.root_commitment ?? null,
        witness_commitment: settlementResult.settlement?.witness_commitment ?? null,
        proof_commitment: settlementResult.settlement?.proof_commitment ?? null,
        relay_commitment: settlementResult.settlement?.evidence.relay_status.relay_commitment ?? null,
        finality_commitment: settlementResult.settlement?.evidence.finality_commitment ?? null,
        attestation_commitment: settlementResult.settlement?.attestation_commitment ?? null,
      }
    : previewRecord.preview.connector_context
      ? {
          version: 1 as const,
          funding_import_commitment: null,
          batch_id: null,
          batch_evidence_commitment: null,
          preview_commitment: previewRecord.preview.preview_commitment,
          manifest_commitment: previewRecord.preview.connector_context.manifest_commitment,
          connector_readiness_commitment: previewRecord.preview.connector_context.connector_readiness_commitment,
          compiler_commitment: previewRecord.preview.connector_context.compiler_commitment,
          linkability_score_commitment: previewRecord.preview.connector_context.linkability_score_commitment,
          work_order_commitment: connectorSubmission.work_order?.work_order_commitment ?? null,
          connector_result_commitment: connectorSubmission.result?.connector_result_commitment ?? null,
          runtime_envelope_commitment: previewRecord.preview.sealed_runtime_context?.runtime_envelope_commitment ?? null,
          runtime_attestation_commitment: previewRecord.preview.sealed_runtime_context?.runtime_attestation_commitment ?? null,
          runtime_health_commitment: previewRecord.preview.sealed_runtime_context?.runtime_health_commitment ?? null,
          schedule_commitment: previewRecord.preview.schedule_decision?.schedule_commitment ?? null,
          rotation_commitment: previewRecord.preview.rotation?.rotation_commitment ?? null,
          simulator_commitment: previewRecord.preview.linkability_simulation?.simulator_commitment ?? null,
          execution_plan_commitment: planResult.plan?.plan_commitment ?? null,
          approval_commitment: approval.approval_commitment,
          execution_commitment: executionCommitment,
          settlement_commitment: settlementResult.settlement?.settlement_commitment ?? null,
          root_commitment: settlementResult.settlement?.root_commitment ?? null,
          witness_commitment: settlementResult.settlement?.witness_commitment ?? null,
          proof_commitment: settlementResult.settlement?.proof_commitment ?? null,
          relay_commitment: settlementResult.settlement?.evidence.relay_status.relay_commitment ?? null,
          finality_commitment: settlementResult.settlement?.evidence.finality_commitment ?? null,
          attestation_commitment: settlementResult.settlement?.attestation_commitment ?? null,
        }
      : null;
  const receipt = buildPrivateAccountReceipt({
    preview: previewRecord.preview,
    approval_commitment: approval.approval_commitment,
    execution_commitment: executionCommitment,
    evidence_chain: boundEvidenceChain,
    secret: process.env.GHOLA_PRIVATE_ACCOUNT_RECEIPT_SECRET,
  });
  await consumePrivateAccountPreview(previewRecord.preview_commitment, now);
  await consumePrivateAccountApproval(approval.approval_commitment, now);
  if (planResult.plan) await consumePrivateExecutionPlan(planResult.plan.plan_commitment, now);
  await putPrivateAccountExecution({
    version: 1,
    owner_commitment: owner.owner_commitment,
    execution_commitment: executionCommitment,
    intent_id: intent.intent_id,
    preview_commitment: previewRecord.preview_commitment,
    approval_commitment: approval.approval_commitment,
    execution_plan_commitment: planResult.plan?.plan_commitment ?? null,
    settlement_commitment: settlementResult.settlement?.settlement_commitment ?? null,
    claim_status: previewRecord.claim_status,
    rail_used: previewRecord.selected_rail,
    receipt_commitment: receipt.receipt_commitment,
    evidence_chain: boundEvidenceChain,
    status: "executed",
    created_at: now,
  });
  await putPrivateAccountReceipt({
    version: 1,
    owner_commitment: owner.owner_commitment,
    receipt_commitment: receipt.receipt_commitment,
    intent_id: intent.intent_id,
    preview_commitment: previewRecord.preview_commitment,
    approval_commitment: approval.approval_commitment,
    receipt,
    created_at: now,
  });
  await recordPrivacyBudgetEvent({
    owner_commitment: owner.owner_commitment,
    account_commitment: intent.account_commitment,
    degraded: previewRecord.claim_status === "degraded_user_accepted_required",
    repeated_withdrawal: intent.action_class === "withdraw",
  });
  await updatePrivateAccountIntentStatus(intent.intent_id, "executed");
  return {
    version: 1,
    ok: true,
    intent_id: intent.intent_id,
    execution_commitment: executionCommitment,
    receipt,
  };
}

export async function settleStoredActionFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const intentId = stringValue(value.intent_id);
  const previewCommitment = stringValue(value.preview_commitment);
  const approvalCommitment = stringValue(value.approval_commitment);
  const planCommitment = stringValue(value.execution_plan_commitment) || stringValue(value.plan_commitment);
  if (!intentId) return { error: "intent_not_found" as const };
  if (!previewCommitment) return { error: "preview_not_found" as const };
  if (!approvalCommitment) return { error: "approval_not_found" as const };
  if (!planCommitment) return { error: "private_execution_plan_required" as const };
  const intent = await getPrivateAccountIntent(intentId);
  if (!intent || intent.owner_commitment !== owner.owner_commitment) return { error: "intent_not_found" as const };
  const preview = await getPrivateAccountPreview(previewCommitment);
  if (!preview || preview.owner_commitment !== owner.owner_commitment) return { error: "preview_not_found" as const };
  const approval = await getPrivateAccountApproval(approvalCommitment);
  if (!approval || approval.owner_commitment !== owner.owner_commitment) return { error: "approval_not_found" as const };
  const plan = await getPrivateExecutionPlan(planCommitment);
  if (!plan || plan.owner_commitment !== owner.owner_commitment) {
    return { error: "private_execution_plan_not_found" as const };
  }
  if (
    plan.intent_id !== intent.intent_id ||
    plan.preview_commitment !== preview.preview_commitment ||
    approval.preview_commitment !== preview.preview_commitment
  ) {
    return { error: "private_execution_plan_mismatch" as const };
  }
  const evidenceChain = await evidenceChainForExecution({
    preview: preview.preview,
    approval_commitment: approval.approval_commitment,
  });
  const executionCommitment = privateActionExecutionCommitment({
    intent_id: intent.intent_id,
    preview_commitment: preview.preview_commitment,
    approval_commitment: approval.approval_commitment,
    evidence_chain: evidenceChain,
    execution_plan_commitment: plan.plan_commitment,
  });
  const settled = await settlementForExecution({
    owner,
    plan,
    approval_commitment: approval.approval_commitment,
    execution_commitment: executionCommitment,
    require_finalized: false,
  });
  if ("error" in settled) return settled;
  return {
    version: 1,
    ok: true,
    execution_commitment: executionCommitment,
    settlement: settled.settlement ? publicSettlement(settled.settlement) : null,
  };
}

export async function refreshSettlementStatusFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
) {
  const value = objectBody(body);
  const settlementCommitment = stringValue(value.settlement_commitment);
  if (!settlementCommitment) return { error: "settlement_not_found" as const };
  const settlement = await getPrivateSettlement(settlementCommitment);
  if (!settlement || settlement.owner_commitment !== owner.owner_commitment) {
    return { error: "settlement_not_found" as const };
  }
  const evidence = await refreshShieldedSettlementEvidence({
    evidence: settlement.evidence,
  });
  const now = new Date().toISOString();
  const updated = await putPrivateSettlement({
    ...settlement,
    lifecycle_status: evidence.lifecycle_status,
    root_commitment: evidence.root_commitment,
    witness_commitment: evidence.witness_commitment,
    proof_commitment: evidence.proof_commitment,
    relay_commitment: evidence.relay_status.relay_commitment,
    finality_commitment: evidence.finality_commitment,
    attestation_commitment: evidence.attestation_commitment,
    failure_reason: evidence.lifecycle_status === "failed"
      ? settlement.failure_reason || "settlement runtime reported failed"
      : null,
    evidence,
    updated_at: now,
  });
  return {
    version: 1,
    settlement: publicSettlement(updated),
  };
}

export async function canaryStatusBody() {
  const [summary, records] = await Promise.all([
    privateModeCanaryStatus(),
    listPrivateModeCanaries(25),
  ]);
  return {
    ...summary,
    records: records.map((record) => ({
      canary_id: record.canary_id,
      canary_kind: record.canary_kind,
      status: record.status,
      evidence_commitment: record.evidence_commitment,
      observed_at: record.observed_at,
      expires_at: record.expires_at,
      reason: record.reason,
      created_at: record.created_at,
    })),
  };
}

export async function runCanariesFromBody() {
  return runPrivateModeCanaries();
}

export async function verifyReceiptFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
): Promise<GholaReceiptVerificationResult | null> {
  const value = objectBody(body);
  const receiptCommitment = stringValue(value.receipt_commitment);
  if (!receiptCommitment) return null;
  const record = await getPrivateAccountReceipt(receiptCommitment);
  if (!record || record.owner_commitment !== owner.owner_commitment) return null;
  const receipt = record.receipt;
  const [
    preview,
    approval,
    execution,
    plan,
    settlement,
    manifest,
    compiled,
    linkability,
    workOrder,
    connectorResult,
    runtimeEnvelope,
    schedule,
    rotation,
    simulation,
  ] = await Promise.all([
    getPrivateAccountPreview(receipt.preview_commitment),
    getPrivateAccountApproval(receipt.approval_commitment),
    getPrivateAccountExecutionByApproval(receipt.approval_commitment),
    receipt.execution_plan_commitment
      ? getPrivateExecutionPlan(receipt.execution_plan_commitment)
      : Promise.resolve(null),
    receipt.settlement_commitment
      ? getPrivateSettlement(receipt.settlement_commitment)
      : Promise.resolve(null),
    receipt.manifest_commitment
      ? getConnectorManifestRecord(receipt.manifest_commitment)
      : Promise.resolve(null),
    receipt.compiler_commitment
      ? getCompiledIntent(receipt.compiler_commitment)
      : Promise.resolve(null),
    receipt.linkability_score_commitment
      ? getLinkabilityScore(receipt.linkability_score_commitment)
      : Promise.resolve(null),
    receipt.work_order_commitment
      ? getConnectorWorkOrder(receipt.work_order_commitment)
      : Promise.resolve(null),
    receipt.connector_result_commitment
      ? getConnectorResult(receipt.connector_result_commitment)
      : Promise.resolve(null),
    receipt.runtime_envelope_commitment
      ? getRuntimeEnvelope(receipt.runtime_envelope_commitment)
      : Promise.resolve(null),
    receipt.schedule_commitment
      ? getScheduleDecision(receipt.schedule_commitment)
      : Promise.resolve(null),
    receipt.rotation_commitment
      ? getPlatformRotation(receipt.rotation_commitment)
      : Promise.resolve(null),
    receipt.simulator_commitment
      ? getLinkabilitySimulation(receipt.simulator_commitment)
      : Promise.resolve(null),
  ]);
  const privateMode = isPrivateModeAvailableStatus(receipt.claim_status);
  const connectorRequired = Boolean(preview?.preview.connector_context || receipt.manifest_commitment);
  const runtimeRequired = Boolean(preview?.preview.sealed_runtime_context || receipt.runtime_envelope_commitment);
  const context = preview?.preview.connector_context ?? null;
  const runtimeContext = preview?.preview.sealed_runtime_context ?? null;
  const checks: GholaReceiptVerificationResult["checks"] = {
    receipt_found: "pass",
    preview_bound: preview?.preview_commitment === receipt.preview_commitment ? "pass" : "fail",
    approval_bound: approval?.approval_commitment === receipt.approval_commitment &&
      approval.preview_commitment === receipt.preview_commitment
      ? "pass"
      : "fail",
    execution_bound: execution?.execution_commitment === receipt.execution_commitment &&
      execution.receipt_commitment === receipt.receipt_commitment
      ? "pass"
      : "fail",
    funding_import_bound: privateMode
      ? receipt.evidence_chain?.funding_import_commitment ? "pass" : "fail"
      : "not_required",
    batch_evidence_bound: privateMode
      ? receipt.evidence_chain?.batch_evidence_commitment ? "pass" : "fail"
      : "not_required",
    execution_plan_bound: privateMode
      ? plan?.plan_commitment === receipt.execution_plan_commitment &&
        plan.preview_commitment === receipt.preview_commitment
        ? "pass"
        : "fail"
      : "not_required",
    settlement_bound: privateMode && receipt.rail_used === "shielded_pool"
      ? settlement?.settlement_commitment === receipt.settlement_commitment &&
        settlement.execution_commitment === receipt.execution_commitment
        ? "pass"
        : "fail"
      : "not_required",
    witness_bound: privateMode && receipt.rail_used === "shielded_pool"
      ? settlement?.witness_commitment &&
        settlement.witness_commitment === receipt.evidence_chain?.witness_commitment
        ? "pass"
        : "fail"
      : "not_required",
    proof_bound: privateMode && receipt.rail_used === "shielded_pool"
      ? settlement?.proof_commitment &&
        settlement.proof_commitment === receipt.evidence_chain?.proof_commitment
        ? "pass"
        : "fail"
      : "not_required",
    relay_bound: privateMode && receipt.rail_used === "shielded_pool"
      ? settlement?.relay_commitment &&
        settlement.relay_commitment === receipt.relay_commitment &&
        settlement.relay_commitment === receipt.evidence_chain?.relay_commitment
        ? "pass"
        : "fail"
      : "not_required",
    finality_bound: privateMode && receipt.rail_used === "shielded_pool"
      ? settlement?.finality_commitment &&
        settlement.finality_commitment === receipt.finality_commitment &&
        settlement.finality_commitment === receipt.evidence_chain?.finality_commitment
        ? "pass"
        : "fail"
      : "not_required",
    attestation_bound: privateMode && receipt.rail_used === "shielded_pool" && settlement?.attestation_commitment
      ? settlement.attestation_commitment === receipt.evidence_chain?.attestation_commitment
        ? "pass"
        : "fail"
      : "not_required",
    manifest_bound: connectorRequired
      ? context?.manifest_commitment === receipt.manifest_commitment &&
        manifest?.manifest_commitment === receipt.manifest_commitment
        ? "pass"
        : "fail"
      : "not_required",
    connector_readiness_bound: connectorRequired
      ? context?.connector_readiness_commitment === receipt.connector_readiness_commitment
        ? "pass"
        : "fail"
      : "not_required",
    compiler_bound: connectorRequired
      ? compiled?.compiler_commitment === receipt.compiler_commitment &&
        compiled.intent_id === record.intent_id &&
        compiled.manifest_commitment === receipt.manifest_commitment
        ? "pass"
        : "fail"
      : "not_required",
    linkability_bound: connectorRequired
      ? linkability?.score_commitment === receipt.linkability_score_commitment &&
        linkability.intent_id === record.intent_id
        ? "pass"
        : "fail"
      : "not_required",
    work_order_bound: connectorRequired
      ? workOrder?.work_order_commitment === receipt.work_order_commitment &&
        workOrder.intent_id === record.intent_id &&
        workOrder.preview_commitment === receipt.preview_commitment &&
        workOrder.approval_commitment === receipt.approval_commitment
        ? "pass"
        : "fail"
      : "not_required",
    connector_result_bound: connectorRequired
      ? connectorResult?.connector_result_commitment === receipt.connector_result_commitment &&
        connectorResult.work_order_commitment === receipt.work_order_commitment &&
        connectorResult.intent_id === record.intent_id
        ? "pass"
        : "fail"
      : "not_required",
    runtime_envelope_bound: runtimeRequired
      ? runtimeEnvelope?.runtime_envelope_commitment === receipt.runtime_envelope_commitment &&
        runtimeEnvelope.intent_id === record.intent_id &&
        runtimeContext?.runtime_envelope_commitment === receipt.runtime_envelope_commitment
        ? "pass"
        : "fail"
      : "not_required",
    runtime_attestation_bound: runtimeRequired
      ? runtimeContext?.runtime_attestation_commitment === receipt.runtime_attestation_commitment &&
        receipt.evidence_chain?.runtime_attestation_commitment === receipt.runtime_attestation_commitment
        ? "pass"
        : "fail"
      : "not_required",
    schedule_bound: runtimeRequired
      ? schedule?.schedule_commitment === receipt.schedule_commitment &&
        schedule.intent_id === record.intent_id
        ? "pass"
        : "fail"
      : "not_required",
    rotation_bound: runtimeRequired
      ? rotation?.rotation_commitment === receipt.rotation_commitment &&
        rotation.owner_commitment === owner.owner_commitment
        ? "pass"
        : "fail"
      : "not_required",
    simulator_bound: runtimeRequired
      ? simulation?.simulator_commitment === receipt.simulator_commitment &&
        simulation.intent_id === record.intent_id
        ? "pass"
        : "fail"
      : "not_required",
    claim_levels_bound: privateMode
      ? receipt.claim_levels_achieved.includes("source_wallet_hidden") &&
        receipt.claim_levels_achieved.includes("amount_bucketed") &&
        receipt.claim_levels_achieved.includes("batched_anonymity_set") &&
        receipt.claim_levels_achieved.includes("operator_sealed") &&
        receipt.claim_levels_missing.length === 0
        ? "pass"
        : "fail"
      : "not_required",
  };
  const errors = Object.entries(checks)
    .filter(([, status]) => status === "fail")
    .map(([name]) => name);
  return {
    version: 1,
    receipt_commitment: receipt.receipt_commitment,
    verified: errors.length === 0,
    claim_status: receipt.claim_status,
    checks,
    errors,
  };
}

export async function receiptFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const receiptCommitment = stringValue(value.receipt_commitment);
  const intentId = stringValue(value.intent_id);
  const record = receiptCommitment
    ? await getPrivateAccountReceipt(receiptCommitment)
    : intentId
      ? await getPrivateAccountReceiptByIntent(intentId)
      : null;
  return record && record.owner_commitment === owner.owner_commitment
    ? { version: 1, receipt: record.receipt }
    : null;
}

export async function receiptListForOwner(req: Request, owner: PrivateAccountRequestOwner) {
  const url = new URL(req.url);
  const limit = Number.parseInt(url.searchParams.get("limit") || "10", 10);
  const records = await listPrivateAccountReceipts(owner.owner_commitment, limit);
  return {
    version: 1,
    receipts: records.map((record) => ({
      receipt_commitment: record.receipt_commitment,
      intent_id: record.intent_id,
      action_commitment: record.receipt.action_commitment,
      preview_commitment: record.preview_commitment,
      claim_status: record.receipt.claim_status,
      privacy_level: record.receipt.privacy_level,
      rail_used: record.receipt.rail_used,
      platform_visibility: record.receipt.platform_visibility,
      public_chain_visibility: record.receipt.public_chain_visibility,
      evidence_commitment: record.receipt.evidence_chain?.batch_evidence_commitment ?? null,
      execution_plan_commitment: record.receipt.execution_plan_commitment,
      settlement_commitment: record.receipt.settlement_commitment,
      manifest_commitment: record.receipt.manifest_commitment,
      compiler_commitment: record.receipt.compiler_commitment,
      connector_result_commitment: record.receipt.connector_result_commitment,
      runtime_envelope_commitment: record.receipt.runtime_envelope_commitment,
      runtime_attestation_commitment: record.receipt.runtime_attestation_commitment,
      schedule_commitment: record.receipt.schedule_commitment,
      rotation_commitment: record.receipt.rotation_commitment,
      simulator_commitment: record.receipt.simulator_commitment,
      venue_access_source: record.receipt.venue_access_source,
      ghola_access_role: record.receipt.ghola_access_role,
      venue_gate: record.receipt.venue_gate,
      venue_visibility: record.receipt.venue_visibility,
      source_wallet_visibility: record.receipt.source_wallet_visibility,
      privacy_claim: record.receipt.privacy_claim,
      claim_levels_achieved: record.receipt.claim_levels_achieved,
      claim_levels_missing: record.receipt.claim_levels_missing,
      created_at: record.created_at,
    })),
  };
}

export async function receiptDetailForOwner(input: {
  receipt_commitment: string;
}, owner: PrivateAccountRequestOwner) {
  const record = await getPrivateAccountReceipt(input.receipt_commitment);
  if (!record || record.owner_commitment !== owner.owner_commitment) return null;
  const preview = await getPrivateAccountPreview(record.preview_commitment);
  return {
    version: 1,
    receipt: record.receipt,
    leakage_map: preview?.owner_commitment === owner.owner_commitment
      ? preview.preview.leakage_map
      : null,
    connector_context: preview?.owner_commitment === owner.owner_commitment
      ? preview.preview.connector_context
      : null,
    sealed_runtime_context: preview?.owner_commitment === owner.owner_commitment
      ? preview.preview.sealed_runtime_context
      : null,
    schedule_decision: preview?.owner_commitment === owner.owner_commitment
      ? preview.preview.schedule_decision
      : null,
    rotation: preview?.owner_commitment === owner.owner_commitment
      ? preview.preview.rotation
      : null,
    linkability_simulation: preview?.owner_commitment === owner.owner_commitment
      ? preview.preview.linkability_simulation
      : null,
    created_at: record.created_at,
  };
}

export async function receiptExportFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const receiptCommitment = stringValue(value.receipt_commitment);
  const scope = stringValue(value.scope) || "commitment_summary";
  if (!receiptCommitment) return null;
  const record = await getPrivateAccountReceipt(receiptCommitment);
  if (!record || record.owner_commitment !== owner.owner_commitment) return null;
  return {
    version: 1,
    export_commitment: gholaCommitment("receipt_export", {
      owner_commitment: owner.owner_commitment,
      receipt_commitment: record.receipt_commitment,
      scope,
    }),
    scope,
    receipt_commitment: record.receipt_commitment,
    claim_status: record.receipt.claim_status,
    privacy_level: record.receipt.privacy_level,
    rail_used: record.receipt.rail_used,
    platform_visibility: record.receipt.platform_visibility,
    public_chain_visibility: record.receipt.public_chain_visibility,
    approval_commitment: record.receipt.approval_commitment,
    execution_commitment: record.receipt.execution_commitment,
    execution_plan_commitment: record.receipt.execution_plan_commitment,
    settlement_commitment: record.receipt.settlement_commitment,
    relay_commitment: record.receipt.relay_commitment,
    finality_commitment: record.receipt.finality_commitment,
    manifest_commitment: record.receipt.manifest_commitment,
    connector_readiness_commitment: record.receipt.connector_readiness_commitment,
    compiler_commitment: record.receipt.compiler_commitment,
    linkability_score_commitment: record.receipt.linkability_score_commitment,
    work_order_commitment: record.receipt.work_order_commitment,
    connector_result_commitment: record.receipt.connector_result_commitment,
    runtime_envelope_commitment: record.receipt.runtime_envelope_commitment,
    runtime_attestation_commitment: record.receipt.runtime_attestation_commitment,
    runtime_health_commitment: record.receipt.runtime_health_commitment,
    schedule_commitment: record.receipt.schedule_commitment,
    rotation_commitment: record.receipt.rotation_commitment,
    simulator_commitment: record.receipt.simulator_commitment,
    venue_access_source: record.receipt.venue_access_source,
    ghola_access_role: record.receipt.ghola_access_role,
    venue_gate: record.receipt.venue_gate,
    venue_visibility: record.receipt.venue_visibility,
    source_wallet_visibility: record.receipt.source_wallet_visibility,
    privacy_claim: record.receipt.privacy_claim,
    claim_levels_achieved: record.receipt.claim_levels_achieved,
    claim_levels_missing: record.receipt.claim_levels_missing,
    claim_evidence_commitments: record.receipt.claim_evidence_commitments,
    evidence_chain: record.receipt.evidence_chain,
    selective_disclosure_available: record.receipt.selective_disclosure_available,
    created_at: record.created_at,
  };
}

export async function runtimeEnvelopeFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const intentId = stringValue(value.intent_id);
  const platformClass = stringValue(value.platform_class) ||
    stringValue(objectBody(value.safe_input).platform_class);
  if (!intentId) return { error: "intent_not_found" as const };
  if (!isPlatformClass(platformClass)) return { error: "valid platform_class is required" as const };
  const intent = await getPrivateAccountIntent(intentId);
  if (!intent || intent.owner_commitment !== owner.owner_commitment) return { error: "intent_not_found" as const };
  const existingCommitment = stringValue(value.runtime_envelope_commitment);
  const existing = existingCommitment ? await getRuntimeEnvelope(existingCommitment) : null;
  if (existing) {
    if (existing.owner_commitment !== owner.owner_commitment || existing.intent_id !== intent.intent_id) {
      return { error: "runtime_envelope_not_found" as const };
    }
    const health = sealedRuntimeHealth();
    await putRuntimeHealth({
      version: 1,
      runtime_health_commitment: health.runtime_health_commitment,
      health,
      created_at: health.observed_at,
    });
    return {
      version: 1,
      intent_id: intent.intent_id,
      runtime_envelope: publicRuntimeEnvelope(existing.envelope),
      sealed_runtime_context: sealedRuntimeContext({ envelope: existing.envelope, health }),
      runtime_health: publicRuntimeHealth(health),
    };
  }
  const created = createRuntimeEnvelope({
    owner_commitment: owner.owner_commitment,
    intent_id: intent.intent_id,
    account_commitment: intent.account_commitment,
    action_commitment: intent.action_commitment,
    platform_class: platformClass,
    safe_input: safeConnectorInput(value.safe_input),
    encrypted_payload_commitment: stringValue(value.encrypted_payload_commitment),
    runtime_envelope_seed: value.runtime_envelope_seed ?? "authenticated_private_session",
  });
  if (!created.ok) return { error: created.error };
  const stored = await putRuntimeEnvelope({
    version: 1,
    runtime_envelope_commitment: created.envelope.runtime_envelope_commitment,
    owner_commitment: owner.owner_commitment,
    intent_id: intent.intent_id,
    account_commitment: intent.account_commitment,
    action_commitment: intent.action_commitment,
    platform_class: platformClass,
    envelope: created.envelope,
    created_at: created.envelope.created_at,
    expires_at: created.envelope.expires_at,
  });
  const health = sealedRuntimeHealth();
  await putRuntimeHealth({
    version: 1,
    runtime_health_commitment: health.runtime_health_commitment,
    health,
    created_at: health.observed_at,
  });
  return {
    version: 1,
    intent_id: intent.intent_id,
    runtime_envelope: publicRuntimeEnvelope(stored.envelope),
    sealed_runtime_context: sealedRuntimeContext({ envelope: stored.envelope, health }),
    runtime_health: publicRuntimeHealth(health),
  };
}

export async function viewKeyCreateFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const requestedScope = stringValue(value.scope);
  const scope = requestedScope === "auditor_selective_disclosure"
    ? "auditor_selective_disclosure"
    : "user_private_receipt";
  const ttlMs = ttlMsFromBody(value.ttl_ms, scope);
  const viewKey = createViewKey({
    owner_commitment: owner.owner_commitment,
    scope,
    audience_seed: stringValue(value.audience_seed) || owner.user.id,
    ttl_ms: ttlMs,
  });
  const stored = await putViewKey({
    version: 1,
    view_key_commitment: viewKey.view_key_commitment,
    owner_commitment: owner.owner_commitment,
    view_key: viewKey,
    created_at: viewKey.created_at,
    updated_at: viewKey.created_at,
  });
  return {
    version: 1,
    view_key: publicViewKey(stored.view_key),
  };
}

export async function privateReceiptExportFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const receiptCommitment = stringValue(value.receipt_commitment);
  if (!receiptCommitment) return { error: "receipt_not_found" as const };
  const receiptRecord = await getPrivateAccountReceipt(receiptCommitment);
  if (!receiptRecord || receiptRecord.owner_commitment !== owner.owner_commitment) {
    return { error: "receipt_not_found" as const };
  }
  const viewKeyResult = await viewKeyForPrivateExport(value, owner);
  if ("error" in viewKeyResult) return viewKeyResult;
  const privateExport = createPrivateReceiptExport({
    receipt: receiptRecord.receipt,
    view_key: viewKeyResult.view_key,
    evidence_chain: receiptRecord.receipt.evidence_chain ?? null,
  });
  const stored = await putPrivateReceiptExport({
    version: 1,
    private_export_commitment: privateExport.private_export_commitment,
    owner_commitment: owner.owner_commitment,
    receipt_commitment: receiptRecord.receipt_commitment,
    view_key_commitment: viewKeyResult.view_key.view_key_commitment,
    private_export: privateExport,
    created_at: privateExport.created_at,
    revoked_at: null,
  });
  return {
    version: 1,
    receipt_commitment: receiptRecord.receipt_commitment,
    view_key: publicViewKey(viewKeyResult.view_key),
    private_export: publicPrivateReceiptExport(stored.private_export, true),
  };
}

export async function revokePrivateReceiptExportFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const exportCommitment = stringValue(value.private_export_commitment);
  if (!exportCommitment) return { error: "private_export_not_found" as const };
  const exportRecord = await getPrivateReceiptExport(exportCommitment);
  if (!exportRecord || exportRecord.owner_commitment !== owner.owner_commitment) {
    return { error: "private_export_not_found" as const };
  }
  const revocation = revokePrivateReceiptExport({
    private_export_commitment: exportRecord.private_export_commitment,
    view_key_commitment: exportRecord.view_key_commitment,
  });
  const updatedExport = {
    ...exportRecord.private_export,
    revoked_at: revocation.revoked_at,
  };
  await putPrivateReceiptExport({
    ...exportRecord,
    private_export: updatedExport,
    revoked_at: revocation.revoked_at,
  });
  await putPrivateReceiptExportRevocation({
    version: 1,
    revocation_commitment: revocation.revocation_commitment,
    owner_commitment: owner.owner_commitment,
    private_export_commitment: exportRecord.private_export_commitment,
    view_key_commitment: exportRecord.view_key_commitment,
    revocation,
    revoked_at: revocation.revoked_at,
  });
  return {
    version: 1,
    revocation,
    private_export: publicPrivateReceiptExport(updatedExport, false),
  };
}

export async function updateVaultReadinessFromBody(body: unknown) {
  const value = objectBody(body);
  const accountCommitment = stringValue(value.account_commitment);
  if (!accountCommitment) return { error: "account_commitment_required" as const };
  const account = await getPrivateAccountByCommitment(accountCommitment);
  if (!account) return { error: "account_not_found" as const };
  const existing = await getPrivateVaultState(account.account_commitment);
  const now = new Date().toISOString();
  const readyRails = arrayOfStrings(value.ready_rails).filter(isRailKind);
  const balanceBuckets = arrayOfStrings(value.balance_bucket_summary).slice(0, 12);
  const vaultReady = value.vault_ready === true || readyRails.length > 0;
  const accountRecord: PrivateAccountRecordV1 = {
    ...account,
    vault_ready: vaultReady,
    account: { ...account.account, vault_ready: vaultReady },
    updated_at: now,
  };
  await putPrivateAccountRecord(accountRecord);
  const vault: PrivateVaultStateRecordV1 = {
    version: 1,
    owner_commitment: account.owner_commitment,
    account_commitment: account.account_commitment,
    vault_root_commitment: account.vault_root_commitment,
    note_root_commitment: account.note_root_commitment,
    nullifier_root_commitment: account.nullifier_root_commitment,
    balance_bucket_summary: balanceBuckets.length ? balanceBuckets : existing?.balance_bucket_summary ?? [],
    ready_rails: readyRails.length ? readyRails : existing?.ready_rails ?? [],
    last_import_commitment: stringValue(value.last_import_commitment) || existing?.last_import_commitment || null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  await putPrivateVaultState(vault);
  return {
    version: 1,
    account: publicAccountSummary(accountRecord, vault),
    vault: publicVaultSummary(vault),
  };
}

export async function hyperliquidVaultStatusForOwner(owner: PrivateAccountRequestOwner) {
  const account = await createOrGetStoredPrivateAccount(owner);
  const [vault, allocation] = await Promise.all([
    getHyperliquidExecutionVaultByAccount(account.account_commitment),
    getHyperliquidManagedAllocationByAccount(account.account_commitment),
  ]);
  return {
    version: 1,
    account_commitment: account.account_commitment,
    hyperliquid_execution_vault: vault ? publicHyperliquidVault(vault) : null,
    managed_allocation: allocation ? publicHyperliquidManagedAllocation(allocation) : null,
    execution_mode: allocation?.status === "allocated" ? "managed_testnet" as const : "byo_api_key" as const,
    ready: vault?.status === "sealed" || allocation?.status === "allocated",
    venue_access: {
      source: vault?.status === "sealed"
        ? "user_provided_credentials" as const
        : allocation?.status === "allocated"
          ? "ghola_managed_testnet" as const
          : null,
      status: vault?.status === "sealed" || allocation?.status === "allocated"
        ? "venue_credentials_sealed" as const
        : "venue_access_required" as const,
      venue_gate: "venue_accepts_or_rejects_credentials" as const,
    },
  };
}

export async function hyperliquidStatusForOwner(owner: PrivateAccountRequestOwner) {
  const account = await createOrGetStoredPrivateAccount(owner);
  const [vault, allocation, runtime, evidence] = await Promise.all([
    getHyperliquidExecutionVaultByAccount(account.account_commitment),
    getHyperliquidManagedAllocationByAccount(account.account_commitment),
    getPrivateAgentRuntimeStatus().catch(() => null),
    getLatestAnonymityEvidence({ account_commitment: account.account_commitment }),
  ]);
  const hasConnection = vault?.status === "sealed" || allocation?.status === "allocated";
  const workerConfigured = Boolean(hyperliquidWorkerConfig().url) || localHyperliquidPilotEnabled();
  const workerReady = Boolean(runtime?.selected_provider) || localHyperliquidPilotEnabled();
  const liveTinyFill = process.env.GHOLA_HYPERLIQUID_LIVE_MODE === "tiny_fill";
  const privateFundingReady = Boolean(
    evidence?.anonymity_set &&
      evidence.anonymity_set.effective >= evidence.anonymity_set.required &&
      evidence.anonymity_set.amount_bucketed &&
      evidence.anonymity_set.timing_window_met,
  );
  const canConnect = workerConfigured && workerReady;
  const canRead = canConnect && hasConnection;
  const canTrade = canRead && (privateFundingReady || liveTinyFill);
  const reasonCodes = [
    ...(workerConfigured ? [] : ["connector_endpoint_missing"]),
    ...(workerReady ? [] : runtime?.blocking_reasons ?? ["private_worker_unavailable"]),
    ...(hasConnection ? ["venue_credentials_sealed"] : ["venue_access_required", "hyperliquid_connection_required"]),
    ...(canRead ? ["venue_ready"] : []),
    ...(privateFundingReady || liveTinyFill ? [] : ["private_funding_or_degraded_acceptance_required"]),
  ];
  return {
    version: 1,
    account_commitment: account.account_commitment,
    platform_class: "hyperliquid_style_market" as const,
    network: liveTinyFill ? "mainnet" as const : "testnet" as const,
    pilot_stage: process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED === "true"
      ? liveTinyFill ? "live_pilot" as const : "testnet_pilot" as const
      : "disabled" as const,
    worker: {
      configured: workerConfigured,
      ready: workerReady,
      selected_provider: runtime?.selected_provider ?? null,
      blocking_reasons: runtime?.blocking_reasons ?? [],
    },
    connection: {
      ready: hasConnection,
      mode: allocation?.status === "allocated"
        ? "managed_testnet" as const
        : vault?.status === "sealed"
          ? "byo_api_key" as const
          : null,
      vault_commitment: vault?.vault_commitment ?? null,
      allocation_commitment: allocation?.allocation_commitment ?? null,
    },
    gates: {
      can_connect: canConnect,
      can_read: canRead,
      can_trade: canTrade,
      private_funding_ready: privateFundingReady,
      reason_codes: Array.from(new Set(reasonCodes)),
    },
    visibility: {
      main_wallet_exposed: false,
      hyperliquid_sees: "execution account and order",
      venue_access_source: "user_provided_credentials",
      ghola_access_role: "private_execution_router",
      venue_gate: "venue accepts or rejects credentials and orders",
      ghola_operator_sees: "commitments and sealed payloads",
      public_chain_sees: privateFundingReady
        ? "hidden or bucketed funding evidence"
        : liveTinyFill ? "no Ghola public settlement" : "not ready",
    },
    hyperliquid_execution_vault: vault ? publicHyperliquidVault(vault) : null,
    managed_allocation: allocation ? publicHyperliquidManagedAllocation(allocation) : null,
  };
}

export async function hyperliquidAccountSnapshotForOwner(owner: PrivateAccountRequestOwner) {
  const account = await createOrGetStoredPrivateAccount(owner);
  const [vault, allocation, runtime] = await Promise.all([
    getHyperliquidExecutionVaultByAccount(account.account_commitment),
    getHyperliquidManagedAllocationByAccount(account.account_commitment),
    getPrivateAgentRuntimeStatus().catch(() => null),
  ]);
  const hasVault = vault?.status === "sealed";
  const hasManaged = allocation?.status === "allocated";
  const accountSource = hasManaged ? "ghola_managed" as const : hasVault ? "sealed_byo" as const : "none" as const;
  if (!hasVault && !hasManaged) {
    return localHyperliquidAccountSnapshot({
      status: "venue_access_required",
      account_source: "none",
      trading_enabled: false,
      next_step: "Connect a Hyperliquid API wallet.",
    });
  }
  if (localHyperliquidPilotEnabled()) {
    return localHyperliquidAccountSnapshot({
      status: "ready_to_trade",
      account_source: accountSource,
      trading_enabled: true,
      next_step: "Preview trade.",
    });
  }
  const cfg = hyperliquidWorkerConfig();
  const workerReady = Boolean(runtime?.selected_provider);
  if (!cfg.url || !workerReady) {
    return localHyperliquidAccountSnapshot({
      status: "worker_unavailable",
      account_source: accountSource,
      trading_enabled: false,
      next_step: "Wait for the private worker to come back online.",
    });
  }
  const body = hasManaged && allocation
    ? {
        version: 1,
        execution_mode: "managed_testnet",
        account_commitment: account.account_commitment,
        managed_allocation_commitment: allocation.allocation_commitment,
      }
    : {
        version: 1,
        execution_mode: "byo_api_key",
        account_commitment: account.account_commitment,
        vault_commitment: vault?.vault_commitment,
        encrypted_execution_vault: vault?.vault.encrypted_execution_vault,
      };
  try {
    const res = await fetch(new URL("/hyperliquid/account-snapshot", cfg.url), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const raw = objectBody(await res.json().catch(() => null));
    if (!res.ok) {
      return localHyperliquidAccountSnapshot({
        status: hyperliquidSnapshotStatusFromError(stringValue(raw.error_code) || stringValue(raw.error)),
        account_source: accountSource,
        trading_enabled: false,
        next_step: "Check venue access, funds, and worker readiness.",
      });
    }
    if (containsForbiddenPublicPrivateAccountField(raw)) {
      return localHyperliquidAccountSnapshot({
        status: "worker_unavailable",
        account_source: accountSource,
        trading_enabled: false,
        next_step: "Worker returned unsafe account data.",
      });
    }
    return normalizeHyperliquidAccountSnapshot(raw, accountSource);
  } catch {
    return localHyperliquidAccountSnapshot({
      status: "worker_unavailable",
      account_source: accountSource,
      trading_enabled: false,
      next_step: "Wait for the private worker to come back online.",
    });
  }
}

export async function allocateHyperliquidManagedFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
) {
  const value = objectBody(body);
  const account = await createOrGetStoredPrivateAccount(owner);
  const existing = value.force_new === true
    ? null
    : await getHyperliquidManagedAllocationByAccount(account.account_commitment);
  if (existing?.status === "allocated") {
    return {
      version: 1,
      account_commitment: account.account_commitment,
      managed_allocation: publicHyperliquidManagedAllocation(existing),
      ready: true,
    };
  }
  const policy = createHyperliquidSessionPolicy({
    market_allowlist: arrayOfStrings(value.market_allowlist),
    max_notional_bucket: isFundingAmountBucket(stringValue(value.max_notional_bucket))
      ? stringValue(value.max_notional_bucket) as GholaHyperliquidSessionPolicy["max_notional_bucket"]
      : "25",
    max_order_count: numberValue(value.max_order_count) || 10,
    ttl_ms: numberValue(value.ttl_ms) || 30 * 60 * 1000,
    kill_switch: value.kill_switch === true,
    strategy_seed: "managed_testnet",
    prompt_seed: "managed_testnet",
  });
  const localAllocation = createHyperliquidManagedAllocation({
    account_commitment: account.account_commitment,
    policy,
    allocation_seed: owner.owner_commitment,
  });
  const workerAllocation = await requestHyperliquidManagedAllocation({
    account_commitment: account.account_commitment,
    policy,
    fallback: localAllocation,
  });
  if ("error" in workerAllocation) return workerAllocation;
  const stored = await putHyperliquidManagedAllocation({
    version: 1,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    allocation_commitment: workerAllocation.allocation.allocation_commitment,
    policy_commitment: workerAllocation.allocation.policy_commitment,
    pool_commitment: workerAllocation.allocation.pool_commitment,
    subledger_account_commitment: workerAllocation.allocation.subledger_account_commitment,
    status: workerAllocation.allocation.status,
    allocation: workerAllocation.allocation,
    created_at: workerAllocation.allocation.created_at,
    updated_at: workerAllocation.allocation.updated_at,
  });
  return {
    version: 1,
    account_commitment: account.account_commitment,
    managed_allocation: publicHyperliquidManagedAllocation(stored),
    ready: stored.status === "allocated",
  };
}

export async function sealHyperliquidVaultFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
) {
  const value = objectBody(body);
  const account = await createOrGetStoredPrivateAccount(owner);
  const bundleInput = objectBody(value.encrypted_execution_vault);
  const ciphertext = stringValue(bundleInput.ciphertext);
  const recipient = stringValue(bundleInput.recipient);
  const aad = stringValue(bundleInput.aad);
  if (!ciphertext || !recipient || !aad) {
    return { error: "encrypted_execution_vault_required" as const };
  }
  if (bundleInput.alg !== "sealed-provider-v1") {
    return { error: "encrypted_execution_vault_alg_unsupported" as const };
  }
  const aadContext = parseHyperliquidVaultAad(aad);
  if (
    !aadContext ||
    aadContext.account_commitment !== account.account_commitment ||
    aadContext.recipient !== recipient
  ) {
    return { error: "encrypted_execution_vault_aad_mismatch" as const };
  }
  const allowedRecipients = await currentPrivateAgentRecipientIds();
  if (!allowedRecipients.has(recipient)) {
    return { error: "encrypted_execution_vault_recipient_mismatch" as const };
  }
  const created = createHyperliquidExecutionVault({
    account_commitment: account.account_commitment,
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext,
      recipient,
      aad,
      encapsulated_key: stringValue(bundleInput.encapsulated_key) || null,
    },
    policy_seed: {
      account_commitment: account.account_commitment,
      recipient,
      network: aadContext.network,
      policy_commitment_seed: "capped-hyperliquid-v1",
    },
  });
  if (!created.ok) return { error: created.error };
  const stored = await putHyperliquidExecutionVault({
    version: 1,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    vault_commitment: created.vault.vault_commitment,
    encrypted_vault_commitment: created.vault.encrypted_vault_commitment,
    recipient_commitment: created.vault.recipient_commitment,
    policy_commitment: created.vault.policy_commitment,
    status: created.vault.status,
    vault: created.vault,
    created_at: created.vault.created_at,
    updated_at: created.vault.updated_at,
  });
  return {
    version: 1,
    account_commitment: account.account_commitment,
    hyperliquid_execution_vault: publicHyperliquidVault(stored),
    ready: stored.status === "sealed",
  };
}

export async function venueVaultStatusForOwner(
  owner: PrivateAccountRequestOwner,
  platformClass: GholaPlatformClass,
) {
  const venueId = venueIdForPlatformClass(platformClass);
  if (!venueId) return { error: "venue_not_supported" as const };
  if (venueId === "hyperliquid") return hyperliquidVaultStatusForOwner(owner);
  const account = await createOrGetStoredPrivateAccount(owner);
  const [vault, allocation] = await Promise.all([
    getVenueExecutionVaultByAccount({
      account_commitment: account.account_commitment,
      venue_id: venueId,
    }),
    venueId === "coinbase_advanced"
      ? getOmnibusAllocationByAccount({
          account_commitment: account.account_commitment,
          venue_id: "coinbase_advanced",
        })
      : Promise.resolve(null),
  ]);
  return {
    version: 1,
    account_commitment: account.account_commitment,
    venue_id: venueId,
    platform_class: platformClass,
    execution_mode: allocation && allocation.status !== "revoked"
      ? "partner_omnibus"
      : vault?.execution_mode ?? "byo_api_key",
    venue_execution_vault: vault ? publicVenueExecutionVault(vault) : null,
    omnibus_allocation: allocation ? publicOmnibusAllocation(allocation) : null,
    ready: vault?.status === "sealed" || allocation?.status === "allocated",
  };
}

export async function sealVenueVaultFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
  platformClass: GholaPlatformClass,
) {
  const venueId = venueIdForPlatformClass(platformClass);
  if (!venueId) return { error: "venue_not_supported" as const };
  if (venueId === "hyperliquid") return sealHyperliquidVaultFromBody(body, owner);
  const value = objectBody(body);
  const account = await createOrGetStoredPrivateAccount(owner);
  const executionMode = venueExecutionModeFromValue(value.execution_mode) ?? "byo_api_key";
  const bundleInput = objectBody(value.encrypted_execution_vault);
  const ciphertext = stringValue(bundleInput.ciphertext);
  const recipient = stringValue(bundleInput.recipient);
  const aad = stringValue(bundleInput.aad);
  if (!ciphertext || !recipient || !aad) {
    return { error: "encrypted_execution_vault_required" as const };
  }
  if (bundleInput.alg !== "sealed-provider-v1") {
    return { error: "encrypted_execution_vault_alg_unsupported" as const };
  }
  const aadContext = parseVenueVaultAad(aad);
  if (
    !aadContext ||
    aadContext.venue_id !== venueId ||
    aadContext.execution_mode !== executionMode ||
    aadContext.account_commitment !== account.account_commitment ||
    aadContext.recipient !== recipient
  ) {
    return { error: "encrypted_execution_vault_aad_mismatch" as const };
  }
  const allowedRecipients = await currentPrivateAgentRecipientIds();
  if (!allowedRecipients.has(recipient)) {
    return { error: "encrypted_execution_vault_recipient_mismatch" as const };
  }
  const allocation = executionMode === "partner_omnibus"
    ? await getOmnibusAllocationByAccount({
        account_commitment: account.account_commitment,
        venue_id: "coinbase_advanced",
      })
    : null;
  const created = createVenueExecutionVault({
    venue_id: venueId,
    account_commitment: account.account_commitment,
    execution_mode: executionMode,
    account_mode: executionMode === "ghola_pooled"
      ? "ghola_pooled"
      : venueId === "coinbase_advanced"
        ? undefined
        : "user_stealth",
    allocation_commitment: allocation?.allocation_commitment ?? null,
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext,
      recipient,
      aad,
      encapsulated_key: stringValue(bundleInput.encapsulated_key) || null,
    },
    policy_seed: {
      account_commitment: account.account_commitment,
      recipient,
      venue_id: venueId,
      execution_mode: executionMode,
      account_mode: executionMode === "ghola_pooled" ? "ghola_pooled" : null,
      network: aadContext.network,
      allocation_commitment: allocation?.allocation_commitment ?? null,
    },
  });
  if (!created.ok) return { error: created.error };
  const stored = await putVenueExecutionVault({
    version: 1,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: created.vault.venue_id,
    platform_class: created.vault.platform_class,
    execution_mode: created.vault.execution_mode,
    vault_commitment: created.vault.vault_commitment,
    encrypted_vault_commitment: created.vault.encrypted_vault_commitment,
    recipient_commitment: created.vault.recipient_commitment,
    policy_commitment: created.vault.policy_commitment,
    allocation_commitment: created.vault.allocation_commitment,
    status: created.vault.status,
    vault: created.vault,
    created_at: created.vault.created_at,
    updated_at: created.vault.updated_at,
  });
  return {
    version: 1,
    account_commitment: account.account_commitment,
    venue_id: venueId,
    platform_class: platformClass,
    execution_mode: stored.execution_mode,
    venue_execution_vault: publicVenueExecutionVault(stored),
    omnibus_allocation: allocation ? publicOmnibusAllocation(allocation) : null,
    ready: stored.status === "sealed",
  };
}

export async function armVenueAgentSessionFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
  platformClass: GholaPlatformClass,
) {
  const venueId = venueIdForPlatformClass(platformClass);
  if (!venueId) return { error: "venue_not_supported" as const };
  if (venueId === "hyperliquid") return armHyperliquidAgentSessionFromBody(body, owner);
  const value = objectBody(body);
  const account = await createOrGetStoredPrivateAccount(owner);
  const requestedMode = venueExecutionModeFromValue(value.execution_mode);
  const [vault, allocation] = await Promise.all([
    getVenueExecutionVaultByAccount({
      account_commitment: account.account_commitment,
      venue_id: venueId,
    }),
    venueId === "coinbase_advanced"
      ? getOmnibusAllocationByAccount({
          account_commitment: account.account_commitment,
          venue_id: "coinbase_advanced",
        })
      : Promise.resolve(null),
  ]);
  const executionMode = requestedMode ??
    (venueId === "coinbase_advanced"
      ? allocation?.status === "allocated" ? "partner_omnibus" : "byo_api_key"
      : "user_stealth");
  if (venueId === "coinbase_advanced" && executionMode === "partner_omnibus" && allocation?.status !== "allocated") {
    return { error: "coinbase_omnibus_allocation_not_ready" as const };
  }
  if (executionMode !== "partner_omnibus" && (!vault || vault.status !== "sealed")) {
    return { error: "coinbase_execution_vault_not_ready" as const };
  }
  const policy = createVenueSessionPolicy({
    venue_id: venueId,
    execution_mode: executionMode,
    market_allowlist: arrayOfStrings(value.market_allowlist),
    max_notional_bucket: isFundingAmountBucket(stringValue(value.max_notional_bucket))
      ? stringValue(value.max_notional_bucket) as GholaVenueSessionPolicy["max_notional_bucket"]
      : "25",
    max_order_count: numberValue(value.max_order_count) || 10,
    ttl_ms: numberValue(value.ttl_ms) || 30 * 60 * 1000,
    kill_switch: value.kill_switch === true,
    strategy_seed: "sealed_strategy_only",
    prompt_seed: "sealed_prompt_only",
  });
  const sessionCommitment = gholaCommitment("venue_agent_session", {
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: venueId,
    execution_mode: executionMode,
    vault_commitment: executionMode === "byo_api_key" ? vault?.vault_commitment : null,
    allocation_commitment: executionMode === "partner_omnibus" ? allocation?.allocation_commitment : null,
    policy_commitment: policy.policy_commitment,
  });
  return {
    version: 1,
    status: policy.kill_switch ? "stopped" as const : "armed" as const,
    account_commitment: account.account_commitment,
    venue_id: venueId,
    platform_class: platformClass,
    execution_mode: executionMode,
    vault_commitment: executionMode === "byo_api_key" ? vault?.vault_commitment : null,
    allocation_commitment: executionMode === "partner_omnibus" ? allocation?.allocation_commitment : null,
    agent_session_commitment: sessionCommitment,
    session_policy: publicVenueSessionPolicy(policy),
  };
}

export async function privateVenuesForOwner(owner: PrivateAccountRequestOwner) {
  const account = await createOrGetStoredPrivateAccount(owner);
  const manifests = listVenueManifests();
  const statuses = await Promise.all(manifests.map((manifest) =>
    venueReadinessForOwner(owner, manifest.venue_id, account)
  ));
  return {
    version: 1,
    account_commitment: account.account_commitment,
    venues: manifests.map((manifest, index) => ({
      manifest: publicVenueManifest(manifest),
      readiness: statuses[index],
    })),
  };
}

export async function venueReadinessForOwner(
  owner: PrivateAccountRequestOwner,
  venueId: GholaVenueId,
  existingAccount?: PrivateAccountRecordV1,
) {
  const account = existingAccount ?? await createOrGetStoredPrivateAccount(owner);
  const manifest = getVenueManifest(venueId);
  const [secretHandle, stealthAccount, pooledAllocation, evidence] = await Promise.all([
    getLatestVenueSecretHandleByAccount({
      account_commitment: account.account_commitment,
      venue_id: venueId,
    }),
    getLatestStealthVenueAccountByAccount({
      account_commitment: account.account_commitment,
      venue_id: venueId,
    }),
    getLatestPooledVenueAllocationByAccount({
      account_commitment: account.account_commitment,
      venue_id: venueId,
    }),
    getLatestAnonymityEvidence({ account_commitment: account.account_commitment }),
  ]);
  const fundingEvidenceReady = Boolean(
    evidence?.anonymity_set &&
      evidence.anonymity_set.effective >= evidence.anonymity_set.required &&
      evidence.anonymity_set.amount_bucketed &&
      evidence.anonymity_set.timing_window_met,
  );
  const stealthReady = stealthAccount?.status === "ready" || (
    stealthAccount?.status === "funding_required" && fundingEvidenceReady
  );
  const pooledReady = pooledAllocation?.status === "allocated";
  const status = pooledReady || stealthReady
    ? "ready"
    : secretHandle?.status === "sealed"
      ? "funding_required"
      : "setup_required";
  return {
    version: 1,
    venue_id: venueId,
    platform_class: manifest.platform_class,
    status,
    readiness_commitment: gholaCommitment("venue_readiness", {
      venue_id: venueId,
      account_commitment: account.account_commitment,
      manifest_commitment: manifest.manifest_commitment,
      status,
      secret_handle_commitment: secretHandle?.secret_handle_commitment ?? null,
      stealth_account_commitment: stealthAccount?.venue_account_commitment ?? null,
      pooled_allocation_commitment: pooledAllocation?.pooled_allocation_commitment ?? null,
      fundingEvidenceReady,
    }),
    supported_account_modes: manifest.supported_account_modes,
    default_account_mode: manifest.default_account_mode,
    claim_summary: {
      main_wallet_hidden_modes: manifest.main_wallet_hidden_modes,
      venue_account_hidden_modes: manifest.venue_account_hidden_modes,
      stealth_mode_claim: "main_wallet_hidden",
      pooled_mode_claim: "venue_account_hidden",
    },
    secret_handle: secretHandle ? publicVenueSecretHandle(secretHandle) : null,
    stealth_account: stealthAccount ? publicStealthVenueAccount(stealthAccount) : null,
    pooled_allocation: pooledAllocation ? publicPooledVenueAllocation(pooledAllocation) : null,
    funding_evidence_ready: fundingEvidenceReady,
    reason_codes: [
      ...(secretHandle ? [] : ["secret_handle_required"]),
      ...(stealthAccount || pooledAllocation ? [] : ["venue_account_required"]),
      ...(fundingEvidenceReady ? [] : ["private_funding_evidence_required"]),
      ...(venuePilotEnabled(venueId) ? [] : ["venue_live_submit_not_enabled"]),
    ],
  };
}

export async function createVenueSecretHandleFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
  venueId: GholaVenueId,
) {
  const value = objectBody(body);
  const account = await createOrGetStoredPrivateAccount(owner);
  const accountMode = venueAccountModeFromValue(value.account_mode) ?? "user_stealth";
  if (!getVenueManifest(venueId).supported_account_modes.includes(accountMode)) {
    return { error: "venue_account_mode_not_supported" as const };
  }
  const encryptedSecretCommitment =
    stringValue(value.encrypted_secret_commitment) ||
    encryptedSecretCommitmentFromBundle(value.encrypted_secret_bundle);
  const recipientCommitment =
    stringValue(value.sealed_runtime_recipient_commitment) ||
    recipientCommitmentFromBundle(value.encrypted_secret_bundle);
  if (!encryptedSecretCommitment || !recipientCommitment) {
    return { error: "encrypted_secret_commitment_required" as const };
  }
  const handle = createSecretHandle({
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: venueId,
    account_mode: accountMode,
    purpose: secretPurposeFromValue(value.purpose),
    encrypted_secret_commitment: encryptedSecretCommitment,
    sealed_runtime_recipient_commitment: recipientCommitment,
    rotation_epoch: numberValue(value.rotation_epoch),
  });
  const stored = await putVenueSecretHandle({
    version: 1,
    secret_handle_commitment: handle.secret_handle_commitment,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: handle.venue_id,
    platform_class: handle.platform_class,
    account_mode: handle.account_mode,
    purpose: handle.purpose,
    status: handle.status,
    secret_handle: handle,
    created_at: handle.created_at,
    updated_at: handle.updated_at,
  });
  return {
    version: 1,
    secret_handle: publicVenueSecretHandle(stored),
  };
}

export async function createStealthVenueAccountFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
  venueId: GholaVenueId,
) {
  const value = objectBody(body);
  const account = await createOrGetStoredPrivateAccount(owner);
  const secretHandleCommitment = stringValue(value.secret_handle_commitment);
  const secretHandle = secretHandleCommitment
    ? await getVenueSecretHandle(secretHandleCommitment)
    : await getLatestVenueSecretHandleByAccount({
        account_commitment: account.account_commitment,
        venue_id: venueId,
        account_mode: "user_stealth",
      });
  if (
    !secretHandle ||
    secretHandle.owner_commitment !== owner.owner_commitment ||
    secretHandle.account_commitment !== account.account_commitment ||
    secretHandle.venue_id !== venueId ||
    secretHandle.account_mode !== "user_stealth" ||
    secretHandle.status !== "sealed"
  ) {
    return { error: "sealed_stealth_secret_required" as const };
  }
  // Funding evidence is NO LONGER trusted as an opaque client string. A stealth
  // credential becomes funded only via a worker-signed attestation proving the
  // fresh credential was funded by Ghola's OWN shielded pool. A bare
  // funding_evidence_commitment string is ignored; an attestation that fails to
  // verify is a hard error (never silently downgraded to unfunded).
  let fundingEvidenceCommitment: string | null = null;
  const attestationInput = value.worker_funding_attestation;
  if (attestationInput && typeof attestationInput === "object") {
    const verification = verifyWorkerFundingAttestation(
      attestationInput as unknown as SignedWorkerFundingAttestation,
      stringValue(value.funding_destination_commitment),
      shieldedPoolConfig().min_confirmations,
      defaultEd25519Verify,
    );
    if (!verification.ok) {
      return { error: `funding_attestation_${verification.reason}` as const };
    }
    fundingEvidenceCommitment = verification.funding_evidence_commitment;
  }
  const venueAccount = createStealthVenueAccount({
    account_commitment: account.account_commitment,
    venue_id: venueId,
    secret_handle_commitment: secretHandle.secret_handle_commitment,
    funding_evidence_commitment: fundingEvidenceCommitment,
    rotation_epoch: secretHandle.secret_handle.rotation_epoch,
  });
  const stored = await putStealthVenueAccount({
    version: 1,
    venue_account_commitment: venueAccount.venue_account_commitment,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: venueAccount.venue_id,
    platform_class: venueAccount.platform_class,
    secret_handle_commitment: venueAccount.secret_handle_commitment,
    status: venueAccount.status,
    venue_account: venueAccount,
    created_at: venueAccount.created_at,
    updated_at: venueAccount.updated_at,
  });
  return {
    version: 1,
    venue_account: publicStealthVenueAccount(stored),
    readiness: await venueReadinessForOwner(owner, venueId, account),
  };
}

export async function allocatePooledVenueFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
  venueId: GholaVenueId,
) {
  const value = objectBody(body);
  const account = await createOrGetStoredPrivateAccount(owner);
  if (!getVenueManifest(venueId).supported_account_modes.includes("ghola_pooled")) {
    return { error: "pooled_mode_not_supported" as const };
  }
  const allocation = createPooledVenueAllocation({
    account_commitment: account.account_commitment,
    venue_id: venueId,
    funding_evidence_commitment: stringValue(value.funding_evidence_commitment) || null,
    utilization_bucket: isFundingAmountBucket(stringValue(value.utilization_bucket))
      ? stringValue(value.utilization_bucket) as "5" | "10" | "25" | "50" | "100"
      : "0",
  });
  const stored = await putPooledVenueAllocation({
    version: 1,
    pooled_allocation_commitment: allocation.pooled_allocation_commitment,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: allocation.venue_id,
    platform_class: allocation.platform_class,
    pool_commitment: allocation.pool_commitment,
    subledger_account_commitment: allocation.subledger_account_commitment,
    status: allocation.status,
    allocation,
    created_at: allocation.created_at,
    updated_at: allocation.updated_at,
  });
  return {
    version: 1,
    pooled_allocation: publicPooledVenueAllocation(stored),
    readiness: await venueReadinessForOwner(owner, venueId, account),
  };
}

export async function preflightVenueTradeFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
  venueId: GholaVenueId,
) {
  const value = objectBody(body);
  const accountMode = venueAccountModeFromValue(value.account_mode) ?? "user_stealth";
  const account = await createOrGetStoredPrivateAccount(owner);
  const manifest = getVenueManifest(venueId);
  const readiness = await venueReadinessForOwner(owner, venueId, account);
  const mainWalletHidden = accountMode !== "byo_account";
  const venueAccountHidden = accountMode === "ghola_pooled";
  const claimStatus = !manifest.supported_account_modes.includes(accountMode)
    ? "blocked"
    : readiness.status === "ready"
      ? "ready"
      : readiness.status === "funding_required"
        ? "waiting"
        : "setup_required";
  return {
    version: 1,
    preflight_commitment: gholaCommitment("venue_preflight", {
      owner_commitment: owner.owner_commitment,
      account_commitment: account.account_commitment,
      venue_id: venueId,
      account_mode: accountMode,
      readiness_commitment: readiness.readiness_commitment,
      claimStatus,
    }),
    venue_id: venueId,
    platform_class: manifest.platform_class,
    account_mode: accountMode,
    claim_status: claimStatus,
    main_wallet_hidden: mainWalletHidden,
    venue_account_hidden: venueAccountHidden,
    venue_sees: venueAccountHidden
      ? "pooled Ghola account and order"
      : accountMode === "user_stealth"
        ? "stealth venue account and order"
        : "connected user account and order",
    public_chain_sees: manifest.public_chain_sees,
    readiness,
  };
}

export async function reconcileVenueFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
  venueId: GholaVenueId,
) {
  const value = objectBody(body);
  const account = await createOrGetStoredPrivateAccount(owner);
  return {
    version: 1,
    venue_id: venueId,
    reconciliation_commitment: gholaCommitment("venue_reconciliation", {
      owner_commitment: owner.owner_commitment,
      account_commitment: account.account_commitment,
      venue_id: venueId,
      venue_account_commitment: stringValue(value.venue_account_commitment) || null,
      pooled_allocation_commitment: stringValue(value.pooled_allocation_commitment) || null,
      at: new Date().toISOString(),
    }),
    status: "queued",
  };
}

export async function omnibusStatusForOwner(owner: PrivateAccountRequestOwner) {
  const account = await createOrGetStoredPrivateAccount(owner);
  const allocation = await getOmnibusAllocationByAccount({
    account_commitment: account.account_commitment,
    venue_id: "coinbase_advanced",
  });
  return {
    version: 1,
    account_commitment: account.account_commitment,
    venue_id: "coinbase_advanced" as const,
    platform_class: "coinbase_style_provider" as const,
    partner_omnibus_enabled: process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_ENABLED === "true",
    pool_ready: process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_READY !== "false",
    allocation: allocation ? publicOmnibusAllocation(allocation) : null,
    ready: allocation?.status === "allocated",
  };
}

export async function allocateOmnibusFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
) {
  const value = objectBody(body);
  const account = await createOrGetStoredPrivateAccount(owner);
  const existing = await getOmnibusAllocationByAccount({
    account_commitment: account.account_commitment,
    venue_id: "coinbase_advanced",
  });
  if (existing?.status === "allocated" && value.force !== true) {
    return {
      version: 1,
      allocation: publicOmnibusAllocation(existing),
      ready: true,
    };
  }
  const imports = await listPrivateFundingImports(owner.owner_commitment, 5);
  const fundingCommitment = stringValue(value.settlement_funding_commitment) ||
    imports.find((item) => item.account_commitment === account.account_commitment && item.verifier_status === "verified")?.import_commitment ||
    null;
  const allocation = createOmnibusAllocation({
    account_commitment: account.account_commitment,
    settlement_funding_commitment: fundingCommitment,
    utilization_bucket: isFundingAmountBucket(stringValue(value.utilization_bucket))
      ? stringValue(value.utilization_bucket) as GholaOmnibusAllocation["utilization_bucket"]
      : fundingCommitment ? "5" : "0",
    pool_seed: process.env.GHOLA_COINBASE_PARTNER_OMNIBUS_POOL_ID || "coinbase-partner-pool-v1",
    partner_seed: process.env.GHOLA_COINBASE_PARTNER_ID || "partner-held-coinbase-v1",
  });
  const stored = await putOmnibusAllocation({
    version: 1,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    venue_id: allocation.venue_id,
    platform_class: allocation.platform_class,
    pool_commitment: allocation.pool_commitment,
    partner_commitment: allocation.partner_commitment,
    subledger_account_commitment: allocation.subledger_account_commitment,
    allocation_commitment: allocation.allocation_commitment,
    settlement_funding_commitment: allocation.settlement_funding_commitment,
    utilization_bucket: allocation.utilization_bucket,
    status: allocation.status,
    allocation,
    created_at: allocation.created_at,
    updated_at: allocation.updated_at,
  });
  return {
    version: 1,
    allocation: publicOmnibusAllocation(stored),
    ready: stored.status === "allocated",
  };
}

export async function reconcileOmnibusFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
) {
  const value = objectBody(body);
  const requested = stringValue(value.allocation_commitment);
  const account = await createOrGetStoredPrivateAccount(owner);
  const allocation = requested
    ? await getOmnibusAllocation(requested)
    : await getOmnibusAllocationByAccount({
        account_commitment: account.account_commitment,
        venue_id: "coinbase_advanced",
      });
  if (!allocation || allocation.owner_commitment !== owner.owner_commitment) {
    return { error: "omnibus_allocation_not_found" as const };
  }
  const nextStatus = value.pause === true
    ? "paused"
    : allocation.settlement_funding_commitment
      ? "allocated"
      : "pending_funding";
  const updatedAllocation = {
    ...allocation.allocation,
    status: nextStatus as GholaOmnibusAllocation["status"],
    updated_at: new Date().toISOString(),
  };
  const stored = await putOmnibusAllocation({
    ...allocation,
    status: updatedAllocation.status,
    allocation: updatedAllocation,
    updated_at: updatedAllocation.updated_at,
  });
  return {
    version: 1,
    allocation: publicOmnibusAllocation(stored),
    ready: stored.status === "allocated",
  };
}

function parseHyperliquidVaultAad(value: string): {
  account_commitment: string;
  recipient: string;
  network: "mainnet" | "testnet";
} | null {
  const [version, accountPart, recipientPart, networkPart] = value.split("|");
  if (version !== "ghola/hyperliquid-execution-vault-v1") return null;
  const account = accountPart?.startsWith("account:") ? accountPart.slice("account:".length) : "";
  const recipient = recipientPart?.startsWith("recipient:") ? recipientPart.slice("recipient:".length) : "";
  const network = networkPart?.startsWith("network:") ? networkPart.slice("network:".length) : "";
  if (!account || !recipient || (network !== "mainnet" && network !== "testnet")) return null;
  return {
    account_commitment: account,
    recipient,
    network,
  };
}

function parseVenueVaultAad(value: string): {
  venue_id: GholaVenueId;
  account_commitment: string;
  recipient: string;
  execution_mode: GholaVenueExecutionMode;
  network: "mainnet" | "sandbox";
} | null {
  const [version, accountPart, recipientPart, modePart, networkPart, venuePart] = value.split("|");
  const venueFromVersion = version === "ghola/coinbase-advanced-execution-vault-v1"
    ? "coinbase_advanced"
    : version === "ghola/solana-perps-execution-vault-v1"
      ? "phoenix"
      : null;
  if (!venueFromVersion) return null;
  const account = accountPart?.startsWith("account:") ? accountPart.slice("account:".length) : "";
  const recipient = recipientPart?.startsWith("recipient:") ? recipientPart.slice("recipient:".length) : "";
  const mode = modePart?.startsWith("mode:") ? modePart.slice("mode:".length) : "";
  const network = networkPart?.startsWith("network:") ? networkPart.slice("network:".length) : "";
  const explicitVenue = venuePart?.startsWith("venue:") ? venuePart.slice("venue:".length) : "";
  if (!account || !recipient) return null;
  if (
    venueFromVersion === "coinbase_advanced" &&
    (mode !== "byo_api_key" && mode !== "partner_omnibus")
  ) {
    return null;
  }
  if (
    venueFromVersion === "phoenix" &&
    (mode !== "user_stealth" && mode !== "ghola_pooled" && mode !== "byo_api_key")
  ) {
    return null;
  }
  if (network !== "mainnet" && network !== "sandbox") return null;
  if (venueFromVersion === "phoenix" && network !== "mainnet") return null;
  if (explicitVenue && explicitVenue !== venueFromVersion) return null;
  return {
    venue_id: venueFromVersion,
    account_commitment: account,
    recipient,
    execution_mode: mode as GholaVenueExecutionMode,
    network,
  };
}

async function currentPrivateAgentRecipientIds(): Promise<Set<string>> {
  const recipients = new Set<string>();
  if (process.env.GHOLA_ENABLE_MOCK_ATTESTED_PROVIDER === "true") {
    recipients.add("mock_attested:dev");
  }
  if (process.env.GHOLA_PRIVATE_AGENT_ATTESTED_READY === "true") {
    for (const value of [
      process.env.GHOLA_PRIVATE_AGENT_RECIPIENT_ID,
      process.env.PRIVATE_AGENT_RECIPIENT_ID,
      process.env.PHALA_ENCLAVE_KEY_ID,
      process.env.GHOLA_PRIVATE_AGENT_ENCLAVE_KEY_ID,
    ]) {
      if (value?.trim()) recipients.add(value.trim());
    }
  }
  if (process.env.GENSYN_CONFIDENTIAL_EXECUTION_READY === "true" && process.env.GENSYN_ENCLAVE_KEY_ID?.trim()) {
    recipients.add(process.env.GENSYN_ENCLAVE_KEY_ID.trim());
  }
  if (recipients.size > 0) return recipients;

  const runtime = await getPrivateAgentRuntimeStatus().catch(() => null);
  for (const provider of runtime?.providers ?? []) {
    if (providerReadyForPrivateAgents(provider) && provider.sealed_recipient?.recipient_id) {
      recipients.add(provider.sealed_recipient.recipient_id);
    }
  }
  return recipients;
}

export async function armHyperliquidAgentSessionFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
) {
  const value = objectBody(body);
  const account = await createOrGetStoredPrivateAccount(owner);
  const requestedMode = venueExecutionModeFromValue(value.execution_mode);
  const [vault, allocation] = await Promise.all([
    getHyperliquidExecutionVaultByAccount(account.account_commitment),
    getHyperliquidManagedAllocationByAccount(account.account_commitment),
  ]);
  const executionMode = requestedMode === "managed_testnet" || allocation?.status === "allocated"
    ? "managed_testnet" as const
    : "byo_api_key" as const;
  if (executionMode === "managed_testnet" && allocation?.status !== "allocated") {
    return { error: "hyperliquid_managed_allocation_not_ready" as const };
  }
  if (executionMode === "byo_api_key" && (!vault || vault.status !== "sealed")) {
    return { error: "venue_access_required" as const };
  }
  const policy = createHyperliquidSessionPolicy({
    market_allowlist: arrayOfStrings(value.market_allowlist),
    max_notional_bucket: isFundingAmountBucket(stringValue(value.max_notional_bucket))
      ? stringValue(value.max_notional_bucket) as GholaHyperliquidSessionPolicy["max_notional_bucket"]
      : "25",
    max_order_count: numberValue(value.max_order_count) || 10,
    ttl_ms: numberValue(value.ttl_ms) || 30 * 60 * 1000,
    kill_switch: value.kill_switch === true,
    strategy_seed: "sealed_strategy_only",
    prompt_seed: "sealed_prompt_only",
  });
  const sessionCommitment = gholaCommitment("hyperliquid_agent_session", {
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    execution_mode: executionMode,
    vault_commitment: executionMode === "byo_api_key" ? vault?.vault_commitment : null,
    allocation_commitment: executionMode === "managed_testnet" ? allocation?.allocation_commitment : null,
    policy_commitment: policy.policy_commitment,
  });
  return {
    version: 1,
    status: policy.kill_switch ? "stopped" as const : "armed" as const,
    account_commitment: account.account_commitment,
    execution_mode: executionMode,
    vault_commitment: executionMode === "byo_api_key" ? vault?.vault_commitment : null,
    allocation_commitment: executionMode === "managed_testnet" ? allocation?.allocation_commitment : null,
    agent_session_commitment: sessionCommitment,
    session_policy: publicHyperliquidSessionPolicy(policy),
  };
}

export async function privacyBudgetForOwner(owner: PrivateAccountRequestOwner) {
  const account = await createOrGetStoredPrivateAccount(owner);
  const budget = await getPrivacyBudget(account.account_commitment);
  return {
    version: 1,
    account_commitment: account.account_commitment,
    privacy_budget: budget?.budget ?? null,
  };
}

export async function fundingInstructionFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
) {
  const value = objectBody(body);
  const amountBucket = stringValue(value.amount_bucket) || "25";
  const assetBucket = stringValue(value.asset_bucket) || "stablecoin";
  if (!isFundingAmountBucket(amountBucket)) return { error: "valid amount_bucket is required" as const };
  if (!isFundingAssetBucket(assetBucket)) return { error: "valid asset_bucket is required" as const };
  const account = await createOrGetStoredPrivateAccount(owner);
  const now = new Date();
  const shieldedDestination = customShieldedDestination(account);
  const record: PrivateFundingInstructionRecordV1 = {
    version: 1,
    funding_intent_id: `pact_funding_${crypto.randomUUID()}`,
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    funding_intent_commitment: gholaCommitment("funding_intent", {
      account_commitment: account.account_commitment,
      amount_bucket: amountBucket,
      asset_bucket: assetBucket,
      created_at: now.toISOString(),
    }),
    asset_bucket: assetBucket,
    amount_bucket: amountBucket,
    shielded_rail: "custom_shielded_deposit",
    destination_commitment: gholaCommitment("funding_destination", shieldedDestination),
    shielded_destination: shieldedDestination,
    status: "pending",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    updated_at: now.toISOString(),
  };
  await putPrivateFundingInstruction(record);
  return {
    version: 1,
    instruction: publicFundingInstruction(record, true),
  };
}

export async function fundingImportFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
) {
  const value = objectBody(body);
  const fundingIntentId = stringValue(value.funding_intent_id);
  const receiptId = stringValue(value.receipt_id);
  if (!fundingIntentId) return { error: "funding_instruction_not_found" as const };
  if (!receiptId) return { error: "shielded_receipt_required" as const };
  const instruction = await getPrivateFundingInstruction(fundingIntentId);
  if (!instruction || instruction.owner_commitment !== owner.owner_commitment) {
    return { error: "funding_instruction_not_found" as const };
  }
  if (instruction.status === "imported") return { error: "funding_already_imported" as const };
  if (isPrivateAccountRecordExpired(instruction)) return { error: "funding_instruction_expired" as const };
  const verified = await verifyCustomShieldedDepositReceipt({ instruction, receipt_id: receiptId });
  if (!verified.ok) {
    await recordRejectedFundingImport({
      owner,
      instruction,
      receipt_id: receiptId,
      error: verified.error,
    });
    await putPrivateFundingInstruction({
      ...instruction,
      status: "rejected",
      updated_at: new Date().toISOString(),
    });
    return { error: verified.error };
  }
  const duplicate = await getPrivateFundingImportByNullifier(verified.result.nullifier_commitment);
  if (duplicate) return { error: "duplicate_nullifier" as const };
  const now = new Date().toISOString();
  const account = await getPrivateAccountByCommitment(instruction.account_commitment);
  if (!account) return { error: "account_not_found" as const };
  const importRecord: PrivateFundingImportRecordV1 = {
    version: 1,
    import_commitment: gholaCommitment("funding_import", {
      funding_intent_commitment: instruction.funding_intent_commitment,
      receipt_commitment: verified.result.receipt_commitment,
      nullifier_commitment: verified.result.nullifier_commitment,
    }),
    owner_commitment: owner.owner_commitment,
    account_commitment: instruction.account_commitment,
    funding_intent_id: instruction.funding_intent_id,
    funding_intent_commitment: instruction.funding_intent_commitment,
    receipt_commitment: verified.result.receipt_commitment,
    nullifier_commitment: verified.result.nullifier_commitment,
    note_root_commitment: gholaCommitment("note_root", {
      vault_root_commitment: account.vault_root_commitment,
      receipt_commitment: verified.result.receipt_commitment,
    }),
    amount_bucket: verified.result.amount_bucket,
    asset_bucket: verified.result.asset_bucket,
    shielded_rail: instruction.shielded_rail,
    verifier_status: "verified",
    verifier_commitment: verified.result.verifier_commitment,
    verifier_observed_at: verified.result.observed_at,
    verifier_head_commitment: verified.result.verifier_head_commitment,
    confirmation_depth: verified.result.confirmation_depth,
    network: verified.result.network,
    rejection_reason: null,
    imported_at: now,
  };
  await putPrivateFundingImport(importRecord);
  await putPrivateFundingInstruction({
    ...instruction,
    status: "imported",
    updated_at: now,
  });
  await markVaultImported({
    account,
    import_record: importRecord,
    now,
  });
  return {
    version: 1,
    import: publicFundingImport(importRecord),
    vault_ready: true,
  };
}

export async function fundingStatusForOwner(owner: PrivateAccountRequestOwner) {
  const account = await createOrGetStoredPrivateAccount(owner);
  const [instructions, imports, batches, vault, privacyHealth] = await Promise.all([
    listPrivateFundingInstructions(owner.owner_commitment, 10),
    listPrivateFundingImports(owner.owner_commitment, 20),
    listPrivateFundingBatches(owner.owner_commitment, 10),
    getPrivateVaultState(account.account_commitment),
    privateModeHealthBody(),
  ]);
  return {
    version: 1,
    account_commitment: account.account_commitment,
    vault_ready: account.vault_ready || Boolean(vault?.ready_rails.length),
    instructions: instructions.map((record) => publicFundingInstruction(record, false)),
    imports: imports.map(publicFundingImport),
    batches: batches.map(publicFundingBatch),
    health: privacyHealth,
  };
}

export async function fundingBatchRefreshFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
) {
  const value = objectBody(body);
  const queueId = stringValue(value.queue_id);
  const queued = queueId ? await getQueuedAction(queueId) : null;
  if (queueId && (!queued || queued.owner_commitment !== owner.owner_commitment)) {
    return { error: "queue_not_found" as const };
  }
  const result = await runPrivateFundingBatchCoordinator({
    owner_commitment: owner.owner_commitment,
    queue_id: queued?.queue_id,
  });
  const batch = queueId
    ? result.batches.find((item) => item.queue_id === queueId) ?? result.batches[0]
    : result.batches[0];
  if (!batch) return { error: "funding_import_not_found" as const };
  return {
    version: 1,
    batch: publicFundingBatch(batch),
    evidence_commitment: batch.evidence_commitment,
    run: publicBatchRun(result.run),
  };
}

export async function anonymityEvidenceFromBody(body: unknown) {
  const value = objectBody(body);
  const queueId = stringValue(value.queue_id);
  const intentId = stringValue(value.intent_id);
  const accountCommitment = stringValue(value.account_commitment);
  const source = stringValue(value.source) || "internal_test";
  if (!isEvidenceSource(source)) return { error: "valid evidence source is required" as const };

  const queued = queueId ? await getQueuedAction(queueId) : null;
  const intent = queued
    ? await getPrivateAccountIntent(queued.intent_id)
    : intentId
      ? await getPrivateAccountIntent(intentId)
      : null;
  const account = intent
    ? await getPrivateAccountByCommitment(intent.account_commitment)
    : accountCommitment
      ? await getPrivateAccountByCommitment(accountCommitment)
      : null;
  if (!account) return { error: "account_not_found" as const };

  const actionCommitment = queued?.action_commitment ||
    intent?.action_commitment ||
    stringValue(value.action_commitment) ||
    null;
  const resolvedQueueId = queued?.queue_id || queueId || null;
  const required = numberValue(value.required_anonymity_set) ||
    DEFAULT_ANONYMITY_SET_POLICY.consumer_min_effective_set;
  const anonymitySet: GholaAnonymitySetSummary = {
    required,
    effective: numberValue(value.effective_anonymity_set),
    solver_count: numberValue(value.solver_count) || undefined,
    amount_bucketed: value.amount_bucketed === true,
    timing_window_met: value.timing_window_met === true,
    uniqueness_score_bps: boundedBps(value.uniqueness_score_bps, 10_000),
    repeated_pattern_score_bps: boundedBps(value.repeated_pattern_score_bps, 0),
  };
  const now = new Date().toISOString();
  const record: PrivateAnonymityEvidenceRecordV1 = {
    version: 1,
    evidence_commitment: gholaCommitment("anon_evidence", {
      account_commitment: account.account_commitment,
      intent_id: intent?.intent_id ?? null,
      action_commitment: actionCommitment,
      queue_id: resolvedQueueId,
      source,
      anonymity_set: anonymitySet,
      created_at: now,
    }),
    owner_commitment: account.owner_commitment,
    account_commitment: account.account_commitment,
    intent_id: intent?.intent_id ?? null,
    action_commitment: actionCommitment,
    queue_id: resolvedQueueId,
    source,
    anonymity_set: anonymitySet,
    created_at: now,
    updated_at: now,
  };
  const stored = await putAnonymityEvidence(record);
  return {
    version: 1,
    evidence: publicAnonymityEvidenceSummary(stored),
  };
}

export async function queueActionFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const intentId = stringValue(value.intent_id);
  const previewCommitment = stringValue(value.preview_commitment);
  if (!intentId) return { error: "intent_not_found" as const };
  if (!previewCommitment) return { error: "preview_not_found" as const };
  const intent = await getPrivateAccountIntent(intentId);
  if (!intent || intent.owner_commitment !== owner.owner_commitment) return { error: "intent_not_found" as const };
  const preview = await getPrivateAccountPreview(previewCommitment);
  if (!preview || preview.owner_commitment !== owner.owner_commitment) return { error: "preview_not_found" as const };
  if (preview.claim_status !== "wait_for_anonymity") return { error: "preview_not_waiting" as const };
  const now = new Date();
  const record = await putQueuedAction({
    version: 1,
    queue_id: `pact_queue_${crypto.randomUUID()}`,
    owner_commitment: owner.owner_commitment,
    account_commitment: intent.account_commitment,
    intent_id: intent.intent_id,
    action_commitment: intent.action_commitment,
    latest_preview_commitment: preview.preview_commitment,
    platform_class: preview.platform_class,
    requested_rail: preview.selected_rail,
    wait_reasons: preview.preview.wait_reasons,
    target_anonymity_set: preview.preview.anonymity_set.required,
    current_anonymity_set: preview.preview.anonymity_set.effective,
    status: "queued",
    created_at: now.toISOString(),
    expires_at: intent.expires_at,
    updated_at: now.toISOString(),
  });
  return { version: 1, queued_action: publicQueueSummary(record) };
}

export async function listQueueForOwner(req: Request, owner: PrivateAccountRequestOwner) {
  const url = new URL(req.url);
  const limit = Number.parseInt(url.searchParams.get("limit") || "25", 10);
  const records = await listQueuedActions(owner.owner_commitment, limit);
  return {
    version: 1,
    queued_actions: records.map(publicQueueSummary),
  };
}

export async function refreshQueuedActionFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const queueId = stringValue(value.queue_id);
  if (!queueId) return { error: "queue_not_found" as const };
  const queued = await getQueuedAction(queueId);
  if (!queued || queued.owner_commitment !== owner.owner_commitment) return { error: "queue_not_found" as const };
  if (queued.status === "cancelled" || queued.status === "executed") return { error: `queue_${queued.status}` as const };
  if (isPrivateAccountRecordExpired(queued)) {
    await updateQueuedActionStatus(queued.queue_id, "expired");
    return { error: "queue_expired" as const };
  }
  const intent = await getPrivateAccountIntent(queued.intent_id);
  if (!intent || intent.owner_commitment !== owner.owner_commitment) return { error: "intent_not_found" as const };
  const account = await createOrGetStoredPrivateAccount(owner);
  const vault = await getPrivateVaultState(account.account_commitment);
  const budget = await getPrivacyBudget(account.account_commitment);
  const evidence = await getLatestAnonymityEvidence({
    account_commitment: intent.account_commitment,
    queue_id: queued.queue_id,
  }) ?? await getLatestAnonymityEvidence({
    account_commitment: intent.account_commitment,
    action_commitment: intent.action_commitment,
  });
  const evidenceContext = await evidenceContextForPreview({
    preview_commitment: "pending",
    evidence_commitment: evidence?.evidence_commitment ?? null,
  });
  const connectorContext = await connectorContextForIntent({
    owner,
    intent,
    platform_class: queued.platform_class,
    selected_rail: queued.requested_rail,
    evidence_ready: Boolean(evidenceContext.chain?.batch_evidence_commitment),
    runtime_envelope_commitment: stringValue(value.runtime_envelope_commitment),
    safe_input: safeConnectorInput(value.safe_input),
  });
  if ("error" in connectorContext) return connectorContext;
  const preview = previewPrivateAccountAction({
    account: {
      account_commitment: intent.account_commitment,
      vault_ready: account.vault_ready || Boolean(vault?.ready_rails.length),
    },
    action: {
      action_class: intent.action_class,
      action_commitment: intent.action_commitment,
      intent_commitment: intent.intent_commitment,
      policy_commitment: intent.policy_commitment,
      product_bucket: intent.product_bucket,
    },
    platform_class: queued.platform_class,
    requested_rail: queued.requested_rail,
    anonymity_set: evidence?.anonymity_set,
    privacy_budget: budget?.budget,
    evidence_status: evidenceContext.status,
    evidence_chain: evidenceContext.chain,
    connector_context: connectorContext.context,
    sealed_runtime_context: connectorContext.sealed_runtime_context,
    schedule_decision: connectorContext.schedule_decision,
    rotation: connectorContext.rotation,
    linkability_simulation: connectorContext.linkability_simulation,
    require_private_mode_evidence: true,
  });
  if (preview.evidence_chain) preview.evidence_chain.preview_commitment = preview.preview_commitment;
  const previewRecord = await putPrivateAccountPreview({
    version: 1,
    owner_commitment: owner.owner_commitment,
    preview_commitment: preview.preview_commitment,
    intent_id: intent.intent_id,
    account_commitment: preview.account_commitment,
    action_commitment: preview.action_commitment,
    platform_class: preview.platform_class,
    selected_rail: preview.selected_rail,
    claim_status: preview.claim_status,
    anonymity_level: preview.anonymity_level,
    preview,
    created_at: new Date().toISOString(),
    expires_at: preview.expires_at,
    consumed_at: null,
  });
  const updated = await putQueuedAction({
    ...queued,
    latest_preview_commitment: preview.preview_commitment,
    wait_reasons: preview.wait_reasons,
    current_anonymity_set: preview.anonymity_set.effective,
    status: isPrivateModeAvailableStatus(preview.claim_status) ? "ready" : "queued",
    updated_at: new Date().toISOString(),
  });
  return {
    version: 1,
    queued_action: publicQueueSummary(updated),
    preview: previewRecord.preview,
  };
}

export async function cancelQueuedActionFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const queueId = stringValue(value.queue_id);
  if (!queueId) return { error: "queue_not_found" as const };
  const queued = await getQueuedAction(queueId);
  if (!queued || queued.owner_commitment !== owner.owner_commitment) return { error: "queue_not_found" as const };
  await updateQueuedActionStatus(queued.queue_id, "cancelled");
  return { version: 1, queue_id: queued.queue_id, status: "cancelled" as const };
}

export async function listAuctionStateForOwner(req: Request, owner: PrivateAccountRequestOwner) {
  const url = new URL(req.url);
  const limit = Number.parseInt(url.searchParams.get("limit") || "25", 10);
  const [epochs, orders, clearings] = await Promise.all([
    listPrivateAuctionEpochs(owner.owner_commitment, limit),
    listPrivateAuctionOrders(owner.owner_commitment, limit),
    listPrivateAuctionClearings(owner.owner_commitment, limit),
  ]);
  return {
    version: 1,
    institutional_auction_readiness: institutionalAuctionReadinessStatus(),
    epochs: epochs.map(publicAuctionEpoch),
    orders: orders.map(publicAuctionOrder),
    clearings: clearings.map(publicAuctionClearing),
  };
}

export async function prepareAuctionMarketFromBody(body: unknown) {
  const value = objectBody(body);
  const signer = stringValue(value.signer_public_key);
  if (!signer) return { error: "auction_signer_required" as const };
  const required = requiredHex(value, [
    "market_commitment_hex",
    "asset_id_hex",
    "auction_verifier_key_hash_hex",
  ]);
  if ("error" in required) return required;
  const ownerCommitment = stringValue(value.owner_commitment) || "institutional_operator";
  const accountCommitment = stringValue(value.account_commitment) || ownerCommitment;
  const batchSize = integerValue(value.batch_size);
  const payload = {
    market_commitment: stringValue(value.market_commitment) || required.market_commitment_hex,
    market_commitment_hex: required.market_commitment_hex,
    asset_id_hex: required.asset_id_hex,
    auction_verifier_key_hash_hex: required.auction_verifier_key_hash_hex,
    batch_size: batchSize > 0 ? batchSize : 64,
  };
  const clientReference = clientReferenceForAuction(value, "init_market", ownerCommitment, payload);
  try {
    const prepared = await prepareAuctionInitMarketTransaction({
      signer_public_key: signer,
      market_commitment_hex: required.market_commitment_hex,
      asset_id_hex: required.asset_id_hex,
      auction_verifier_key_hash_hex: required.auction_verifier_key_hash_hex,
      batch_size: payload.batch_size as number,
      client_reference: clientReference,
    });
    const record = await putPreparedAuctionTransaction({
      prepared,
      owner_commitment: ownerCommitment,
      account_commitment: accountCommitment,
      payload,
      now: new Date(),
    });
    return preparedAuctionResponse(prepared, record);
  } catch (error) {
    return auctionOnChainError(error);
  }
}

export async function prepareAuctionOpenEpochFromBody(body: unknown) {
  const value = objectBody(body);
  const signer = stringValue(value.signer_public_key);
  if (!signer) return { error: "auction_signer_required" as const };
  const required = requiredHex(value, ["market_commitment_hex"]);
  if ("error" in required) return required;
  const epochId = integerValue(value.epoch_id);
  const closesSlot = integerValue(value.closes_slot);
  if (epochId < 0) return { error: "auction_epoch_id_required" as const };
  if (closesSlot <= 0) return { error: "auction_closes_slot_required" as const };
  const ownerCommitment = stringValue(value.owner_commitment) || "institutional_operator";
  const accountCommitment = stringValue(value.account_commitment) || ownerCommitment;
  const payload = {
    market_commitment: stringValue(value.market_commitment) || required.market_commitment_hex,
    market_commitment_hex: required.market_commitment_hex,
    platform_class: stringValue(value.platform_class) || "rfq_solver_network",
    asset_bucket: stringValue(value.asset_bucket) || "private_asset",
    amount_bucket: stringValue(value.amount_bucket) || "0",
    epoch_id: epochId,
    closes_slot: closesSlot,
    auction_epoch_commitment: stringValue(value.auction_epoch_commitment) ||
      gholaCommitment("auction_epoch_on_chain", {
        owner_commitment: ownerCommitment,
        market_commitment_hex: required.market_commitment_hex,
        epoch_id: epochId,
      }),
  };
  const clientReference = clientReferenceForAuction(value, "open_epoch", ownerCommitment, payload);
  try {
    const prepared = await prepareAuctionOpenEpochTransaction({
      signer_public_key: signer,
      market_commitment_hex: required.market_commitment_hex,
      epoch_id: epochId,
      closes_slot: closesSlot,
      client_reference: clientReference,
    });
    const record = await putPreparedAuctionTransaction({
      prepared,
      owner_commitment: ownerCommitment,
      account_commitment: accountCommitment,
      payload,
      now: new Date(),
    });
    return preparedAuctionResponse(prepared, record);
  } catch (error) {
    return auctionOnChainError(error);
  }
}

export async function commitAuctionOrderFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const queueId = stringValue(value.queue_id);
  if (!queueId) return { error: "queue_not_found" as const };
  const queued = await getQueuedAction(queueId);
  if (!queued || queued.owner_commitment !== owner.owner_commitment) return { error: "queue_not_found" as const };
  if (queued.status !== "queued" && queued.status !== "ready") return { error: `queue_${queued.status}` as const };
  if (queued.requested_rail !== "shielded_batch_auction") return { error: "auction_rail_required" as const };
  if (isPrivateAccountRecordExpired(queued)) {
    await updateQueuedActionStatus(queued.queue_id, "expired");
    return { error: "queue_expired" as const };
  }
  const intent = await getPrivateAccountIntent(queued.intent_id);
  if (!intent || intent.owner_commitment !== owner.owner_commitment) return { error: "intent_not_found" as const };
  if (!isAuctionEligibleAction(intent.action_class)) return { error: "auction_action_not_supported" as const };

  const side = auctionSideFromValue(value.side, intent.action_class);
  const assetBucket = auctionAssetBucket(value.asset_bucket, intent.product_bucket);
  const amountBucket = auctionAmountBucket(value.amount_bucket);
  if (institutionalAuctionOnChainPrepareRequired()) {
    return prepareProductionAuctionCommit({
      value,
      owner,
      queued,
      intent,
      side,
      assetBucket,
      amountBucket,
    });
  }

  const existing = await getPrivateAuctionOrderByQueue(queueId);
  if (existing && existing.owner_commitment === owner.owner_commitment) {
    const epoch = await getPrivateAuctionEpoch(existing.auction_epoch_commitment);
    return {
      version: 1,
      epoch: epoch ? publicAuctionEpoch(epoch) : null,
      order: publicAuctionOrder(existing),
      idempotent: true,
    };
  }

  const now = new Date();
  const account = await createOrGetStoredPrivateAccount(owner);
  const marketCommitment = gholaCommitment("auction_market", {
    platform_class: queued.platform_class,
    asset_bucket: assetBucket,
    amount_bucket: amountBucket,
  });
  let epoch = await getOpenPrivateAuctionEpoch({
    owner_commitment: owner.owner_commitment,
    platform_class: queued.platform_class,
    asset_bucket: assetBucket,
    amount_bucket: amountBucket,
    now,
  });
  if (!epoch) {
    const windowStart = new Date(Math.floor(now.getTime() / 600_000) * 600_000).toISOString();
    epoch = await putPrivateAuctionEpoch({
      version: 1,
      owner_commitment: owner.owner_commitment,
      account_commitment: account.account_commitment,
      auction_epoch_commitment: gholaCommitment("auction_epoch", {
        owner_commitment: owner.owner_commitment,
        account_commitment: account.account_commitment,
        market_commitment: marketCommitment,
        window_start: windowStart,
      }),
      market_commitment: marketCommitment,
      platform_class: queued.platform_class,
      asset_bucket: assetBucket,
      amount_bucket: amountBucket,
      status: "open",
      order_count: 0,
      matched_count: 0,
      rolled_count: 0,
      opened_at: now.toISOString(),
      closes_at: new Date(now.getTime() + 600_000).toISOString(),
      updated_at: now.toISOString(),
    });
  }

  const order: PrivateAuctionOrderRecordV1 = {
    version: 1,
    owner_commitment: owner.owner_commitment,
    account_commitment: queued.account_commitment,
    auction_order_commitment: gholaCommitment("auction_order", {
      queue_id: queued.queue_id,
      intent_id: intent.intent_id,
      action_commitment: intent.action_commitment,
      auction_epoch_commitment: epoch.auction_epoch_commitment,
      side,
      asset_bucket: assetBucket,
      amount_bucket: amountBucket,
    }),
    auction_epoch_commitment: epoch.auction_epoch_commitment,
    queue_id: queued.queue_id,
    intent_id: intent.intent_id,
    action_commitment: intent.action_commitment,
    action_class: intent.action_class,
    platform_class: queued.platform_class,
    side,
    asset_bucket: assetBucket,
    amount_bucket: amountBucket,
    status: "committed",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const storedOrder = await putPrivateAuctionOrder(order);
  const epochOrders = await listPrivateAuctionOrdersByEpoch(epoch.auction_epoch_commitment);
  const updatedEpoch = await putPrivateAuctionEpoch({
    ...epoch,
    order_count: Math.max(epoch.order_count, epochOrders.length),
    updated_at: now.toISOString(),
  });
  return {
    version: 1,
    epoch: publicAuctionEpoch(updatedEpoch),
    order: publicAuctionOrder(storedOrder),
  };
}

export async function closeAuctionEpochFromBody(body: unknown) {
  const value = objectBody(body);
  if (institutionalAuctionOnChainPrepareRequired()) {
    return prepareProductionAuctionClose(value);
  }

  const auctionEpochCommitment = stringValue(value.auction_epoch_commitment);
  if (!auctionEpochCommitment) return { error: "auction_epoch_not_found" as const };
  const epoch = await getPrivateAuctionEpoch(auctionEpochCommitment);
  if (!epoch) return { error: "auction_epoch_not_found" as const };
  const existing = await getPrivateAuctionClearingByEpoch(epoch.auction_epoch_commitment);
  if (existing) {
    return {
      version: 1,
      epoch: publicAuctionEpoch(epoch),
      clearing: publicAuctionClearing(existing),
      idempotent: true,
    };
  }

  const now = new Date().toISOString();
  const orders = await listPrivateAuctionOrdersByEpoch(epoch.auction_epoch_commitment);
  const committed = orders.filter((order) => order.status === "committed");
  const buys = committed.filter((order) => order.side === "buy");
  const sells = committed.filter((order) => order.side === "sell");
  const pairCount = Math.min(buys.length, sells.length);
  const matched = [...buys.slice(0, pairCount), ...sells.slice(0, pairCount)]
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const matchedSet = new Set(matched.map((order) => order.auction_order_commitment));
  const rolled = committed.filter((order) => !matchedSet.has(order.auction_order_commitment));
  await Promise.all([
    ...matched.map((order) => putPrivateAuctionOrder({ ...order, status: "matched", updated_at: now })),
    ...rolled.map((order) => putPrivateAuctionOrder({ ...order, status: "rolled", updated_at: now })),
  ]);
  const matchedOrderCommitments = matched.map((order) => order.auction_order_commitment);
  const rolledOrderCommitments = rolled.map((order) => order.auction_order_commitment);
  const clearingPriceCommitment = stringValue(value.clearing_price_commitment) ||
    gholaCommitment("auction_uniform_clearing_price", {
      auction_epoch_commitment: epoch.auction_epoch_commitment,
      asset_bucket: epoch.asset_bucket,
      amount_bucket: epoch.amount_bucket,
      matched_order_commitments: [...matchedOrderCommitments].sort(),
    });
  const proofCommitment = stringValue(value.proof_commitment) ||
    gholaCommitment("auction_clearing_proof", {
      auction_epoch_commitment: epoch.auction_epoch_commitment,
      clearing_price_commitment: clearingPriceCommitment,
      matched_order_commitments: matchedOrderCommitments,
      rolled_order_commitments: rolledOrderCommitments,
    });
  const clearing: PrivateAuctionClearingRecordV1 = {
    version: 1,
    owner_commitment: epoch.owner_commitment,
    account_commitment: epoch.account_commitment,
    clearing_commitment: gholaCommitment("auction_clearing", {
      auction_epoch_commitment: epoch.auction_epoch_commitment,
      clearing_price_commitment: clearingPriceCommitment,
      matched_order_commitments: matchedOrderCommitments,
      rolled_order_commitments: rolledOrderCommitments,
      proof_commitment: proofCommitment,
    }),
    auction_epoch_commitment: epoch.auction_epoch_commitment,
    status: "cleared",
    clearing_price_commitment: clearingPriceCommitment,
    matched_order_commitments: matchedOrderCommitments,
    rolled_order_commitments: rolledOrderCommitments,
    proof_commitment: proofCommitment,
    settlement_commitment: null,
    created_at: now,
    updated_at: now,
  };
  const storedClearing = await putPrivateAuctionClearing(clearing);
  const updatedEpoch = await putPrivateAuctionEpoch({
    ...epoch,
    status: "cleared",
    order_count: orders.length,
    matched_count: matchedOrderCommitments.length,
    rolled_count: rolledOrderCommitments.length,
    updated_at: now,
  });
  return {
    version: 1,
    epoch: publicAuctionEpoch(updatedEpoch),
    clearing: publicAuctionClearing(storedClearing),
  };
}

export async function settleAuctionClearingFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  if (institutionalAuctionOnChainPrepareRequired()) {
    return prepareProductionAuctionSettle(value, owner);
  }

  const clearingCommitment = stringValue(value.clearing_commitment);
  if (!clearingCommitment) return { error: "auction_clearing_not_found" as const };
  const clearing = await getPrivateAuctionClearing(clearingCommitment);
  if (!clearing || clearing.owner_commitment !== owner.owner_commitment) {
    return { error: "auction_clearing_not_found" as const };
  }
  if (clearing.status === "settled" && clearing.settlement_commitment) {
    const epoch = await getPrivateAuctionEpoch(clearing.auction_epoch_commitment);
    return {
      version: 1,
      epoch: epoch ? publicAuctionEpoch(epoch) : null,
      clearing: publicAuctionClearing(clearing),
      idempotent: true,
    };
  }

  const now = new Date().toISOString();
  const settlementCommitment = stringValue(value.settlement_commitment) ||
    gholaCommitment("auction_settlement", {
      clearing_commitment: clearing.clearing_commitment,
      owner_commitment: owner.owner_commitment,
      settled_at: now,
    });
  const updatedClearing = await putPrivateAuctionClearing({
    ...clearing,
    status: "settled",
    settlement_commitment: settlementCommitment,
    updated_at: now,
  });
  const orders = await listPrivateAuctionOrdersByEpoch(clearing.auction_epoch_commitment);
  const matchedSet = new Set(clearing.matched_order_commitments);
  await Promise.all(
    orders
      .filter((order) => matchedSet.has(order.auction_order_commitment))
      .map((order) => putPrivateAuctionOrder({ ...order, status: "settled", updated_at: now })),
  );
  const epoch = await getPrivateAuctionEpoch(clearing.auction_epoch_commitment);
  const updatedEpoch = epoch
    ? await putPrivateAuctionEpoch({ ...epoch, status: "settled", updated_at: now })
    : null;
  return {
    version: 1,
    epoch: updatedEpoch ? publicAuctionEpoch(updatedEpoch) : null,
    clearing: publicAuctionClearing(updatedClearing),
  };
}

async function prepareProductionAuctionCommit(input: {
  value: Record<string, unknown>;
  owner: PrivateAccountRequestOwner;
  queued: PrivateQueuedActionRecordV1;
  intent: PrivateAccountIntentRecordV1;
  side: GholaAuctionOrderSide;
  assetBucket: string;
  amountBucket: string;
}) {
  const signer = stringValue(input.value.signer_public_key);
  if (!signer) return { error: "auction_signer_required" as const };
  const required = requiredHex(input.value, [
    "market_commitment_hex",
    "order_commitment_hex",
    "order_nullifier_hex",
    "price_bucket_commitment_hex",
    "institution_policy_commitment_hex",
  ]);
  if ("error" in required) return required;
  const epochId = integerValue(input.value.epoch_id);
  if (epochId < 0) return { error: "auction_epoch_id_required" as const };
  const account = await createOrGetStoredPrivateAccount(input.owner);
  const now = new Date();
  const auctionEpochCommitment = stringValue(input.value.auction_epoch_commitment) ||
    gholaCommitment("auction_epoch_on_chain", {
      owner_commitment: input.owner.owner_commitment,
      market_commitment_hex: required.market_commitment_hex,
      epoch_id: epochId,
    });
  const auctionOrderCommitment = stringValue(input.value.auction_order_commitment) ||
    gholaCommitment("auction_order_on_chain", {
      queue_id: input.queued.queue_id,
      order_commitment_hex: required.order_commitment_hex,
    });
  const payload = {
    queue_id: input.queued.queue_id,
    intent_id: input.intent.intent_id,
    action_commitment: input.intent.action_commitment,
    action_class: input.intent.action_class,
    platform_class: input.queued.platform_class,
    side: input.side,
    asset_bucket: input.assetBucket,
    amount_bucket: input.amountBucket,
    market_commitment: stringValue(input.value.market_commitment) || required.market_commitment_hex,
    market_commitment_hex: required.market_commitment_hex,
    epoch_id: epochId,
    auction_epoch_commitment: auctionEpochCommitment,
    auction_order_commitment: auctionOrderCommitment,
    order_commitment_hex: required.order_commitment_hex,
  };
  const clientReference = clientReferenceForAuction(input.value, "commit_order", input.owner.owner_commitment, payload);
  try {
    const prepared = await prepareAuctionCommitOrderTransaction({
      signer_public_key: signer,
      market_commitment_hex: required.market_commitment_hex,
      epoch_id: epochId,
      order_commitment_hex: required.order_commitment_hex,
      order_nullifier_hex: required.order_nullifier_hex,
      price_bucket_commitment_hex: required.price_bucket_commitment_hex,
      institution_policy_commitment_hex: required.institution_policy_commitment_hex,
      side: input.side,
      amount_bucket: Number.parseInt(input.amountBucket, 10) || 0,
      client_reference: clientReference,
    });
    const record = await putPreparedAuctionTransaction({
      prepared,
      owner_commitment: input.owner.owner_commitment,
      account_commitment: account.account_commitment,
      payload,
      now,
    });
    return preparedAuctionResponse(prepared, record);
  } catch (error) {
    return auctionOnChainError(error);
  }
}

async function prepareProductionAuctionClose(value: Record<string, unknown>) {
  const signer = stringValue(value.signer_public_key);
  if (!signer) return { error: "auction_signer_required" as const };
  const required = requiredHex(value, [
    "market_commitment_hex",
    "proof_a_hex",
    "proof_b_hex",
    "proof_c_hex",
    "auction_order_root_hex",
    "clearing_commitment_hex",
    "clearing_price_commitment_hex",
    "matched_root_hex",
    "rolled_root_hex",
    "settlement_commitment_hex",
    "proof_commitment_hex",
  ]);
  if ("error" in required) return required;
  const epochId = integerValue(value.epoch_id);
  if (epochId < 0) return { error: "auction_epoch_id_required" as const };
  const ownerCommitment = stringValue(value.owner_commitment) || "institutional_operator";
  const accountCommitment = stringValue(value.account_commitment) || ownerCommitment;
  const payload = {
    auction_epoch_commitment: stringValue(value.auction_epoch_commitment) ||
      gholaCommitment("auction_epoch_on_chain", {
        owner_commitment: ownerCommitment,
        market_commitment_hex: required.market_commitment_hex,
        epoch_id: epochId,
      }),
    clearing_commitment: stringValue(value.clearing_commitment) ||
      gholaCommitment("auction_clearing_on_chain", required.clearing_commitment_hex),
    market_commitment: stringValue(value.market_commitment) || required.market_commitment_hex,
    market_commitment_hex: required.market_commitment_hex,
    epoch_id: epochId,
    clearing_price_commitment: stringValue(value.clearing_price_commitment) || required.clearing_price_commitment_hex,
    matched_order_commitments: stringArray(value.matched_order_commitments),
    rolled_order_commitments: stringArray(value.rolled_order_commitments),
    proof_commitment: stringValue(value.proof_commitment) || required.proof_commitment_hex,
    settlement_commitment: stringValue(value.settlement_commitment) || null,
    matched_count: integerValue(value.matched_count),
    rolled_count: integerValue(value.rolled_count),
  };
  const clientReference = clientReferenceForAuction(value, "close_epoch", ownerCommitment, payload);
  try {
    const prepared = await prepareAuctionCloseEpochTransaction({
      signer_public_key: signer,
      market_commitment_hex: required.market_commitment_hex,
      epoch_id: epochId,
      proof_a_hex: required.proof_a_hex,
      proof_b_hex: required.proof_b_hex,
      proof_c_hex: required.proof_c_hex,
      auction_order_root_hex: required.auction_order_root_hex,
      clearing_commitment_hex: required.clearing_commitment_hex,
      clearing_price_commitment_hex: required.clearing_price_commitment_hex,
      matched_root_hex: required.matched_root_hex,
      rolled_root_hex: required.rolled_root_hex,
      matched_count: integerValue(value.matched_count),
      rolled_count: integerValue(value.rolled_count),
      settlement_commitment_hex: required.settlement_commitment_hex,
      proof_commitment_hex: required.proof_commitment_hex,
      client_reference: clientReference,
    });
    const record = await putPreparedAuctionTransaction({
      prepared,
      owner_commitment: ownerCommitment,
      account_commitment: accountCommitment,
      payload,
      now: new Date(),
    });
    return preparedAuctionResponse(prepared, record);
  } catch (error) {
    return auctionOnChainError(error);
  }
}

async function prepareProductionAuctionSettle(
  value: Record<string, unknown>,
  owner: PrivateAccountRequestOwner,
) {
  const signer = stringValue(value.signer_public_key);
  if (!signer) return { error: "auction_signer_required" as const };
  const required = requiredHex(value, [
    "market_commitment_hex",
    "settlement_commitment_hex",
  ]);
  if ("error" in required) return required;
  const epochId = integerValue(value.epoch_id);
  if (epochId < 0) return { error: "auction_epoch_id_required" as const };
  const account = await createOrGetStoredPrivateAccount(owner);
  const payload = {
    auction_epoch_commitment: stringValue(value.auction_epoch_commitment) ||
      gholaCommitment("auction_epoch_on_chain", {
        owner_commitment: owner.owner_commitment,
        market_commitment_hex: required.market_commitment_hex,
        epoch_id: epochId,
      }),
    clearing_commitment: stringValue(value.clearing_commitment),
    market_commitment_hex: required.market_commitment_hex,
    epoch_id: epochId,
    settlement_commitment: stringValue(value.settlement_commitment) || required.settlement_commitment_hex,
  };
  const clientReference = clientReferenceForAuction(value, "settle_clearing", owner.owner_commitment, payload);
  try {
    const prepared = await prepareAuctionSettleClearingTransaction({
      signer_public_key: signer,
      market_commitment_hex: required.market_commitment_hex,
      epoch_id: epochId,
      settlement_commitment_hex: required.settlement_commitment_hex,
      client_reference: clientReference,
    });
    const record = await putPreparedAuctionTransaction({
      prepared,
      owner_commitment: owner.owner_commitment,
      account_commitment: account.account_commitment,
      payload,
      now: new Date(),
    });
    return preparedAuctionResponse(prepared, record);
  } catch (error) {
    return auctionOnChainError(error);
  }
}

export async function confirmAuctionTransactionFromBody(body: unknown, owner: PrivateAccountRequestOwner) {
  const value = objectBody(body);
  const clientReference = stringValue(value.client_reference);
  const signature = stringValue(value.signature);
  if (!clientReference) return { error: "auction_client_reference_required" as const };
  if (!signature) return { error: "auction_signature_required" as const };
  const prepared = await getPrivateAuctionPreparedTransaction(clientReference);
  if (!prepared || prepared.owner_commitment !== owner.owner_commitment) {
    return { error: "auction_prepared_transaction_not_found" as const };
  }
  return confirmPreparedAuctionTransaction(prepared, signature);
}

export async function confirmAuctionInternalTransactionFromBody(body: unknown) {
  const value = objectBody(body);
  const clientReference = stringValue(value.client_reference);
  const signature = stringValue(value.signature);
  if (!clientReference) return { error: "auction_client_reference_required" as const };
  if (!signature) return { error: "auction_signature_required" as const };
  const prepared = await getPrivateAuctionPreparedTransaction(clientReference);
  if (!prepared) return { error: "auction_prepared_transaction_not_found" as const };
  if (prepared.operation === "commit_order") {
    return { error: "auction_internal_confirmation_forbidden" as const };
  }
  return confirmPreparedAuctionTransaction(prepared, signature);
}

async function confirmPreparedAuctionTransaction(
  prepared: PrivateAuctionPreparedTransactionRecordV1,
  signature: string,
) {
  if (prepared.status === "confirmed") {
    return {
      version: 1,
      prepared_transaction: publicPreparedAuctionTransaction(prepared),
      idempotent: true,
    };
  }
  if (new Date(prepared.expires_at).getTime() <= Date.now()) {
    await putPrivateAuctionPreparedTransaction({
      ...prepared,
      status: "expired",
      updated_at: new Date().toISOString(),
    });
    return { error: "auction_prepared_transaction_expired" as const };
  }

  try {
    const confirmation = await verifyAuctionPreparedTransaction({ signature });
    const now = new Date().toISOString();
    const confirmed = await putPrivateAuctionPreparedTransaction({
      ...prepared,
      status: "confirmed",
      signature,
      updated_at: now,
    });
    const local = await applyConfirmedAuctionTransaction(confirmed, now);
    return {
      version: 1,
      confirmation,
      prepared_transaction: publicPreparedAuctionTransaction(confirmed),
      ...local,
    };
  } catch (error) {
    return auctionOnChainError(error);
  }
}

async function putPreparedAuctionTransaction(input: {
  prepared: {
    operation: GholaAuctionOnChainOperation;
    client_reference: string;
    transaction_base64: string;
  };
  owner_commitment: string;
  account_commitment: string;
  payload: Record<string, unknown>;
  now: Date;
}) {
  return putPrivateAuctionPreparedTransaction({
    version: 1,
    client_reference: input.prepared.client_reference,
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    operation: input.prepared.operation,
    transaction_base64: input.prepared.transaction_base64,
    payload: input.payload,
    status: "prepared",
    signature: null,
    created_at: input.now.toISOString(),
    expires_at: new Date(input.now.getTime() + 10 * 60_000).toISOString(),
    updated_at: input.now.toISOString(),
  });
}

function preparedAuctionResponse(
  prepared: GholaPreparedAuctionTransaction,
  record: PrivateAuctionPreparedTransactionRecordV1,
) {
  return {
    version: 1,
    mode: "on_chain_prepare" as const,
    prepared_transaction: {
      ...prepared,
      expires_at: record.expires_at,
    },
    auction_readiness: institutionalAuctionReadinessStatus(),
  };
}

function publicPreparedAuctionTransaction(record: PrivateAuctionPreparedTransactionRecordV1) {
  return {
    version: 1,
    client_reference: record.client_reference,
    operation: record.operation,
    status: record.status,
    signature: record.signature,
    expires_at: record.expires_at,
    updated_at: record.updated_at,
  };
}

async function applyConfirmedAuctionTransaction(
  prepared: PrivateAuctionPreparedTransactionRecordV1,
  now: string,
) {
  if (prepared.operation === "init_market") {
    return {
      local_update: "auction_market_initialized" as const,
      auction_market: {
        market_commitment: payloadString(prepared.payload, "market_commitment") ||
          payloadString(prepared.payload, "market_commitment_hex"),
        market_commitment_hex: payloadString(prepared.payload, "market_commitment_hex"),
        asset_id_hex: payloadString(prepared.payload, "asset_id_hex"),
        auction_verifier_key_hash_hex: payloadString(prepared.payload, "auction_verifier_key_hash_hex"),
        batch_size: integerValue(prepared.payload.batch_size),
      },
    };
  }

  if (prepared.operation === "open_epoch") {
    const payload = prepared.payload;
    const auctionEpochCommitment = payloadString(payload, "auction_epoch_commitment");
    if (!auctionEpochCommitment) return { local_update: "skipped" as const };
    const existingEpoch = await getPrivateAuctionEpoch(auctionEpochCommitment);
    const epoch = await putPrivateAuctionEpoch({
      version: 1,
      owner_commitment: prepared.owner_commitment,
      account_commitment: prepared.account_commitment,
      auction_epoch_commitment: auctionEpochCommitment,
      market_commitment: payloadString(payload, "market_commitment") || payloadString(payload, "market_commitment_hex"),
      platform_class: payloadString(payload, "platform_class") as GholaPlatformClass,
      asset_bucket: payloadString(payload, "asset_bucket"),
      amount_bucket: payloadString(payload, "amount_bucket"),
      status: existingEpoch?.status ?? "open",
      order_count: existingEpoch?.order_count ?? 0,
      matched_count: existingEpoch?.matched_count ?? 0,
      rolled_count: existingEpoch?.rolled_count ?? 0,
      opened_at: existingEpoch?.opened_at ?? now,
      closes_at: existingEpoch?.closes_at ?? new Date(Date.now() + 10 * 60_000).toISOString(),
      updated_at: now,
    });
    return {
      local_update: "auction_epoch_opened" as const,
      epoch: publicAuctionEpoch(epoch),
    };
  }

  if (prepared.operation === "commit_order") {
    const payload = prepared.payload;
    const auctionEpochCommitment = payloadString(payload, "auction_epoch_commitment");
    const auctionOrderCommitment = payloadString(payload, "auction_order_commitment");
    if (!auctionEpochCommitment || !auctionOrderCommitment) {
      return { local_update: "skipped" as const };
    }
    const existingEpoch = await getPrivateAuctionEpoch(auctionEpochCommitment);
    const epoch = existingEpoch ?? await putPrivateAuctionEpoch({
      version: 1,
      owner_commitment: prepared.owner_commitment,
      account_commitment: prepared.account_commitment,
      auction_epoch_commitment: auctionEpochCommitment,
      market_commitment: payloadString(payload, "market_commitment") || payloadString(payload, "market_commitment_hex"),
      platform_class: payloadString(payload, "platform_class") as GholaPlatformClass,
      asset_bucket: payloadString(payload, "asset_bucket"),
      amount_bucket: payloadString(payload, "amount_bucket"),
      status: "open",
      order_count: 0,
      matched_count: 0,
      rolled_count: 0,
      opened_at: now,
      closes_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      updated_at: now,
    });
    const order = await putPrivateAuctionOrder({
      version: 1,
      owner_commitment: prepared.owner_commitment,
      account_commitment: prepared.account_commitment,
      auction_order_commitment: auctionOrderCommitment,
      auction_epoch_commitment: auctionEpochCommitment,
      queue_id: payloadString(payload, "queue_id"),
      intent_id: payloadString(payload, "intent_id"),
      action_commitment: payloadString(payload, "action_commitment"),
      action_class: payloadString(payload, "action_class") as GholaPrivateAccountActionClass,
      platform_class: payloadString(payload, "platform_class") as GholaPlatformClass,
      side: payloadString(payload, "side") as GholaAuctionOrderSide,
      asset_bucket: payloadString(payload, "asset_bucket"),
      amount_bucket: payloadString(payload, "amount_bucket"),
      status: "committed",
      created_at: now,
      updated_at: now,
    });
    const orders = await listPrivateAuctionOrdersByEpoch(auctionEpochCommitment);
    const updatedEpoch = await putPrivateAuctionEpoch({
      ...epoch,
      order_count: Math.max(epoch.order_count, orders.length),
      updated_at: now,
    });
    return {
      local_update: "auction_order_committed" as const,
      epoch: publicAuctionEpoch(updatedEpoch),
      order: publicAuctionOrder(order),
    };
  }

  if (prepared.operation === "close_epoch") {
    const payload = prepared.payload;
    const auctionEpochCommitment = payloadString(payload, "auction_epoch_commitment");
    const clearingCommitment = payloadString(payload, "clearing_commitment");
    if (!auctionEpochCommitment || !clearingCommitment) return { local_update: "skipped" as const };
    const matchedOrderCommitments = stringArray(payload.matched_order_commitments);
    const rolledOrderCommitments = stringArray(payload.rolled_order_commitments);
    const clearing = await putPrivateAuctionClearing({
      version: 1,
      owner_commitment: prepared.owner_commitment,
      account_commitment: prepared.account_commitment,
      clearing_commitment: clearingCommitment,
      auction_epoch_commitment: auctionEpochCommitment,
      status: "cleared",
      clearing_price_commitment: payloadString(payload, "clearing_price_commitment"),
      matched_order_commitments: matchedOrderCommitments,
      rolled_order_commitments: rolledOrderCommitments,
      proof_commitment: payloadString(payload, "proof_commitment"),
      settlement_commitment: payloadString(payload, "settlement_commitment") || null,
      created_at: now,
      updated_at: now,
    });
    const epoch = await getPrivateAuctionEpoch(auctionEpochCommitment);
    const updatedEpoch = epoch
      ? await putPrivateAuctionEpoch({
          ...epoch,
          status: "cleared",
          matched_count: matchedOrderCommitments.length,
          rolled_count: rolledOrderCommitments.length,
          updated_at: now,
        })
      : null;
    return {
      local_update: "auction_epoch_cleared" as const,
      epoch: updatedEpoch ? publicAuctionEpoch(updatedEpoch) : null,
      clearing: publicAuctionClearing(clearing),
    };
  }

  if (prepared.operation === "settle_clearing") {
    const payload = prepared.payload;
    const clearingCommitment = payloadString(payload, "clearing_commitment");
    const settlementCommitment = payloadString(payload, "settlement_commitment");
    const clearing = clearingCommitment ? await getPrivateAuctionClearing(clearingCommitment) : null;
    if (!clearing || !settlementCommitment) return { local_update: "skipped" as const };
    const updatedClearing = await putPrivateAuctionClearing({
      ...clearing,
      status: "settled",
      settlement_commitment: settlementCommitment,
      updated_at: now,
    });
    const epoch = await getPrivateAuctionEpoch(clearing.auction_epoch_commitment);
    const updatedEpoch = epoch ? await putPrivateAuctionEpoch({ ...epoch, status: "settled", updated_at: now }) : null;
    return {
      local_update: "auction_clearing_settled" as const,
      epoch: updatedEpoch ? publicAuctionEpoch(updatedEpoch) : null,
      clearing: publicAuctionClearing(updatedClearing),
    };
  }

  return { local_update: "skipped" as const };
}

function requiredHex(value: Record<string, unknown>, keys: string[]) {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const hex = stringValue(value[key]);
    if (!hex) return { error: `${key}_required` as const };
    out[key] = hex;
  }
  return out;
}

function clientReferenceForAuction(
  value: Record<string, unknown>,
  operation: GholaAuctionOnChainOperation,
  ownerCommitment: string,
  payload: Record<string, unknown>,
) {
  return stringValue(value.client_reference) ||
    gholaCommitment("auction_on_chain_prepare", {
      operation,
      owner_commitment: ownerCommitment,
      payload,
      nonce: stringValue(value.client_reference_nonce),
    });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function payloadString(payload: Record<string, unknown>, key: string): string {
  return typeof payload[key] === "string" ? payload[key] as string : "";
}

function integerValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : -1;
  }
  return -1;
}

function auctionOnChainError(error: unknown) {
  if (error instanceof AuctionOnChainError) return { error: error.code as string };
  return { error: "auction_on_chain_prepare_failed" as const };
}

export async function leakageMapFromBody(body: unknown) {
  const value = objectBody(body);
  const previewCommitment = stringValue(value.preview_commitment);
  if (previewCommitment) {
    const record = await getPrivateAccountPreview(previewCommitment);
    if (!record) return null;
    return { version: 1, simulated: false, leakage_map: record.preview.leakage_map };
  }
  const preview = buildPreviewFromBody(body);
  return preview ? { version: 1, simulated: true, leakage_map: preview.leakage_map } : null;
}

export async function platformReadinessBody(): Promise<PrivateAccountReadinessResponse> {
  const [health, env] = await Promise.all([
    fetchPaymentHealth(),
    connectorRuntimeEnv("hyperliquid_style_market"),
  ]);
  return privateAccountReadiness({ paymentHealth: health, env });
}

export async function privateModeHealthBody() {
  const now = new Date();
  const manifests = listConnectorManifests(now);
  const runtimeEnv = await connectorRuntimeEnv("hyperliquid_style_market");
  const [verifier, coordinator, shieldedPool, canarySummary, imports, runtime, connectorReadinessList] = await Promise.all([
    customShieldedVerifierHealth(now),
    privateModeCoordinatorHealth(now),
    shieldedPoolHealth(now),
    privateModeCanaryStatus(now),
    listAllPrivateFundingImports(1_000),
    Promise.resolve(sealedRuntimeHealth(now, runtimeEnv)),
    Promise.all(manifests.map((manifest) => connectorReadinessForManifest(manifest, now))),
  ]);
  await putRuntimeHealth({
    version: 1,
    runtime_health_commitment: runtime.runtime_health_commitment,
    health: runtime,
    created_at: runtime.observed_at,
  });
  const maxStaleMs = verifierConfig().max_stale_ms;
  const staleImports = imports.filter((record) =>
    record.verifier_status === "stale" ||
    now.getTime() - new Date(record.verifier_observed_at).getTime() > maxStaleMs
  ).length;
  const rejectedImports = imports.filter((record) => record.verifier_status !== "verified").length;
  const manifestsCurrent = connectorReadinessList.every((record) =>
    record.status !== "stale" && record.status !== "missing"
  );
  const productionGates = v6ProductionGateStatus({
    verifier_green: verifier.status === "green",
    manifests_current: manifestsCurrent,
    sealed_runtime_attested: runtime.status === "green" &&
      Boolean(runtime.runtime_attestation_commitment && runtime.runtime_policy_commitment),
    batch_coordinator_green: coordinator.status === "green",
    simulator_passed: true,
    forbidden_field_tests_passed: true,
  });
  const status = verifier.status === "green" &&
    coordinator.status === "green" &&
    shieldedPool.status === "green" &&
    canarySummary.status === "green" &&
    runtime.status === "green" &&
    productionGates.status === "green"
    ? "green"
    : "red";
  return {
    version: 1,
    status,
    private_mode_enabled: status === "green" &&
      productionGates.private_mode_enabled &&
      (shieldedPool.mode === "local_test" || canarySummary.production_enabled),
    production_enabled: canarySummary.production_enabled,
    production_enablement_reason: canarySummary.reason,
    verifier,
    coordinator,
    shielded_pool: shieldedPool,
    sealed_runtime: publicRuntimeHealth(runtime),
    canaries: canarySummary.canaries,
    v6_production_gates: productionGates,
    connector_gate_health: connectorReadinessList.map(publicConnectorReadiness),
    evidence_coordinator: {
      status: coordinator.status,
      lock: coordinator.lock,
      last_run_commitment: coordinator.last_run_commitment,
      last_run_at: coordinator.last_run_at,
    },
    stale_imports: staleImports,
    rejected_imports: rejectedImports,
    checked_at: now.toISOString(),
  };
}

export async function operationsStatusForOwner(owner: PrivateAccountRequestOwner) {
  const account = await createOrGetStoredPrivateAccount(owner);
  const [
    health,
    imports,
    batches,
    queue,
    receipts,
    settlements,
    connectorWorkOrders,
    connectorResults,
    linkabilityScores,
    platformRotations,
    linkabilitySimulations,
    auctionEpochs,
    auctionOrders,
    auctionClearings,
  ] = await Promise.all([
    privateModeHealthBody(),
    listPrivateFundingImports(owner.owner_commitment, 50),
    listPrivateFundingBatches(owner.owner_commitment, 50),
    listQueuedActions(owner.owner_commitment, 50),
    listPrivateAccountReceipts(owner.owner_commitment, 20),
    listPrivateSettlements(owner.owner_commitment, 20),
    listConnectorWorkOrders(owner.owner_commitment, 50),
    listConnectorResults(owner.owner_commitment, 50),
    listLinkabilityScores(owner.owner_commitment, 50),
    listPlatformRotations(owner.owner_commitment, 50),
    listLinkabilitySimulations(owner.owner_commitment, 50),
    listPrivateAuctionEpochs(owner.owner_commitment, 50),
    listPrivateAuctionOrders(owner.owner_commitment, 50),
    listPrivateAuctionClearings(owner.owner_commitment, 50),
  ]);
  const connectorHealth = await connectorReadinessSummaries();
  const enterpriseGate = enterpriseGateStatus();
  return {
    version: 1,
    account_commitment: account.account_commitment,
    health,
    institutional_auction_readiness: institutionalAuctionReadinessStatus(),
    enterprise_gate: enterpriseGate,
    connector_health: connectorHealth,
    connector_work_order_depth: connectorWorkOrders.filter((item) =>
      item.status === "prepared" || item.status === "submitted"
    ).length,
    connector_ready_count: connectorHealth.filter((item) => item.status === "ready").length,
    blocked_connectors: connectorHealth.filter((item) => item.status === "blocked"),
    stale_connectors: connectorHealth.filter((item) => item.status === "stale" || item.status === "missing"),
    queue_depth: queue.filter((item) => item.status === "queued").length,
    ready_queue_depth: queue.filter((item) => item.status === "ready").length,
    auction_open_count: auctionEpochs.filter((item) => item.status === "open").length,
    auction_cleared_count: auctionClearings.filter((item) => item.status === "cleared").length,
    auction_epochs: auctionEpochs.map(publicAuctionEpoch),
    auction_orders: auctionOrders.map(publicAuctionOrder),
    auction_clearings: auctionClearings.map(publicAuctionClearing),
    anonymity_set_health: batches[0]
      ? {
          effective: batches[0].effective_anonymity_set,
          required: batches[0].required_anonymity_set,
          status: batches[0].status,
        }
      : null,
    stale_imports: imports.filter((item) => item.verifier_status === "stale").map(publicFundingImport),
    rejected_imports: imports.filter((item) => item.verifier_status !== "verified").map(publicFundingImport),
    ready_evidence: batches.filter((item) => item.evidence_commitment).map(publicFundingBatch),
    stuck_batches: batches
      .filter((item) => item.status === "waiting" && item.timing_window_met && item.effective_anonymity_set < item.required_anonymity_set)
      .map(publicFundingBatch),
    canaries: health.canaries,
    settlement_evidence: settlements.map(publicSettlement),
    pending_settlements: settlements
      .filter((item) => item.lifecycle_status !== "finalized" && item.lifecycle_status !== "failed")
      .map(publicSettlement),
    failed_settlements: settlements
      .filter((item) => item.lifecycle_status === "failed")
      .map(publicSettlement),
    connector_work_orders: connectorWorkOrders.map(publicConnectorWorkOrderRecord),
    connector_results: connectorResults.map(publicConnectorResultRecord),
    connector_linkability: linkabilityScores.map(publicLinkabilityScoreRecord),
    platform_rotations: platformRotations.map((record) => publicPlatformRotation(record.rotation)),
    linkability_simulations: linkabilitySimulations.map((record) => ({
      ...publicLinkabilitySimulation(record.simulation),
      intent_id: record.intent_id,
      preview_commitment: record.preview_commitment,
    })),
    recent_batches: batches.map(publicFundingBatch),
    recent_receipts: receipts.map((record) => ({
      receipt_commitment: record.receipt_commitment,
      claim_status: record.receipt.claim_status,
      evidence_commitment: record.receipt.evidence_chain?.batch_evidence_commitment ?? null,
      execution_plan_commitment: record.receipt.execution_plan_commitment,
      settlement_commitment: record.receipt.settlement_commitment,
      manifest_commitment: record.receipt.manifest_commitment,
      connector_result_commitment: record.receipt.connector_result_commitment,
      runtime_envelope_commitment: record.receipt.runtime_envelope_commitment,
      schedule_commitment: record.receipt.schedule_commitment,
      rotation_commitment: record.receipt.rotation_commitment,
      simulator_commitment: record.receipt.simulator_commitment,
      claim_levels_achieved: record.receipt.claim_levels_achieved,
      created_at: record.created_at,
    })),
  };
}

export async function connectorManifestsBody() {
  const now = new Date();
  const manifests = listConnectorManifests(now);
  const readiness = await Promise.all(manifests.map((manifest) =>
    connectorReadinessForManifest(manifest, now)
  ));
  await Promise.all(manifests.map((manifest, index) =>
    putConnectorManifest({
      version: 1,
      manifest_commitment: manifest.manifest_commitment,
      platform_class: manifest.platform_class,
      manifest,
      status: readiness[index]?.status === "ready"
        ? "current"
        : readiness[index]?.status === "stale"
          ? "stale"
          : "blocked",
      created_at: now.toISOString(),
      expires_at: manifest.expires_at,
      updated_at: now.toISOString(),
    })
  ));
  return {
    version: 1,
    manifests: manifests.map(publicConnectorManifest),
  };
}

export async function connectorReadinessBody(body: unknown) {
  const value = objectBody(body);
  const platformClass = stringValue(value.platform_class);
  const manifests = isPlatformClass(platformClass)
    ? [getConnectorManifest(platformClass)]
    : listConnectorManifests();
  const readiness = await Promise.all(manifests.map((manifest) =>
    connectorReadinessForManifest(manifest)
  ));
  return {
    version: 1,
    readiness: readiness.map(publicConnectorReadiness),
  };
}

export async function compileConnectorIntentFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
) {
  const value = objectBody(body);
  const intentId = stringValue(value.intent_id);
  const platformClass = stringValue(value.platform_class);
  const requestedRail = stringValue(value.requested_rail);
  if (!intentId) return { error: "intent_not_found" as const };
  if (!isPlatformClass(platformClass)) return { error: "valid platform_class is required" as const };
  if (requestedRail && !isRailKind(requestedRail)) return { error: "valid requested_rail is required" as const };
  const intent = await getPrivateAccountIntent(intentId);
  if (!intent || intent.owner_commitment !== owner.owner_commitment) return { error: "intent_not_found" as const };
  const compiled = await connectorContextForIntent({
    owner,
    intent,
    platform_class: platformClass,
    selected_rail: requestedRail ? requestedRail as GholaRailKind : undefined,
    evidence_ready: false,
    runtime_envelope_commitment: stringValue(value.runtime_envelope_commitment),
    safe_input: safeConnectorInput(value.safe_input),
  });
  if ("error" in compiled) return compiled;
  return {
    version: 1,
    intent_id: intent.intent_id,
    manifest: publicConnectorManifest(compiled.manifest),
    readiness: publicConnectorReadiness(compiled.readiness),
    compiled_intent: publicCompiledIntent(compiled.compiled_intent),
    linkability_score: publicLinkabilityScore(compiled.linkability_score),
    connector_context: compiled.context,
    sealed_runtime_context: compiled.sealed_runtime_context,
    schedule_decision: compiled.schedule_decision,
    rotation: compiled.rotation,
    linkability_simulation: compiled.linkability_simulation,
    runtime_envelope: publicRuntimeEnvelope(compiled.runtime_envelope),
  };
}

export async function connectorSubmitFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
) {
  const value = objectBody(body);
  const intentId = stringValue(value.intent_id);
  const previewCommitment = stringValue(value.preview_commitment);
  const approvalCommitment = stringValue(value.approval_commitment);
  if (!intentId) return { error: "intent_not_found" as const };
  if (!previewCommitment) return { error: "preview_not_found" as const };
  if (!approvalCommitment) return { error: "approval_not_found" as const };
  const [intent, preview, approval] = await Promise.all([
    getPrivateAccountIntent(intentId),
    getPrivateAccountPreview(previewCommitment),
    getPrivateAccountApproval(approvalCommitment),
  ]);
  if (!intent || intent.owner_commitment !== owner.owner_commitment) return { error: "intent_not_found" as const };
  if (!preview || preview.owner_commitment !== owner.owner_commitment) return { error: "preview_not_found" as const };
  if (!approval || approval.owner_commitment !== owner.owner_commitment) return { error: "approval_not_found" as const };
  const canExecute = canExecutePrivateAccountAction({ intent, preview: preview.preview, approval });
  if (!canExecute.ok) return { error: canExecute.error };
  const planResult = await planForExecution({
    owner,
    intent,
    preview: preview.preview,
    approval,
  });
  if ("error" in planResult) return planResult;
  const submitted = await connectorForExecution({
    owner,
    intent,
    preview: preview.preview,
    approval_commitment: approval.approval_commitment,
    execution_plan_commitment: planResult.plan?.plan_commitment ?? null,
  });
  if ("error" in submitted) return submitted;
  return {
    version: 1,
    intent_id: intent.intent_id,
    work_order: submitted.work_order ? publicConnectorWorkOrder(submitted.work_order) : null,
    connector_result: submitted.result ? publicConnectorResult(submitted.result) : null,
  };
}

export async function connectorVerifyNoSubmitFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
  context: { site_origin?: string | null } = {},
) {
  const value = objectBody(body);
  const platformClass = stringValue(value.platform_class) || "solana_perps_market";
  const workOrderCommitment = stringValue(value.work_order_commitment);
  const encryptedInstruction = value.encrypted_execution_instruction_bundle;
  if (!isPlatformClass(platformClass)) return { error: "valid platform_class is required" as const };
  if (platformClass !== "solana_perps_market") return { error: "unsupported_platform" as const };
  if (!workOrderCommitment) return { error: "work_order_commitment_required" as const };
  if (!encryptedInstruction || typeof encryptedInstruction !== "object") {
    return { error: "encrypted_execution_instruction_required" as const };
  }

  const account = await createOrGetStoredPrivateAccount(owner);
  const venueId = venueIdForPlatformClass(platformClass);
  if (!venueId) return { error: "venue_not_supported" as const };
  const vault = await getVenueExecutionVaultByAccount({
    account_commitment: account.account_commitment,
    venue_id: venueId,
  });
  if (!vault || vault.owner_commitment !== owner.owner_commitment || vault.status !== "sealed") {
    return { error: "solana_perps_execution_vault_not_ready" as const };
  }

  const manifest = getConnectorManifest(platformClass);
  const connectorEnv = await connectorRuntimeEnv(platformClass);
  const readiness = await connectorReadiness({
    manifest,
    execution_vault_ready: true,
    execution_mode: vault.execution_mode,
    action_class: "trade_on_platform",
    omnibus_allocation_ready: false,
    shielded_funding_ready: false,
    runtime_health: sealedRuntimeHealth(undefined, connectorEnv),
    env: connectorEnv,
  });
  const verification = await verifyConnectorNoSubmit({
    platform_class: platformClass,
    manifest,
    readiness,
    work_order_commitment: workOrderCommitment,
    operation_class: "perp_limit_order",
    venue_execution_vault: vault.vault,
    encrypted_execution_instruction_bundle: encryptedInstruction,
    session_policy: {
      market_allowlist: ["SOL"],
      max_notional_bucket: "5",
      max_order_count: 5,
      kill_switch: false,
    },
    site_origin: context.site_origin ?? null,
    env: connectorEnv,
  });
  return {
    version: 1,
    account_commitment: account.account_commitment,
    readiness: publicConnectorReadiness(readiness),
    verification,
  };
}

export async function connectorReconcileFromBody(
  body: unknown,
  owner: PrivateAccountRequestOwner,
) {
  const value = objectBody(body);
  const workOrderCommitment = stringValue(value.work_order_commitment);
  const resultCommitment = stringValue(value.connector_result_commitment);
  const existingResult = resultCommitment ? await getConnectorResult(resultCommitment) : null;
  const workOrderRecord = workOrderCommitment
    ? await getConnectorWorkOrder(workOrderCommitment)
    : existingResult
      ? await getConnectorWorkOrder(existingResult.work_order_commitment)
      : null;
  if (!workOrderRecord || workOrderRecord.owner_commitment !== owner.owner_commitment) {
    return { error: "connector_work_order_not_found" as const };
  }
  const manifestRecord = await getConnectorManifestRecord(workOrderRecord.work_order.manifest_commitment);
  if (!manifestRecord) return { error: "connector_artifact_missing" as const };
  const reconciled = await reconcileConnectorResult({
    work_order: workOrderRecord.work_order,
    manifest: manifestRecord.manifest,
    existing_result: existingResult?.result ?? null,
  });
  const now = new Date().toISOString();
  await putConnectorWorkOrder({
    ...workOrderRecord,
    status: reconciled.status,
    work_order: {
      ...workOrderRecord.work_order,
      status: reconciled.status,
      updated_at: now,
    },
    updated_at: now,
  });
  const stored = await putConnectorResult({
    version: 1,
    connector_result_commitment: reconciled.connector_result_commitment,
    work_order_commitment: workOrderRecord.work_order_commitment,
    owner_commitment: owner.owner_commitment,
    intent_id: workOrderRecord.intent_id,
    platform_class: workOrderRecord.platform_class,
    status: reconciled.status,
    result: reconciled,
    created_at: reconciled.created_at,
    updated_at: reconciled.updated_at,
  });
  return {
    version: 1,
    work_order: publicConnectorWorkOrderRecord({
      ...workOrderRecord,
      status: reconciled.status,
      work_order: {
        ...workOrderRecord.work_order,
        status: reconciled.status,
        updated_at: now,
      },
      updated_at: now,
    }),
    connector_result: publicConnectorResultRecord(stored),
  };
}

export async function connectorOperationsForOwner(owner: PrivateAccountRequestOwner) {
  const [readiness, workOrders, results, linkability, rotations, simulations] = await Promise.all([
    connectorReadinessSummaries(),
    listConnectorWorkOrders(owner.owner_commitment, 100),
    listConnectorResults(owner.owner_commitment, 100),
    listLinkabilityScores(owner.owner_commitment, 100),
    listPlatformRotations(owner.owner_commitment, 100),
    listLinkabilitySimulations(owner.owner_commitment, 100),
  ]);
  return {
    version: 1,
    connector_health: readiness,
    work_order_depth: workOrders.filter((item) =>
      item.status === "prepared" || item.status === "submitted"
    ).length,
    rotation_required_count: rotations.filter((item) => item.rotation.status !== "ready").length,
    simulator_wait_or_block_count: simulations.filter((item) =>
      item.simulation.decision !== "proceed"
    ).length,
    stale_manifests: readiness.filter((item) => item.status === "stale" || item.status === "missing"),
    blocked_connectors: readiness.filter((item) => item.status === "blocked"),
    work_orders: workOrders.map(publicConnectorWorkOrderRecord),
    results: results.map(publicConnectorResultRecord),
    linkability: linkability.map(publicLinkabilityScoreRecord),
    rotations: rotations.map((record) => publicPlatformRotation(record.rotation)),
    simulations: simulations.map((record) => ({
      ...publicLinkabilitySimulation(record.simulation),
      intent_id: record.intent_id,
      preview_commitment: record.preview_commitment,
    })),
  };
}

export async function fundingBatchesForOwner(req: Request, owner: PrivateAccountRequestOwner) {
  const url = new URL(req.url);
  const limit = Number.parseInt(url.searchParams.get("limit") || "25", 10);
  const records = await listPrivateFundingBatches(owner.owner_commitment, limit);
  return {
    version: 1,
    batches: records.map(publicFundingBatch),
  };
}

export async function runFundingBatchCoordinatorFromBody(body: unknown) {
  const value = objectBody(body);
  const result = await runPrivateFundingBatchCoordinator({
    owner_commitment: stringValue(value.owner_commitment) || undefined,
    queue_id: stringValue(value.queue_id) || undefined,
  });
  return {
    version: 1,
    run: publicBatchRun(result.run),
    batches: result.batches.map(publicFundingBatch),
  };
}

async function fetchPaymentHealth() {
  const base =
    process.env.NEXT_PUBLIC_THUMPER_API_URL ||
    process.env.THUMPER_API_URL ||
    "https://thumper-cloud.onrender.com";
  try {
    const res = await fetch(new URL("/health/payments", base), {
      method: "GET",
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function bearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() || null : null;
}

function sessionCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  return match ? decodeURIComponent(match.slice(SESSION_COOKIE_NAME.length + 1)) : null;
}

function objectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function publicAccountSummary(
  record: PrivateAccountRecordV1,
  vault?: PrivateVaultStateRecordV1,
) {
  return {
    version: 1,
    account_commitment: record.account_commitment,
    session_commitment: record.session_commitment,
    turnkey_wallet_commitment: record.turnkey_wallet_commitment,
    vault_root_commitment: record.vault_root_commitment,
    note_root_commitment: record.note_root_commitment,
    nullifier_root_commitment: record.nullifier_root_commitment,
    platform_link_root: record.platform_link_root,
    policy_commitment: record.policy_commitment,
    privacy_mode: record.privacy_mode,
    claim_boundary: record.claim_boundary,
    vault_ready: record.vault_ready || Boolean(vault?.ready_rails.length),
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function publicVaultSummary(record: PrivateVaultStateRecordV1) {
  return {
    version: 1,
    account_commitment: record.account_commitment,
    vault_root_commitment: record.vault_root_commitment,
    note_root_commitment: record.note_root_commitment,
    nullifier_root_commitment: record.nullifier_root_commitment,
    balance_bucket_summary: record.balance_bucket_summary,
    ready_rails: record.ready_rails,
    last_import_commitment: record.last_import_commitment,
    updated_at: record.updated_at,
  };
}

function publicHyperliquidVault(record: PrivateHyperliquidVaultRecordV1) {
  return {
    version: 1,
    platform_class: "hyperliquid_style_market" as const,
    account_commitment: record.account_commitment,
    vault_commitment: record.vault_commitment,
    encrypted_vault_commitment: record.encrypted_vault_commitment,
    recipient_commitment: record.recipient_commitment,
    policy_commitment: record.policy_commitment,
    supported_operations: record.vault.supported_operations,
    blocked_operations: record.vault.blocked_operations,
    status: record.status,
    updated_at: record.updated_at,
  };
}

function publicHyperliquidManagedAllocation(record: PrivateHyperliquidManagedAllocationRecordV1) {
  return {
    version: 1,
    venue_id: "hyperliquid" as const,
    platform_class: "hyperliquid_style_market" as const,
    execution_mode: "managed_testnet" as const,
    network: "testnet" as const,
    account_commitment: record.account_commitment,
    allocation_commitment: record.allocation_commitment,
    policy_commitment: record.policy_commitment,
    pool_commitment: record.pool_commitment,
    subledger_account_commitment: record.subledger_account_commitment,
    status: record.status,
    session_policy: publicHyperliquidSessionPolicy(record.allocation.session_policy),
    allowed_operations: record.allocation.allowed_operations,
    blocked_operations: record.allocation.blocked_operations,
    visibility_summary: record.allocation.visibility_summary,
    updated_at: record.updated_at,
  };
}

function publicHyperliquidSessionPolicy(policy: GholaHyperliquidSessionPolicy) {
  return {
    version: 1,
    policy_commitment: policy.policy_commitment,
    market_allowlist: policy.market_allowlist,
    max_notional_bucket: policy.max_notional_bucket,
    max_order_count: policy.max_order_count,
    expires_at: policy.expires_at,
    kill_switch: policy.kill_switch,
    allowed_operations: policy.allowed_operations,
    blocked_operations: policy.blocked_operations,
    strategy_commitment: policy.strategy_commitment,
    prompt_commitment: policy.prompt_commitment,
    created_at: policy.created_at,
  };
}

async function requestHyperliquidManagedAllocation(input: {
  account_commitment: string;
  policy: GholaHyperliquidSessionPolicy;
  fallback: GholaHyperliquidManagedAllocation;
}): Promise<
  | { allocation: GholaHyperliquidManagedAllocation }
  | { error: "connector_endpoint_missing" | "hyperliquid_managed_allocation_failed" | "forbidden_public_field" }
> {
  if (localHyperliquidPilotEnabled()) {
    return { allocation: input.fallback };
  }
  const cfg = hyperliquidWorkerConfig();
  if (!cfg.url) return { error: "connector_endpoint_missing" };
  try {
    const res = await fetch(new URL("/hyperliquid/managed/allocations", cfg.url), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify({
        version: 1,
        account_commitment: input.account_commitment,
        policy_commitment: input.policy.policy_commitment,
        network: "testnet",
        session_policy: publicHyperliquidSessionPolicy(input.policy),
      }),
    });
    const body = objectBody(await res.json().catch(() => null));
    if (!res.ok) return { error: "hyperliquid_managed_allocation_failed" };
    if (containsForbiddenPublicPrivateAccountField(body)) {
      return { error: "forbidden_public_field" };
    }
    const allocation = normalizeHyperliquidManagedAllocation(body, input.fallback);
    const safe = assertPublicSafePrivateAccountArtifact(allocation);
    if (!safe.ok) return { error: safe.error };
    return { allocation };
  } catch {
    return { error: "hyperliquid_managed_allocation_failed" };
  }
}

function normalizeHyperliquidManagedAllocation(
  value: Record<string, unknown>,
  fallback: GholaHyperliquidManagedAllocation,
): GholaHyperliquidManagedAllocation {
  const sessionPolicyInput = objectBody(value.session_policy);
  const sessionPolicy = sessionPolicyInput.policy_commitment
    ? {
        ...fallback.session_policy,
        policy_commitment: stringValue(sessionPolicyInput.policy_commitment) || fallback.session_policy.policy_commitment,
        market_allowlist: arrayOfStrings(sessionPolicyInput.market_allowlist).length
          ? arrayOfStrings(sessionPolicyInput.market_allowlist)
          : fallback.session_policy.market_allowlist,
        max_notional_bucket: isFundingAmountBucket(stringValue(sessionPolicyInput.max_notional_bucket))
          ? stringValue(sessionPolicyInput.max_notional_bucket) as GholaHyperliquidSessionPolicy["max_notional_bucket"]
          : fallback.session_policy.max_notional_bucket,
        max_order_count: numberValue(sessionPolicyInput.max_order_count) || fallback.session_policy.max_order_count,
        expires_at: stringValue(sessionPolicyInput.expires_at) || fallback.session_policy.expires_at,
        kill_switch: sessionPolicyInput.kill_switch === true,
      }
    : fallback.session_policy;
  const status = stringValue(value.status);
  const createdAt = stringValue(value.created_at) || fallback.created_at;
  return {
    ...fallback,
    allocation_commitment: stringValue(value.allocation_commitment) || fallback.allocation_commitment,
    policy_commitment: stringValue(value.policy_commitment) || sessionPolicy.policy_commitment,
    pool_commitment: stringValue(value.pool_commitment) || fallback.pool_commitment,
    subledger_account_commitment: stringValue(value.subledger_account_commitment) || fallback.subledger_account_commitment,
    status: status === "paused" || status === "revoked" || status === "pending_funding"
      ? status
      : "allocated",
    session_policy: sessionPolicy,
    created_at: createdAt,
    updated_at: stringValue(value.updated_at) || createdAt,
  };
}

function normalizeHyperliquidAccountSnapshot(
  value: Record<string, unknown>,
  fallbackSource: "sealed_byo" | "ghola_managed" | "none",
) {
  const status = stringValue(value.status);
  const normalizedStatus = isHyperliquidAccountSnapshotStatus(status)
    ? status
    : "worker_unavailable";
  const source = stringValue(value.account_source);
  const equityBucket = stringValue(value.equity_bucket);
  return {
    version: 1,
    platform_class: "hyperliquid_style_market" as const,
    venue_id: "hyperliquid" as const,
    status: normalizedStatus,
    account_source: source === "sealed_byo" || source === "ghola_managed" || source === "none"
      ? source
      : fallbackSource,
    trading_enabled: value.trading_enabled === true && normalizedStatus === "ready_to_trade",
    equity_bucket: equityBucket === "none" || equityBucket === "low" || equityBucket === "ready"
      ? equityBucket
      : "unknown",
    position_count: Math.max(0, Math.min(100, Math.floor(numberValue(value.position_count) || 0))),
    open_order_count: Math.max(0, Math.min(100, Math.floor(numberValue(value.open_order_count) || 0))),
    last_checked_at: stringValue(value.last_checked_at) || new Date().toISOString(),
    next_step: stringValue(value.next_step) || hyperliquidSnapshotNextStep(normalizedStatus),
  };
}

function localHyperliquidAccountSnapshot(input: {
  status: "ready_to_trade" | "needs_funds" | "venue_access_required" | "worker_unavailable" | "private_mode_waiting";
  account_source: "sealed_byo" | "ghola_managed" | "none";
  trading_enabled: boolean;
  next_step: string;
}) {
  return {
    version: 1,
    platform_class: "hyperliquid_style_market" as const,
    venue_id: "hyperliquid" as const,
    status: input.status,
    account_source: input.account_source,
    trading_enabled: input.trading_enabled,
    equity_bucket: input.status === "ready_to_trade" ? "ready" as const : "unknown" as const,
    position_count: 0,
    open_order_count: 0,
    last_checked_at: new Date().toISOString(),
    next_step: input.next_step,
  };
}

function hyperliquidSnapshotStatusFromError(error: string) {
  if (error === "venue_access_required") return "venue_access_required" as const;
  if (error === "needs_funds") return "needs_funds" as const;
  return "worker_unavailable" as const;
}

function isHyperliquidAccountSnapshotStatus(value: string): value is
  | "ready_to_trade"
  | "needs_funds"
  | "venue_access_required"
  | "worker_unavailable"
  | "private_mode_waiting" {
  return value === "ready_to_trade" ||
    value === "needs_funds" ||
    value === "venue_access_required" ||
    value === "worker_unavailable" ||
    value === "private_mode_waiting";
}

function hyperliquidSnapshotNextStep(status: string) {
  if (status === "ready_to_trade") return "Preview trade.";
  if (status === "needs_funds") return "Add collateral on Hyperliquid, then check again.";
  if (status === "venue_access_required") return "Connect a Hyperliquid API wallet.";
  if (status === "private_mode_waiting") return "Wait for Private Mode evidence.";
  return "Wait for the private worker to come back online.";
}

function hyperliquidWorkerConfig() {
  return {
    url: process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL?.trim() || "",
    token: process.env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_TOKEN?.trim() || "",
  };
}

function localHyperliquidPilotEnabled() {
  return process.env.NODE_ENV === "test" || process.env.GHOLA_CONNECTOR_MODE === "local_test";
}

function publicVenueExecutionVault(record: PrivateVenueExecutionVaultRecordV1) {
  return {
    version: 1,
    venue_id: record.venue_id,
    platform_class: record.platform_class,
    execution_mode: record.execution_mode,
    account_mode: record.vault.account_mode,
    account_commitment: record.account_commitment,
    vault_commitment: record.vault_commitment,
    encrypted_vault_commitment: record.encrypted_vault_commitment,
    recipient_commitment: record.recipient_commitment,
    policy_commitment: record.policy_commitment,
    allocation_commitment: record.allocation_commitment,
    supported_operations: record.vault.supported_operations,
    blocked_operations: record.vault.blocked_operations,
    status: record.status,
    updated_at: record.updated_at,
  };
}

function publicVenueManifest(manifest: ReturnType<typeof getVenueManifest>) {
  return {
    version: manifest.version,
    venue_id: manifest.venue_id,
    platform_class: manifest.platform_class,
    label: manifest.label,
    supported_account_modes: manifest.supported_account_modes,
    default_account_mode: manifest.default_account_mode,
    supported_actions: manifest.supported_actions,
    supported_operations: manifest.supported_operations,
    supported_rails: manifest.supported_rails,
    main_wallet_hidden_modes: manifest.main_wallet_hidden_modes,
    venue_account_hidden_modes: manifest.venue_account_hidden_modes,
    venue_sees: manifest.venue_sees,
    public_chain_sees: manifest.public_chain_sees,
    minimum_anonymity_set: manifest.minimum_anonymity_set,
    pilot_max_notional_bucket: manifest.pilot_max_notional_bucket,
    blocked_operations: manifest.blocked_operations,
    manifest_commitment: manifest.manifest_commitment,
    expires_at: manifest.expires_at,
  };
}

function publicVenueSecretHandle(record: PrivateVenueSecretHandleRecordV1) {
  return {
    version: 1,
    secret_handle_commitment: record.secret_handle_commitment,
    account_commitment: record.account_commitment,
    venue_id: record.venue_id,
    platform_class: record.platform_class,
    account_mode: record.account_mode,
    purpose: record.purpose,
    sealed_runtime_recipient_commitment: record.secret_handle.sealed_runtime_recipient_commitment,
    encrypted_secret_commitment: record.secret_handle.encrypted_secret_commitment,
    policy_commitment: record.secret_handle.policy_commitment,
    rotation_epoch: record.secret_handle.rotation_epoch,
    status: record.status,
    updated_at: record.updated_at,
  };
}

function publicStealthVenueAccount(record: PrivateStealthVenueAccountRecordV1) {
  return {
    version: 1,
    venue_account_commitment: record.venue_account_commitment,
    account_commitment: record.account_commitment,
    venue_id: record.venue_id,
    platform_class: record.platform_class,
    account_mode: "user_stealth" as const,
    secret_handle_commitment: record.secret_handle_commitment,
    funding_evidence_commitment: record.venue_account.funding_evidence_commitment,
    rotation_epoch_commitment: record.venue_account.rotation_epoch_commitment,
    main_wallet_exposed: false,
    venue_account_visible_to_venue: true,
    status: record.status,
    updated_at: record.updated_at,
  };
}

function publicPooledVenueAllocation(record: PrivatePooledVenueAllocationRecordV1) {
  return {
    version: 1,
    pooled_allocation_commitment: record.pooled_allocation_commitment,
    account_commitment: record.account_commitment,
    venue_id: record.venue_id,
    platform_class: record.platform_class,
    account_mode: "ghola_pooled" as const,
    pool_commitment: record.pool_commitment,
    subledger_account_commitment: record.subledger_account_commitment,
    funding_evidence_commitment: record.allocation.funding_evidence_commitment,
    utilization_bucket: record.allocation.utilization_bucket,
    main_wallet_exposed: false,
    venue_account_visible_to_venue: false,
    status: record.status,
    updated_at: record.updated_at,
  };
}

function publicVenueSessionPolicy(policy: GholaVenueSessionPolicy) {
  return {
    version: 1,
    venue_id: policy.venue_id,
    execution_mode: policy.execution_mode,
    policy_commitment: policy.policy_commitment,
    market_allowlist: policy.market_allowlist,
    max_notional_bucket: policy.max_notional_bucket,
    max_order_count: policy.max_order_count,
    expires_at: policy.expires_at,
    kill_switch: policy.kill_switch,
    allowed_operations: policy.allowed_operations,
    blocked_operations: policy.blocked_operations,
    strategy_commitment: policy.strategy_commitment,
    prompt_commitment: policy.prompt_commitment,
    created_at: policy.created_at,
  };
}

function publicOmnibusAllocation(record: PrivateOmnibusAllocationRecordV1) {
  return {
    version: 1,
    venue_id: record.venue_id,
    platform_class: record.platform_class,
    execution_mode: "partner_omnibus" as const,
    account_commitment: record.account_commitment,
    pool_commitment: record.pool_commitment,
    partner_commitment: record.partner_commitment,
    subledger_account_commitment: record.subledger_account_commitment,
    allocation_commitment: record.allocation_commitment,
    settlement_funding_commitment: record.settlement_funding_commitment,
    utilization_bucket: record.utilization_bucket,
    status: record.status,
    supported_operations: record.allocation.supported_operations,
    blocked_operations: record.allocation.blocked_operations,
    updated_at: record.updated_at,
  };
}

function publicQueueSummary(record: PrivateQueuedActionRecordV1) {
  return {
    version: 1,
    queue_id: record.queue_id,
    account_commitment: record.account_commitment,
    intent_id: record.intent_id,
    action_commitment: record.action_commitment,
    latest_preview_commitment: record.latest_preview_commitment,
    platform_class: record.platform_class,
    requested_rail: record.requested_rail,
    wait_reasons: record.wait_reasons,
    target_anonymity_set: record.target_anonymity_set,
    current_anonymity_set: record.current_anonymity_set,
    status: record.status,
    expires_at: record.expires_at,
    updated_at: record.updated_at,
  };
}

function publicAnonymityEvidenceSummary(record: PrivateAnonymityEvidenceRecordV1) {
  return {
    version: 1,
    evidence_commitment: record.evidence_commitment,
    account_commitment: record.account_commitment,
    intent_id: record.intent_id,
    action_commitment: record.action_commitment,
    queue_id: record.queue_id,
    source: record.source,
    anonymity_set: record.anonymity_set,
    updated_at: record.updated_at,
  };
}

function publicFundingInstruction(
  record: PrivateFundingInstructionRecordV1,
  includeDestination: boolean,
) {
  return {
    version: 1,
    funding_intent_id: record.funding_intent_id,
    account_commitment: record.account_commitment,
    funding_intent_commitment: record.funding_intent_commitment,
    asset_bucket: record.asset_bucket,
    amount_bucket: record.amount_bucket,
    shielded_rail: record.shielded_rail,
    destination_commitment: record.destination_commitment,
    ...(includeDestination ? { shielded_destination: record.shielded_destination } : {}),
    status: record.status,
    expires_at: record.expires_at,
    updated_at: record.updated_at,
  };
}

function publicFundingImport(record: PrivateFundingImportRecordV1) {
  return {
    version: 1,
    import_commitment: record.import_commitment,
    account_commitment: record.account_commitment,
    funding_intent_id: record.funding_intent_id,
    funding_intent_commitment: record.funding_intent_commitment,
    receipt_commitment: record.receipt_commitment,
    nullifier_commitment: record.nullifier_commitment,
    note_root_commitment: record.note_root_commitment,
    amount_bucket: record.amount_bucket,
    asset_bucket: record.asset_bucket,
    shielded_rail: record.shielded_rail,
    verifier_status: record.verifier_status,
    imported_at: record.imported_at,
  };
}

function publicFundingBatch(record: PrivateFundingBatchRecordV1) {
  return {
    version: 1,
    batch_id: record.batch_id,
    account_commitment: record.account_commitment,
    queue_id: record.queue_id,
    action_commitment: record.action_commitment,
    selected_import_commitment: record.selected_import_commitment,
    amount_bucket: record.amount_bucket,
    asset_bucket: record.asset_bucket,
    network: record.network,
    shielded_rail: record.shielded_rail,
    import_commitments: record.import_commitments,
    effective_anonymity_set: record.effective_anonymity_set,
    required_anonymity_set: record.required_anonymity_set,
    timing_window_met: record.timing_window_met,
    evidence_commitment: record.evidence_commitment,
    status: record.status,
    updated_at: record.updated_at,
  };
}

function publicAuctionEpoch(record: PrivateAuctionEpochRecordV1) {
  return {
    version: 1,
    auction_epoch_commitment: record.auction_epoch_commitment,
    market_commitment: record.market_commitment,
    platform_class: record.platform_class,
    asset_bucket: record.asset_bucket,
    amount_bucket: record.amount_bucket,
    status: record.status,
    order_count: record.order_count,
    matched_count: record.matched_count,
    rolled_count: record.rolled_count,
    opened_at: record.opened_at,
    closes_at: record.closes_at,
    updated_at: record.updated_at,
  };
}

function publicAuctionOrder(record: PrivateAuctionOrderRecordV1) {
  return {
    version: 1,
    auction_order_commitment: record.auction_order_commitment,
    auction_epoch_commitment: record.auction_epoch_commitment,
    queue_id: record.queue_id,
    intent_id: record.intent_id,
    action_commitment: record.action_commitment,
    action_class: record.action_class,
    platform_class: record.platform_class,
    side: record.side,
    asset_bucket: record.asset_bucket,
    amount_bucket: record.amount_bucket,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function publicAuctionClearing(record: PrivateAuctionClearingRecordV1) {
  return {
    version: 1,
    clearing_commitment: record.clearing_commitment,
    auction_epoch_commitment: record.auction_epoch_commitment,
    status: record.status,
    clearing_price_commitment: record.clearing_price_commitment,
    matched_order_commitments: record.matched_order_commitments,
    rolled_order_commitments: record.rolled_order_commitments,
    proof_commitment: record.proof_commitment,
    settlement_commitment: record.settlement_commitment,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function publicBatchRun(record: {
  run_id: string;
  coordinator_commitment: string;
  status: string;
  accounts_scanned: number;
  queues_scanned: number;
  imports_scanned: number;
  batches_written: number;
  evidence_written: number;
  stale_imports: number;
  rejected_imports: number;
  error: string | null;
  updated_at: string;
}) {
  return {
    version: 1,
    run_id: record.run_id,
    coordinator_commitment: record.coordinator_commitment,
    status: record.status,
    accounts_scanned: record.accounts_scanned,
    queues_scanned: record.queues_scanned,
    imports_scanned: record.imports_scanned,
    batches_written: record.batches_written,
    evidence_written: record.evidence_written,
    stale_imports: record.stale_imports,
    rejected_imports: record.rejected_imports,
    error: record.error,
    updated_at: record.updated_at,
  };
}

function publicExecutionPlan(record: PrivateExecutionPlanRecordV1) {
  return {
    version: 1,
    plan_commitment: record.plan_commitment,
    intent_id: record.intent_id,
    preview_commitment: record.preview_commitment,
    account_commitment: record.account_commitment,
    action_commitment: record.action_commitment,
    status: record.status,
    selected_rail: record.selected_rail,
    settlement_kind: record.plan.settlement_kind,
    settlement_required: record.plan.settlement_required,
    shielded_pool_health_commitment: record.plan.shielded_pool_health_commitment,
    sealed_runtime_status: record.plan.sealed_runtime_status,
    evidence_chain_commitment: record.plan.evidence_chain_commitment,
    manifest_commitment: record.plan.manifest_commitment,
    connector_readiness_commitment: record.plan.connector_readiness_commitment,
    compiler_commitment: record.plan.compiler_commitment,
    linkability_score_commitment: record.plan.linkability_score_commitment,
    sandbox_policy_commitment: record.plan.sandbox_policy_commitment,
    runtime_envelope_commitment: record.plan.runtime_envelope_commitment,
    runtime_attestation_commitment: record.plan.runtime_attestation_commitment,
    runtime_health_commitment: record.plan.runtime_health_commitment,
    schedule_commitment: record.plan.schedule_commitment,
    rotation_commitment: record.plan.rotation_commitment,
    simulator_commitment: record.plan.simulator_commitment,
    claim_levels_achieved: record.plan.claim_levels_achieved,
    claim_levels_missing: record.plan.claim_levels_missing,
    rail_steps: record.plan.rail_steps,
    wait_reasons: record.plan.wait_reasons,
    blocked_reasons: record.plan.blocked_reasons,
    expires_at: record.expires_at,
    consumed_at: record.consumed_at,
  };
}

function publicSettlement(record: PrivateSettlementRecordV1) {
  return {
    version: 1,
    settlement_commitment: record.settlement_commitment,
    execution_commitment: record.execution_commitment,
    execution_plan_commitment: record.plan_commitment,
    preview_commitment: record.preview_commitment,
    approval_commitment: record.approval_commitment,
    rail_used: record.rail_used,
    network: record.evidence.network,
    lifecycle_status: record.lifecycle_status,
    root_commitment: record.root_commitment,
    proof_commitment: record.evidence.proof_commitment,
    witness_commitment: record.evidence.witness_commitment,
    relay_commitment: record.evidence.relay_status.relay_commitment,
    relay_status_commitment: record.evidence.relay_status.status_commitment,
    relay_status: record.evidence.relay_status.status,
    finality_commitment: record.evidence.finality_commitment,
    attestation_commitment: record.attestation_commitment,
    failure_reason: record.failure_reason,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function publicConnectorReadiness(record: GholaConnectorReadiness) {
  return {
    version: 1,
    platform_class: record.platform_class,
    status: record.status,
    mode: record.mode,
    manifest_commitment: record.manifest_commitment,
    connector_readiness_commitment: record.readiness_commitment,
    live_submit_enabled: record.live_submit_enabled,
    reason_codes: record.reason_codes,
    checked_at: record.checked_at,
  };
}

function publicCompiledIntent(record: GholaCompiledPrivateIntent) {
  return {
    version: 1,
    compiler_version: record.compiler_version,
    compiler_commitment: record.compiler_commitment,
    ticket_commitment: record.ticket_commitment,
    intent_id: record.intent_id,
    account_commitment: record.account_commitment,
    action_commitment: record.action_commitment,
    action_class: record.action_class,
    platform_class: record.platform_class,
    product_bucket: record.product_bucket,
    amount_bucket: record.amount_bucket,
    asset_bucket: record.asset_bucket,
    destination_class: record.destination_class,
    urgency_bucket: record.urgency_bucket,
    solver_count_bucket: record.solver_count_bucket,
    manifest_commitment: record.manifest_commitment,
    runtime_payload_policy: record.runtime_payload_policy,
    created_at: record.created_at,
  };
}

function publicLinkabilityScore(record: GholaLinkabilityScore) {
  return {
    version: 1,
    score_commitment: record.score_commitment,
    account_commitment: record.account_commitment,
    platform_class: record.platform_class,
    score_bps: record.score_bps,
    risk: record.risk,
    decision: record.decision,
    components: record.components,
    reason_codes: record.reason_codes,
    created_at: record.created_at,
  };
}

function publicLinkabilityScoreRecord(record: PrivateLinkabilityScoreRecordV1) {
  return {
    ...publicLinkabilityScore(record.score),
    intent_id: record.intent_id,
    amount_bucket: record.amount_bucket,
    asset_bucket: record.asset_bucket,
    destination_class: record.destination_class,
  };
}

function publicConnectorWorkOrder(record: GholaConnectorWorkOrder) {
  return {
    version: 1,
    work_order_commitment: record.work_order_commitment,
    intent_id: record.intent_id,
    account_commitment: record.account_commitment,
    action_commitment: record.action_commitment,
    preview_commitment: record.preview_commitment,
    approval_commitment: record.approval_commitment,
    execution_plan_commitment: record.execution_plan_commitment,
    platform_class: record.platform_class,
    selected_rail: record.selected_rail,
    manifest_commitment: record.manifest_commitment,
    connector_readiness_commitment: record.connector_readiness_commitment,
    compiler_commitment: record.compiler_commitment,
    linkability_score_commitment: record.linkability_score_commitment,
    platform_funding_account_commitment: record.platform_funding_account_commitment,
    rotation_commitment: record.rotation_commitment,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function publicConnectorWorkOrderRecord(record: PrivateConnectorWorkOrderRecordV1) {
  return publicConnectorWorkOrder(record.work_order);
}

function publicConnectorResult(record: GholaConnectorResult) {
  return {
    version: 1,
    connector_result_commitment: record.connector_result_commitment,
    work_order_commitment: record.work_order_commitment,
    platform_class: record.platform_class,
    status: record.status,
    provider_ref_commitment: record.provider_ref_commitment,
    result_commitment: record.result_commitment,
    visibility_summary: record.visibility_summary,
    reason: record.reason,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function publicConnectorResultRecord(record: PrivateConnectorResultRecordV1) {
  return {
    ...publicConnectorResult(record.result),
    intent_id: record.intent_id,
  };
}

function publicRuntimeEnvelope(record: GholaRuntimeEnvelope | null) {
  if (!record) return null;
  return {
    version: 1,
    runtime_envelope_commitment: record.runtime_envelope_commitment,
    intent_id: record.intent_id,
    account_commitment: record.account_commitment,
    action_commitment: record.action_commitment,
    platform_class: record.platform_class,
    encrypted_payload_commitment: record.encrypted_payload_commitment,
    payload_policy_commitment: record.payload_policy_commitment,
    created_at: record.created_at,
    expires_at: record.expires_at,
  };
}

function publicRuntimeHealth(record: GholaRuntimeHealth) {
  return {
    version: 1,
    status: record.status,
    mode: record.mode,
    runtime_health_commitment: record.runtime_health_commitment,
    runtime_attestation_commitment: record.runtime_attestation_commitment,
    runtime_measurement_commitment: record.runtime_measurement_commitment,
    runtime_policy_commitment: record.runtime_policy_commitment,
    observed_at: record.observed_at,
    reason: record.reason,
  };
}

function publicViewKey(record: GholaViewKey) {
  return {
    version: 1,
    view_key_commitment: record.view_key_commitment,
    scope: record.scope,
    audience_commitment: record.audience_commitment,
    created_at: record.created_at,
    expires_at: record.expires_at,
    revoked_at: record.revoked_at,
  };
}

function publicPrivateReceiptExport(record: GholaPrivateReceiptExport, includeCiphertext: boolean) {
  return {
    version: 1,
    private_export_commitment: record.private_export_commitment,
    receipt_commitment: record.receipt_commitment,
    view_key_commitment: record.view_key_commitment,
    encrypted_receipt_commitment: record.encrypted_receipt_commitment,
    encrypted_receipt_ciphertext: includeCiphertext ? record.encrypted_receipt_ciphertext : undefined,
    runtime_envelope_commitment: record.runtime_envelope_commitment,
    runtime_attestation_commitment: record.runtime_attestation_commitment,
    revocation_commitment: record.revocation_commitment,
    created_at: record.created_at,
    revoked_at: record.revoked_at,
  };
}

function publicPlatformRotation(record: GholaPlatformFundingRotation) {
  return {
    version: 1,
    rotation_commitment: record.rotation_commitment,
    platform_funding_account_commitment: record.platform_funding_account_commitment,
    rotation_epoch_commitment: record.rotation_epoch_commitment,
    reuse_count: record.reuse_count,
    withdrawal_destination_reuse_count: record.withdrawal_destination_reuse_count,
    status: record.status,
    reason_codes: record.reason_codes,
  };
}

function publicLinkabilitySimulation(record: GholaAdversarialLinkabilitySimulation) {
  return {
    version: 1,
    simulator_commitment: record.simulator_commitment,
    score_bps: record.score_bps,
    decision: record.decision,
    actors: record.actors,
    reason_codes: record.reason_codes,
    simulated_at: record.simulated_at,
  };
}

async function connectorReadinessSummaries() {
  const manifests = listConnectorManifests();
  const readiness = await Promise.all(manifests.map((manifest) =>
    connectorReadinessForManifest(manifest)
  ));
  return readiness.map(publicConnectorReadiness);
}

async function buildExecutionPlanForPreview(
  preview: { preview_commitment: string; evidence_chain: GholaPrivateModeEvidenceChain | null } & Parameters<typeof buildPrivateExecutionPlan>[0]["preview"],
): Promise<GholaPrivateExecutionPlan> {
  const health = await shieldedPoolHealth();
  const evidenceChain = preview.evidence_chain
    ? { ...preview.evidence_chain, preview_commitment: preview.preview_commitment }
    : null;
  return buildPrivateExecutionPlan({
    preview,
    shielded_pool_health: health,
    evidence_chain: evidenceChain,
  });
}

async function planForApproval(input: {
  owner: PrivateAccountRequestOwner;
  intent: PrivateAccountIntentRecordV1;
  preview: Parameters<typeof buildPrivateExecutionPlan>[0]["preview"];
  requested_plan_commitment?: string;
}): Promise<
  | { execution_plan_commitment: string | null }
  | { error: "private_execution_plan_not_found" | "private_execution_plan_mismatch" | "private_execution_plan_not_ready" | "wait_for_anonymity" }
> {
  if (!isPrivateModeAvailableStatus(input.preview.claim_status)) {
    if (!input.requested_plan_commitment) return { execution_plan_commitment: null };
  }
  const planRecord = input.requested_plan_commitment
    ? await getPrivateExecutionPlan(input.requested_plan_commitment)
    : await getPrivateExecutionPlanByPreview(input.preview.preview_commitment) ??
      await createExecutionPlanRecord(input.owner, input.intent, input.preview);
  if (!planRecord || planRecord.owner_commitment !== input.owner.owner_commitment) {
    return { error: "private_execution_plan_not_found" };
  }
  if (
    planRecord.intent_id !== input.intent.intent_id ||
    planRecord.preview_commitment !== input.preview.preview_commitment ||
    planRecord.action_commitment !== input.intent.action_commitment
  ) {
    return { error: "private_execution_plan_mismatch" };
  }
  if (isPrivateModeAvailableStatus(input.preview.claim_status) && planRecord.status !== "ready") {
    return { error: planRecord.status === "waiting" ? "wait_for_anonymity" : "private_execution_plan_not_ready" };
  }
  return { execution_plan_commitment: planRecord.plan_commitment };
}

async function planForExecution(input: {
  owner: PrivateAccountRequestOwner;
  intent: PrivateAccountIntentRecordV1;
  preview: Parameters<typeof buildPrivateExecutionPlan>[0]["preview"];
  approval: { execution_plan_commitment?: string | null; preview_commitment: string };
}): Promise<
  | { plan: PrivateExecutionPlanRecordV1 | null }
  | { error: "private_execution_plan_required" | "private_execution_plan_not_found" | "private_execution_plan_mismatch" | "private_execution_plan_not_ready" }
> {
  if (!isPrivateModeAvailableStatus(input.preview.claim_status)) return { plan: null };
  if (!input.approval.execution_plan_commitment) return { error: "private_execution_plan_required" };
  const plan = await getPrivateExecutionPlan(input.approval.execution_plan_commitment);
  if (!plan || plan.owner_commitment !== input.owner.owner_commitment) {
    return { error: "private_execution_plan_not_found" };
  }
  if (
    plan.intent_id !== input.intent.intent_id ||
    plan.preview_commitment !== input.preview.preview_commitment ||
    plan.action_commitment !== input.intent.action_commitment
  ) {
    return { error: "private_execution_plan_mismatch" };
  }
  if (plan.status !== "ready") return { error: "private_execution_plan_not_ready" };
  return { plan };
}

async function createExecutionPlanRecord(
  owner: PrivateAccountRequestOwner,
  intent: PrivateAccountIntentRecordV1,
  preview: Parameters<typeof buildPrivateExecutionPlan>[0]["preview"],
): Promise<PrivateExecutionPlanRecordV1> {
  const plan = await buildExecutionPlanForPreview(preview);
  return putPrivateExecutionPlan({
    version: 1,
    owner_commitment: owner.owner_commitment,
    plan_commitment: plan.plan_commitment,
    intent_id: intent.intent_id,
    preview_commitment: preview.preview_commitment,
    account_commitment: preview.account_commitment,
    action_commitment: preview.action_commitment,
    status: plan.status,
    selected_rail: plan.selected_rail,
    plan,
    created_at: plan.created_at,
    expires_at: plan.expires_at,
    consumed_at: null,
  });
}

async function settlementForExecution(input: {
  owner: PrivateAccountRequestOwner;
  plan: PrivateExecutionPlanRecordV1 | null;
  approval_commitment: string;
  execution_commitment: string;
  require_finalized?: boolean;
}): Promise<
  | { settlement: PrivateSettlementRecordV1 | null }
  | { error:
      | "private_execution_plan_not_ready"
      | "shielded_pool_unhealthy"
      | "sealed_runtime_unavailable"
      | "sealed_runtime_settlement_unavailable"
      | "settlement_evidence_malformed"
      | "settlement_not_finalized"
    }
> {
  if (!input.plan) return { settlement: null };
  const existing = await getPrivateSettlementByExecution(input.execution_commitment);
  if (existing) {
    if (input.require_finalized !== false && existing.lifecycle_status !== "finalized") {
      return { error: "settlement_not_finalized" };
    }
    return { settlement: existing };
  }
  const settled = await settlePrivateExecutionPlan({
    plan: input.plan.plan,
    approval_commitment: input.approval_commitment,
    execution_commitment: input.execution_commitment,
  });
  if (!settled.ok) return { error: settled.error };
  const now = new Date().toISOString();
  const record = await putPrivateSettlement({
    version: 1,
    owner_commitment: input.owner.owner_commitment,
    settlement_commitment: settled.evidence.settlement_commitment,
    execution_commitment: input.execution_commitment,
    plan_commitment: input.plan.plan_commitment,
    preview_commitment: input.plan.preview_commitment,
    approval_commitment: input.approval_commitment,
    rail_used: input.plan.selected_rail,
    lifecycle_status: settled.evidence.lifecycle_status,
    root_commitment: settled.evidence.root_commitment,
    witness_commitment: settled.evidence.witness_commitment,
    proof_commitment: settled.evidence.proof_commitment,
    relay_commitment: settled.evidence.relay_status.relay_commitment,
    finality_commitment: settled.evidence.finality_commitment,
    attestation_commitment: settled.evidence.attestation_commitment,
    failure_reason: settled.evidence.lifecycle_status === "failed"
      ? "settlement runtime reported failed"
      : null,
    evidence: settled.evidence,
    created_at: now,
    updated_at: now,
  });
  if (input.require_finalized !== false && record.lifecycle_status !== "finalized") {
    return { error: "settlement_not_finalized" };
  }
  return { settlement: record };
}

function privateActionExecutionCommitment(input: {
  intent_id: string;
  preview_commitment: string;
  approval_commitment: string;
  evidence_chain: GholaPrivateModeEvidenceChain | null;
  execution_plan_commitment: string | null;
}) {
  return gholaCommitment("exec", input);
}

async function evidenceContextForPreview(input: {
  preview_commitment: string;
  evidence_commitment: string | null;
}): Promise<{
  status: GholaPrivateModeEvidenceStatus;
  chain: GholaPrivateModeEvidenceChain | null;
}> {
  const [health, batch] = await Promise.all([
    privateModeHealthBody(),
    input.evidence_commitment
      ? getPrivateFundingBatchByEvidence(input.evidence_commitment)
      : Promise.resolve(null),
  ]);
  if (health.status !== "green") {
    const stale =
      health.verifier.reason?.includes("stale") ||
      health.coordinator.reason?.includes("stale") ||
      health.shielded_pool.reason?.includes("stale") ||
      health.canaries.some((item) => item.status === "stale");
    return {
      status: stale ? "stale" : "unhealthy",
      chain: null,
    };
  }
  const chain = evidenceChainFromBatch({
    batch,
    preview_commitment: input.preview_commitment,
  });
  return {
    status: chain ? "ready" : input.evidence_commitment ? "missing" : "missing",
    chain,
  };
}

async function evidenceChainForExecution(input: {
  preview: { preview_commitment: string; evidence_chain: GholaPrivateModeEvidenceChain | null };
  approval_commitment: string;
}): Promise<GholaPrivateModeEvidenceChain | null> {
  if (!input.preview.evidence_chain?.batch_evidence_commitment) return null;
  const health = await privateModeHealthBody();
  if (health.status !== "green") return null;
  const batch = await getPrivateFundingBatchByEvidence(input.preview.evidence_chain.batch_evidence_commitment);
  return evidenceChainFromBatch({
    batch,
    preview_commitment: input.preview.preview_commitment,
    approval_commitment: input.approval_commitment,
  });
}

function safeConnectorInput(value: unknown): ConnectorSafeIntentInput {
  const body = objectBody(value);
  return {
    product_bucket: stringValue(body.product_bucket) || undefined,
    amount_bucket: stringValue(body.amount_bucket) || undefined,
    asset_bucket: stringValue(body.asset_bucket) || undefined,
    destination_class: stringValue(body.destination_class) || undefined,
    urgency: stringValue(body.urgency) || undefined,
    solver_count_bucket: stringValue(body.solver_count_bucket) || undefined,
  };
}

async function viewKeyForPrivateExport(
  value: Record<string, unknown>,
  owner: PrivateAccountRequestOwner,
): Promise<
  | { view_key: GholaViewKey }
  | { error: "view_key_not_found" | "view_key_revoked" | "view_key_expired" }
> {
  const viewKeyCommitment = stringValue(value.view_key_commitment);
  if (viewKeyCommitment) {
    const stored = await getViewKey(viewKeyCommitment);
    if (!stored || stored.owner_commitment !== owner.owner_commitment) return { error: "view_key_not_found" };
    if (stored.view_key.revoked_at) return { error: "view_key_revoked" };
    if (stored.view_key.expires_at && new Date(stored.view_key.expires_at).getTime() <= Date.now()) {
      return { error: "view_key_expired" };
    }
    return { view_key: stored.view_key };
  }
  const requestedScope = stringValue(value.scope);
  const scope = requestedScope === "auditor_selective_disclosure"
    ? "auditor_selective_disclosure"
    : "user_private_receipt";
  const viewKey = createViewKey({
    owner_commitment: owner.owner_commitment,
    scope,
    audience_seed: stringValue(value.audience_seed) || owner.user.id,
    ttl_ms: ttlMsFromBody(value.ttl_ms, scope),
  });
  const stored = await putViewKey({
    version: 1,
    view_key_commitment: viewKey.view_key_commitment,
    owner_commitment: owner.owner_commitment,
    view_key: viewKey,
    created_at: viewKey.created_at,
    updated_at: viewKey.created_at,
  });
  return { view_key: stored.view_key };
}

function ttlMsFromBody(value: unknown, scope: GholaViewKey["scope"]): number | null {
  const requested = numberValue(value);
  if (requested > 0) return Math.min(requested, 90 * 24 * 60 * 60 * 1_000);
  return scope === "auditor_selective_disclosure" ? 7 * 24 * 60 * 60 * 1_000 : null;
}

async function connectorContextForIntent(input: {
  owner: PrivateAccountRequestOwner;
  intent: PrivateAccountIntentRecordV1;
  platform_class: GholaPlatformClass;
  selected_rail?: GholaRailKind;
  evidence_ready?: boolean;
  runtime_envelope_commitment?: string;
  safe_input?: ConnectorSafeIntentInput | null;
}): Promise<
  | {
      context: GholaConnectorPreviewContext;
      sealed_runtime_context: GholaSealedRuntimeContext;
      schedule_decision: GholaPrivacyScheduleDecision;
      rotation: GholaPlatformFundingRotation;
      linkability_simulation: GholaAdversarialLinkabilitySimulation;
      runtime_envelope: GholaRuntimeEnvelope;
      manifest: GholaConnectorManifest;
      readiness: GholaConnectorReadiness;
      compiled_intent: GholaCompiledPrivateIntent;
      linkability_score: GholaLinkabilityScore;
    }
  | { error: "connector_compile_failed" }
> {
  const now = new Date();
  const manifest = getConnectorManifest(input.platform_class, now);
  const connectorEnv = await connectorRuntimeEnv(input.platform_class);
  const runtimeHealth = sealedRuntimeHealth(now, connectorEnv);
  const hyperliquidVault = input.platform_class === "hyperliquid_style_market"
    ? await getHyperliquidExecutionVaultByAccount(input.intent.account_commitment)
    : null;
  const hyperliquidAllocation = input.platform_class === "hyperliquid_style_market"
    ? await getHyperliquidManagedAllocationByAccount(input.intent.account_commitment)
    : null;
  const venueId = venueIdForPlatformClass(input.platform_class);
  const usesVenueVault = input.platform_class === "coinbase_style_provider" ||
    input.platform_class === "solana_perps_market";
  const [venueVault, omnibusAllocation] = usesVenueVault
    ? await Promise.all([
        getVenueExecutionVaultByAccount({
          account_commitment: input.intent.account_commitment,
          venue_id: venueId,
        }),
        input.platform_class === "coinbase_style_provider"
          ? getOmnibusAllocationByAccount({
              account_commitment: input.intent.account_commitment,
              venue_id: "coinbase_advanced",
            })
          : Promise.resolve(null),
      ])
    : [null, null] as const;
  const executionMode: GholaVenueExecutionMode | undefined = venueId === "coinbase_advanced"
    ? omnibusAllocation?.status === "allocated"
      ? "partner_omnibus"
      : venueVault?.execution_mode ?? "partner_omnibus"
    : input.platform_class === "solana_perps_market"
      ? venueVault?.execution_mode ?? "user_stealth"
    : hyperliquidAllocation?.status === "allocated"
      ? "managed_testnet"
      : "byo_api_key";
  const readiness = await connectorReadiness({
    manifest,
    now,
    execution_vault_ready: usesVenueVault
      ? venueVault?.status === "sealed"
      : hyperliquidVault?.status === "sealed" || hyperliquidAllocation?.status === "allocated",
    execution_mode: executionMode,
    action_class: input.intent.action_class,
    omnibus_allocation_ready: omnibusAllocation?.status === "allocated",
    shielded_funding_ready: input.evidence_ready === true,
    runtime_health: runtimeHealth,
    env: connectorEnv,
  });
  await putConnectorManifest({
    version: 1,
    manifest_commitment: manifest.manifest_commitment,
    platform_class: manifest.platform_class,
    manifest,
    status: readiness.status === "ready"
      ? "current"
      : readiness.status === "stale"
        ? "stale"
        : "blocked",
    created_at: now.toISOString(),
    expires_at: manifest.expires_at,
    updated_at: now.toISOString(),
  });
  const compiled = compilePrivateConnectorIntent({
    intent_id: input.intent.intent_id,
    account_commitment: input.intent.account_commitment,
    action_commitment: input.intent.action_commitment,
    action_class: input.intent.action_class,
    platform_class: input.platform_class,
    product_bucket: input.intent.product_bucket,
    manifest,
    safe_input: input.safe_input,
    now,
  });
  if (!compiled.ok) return { error: "connector_compile_failed" };
  await putCompiledIntent({
    version: 1,
    compiler_commitment: compiled.compiled_intent.compiler_commitment,
    owner_commitment: input.owner.owner_commitment,
    intent_id: input.intent.intent_id,
    account_commitment: input.intent.account_commitment,
    action_commitment: input.intent.action_commitment,
    platform_class: input.platform_class,
    manifest_commitment: manifest.manifest_commitment,
    compiled_intent: compiled.compiled_intent,
    created_at: compiled.compiled_intent.created_at,
  });
  const selectedRail = input.selected_rail ?? connectorDefaultRail(input.platform_class);
  const sandbox = connectorSandboxPolicy({
    manifest,
    compiled_intent: compiled.compiled_intent,
    selected_rail: selectedRail,
  });
  const prior = (await listLinkabilityScores(input.owner.owner_commitment, 200))
    .filter((record) => record.intent_id !== input.intent.intent_id);
  const platformPrior = prior.filter((record) => record.platform_class === input.platform_class);
  const sameAmount = platformPrior.filter((record) =>
    record.amount_bucket === compiled.compiled_intent.amount_bucket
  );
  const sameAsset = platformPrior.filter((record) =>
    record.asset_bucket === compiled.compiled_intent.asset_bucket
  );
  const sameDestination = platformPrior.filter((record) =>
    record.destination_class === compiled.compiled_intent.destination_class
  );
  const sameSolver = input.platform_class === "rfq_solver_network"
    ? platformPrior.filter((record) =>
        record.score.reason_codes.includes("same_solver") ||
        record.score.platform_class === input.platform_class
      )
    : [];
  const linkabilityScore = scoreConnectorLinkability({
    account_commitment: input.intent.account_commitment,
    platform_class: input.platform_class,
    compiled_intent: compiled.compiled_intent,
    prior_platform_actions: platformPrior.length,
    same_amount_bucket_actions: sameAmount.length,
    same_asset_bucket_actions: sameAsset.length,
    reused_platform_funding_account: manifest.requires_omnibus_funding && platformPrior.length > 0,
    same_solver_actions: sameSolver.length,
    withdrawal_destination_reuse: input.intent.action_class === "withdraw" ? sameDestination.length : 0,
    repeated_timing_actions: platformPrior.length > 2 ? platformPrior.length - 2 : 0,
    now,
  });
  await putLinkabilityScore({
    version: 1,
    score_commitment: linkabilityScore.score_commitment,
    owner_commitment: input.owner.owner_commitment,
    account_commitment: input.intent.account_commitment,
    intent_id: input.intent.intent_id,
    platform_class: input.platform_class,
    amount_bucket: compiled.compiled_intent.amount_bucket,
    asset_bucket: compiled.compiled_intent.asset_bucket,
    destination_class: compiled.compiled_intent.destination_class,
    score: linkabilityScore,
    created_at: linkabilityScore.created_at,
  });
  const existingEnvelope = input.runtime_envelope_commitment
    ? await getRuntimeEnvelope(input.runtime_envelope_commitment)
    : await getRuntimeEnvelopeByIntent(input.intent.intent_id);
  const envelope = existingEnvelope?.owner_commitment === input.owner.owner_commitment
    ? existingEnvelope.envelope
    : (() => {
        const created = createRuntimeEnvelope({
          owner_commitment: input.owner.owner_commitment,
          intent_id: input.intent.intent_id,
          account_commitment: input.intent.account_commitment,
          action_commitment: input.intent.action_commitment,
          platform_class: input.platform_class,
          safe_input: input.safe_input,
          now,
        });
        if (!created.ok) return null;
        return created.envelope;
      })();
  if (!envelope) return { error: "connector_compile_failed" };
  await putRuntimeEnvelope({
    version: 1,
    runtime_envelope_commitment: envelope.runtime_envelope_commitment,
    owner_commitment: input.owner.owner_commitment,
    intent_id: input.intent.intent_id,
    account_commitment: input.intent.account_commitment,
    action_commitment: input.intent.action_commitment,
    platform_class: input.platform_class,
    envelope,
    created_at: envelope.created_at,
    expires_at: envelope.expires_at,
  });
  await putRuntimeHealth({
    version: 1,
    runtime_health_commitment: runtimeHealth.runtime_health_commitment,
    health: runtimeHealth,
    created_at: runtimeHealth.observed_at,
  });
  const runtimeContext = sealedRuntimeContext({
    envelope,
    health: runtimeHealth,
  });
  const rotation = platformFundingRotation({
    owner_commitment: input.owner.owner_commitment,
    account_commitment: input.intent.account_commitment,
    platform_class: input.platform_class,
    manifest,
    reuse_count: platformPrior.length,
    withdrawal_destination_reuse_count: input.intent.action_class === "withdraw" ? sameDestination.length : 0,
    now,
  });
  await putPlatformRotation({
    version: 1,
    rotation_commitment: rotation.rotation_commitment,
    owner_commitment: input.owner.owner_commitment,
    account_commitment: input.intent.account_commitment,
    platform_class: input.platform_class,
    rotation,
    created_at: now.toISOString(),
  });
  const simulation = adversarialLinkabilitySimulation({
    platform_class: input.platform_class,
    selected_rail: selectedRail,
    linkability_score: linkabilityScore,
    rotation,
    public_chain_visible: manifest.public_chain_sees === "visible" || selectedRail === "direct_public_fallback",
    platform_order_visible: manifest.order_details_visible,
    provider_account_visible: manifest.platform_sees === "account_visible",
    now,
  });
  await putLinkabilitySimulation({
    version: 1,
    simulator_commitment: simulation.simulator_commitment,
    owner_commitment: input.owner.owner_commitment,
    intent_id: input.intent.intent_id,
    preview_commitment: null,
    simulation,
    created_at: simulation.simulated_at,
  });
  const schedule = privacyScheduleDecision({
    compiled_intent: compiled.compiled_intent,
    evidence_ready: input.evidence_ready === true,
    runtime_ready: runtimeContext.runtime_status === "ready",
    rotation_status: rotation.status,
    simulator_decision: simulation.decision,
    now,
  });
  await putScheduleDecision({
    version: 1,
    schedule_commitment: schedule.schedule_commitment,
    owner_commitment: input.owner.owner_commitment,
    intent_id: input.intent.intent_id,
    preview_commitment: null,
    decision: schedule,
    created_at: now.toISOString(),
  });
  return {
    context: connectorPreviewContext({
      manifest,
      readiness,
      compiled_intent: compiled.compiled_intent,
      sandbox_policy: sandbox,
      linkability_score: linkabilityScore,
    }),
    sealed_runtime_context: runtimeContext,
    schedule_decision: schedule,
    rotation,
    linkability_simulation: simulation,
    runtime_envelope: envelope,
    manifest,
    readiness,
    compiled_intent: compiled.compiled_intent,
    linkability_score: linkabilityScore,
  };
}

async function connectorForExecution(input: {
  owner: PrivateAccountRequestOwner;
  intent: PrivateAccountIntentRecordV1;
  preview: GholaPrivacyPreview;
  approval_commitment: string;
  execution_plan_commitment: string | null;
  encrypted_execution_instruction_bundle?: unknown;
}): Promise<
  | { work_order: GholaConnectorWorkOrder | null; result: GholaConnectorResult | null }
  | {
      error:
        | "connector_artifact_missing"
        | "connector_not_ready"
        | "connector_submit_failed"
        | "connector_submit_blocked"
        | "venue_access_required"
        | "needs_funds"
        | "venue_rejected";
    }
> {
  const context = input.preview.connector_context;
  if (!context) return { work_order: null, result: null };
  const runtimeContext = input.preview.sealed_runtime_context;
  if (!runtimeContext) return { error: "connector_artifact_missing" };
  const [compiledRecord, manifestRecord, linkabilityRecord, runtimeEnvelope] = await Promise.all([
    getCompiledIntent(context.compiler_commitment),
    getConnectorManifestRecord(context.manifest_commitment),
    getLinkabilityScore(context.linkability_score_commitment),
    getRuntimeEnvelope(runtimeContext.runtime_envelope_commitment),
  ]);
  if (
    !compiledRecord ||
    !manifestRecord ||
    !linkabilityRecord ||
    !runtimeEnvelope ||
    compiledRecord.owner_commitment !== input.owner.owner_commitment ||
    compiledRecord.intent_id !== input.intent.intent_id ||
    linkabilityRecord.owner_commitment !== input.owner.owner_commitment ||
    linkabilityRecord.intent_id !== input.intent.intent_id ||
    runtimeEnvelope.owner_commitment !== input.owner.owner_commitment ||
    runtimeEnvelope.intent_id !== input.intent.intent_id
  ) {
    return { error: "connector_artifact_missing" };
  }
  const hyperliquidVault = manifestRecord.platform_class === "hyperliquid_style_market"
    ? await getHyperliquidExecutionVaultByAccount(input.intent.account_commitment)
    : null;
  const hyperliquidAllocation = manifestRecord.platform_class === "hyperliquid_style_market"
    ? await getHyperliquidManagedAllocationByAccount(input.intent.account_commitment)
    : null;
  const venueId = venueIdForPlatformClass(manifestRecord.platform_class);
  const usesVenueVault = manifestRecord.platform_class === "coinbase_style_provider" ||
    manifestRecord.platform_class === "solana_perps_market";
  const [venueVault, omnibusAllocation] = usesVenueVault
    ? await Promise.all([
        getVenueExecutionVaultByAccount({
          account_commitment: input.intent.account_commitment,
          venue_id: venueId,
        }),
        manifestRecord.platform_class === "coinbase_style_provider"
          ? getOmnibusAllocationByAccount({
              account_commitment: input.intent.account_commitment,
              venue_id: "coinbase_advanced",
            })
          : Promise.resolve(null),
      ])
    : [null, null] as const;
  const venueExecutionMode: GholaVenueExecutionMode | undefined = manifestRecord.platform_class === "coinbase_style_provider"
    ? omnibusAllocation?.status === "allocated"
      ? "partner_omnibus"
      : venueVault?.execution_mode ?? "partner_omnibus"
    : manifestRecord.platform_class === "solana_perps_market"
      ? venueVault?.execution_mode ?? "user_stealth"
    : hyperliquidAllocation?.status === "allocated"
      ? "managed_testnet"
      : "byo_api_key";
  const connectorEnv = await connectorRuntimeEnv(manifestRecord.platform_class);
  const readiness = await connectorReadiness({
    manifest: manifestRecord.manifest,
    execution_vault_ready: usesVenueVault
      ? venueVault?.status === "sealed"
      : hyperliquidVault?.status === "sealed" || hyperliquidAllocation?.status === "allocated",
    execution_mode: venueExecutionMode,
    action_class: input.intent.action_class,
    omnibus_allocation_ready: omnibusAllocation?.status === "allocated",
    shielded_funding_ready: Boolean(input.preview.evidence_chain?.batch_evidence_commitment),
    runtime_health: sealedRuntimeHealth(undefined, connectorEnv),
    env: connectorEnv,
  });
  if (readiness.readiness_commitment !== context.connector_readiness_commitment) {
    return { error: "connector_artifact_missing" };
  }
  let workOrderRecord = await getConnectorWorkOrderByPreview(input.preview.preview_commitment);
  if (
    !workOrderRecord ||
    workOrderRecord.owner_commitment !== input.owner.owner_commitment ||
    workOrderRecord.approval_commitment !== input.approval_commitment
  ) {
    const workOrder = buildConnectorWorkOrder({
      owner_commitment: input.owner.owner_commitment,
      intent_id: input.intent.intent_id,
      account_commitment: input.intent.account_commitment,
      action_commitment: input.intent.action_commitment,
      preview: input.preview,
      approval_commitment: input.approval_commitment,
      execution_plan_commitment: input.execution_plan_commitment,
      compiled_intent: compiledRecord.compiled_intent,
      manifest: manifestRecord.manifest,
      readiness,
      linkability_score: linkabilityRecord.score,
    });
    workOrderRecord = await putConnectorWorkOrder({
      version: 1,
      work_order_commitment: workOrder.work_order_commitment,
      owner_commitment: input.owner.owner_commitment,
      intent_id: input.intent.intent_id,
      account_commitment: input.intent.account_commitment,
      action_commitment: input.intent.action_commitment,
      preview_commitment: input.preview.preview_commitment,
      approval_commitment: input.approval_commitment,
      execution_plan_commitment: input.execution_plan_commitment,
      platform_class: manifestRecord.platform_class,
      status: workOrder.status,
      work_order: workOrder,
      created_at: workOrder.created_at,
      updated_at: workOrder.updated_at,
    });
  }
  const existingResult = await getConnectorResultByWorkOrder(workOrderRecord.work_order_commitment);
  if (existingResult && existingResult.owner_commitment === input.owner.owner_commitment) {
    return {
      work_order: workOrderRecord.work_order,
      result: existingResult.result,
    };
  }
  const submitted = await submitConnectorWorkOrder({
    work_order: workOrderRecord.work_order,
    manifest: manifestRecord.manifest,
    compiled_intent: compiledRecord.compiled_intent,
    preview: input.preview,
    readiness,
    hyperliquid_execution_vault: hyperliquidAllocation?.status === "allocated"
      ? null
      : hyperliquidVault?.vault ?? null,
    hyperliquid_managed_allocation: hyperliquidAllocation?.allocation ?? null,
    venue_execution_vault: venueVault?.vault ?? null,
    omnibus_allocation: omnibusAllocation?.allocation ?? null,
    encrypted_execution_instruction_bundle: input.encrypted_execution_instruction_bundle,
    env: connectorEnv,
  });
  if (!submitted.ok) return { error: submitted.error };
  const now = new Date().toISOString();
  await putConnectorWorkOrder({
    ...workOrderRecord,
    status: submitted.result.status,
    work_order: {
      ...workOrderRecord.work_order,
      status: submitted.result.status,
      updated_at: now,
    },
    updated_at: now,
  });
  const resultRecord = await putConnectorResult({
    version: 1,
    connector_result_commitment: submitted.result.connector_result_commitment,
    work_order_commitment: workOrderRecord.work_order_commitment,
    owner_commitment: input.owner.owner_commitment,
    intent_id: input.intent.intent_id,
    platform_class: manifestRecord.platform_class,
    status: submitted.result.status,
    result: submitted.result,
    created_at: submitted.result.created_at,
    updated_at: submitted.result.updated_at,
  });
  return {
    work_order: workOrderRecord.work_order,
    result: resultRecord.result,
  };
}

async function recordRejectedFundingImport(input: {
  owner: PrivateAccountRequestOwner;
  instruction: PrivateFundingInstructionRecordV1;
  receipt_id: string;
  error: PrivateShieldedVerifierError;
}) {
  const now = new Date().toISOString();
  const status = input.error === "custom_shielded_verifier_stale"
    ? "stale"
    : input.error === "insufficient_confirmations"
      ? "insufficient_confirmations"
      : "rejected";
  await putPrivateFundingImport({
    version: 1,
    import_commitment: gholaCommitment("funding_import_rejected", {
      funding_intent_commitment: input.instruction.funding_intent_commitment,
      receipt_id: input.receipt_id,
      error: input.error,
      at: now,
    }),
    owner_commitment: input.owner.owner_commitment,
    account_commitment: input.instruction.account_commitment,
    funding_intent_id: input.instruction.funding_intent_id,
    funding_intent_commitment: input.instruction.funding_intent_commitment,
    receipt_commitment: gholaCommitment("funding_receipt_rejected", {
      receipt_id: input.receipt_id,
      destination_commitment: input.instruction.destination_commitment,
    }),
    nullifier_commitment: gholaCommitment("funding_nullifier_rejected", {
      receipt_id: input.receipt_id,
      destination_commitment: input.instruction.destination_commitment,
      error: input.error,
      at: now,
    }),
    note_root_commitment: gholaCommitment("note_root_rejected", input.instruction.funding_intent_commitment),
    amount_bucket: input.instruction.amount_bucket,
    asset_bucket: input.instruction.asset_bucket,
    shielded_rail: input.instruction.shielded_rail,
    verifier_status: status,
    verifier_commitment: gholaCommitment("verifier_rejected", input.error),
    verifier_observed_at: now,
    verifier_head_commitment: gholaCommitment("verifier_head_rejected", input.error),
    confirmation_depth: 0,
    network: verifierConfig().network,
    rejection_reason: input.error,
    imported_at: now,
  });
}

function customShieldedDestination(account: PrivateAccountRecordV1): string {
  const configured = process.env.GHOLA_CUSTOM_SHIELDED_DEPOSIT_DESTINATION?.trim();
  if (configured) return configured;
  return `ghola_shielded_${account.account_commitment.slice(-32)}`;
}

async function markVaultImported(input: {
  account: PrivateAccountRecordV1;
  import_record: PrivateFundingImportRecordV1;
  now: string;
}) {
  const existing = await getPrivateVaultState(input.account.account_commitment);
  const readyRails = Array.from(new Set([
    ...(existing?.ready_rails ?? []),
    "private_state_only" as GholaRailKind,
    "vault_omnibus_netting" as GholaRailKind,
    "shielded_pool" as GholaRailKind,
  ]));
  const balanceBuckets = Array.from(new Set([
    ...(existing?.balance_bucket_summary ?? []),
    `${input.import_record.asset_bucket}_${input.import_record.amount_bucket}`,
  ]));
  const accountRecord: PrivateAccountRecordV1 = {
    ...input.account,
    vault_ready: true,
    account: { ...input.account.account, vault_ready: true },
    note_root_commitment: input.import_record.note_root_commitment,
    updated_at: input.now,
  };
  await putPrivateAccountRecord(accountRecord);
  await putPrivateVaultState({
    version: 1,
    owner_commitment: input.account.owner_commitment,
    account_commitment: input.account.account_commitment,
    vault_root_commitment: input.account.vault_root_commitment,
    note_root_commitment: input.import_record.note_root_commitment,
    nullifier_root_commitment: gholaCommitment("nullifier_root", input.import_record.nullifier_commitment),
    balance_bucket_summary: balanceBuckets,
    ready_rails: readyRails,
    last_import_commitment: input.import_record.import_commitment,
    created_at: existing?.created_at ?? input.now,
    updated_at: input.now,
  });
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boundedBps(value: unknown, fallback: number): number {
  const parsed = numberValue(value);
  if (!parsed && fallback) return fallback;
  return Math.max(0, Math.min(10_000, Math.floor(parsed)));
}

function isEvidenceSource(value: string): value is PrivateAnonymityEvidenceRecordV1["source"] {
  return [
    "vault_indexer",
    "batch_coordinator",
    "solver_cohort",
    "settlement_observer",
    "internal_test",
  ].includes(value);
}

function isFundingAmountBucket(value: string): boolean {
  return ["5", "10", "25", "50", "100"].includes(value);
}

function isFundingAssetBucket(value: string): boolean {
  return ["stablecoin", "SOL", "ETH", "BTC", "major", "long_tail"].includes(value);
}

function isAuctionEligibleAction(value: GholaPrivateAccountActionClass): boolean {
  return value === "trade_on_platform" || value === "rebalance" || value === "maintain_allocation";
}

function auctionSideFromValue(
  value: unknown,
  actionClass: GholaPrivateAccountActionClass,
): GholaAuctionOrderSide {
  if (value === "buy" || value === "sell") return value;
  return actionClass === "trade_on_platform" ? "buy" : "not_applicable";
}

function auctionAssetBucket(value: unknown, fallback: string): string {
  const bucket = stringValue(value);
  if (bucket && isFundingAssetBucket(bucket)) return bucket;
  return isFundingAssetBucket(fallback) ? fallback : "stablecoin";
}

function auctionAmountBucket(value: unknown): string {
  const bucket = stringValue(value);
  return isFundingAmountBucket(bucket) ? bucket : "25";
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isActionClass(value: string): value is GholaPrivateAccountActionClass {
  return [
    "pay",
    "transfer",
    "fund_platform",
    "trade_on_platform",
    "rebalance",
    "maintain_allocation",
    "withdraw",
  ].includes(value);
}

function isPlatformClass(value: string): value is GholaPlatformClass {
  return [
    "solana_public_wallet",
    "solana_private_balance",
    "solana_perps_market",
    "solana_swap_aggregator",
    "hyperliquid_style_market",
    "coinbase_style_provider",
    "rfq_solver_network",
    "partner_tokenized_assets",
  ].includes(value);
}

export function isVenueId(value: string): value is GholaVenueId {
  return [
    "hyperliquid",
    "phoenix",
    "drift",
    "jupiter",
    "backpack",
    "coinbase_advanced",
    "rfq_network",
  ].includes(value);
}

function venueExecutionModeFromValue(value: unknown): GholaVenueExecutionMode | null {
  return value === "byo_api_key" ||
    value === "partner_omnibus" ||
    value === "managed_testnet" ||
    value === "user_stealth" ||
    value === "ghola_pooled"
    ? value
    : null;
}

function venueAccountModeFromValue(value: unknown): GholaVenueAccountMode | null {
  return value === "byo_account" || value === "user_stealth" || value === "ghola_pooled" ? value : null;
}

function secretPurposeFromValue(value: unknown) {
  return value === "venue_api_key" ||
    value === "trader_authority" ||
    value === "pooled_operator"
    ? value
    : "venue_account";
}

function encryptedSecretCommitmentFromBundle(value: unknown): string {
  const bundle = objectBody(value);
  const ciphertext = stringValue(bundle.ciphertext);
  const recipient = stringValue(bundle.recipient);
  const aad = stringValue(bundle.aad);
  if (!ciphertext || !recipient || !aad) return "";
  return gholaCommitment("encrypted_secret", {
    ciphertext,
    recipient,
    aad,
    alg: stringValue(bundle.alg) || "sealed-provider-v1",
  });
}

function recipientCommitmentFromBundle(value: unknown): string {
  const recipient = stringValue(objectBody(value).recipient);
  return recipient ? gholaCommitment("sealed_recipient", recipient) : "";
}

function venuePilotEnabled(venueId: GholaVenueId): boolean {
  if (venueId === "hyperliquid") return process.env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED === "true";
  if (venueId === "phoenix") return process.env.GHOLA_VENUE_PHOENIX_PILOT_ENABLED === "true";
  if (venueId === "drift") return process.env.GHOLA_VENUE_DRIFT_PILOT_ENABLED === "true";
  if (venueId === "jupiter") return process.env.GHOLA_VENUE_JUPITER_PILOT_ENABLED === "true";
  if (venueId === "backpack") return process.env.GHOLA_VENUE_BACKPACK_PILOT_ENABLED === "true";
  if (venueId === "coinbase_advanced") return process.env.GHOLA_V6_COINBASE_PILOT_ENABLED === "true";
  if (venueId === "rfq_network") return Number.parseInt(process.env.GHOLA_RFQ_SOLVER_COUNT || "0", 10) >= 5;
  return false;
}

function isRailKind(value: string): value is GholaRailKind {
  return [
    "private_state_only",
    "vault_omnibus_netting",
    "combined_vault_shielded_batch",
    "shielded_batch_auction",
    "shielded_pool",
    "confidential_token",
    "provider_omnibus_subaccount",
    "private_relayer",
    "stealth_change_address",
    "direct_public_fallback",
  ].includes(value);
}

async function connectorRuntimeEnv(
  platformClass: GholaPlatformClass,
): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (platformClass !== "hyperliquid_style_market" && platformClass !== "solana_perps_market") return env;

  const runtime = await getPrivateAgentRuntimeStatus().catch(() => null);
  if (!runtime?.remote_execution_ready || !runtime.selected_provider) return env;
  const provider = runtime.providers.find((item) => item.id === runtime.selected_provider);
  const executionUrl = provider?.execution_url?.trim();
  if (!executionUrl) return env;

  if (platformClass === "hyperliquid_style_market") {
    env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL ||= executionUrl;
    env.GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_READINESS ||= "ready";
  }
  if (platformClass === "solana_perps_market") {
    env.GHOLA_CONNECTOR_SOLANA_PERPS_MARKET_URL ||= executionUrl;
    env.GHOLA_CONNECTOR_SOLANA_PERPS_MARKET_READINESS ||= "ready";
  }
  env.GHOLA_PRIVATE_RUNTIME_URL ||= executionUrl;

  const measurement =
    provider?.sealed_recipient?.measurement_hex?.trim() ||
    provider?.sealed_recipient?.attestation_hash?.trim() ||
    "attested";
  env.GHOLA_PRIVATE_RUNTIME_MEASUREMENT ||= measurement;
  env.GHOLA_PRIVATE_RUNTIME_EXPECTED_MEASUREMENT ||=
    env.GHOLA_PRIVATE_RUNTIME_MEASUREMENT;
  return env;
}

async function connectorReadinessForManifest(
  manifest: GholaConnectorManifest,
  now?: Date,
): Promise<GholaConnectorReadiness> {
  const observedAt = now ?? new Date();
  const env = await connectorRuntimeEnv(manifest.platform_class);
  const platformLaunchReady =
    manifest.platform_class === "hyperliquid_style_market"
      ? env.GHOLA_V6_HYPERLIQUID_PILOT_ENABLED === "true" &&
        env.GHOLA_HYPERLIQUID_LIVE_MODE === "tiny_fill"
      : manifest.platform_class === "solana_perps_market"
        ? env.GHOLA_VENUE_PHOENIX_PILOT_ENABLED === "true" &&
          (env.GHOLA_SOLANA_PERPS_LIVE_MODE === "sdk_runner" ||
            env.PRIVATE_AGENT_SOLANA_PERPS_LIVE_MODE === "sdk_runner")
        : false;
  const launchExecutionMode = manifest.platform_class === "hyperliquid_style_market"
    ? "byo_api_key"
    : manifest.platform_class === "solana_perps_market"
      ? "user_stealth"
      : undefined;
  return connectorReadiness({
    manifest,
    now: observedAt,
    env,
    // Manifest readiness is platform-scoped. Per-account vault and funding gates
    // are still enforced in connectorContextForIntent before any live submit.
    execution_mode: platformLaunchReady ? launchExecutionMode : undefined,
    execution_vault_ready: platformLaunchReady,
    runtime_health: sealedRuntimeHealth(observedAt, env),
  });
}

function connectorDefaultRail(platformClass: GholaPlatformClass): GholaRailKind {
  const profile = getPlatformPrivacyProfile(platformClass);
  return profile.privacy_runnable_rails[0] ?? "direct_public_fallback";
}
