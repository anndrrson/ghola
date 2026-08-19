import { ed25519 } from "@noble/curves/ed25519";
import { didKeyFromVerifying, RecipientKind, seal } from "./envelope";
import { currentLiveTradingReleaseIdentity } from "./live-trading-release.server";
import {
  LIVE_TRADING_MAX_ORDER_NOTIONAL_USD,
  LIVE_TRADING_ROLLING_24H_NOTIONAL_USD,
  configuredLiveTradingFundingSignerKeys,
} from "./live-trading-contract";
import { gholaCommitment } from "./private-account";
import { getHyperliquidExecutionVaultByAccount } from "./private-account-store";
import { parseHyperliquidVaultAssociatedData } from "./hyperliquid-vault-seal";
import {
  getLiveTradingLaunchControl,
  getLiveTradingWorkOrderReconciliation,
  inspectLiveTradingDispatchAbsence,
  LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS,
  liveTradingWorkerRequestDigest,
  putLiveTradingWorkOrderReconciliation,
  recordLiveTradingWorkerClaimAbsence,
  settleLiveTradingNotionalReservation,
  type LiveTradingProvenFill,
  type LiveTradingWorkOrderReconciliation,
  type LiveTradingWorkOrderReconciliationStatus,
} from "./live-trading-store";
import {
  workerAuthorizationHeader,
  workerCapabilityExpectedFromBody,
} from "./private-agent-capability";
import { expectedRecipientReportDataHex } from "./private-agent-phala";
import { autopilotWorkerConfig } from "./private-agent-worker-readiness";
import {
  privateAgentEmergencyControlTransportAllowed,
  privateAgentTransportAllowed,
} from "./private-agent-spend-policy";
import type { TradeOrderPlan } from "./trade-order-plan";

const WORKER_PATH = "/hyperliquid/orders";
const WORKER_RECONCILE_PATH = "/hyperliquid/reconcile";
export const LIVE_TRADING_DISPATCH_DISPOSITION_HEADER = "x-ghola-live-trading-disposition";
export type LiveTradingDispatchDisposition = "not_dispatched" | "submitted" | "filled" | "no_fill";
const SAFE_COMMITMENT = /^[A-Za-z0-9_:-]{8,200}$/u;
const LIVE_INSTRUCTION_TTL_MS = 15_000;
const LIVE_RECONCILIATION_DELAYS_MS = [200, 800] as const;
const WORKER_CLAIM_ABSENCE_PROPAGATION_GRACE_MS = 30_000;
const WORKER_CLAIM_ABSENCE_OBSERVATION_SPACING_MS = 5_000;
const TERMINAL_HYPERLIQUID_ORDER_STATUSES = new Set([
  "filled", "canceled", "cancelled", "rejected", "margincanceled", "expired", "triggered",
  "vaultwithdrawalcanceled", "openinterestcapcanceled", "selftradecanceled", "reduceonlycanceled",
  "siblingfilledcanceled", "delistedcanceled", "liquidatedcanceled", "scheduledcancel", "tickrejected",
  "mintradentlrejected", "mintradespotntlrejected", "perpmarginrejected", "reduceonlyrejected",
  "badalopxrejected", "ioccancelrejected", "badtriggerpxrejected", "marketordernoliquidityrejected",
  "positionincreaseatopeninterestcaprejected", "positionflipatopeninterestcaprejected",
  "tooaggressiveatopeninterestcaprejected", "openinterestincreaserejected",
  "insufficientspotbalancerejected", "oraclerejected", "perpmaxpositionrejected",
]);

interface RecipientMetadata {
  recipient_id?: unknown;
  x25519_pub_hex?: unknown;
  funding_signer_public_key_b64?: unknown;
  image_digest?: unknown;
  report_data_hex?: unknown;
  attested_ready?: unknown;
}

export async function dispatchLiveTradingOrder(input: {
  owner_commitment: string;
  account_commitment: string;
  vault_commitment: string;
  idempotency_key: string;
  plan_digest: string;
  order_plan: TradeOrderPlan;
  reservation_id?: string | null;
  expected_launch_revision: number | null;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  waitImpl?: (delayMs: number) => Promise<void>;
  persistWorkOrderReconciliationImpl?: typeof putLiveTradingWorkOrderReconciliation;
}): Promise<Response> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const exposureIncreasing = !input.order_plan.execution_policy.reduce_only;
  // Recovery is release/transport independent and never broadcasts. A retry
  // of a durable plan must not be mislabeled pre-dispatch merely because the
  // current opening gates changed after the original submission.
  const existingRecovery = await getLiveTradingWorkOrderReconciliation({
    owner_commitment: input.owner_commitment,
    plan_digest: input.plan_digest,
  }).catch(() => null);
  if (existingRecovery) {
    return reconcileLiveTradingWorkOrder({
      owner_commitment: input.owner_commitment,
      plan_digest: input.plan_digest,
      fetchImpl,
      env,
    });
  }
  const transportAllowed = input.order_plan.execution_policy.reduce_only
    ? privateAgentEmergencyControlTransportAllowed("close", env, fetchImpl)
    : privateAgentTransportAllowed("execute", env, fetchImpl);
  if (!transportAllowed) {
    return failure(503, "private_agent_remote_execution_disabled");
  }
  const release = currentLiveTradingReleaseIdentity(env);
  if (!release.valid) return failure(503, "live_release_identity_invalid");
  if (
    input.order_plan.venue_id !== "hyperliquid" ||
    input.order_plan.network !== "mainnet" ||
    input.order_plan.order_type !== "limit" ||
    input.order_plan.time_in_force !== "ioc"
  ) {
    return failure(409, "live_order_plan_not_supported");
  }
  if (
    input.order_plan.protection_intent &&
    env.GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED?.trim() !== "true"
  ) {
    return failure(503, "live_position_protection_canary_required");
  }
  if (
    env.GHOLA_LIVE_TRADING_POSITION_PROTECTION_ENABLED?.trim() === "true" &&
    !input.order_plan.execution_policy.reduce_only &&
    !input.order_plan.protection_intent
  ) {
    return failure(409, "live_position_protection_required");
  }

  const vault = await getHyperliquidExecutionVaultByAccount(input.account_commitment);
  if (
    !vault ||
    vault.owner_commitment !== input.owner_commitment ||
    vault.account_commitment !== input.account_commitment ||
    vault.vault_commitment !== input.vault_commitment ||
    vault.status !== "sealed"
  ) {
    return failure(409, "sealed_hyperliquid_vault_required");
  }
  const vaultAad = vault.vault?.encrypted_execution_vault?.aad;
  const vaultScope = typeof vaultAad === "string"
    ? parseHyperliquidVaultAssociatedData(vaultAad)
    : null;
  if (vaultScope?.network !== "mainnet" || vaultScope.account_commitment !== input.account_commitment) {
    return failure(409, "hyperliquid_mainnet_vault_required");
  }
  if (exposureIncreasing) {
    const launchError = await exposureLaunchError(input.expected_launch_revision);
    if (launchError) return failure(503, launchError);
  }
  const recipientResult = await fetchWorkerRecipient(fetchImpl, env, release.worker_image_digest);
  if (!recipientResult.ok) return failure(503, recipientResult.error);
  const recipient = recipientResult.recipient;
  if (vault.vault.encrypted_execution_vault.recipient !== recipient.recipient_id) {
    return failure(409, "worker_recipient_vault_mismatch");
  }

  const workOrderCommitment = gholaCommitment("live_trade_work_order", {
    idempotency_key: input.idempotency_key,
    plan_digest: input.plan_digest,
    account_commitment: input.account_commitment,
  });
  const sealedInstruction = await sealInstruction({
    recipient,
    workOrderCommitment,
    plan: input.order_plan,
  }).catch(() => null);
  if (!sealedInstruction) return failure(503, "live_instruction_seal_failed");
  const encryptedInstruction = sealedInstruction.bundle;

  const orderPolicy = {
    policy_commitment: gholaCommitment("live_trade_order_policy", {
      work_order_commitment: workOrderCommitment,
      vault_policy_commitment: vault.policy_commitment,
      max_order_notional_usd: LIVE_TRADING_MAX_ORDER_NOTIONAL_USD,
      rolling_24h_notional_usd: LIVE_TRADING_ROLLING_24H_NOTIONAL_USD,
    }),
    market_allowlist: [input.order_plan.coin, input.order_plan.product],
    max_notional_bucket: String(LIVE_TRADING_MAX_ORDER_NOTIONAL_USD),
    max_daily_notional_bucket: String(LIVE_TRADING_ROLLING_24H_NOTIONAL_USD),
    max_order_count: 1,
    execution_network: "mainnet",
    kill_switch: false,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  const requestCommitment = gholaCommitment("live_trade_request", {
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    vault_commitment: vault.vault_commitment,
    vault_policy_commitment: vault.policy_commitment,
    order_policy_commitment: orderPolicy.policy_commitment,
    plan_digest: input.plan_digest,
    work_order_commitment: workOrderCommitment,
    market: input.order_plan.coin,
    encrypted_execution_vault: vault.vault.encrypted_execution_vault,
    encrypted_execution_instruction_bundle: encryptedInstruction,
  });
  const body = {
    version: 1,
    reconciliation_binding_version: 1,
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "limit_order",
    work_order_commitment: workOrderCommitment,
    plan_digest: input.plan_digest,
    request_commitment: requestCommitment,
    order_policy_commitment: orderPolicy.policy_commitment,
    market: input.order_plan.coin,
    vault_commitment: vault.vault_commitment,
    policy_commitment: vault.policy_commitment,
    encrypted_execution_vault: vault.vault.encrypted_execution_vault,
    encrypted_execution_instruction_bundle: encryptedInstruction,
    session_policy: orderPolicy,
  };
  const config = autopilotWorkerConfig(env);
  if (!config.url) return failure(503, "live_worker_not_configured");
  const authorization = workerAuthorizationHeader({
    env,
    fallbackToken: config.token,
    method: "POST",
    path: WORKER_PATH,
    scope: "order:submit",
    body,
    expected: workerCapabilityExpectedFromBody(body, {
      venue_id: "hyperliquid",
      platform_class: "hyperliquid_style_market",
      operation_class: "limit_order",
    }),
  });
  if (!authorization) return failure(503, "live_worker_auth_missing");

  if (exposureIncreasing) {
    const launchError = await exposureLaunchError(input.expected_launch_revision);
    if (launchError) return failure(503, launchError);
  }

  const createdAt = new Date().toISOString();
  const recoveryRecord: LiveTradingWorkOrderReconciliation = {
    version: 1,
    work_order_commitment: workOrderCommitment,
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    vault_commitment: vault.vault_commitment,
    vault_policy_commitment: vault.policy_commitment,
    order_policy_commitment: orderPolicy.policy_commitment,
    plan_digest: input.plan_digest,
    request_commitment: requestCommitment,
    worker_request_digest: liveTradingWorkerRequestDigest(body),
    market: input.order_plan.coin,
    require_protection: Boolean(input.order_plan.protection_intent),
    protection_slippage_bps: input.order_plan.protection_intent?.max_slippage_bps ?? null,
    worker_recipient: recipient.recipient_id,
    worker_image_digest: release.worker_image_digest as string,
    instruction_expires_at: sealedInstruction.expiresAt,
    reservation_id: input.reservation_id ?? null,
    status: "pending",
    result_commitment: null,
    order_id: null,
    proven_fill: null,
    worker_request: body,
    created_at: createdAt,
    updated_at: createdAt,
  };
  const recoveryPersisted = await (
    input.persistWorkOrderReconciliationImpl ?? putLiveTradingWorkOrderReconciliation
  )(recoveryRecord)
    .catch(() => false);
  if (!recoveryPersisted) {
    const concurrentRecovery = await getLiveTradingWorkOrderReconciliation({
      owner_commitment: input.owner_commitment,
      plan_digest: input.plan_digest,
    }).catch(() => null);
    return concurrentRecovery
      ? reconcileLiveTradingWorkOrder({
          owner_commitment: input.owner_commitment,
          plan_digest: input.plan_digest,
          fetchImpl,
          env,
        })
      : failure(503, "live_reconciliation_record_unavailable", "submitted");
  }

  if (exposureIncreasing) {
    const launchError = await exposureLaunchError(input.expected_launch_revision);
    if (launchError) {
      await putLiveTradingWorkOrderReconciliation({
        ...recoveryRecord,
        status: "not_dispatched",
        result_commitment: "launch_epoch_changed_before_dispatch",
        updated_at: new Date().toISOString(),
      }).catch(() => false);
      return failure(503, launchError);
    }
  }

  const response = await fetchImpl(new URL(WORKER_PATH, config.url), {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization,
      "content-type": "application/json",
      "x-ghola-sealed-execution-required": "true",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const workerBody = response ? await response.json().catch(() => null) : null;
  if (workerOutcomeRequiresReconciliation(response, workerBody)) {
    const reconciliation = await reconcileSubmittedWorkOrder({
      record: recoveryRecord,
      fetchImpl,
      env,
      workerUrl: String(config.url),
      requireProtection: Boolean(input.order_plan.protection_intent),
      protectionSlippageBps: input.order_plan.protection_intent?.max_slippage_bps,
      waitImpl: input.waitImpl,
    });
    if (reconciliation?.filled) {
      const persisted = await persistReconciliationStatus(recoveryRecord, "reconciled", reconciliation);
      if (!persisted) return reconciliationPendingResponse(recoveryRecord);
      return liveRunResponse({
        status: "reconciled",
        commitment: reconciliation.commitment,
        workOrderCommitment,
        orderId: reconciliation.orderId,
        provenFill: reconciliation.provenFill,
      });
    }
    if (reconciliation?.noFill) {
      const persisted = await persistReconciliationStatus(recoveryRecord, "no_fill", reconciliation);
      if (!persisted) return reconciliationPendingResponse(recoveryRecord);
      return liveRunResponse({
        status: "no_fill",
        commitment: reconciliation.commitment,
        workOrderCommitment,
        orderId: reconciliation.orderId,
      });
    }
    if (reconciliation?.notDispatched) {
      const persisted = await persistReconciliationStatus(recoveryRecord, "not_dispatched", reconciliation);
      if (!persisted) return reconciliationPendingResponse(recoveryRecord);
      return liveRunResponse({
        status: "not_dispatched",
        commitment: reconciliation.commitment,
        workOrderCommitment,
      });
    }
  }
  if (!response) {
    return reconciliationPendingResponse(recoveryRecord);
  }
  if (!response.ok) {
    const ambiguous = workerOutcomeRequiresReconciliation(response, workerBody);
    if (ambiguous) return reconciliationPendingResponse(recoveryRecord);
    await persistReconciliationStatus(recoveryRecord, "not_dispatched").catch(() => false);
    return Response.json(publicWorkerFailure(workerBody), {
      status: response.status >= 400 ? response.status : 502,
      headers: dispositionHeaders("not_dispatched"),
    });
  }
  const receipt = inspectWorkerReceipt(workerBody, {
    workOrderCommitment,
    vaultCommitment: vault.vault_commitment,
    expectedBaseSize: input.order_plan.base_size,
    requireProtection: Boolean(input.order_plan.protection_intent),
    protectionSlippageBps: input.order_plan.protection_intent?.max_slippage_bps,
  });
  if (!receipt) return failure(502, "live_worker_receipt_invalid", "submitted");
  const nextStatus = receipt.status === "reconciled" ? "reconciled" : "submitted";
  const persisted = await persistReconciliationStatus(recoveryRecord, nextStatus, {
    commitment: receipt.commitment,
    orderId: receipt.orderId,
    provenFill: receipt.provenFill,
  });
  if (!persisted) return reconciliationPendingResponse(recoveryRecord);
  return liveRunResponse({
    status: receipt.status,
    commitment: receipt.commitment,
    workOrderCommitment,
    orderId: receipt.orderId,
    provenFill: receipt.provenFill,
  });
}

async function exposureLaunchError(expectedRevision: number | null) {
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) <= 0) {
    return "live_trading_launch_epoch_missing";
  }
  const control = await getLiveTradingLaunchControl().catch(() => null);
  if (!control) return "live_trading_launch_state_unavailable";
  if (control.state === "killed") return "live_trading_killed";
  if (control.state !== "public" && control.state !== "canary") {
    return "live_trading_launch_state_invalid";
  }
  if (control.revision !== expectedRevision) return "live_trading_launch_epoch_changed";
  return null;
}

function liveRunResponse(input: {
  status: string;
  commitment: string;
  workOrderCommitment: string;
  orderId?: string | null;
  provenFill?: LiveTradingProvenFill | null;
  planDigest?: string;
}) {
  return Response.json({
    ...(input.planDigest ? { planDigest: input.planDigest } : {}),
    appLiveTradingExecutionRun: {
      status: input.status,
      gholaAppLiveTradingExecutionRunCommitment: input.commitment,
      liveTradingOrder: input.orderId ? {
        orderId: input.orderId,
        ...(input.status === "reconciled" && input.provenFill ? {
          venueProvenFill: publicProvenFill(input.provenFill),
        } : {}),
      } : null,
      workerWorkOrderCommitment: input.workOrderCommitment,
    },
  }, {
    status: 202,
    headers: dispositionHeaders(
      input.status === "reconciled"
        ? "filled"
        : input.status === "no_fill"
          ? "no_fill"
          : input.status === "not_dispatched"
            ? "not_dispatched"
            : "submitted",
    ),
  });
}

async function reconcileSubmittedWorkOrder(input: {
  record: LiveTradingWorkOrderReconciliation;
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
  workerUrl: string;
  requireProtection: boolean;
  protectionSlippageBps?: number;
  waitImpl?: (delayMs: number) => Promise<void>;
}) {
  let recoveryRecord = input.record;
  const reconcileBody = reconciliationBody(recoveryRecord);
  const waitImpl = input.waitImpl ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  for (const delayMs of LIVE_RECONCILIATION_DELAYS_MS) {
    await waitImpl(delayMs);
    const authorization = workerAuthorizationHeader({
      env: input.env,
      method: "POST",
      path: WORKER_RECONCILE_PATH,
      scope: "reconcile:read",
      body: reconcileBody,
      expected: workerCapabilityExpectedFromBody(reconcileBody, {
        venue_id: "hyperliquid",
        platform_class: "hyperliquid_style_market",
        operation_class: "reconcile",
      }),
    });
    if (!authorization) return null;
    const response = await input.fetchImpl(new URL(WORKER_RECONCILE_PATH, input.workerUrl), {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization,
        "content-type": "application/json",
        "x-ghola-sealed-execution-required": "true",
      },
      body: JSON.stringify(reconcileBody),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    const responseBody = response ? await response.json().catch(() => null) : null;
    if (!response?.ok) {
      if (response?.status === 404 && record(responseBody)?.error_code === "HYPERLIQUID_EXECUTION_CLAIM_NOT_FOUND") {
        const observedAt = new Date();
        const expiresAtMs = Date.parse(recoveryRecord.instruction_expires_at);
        if (Number.isFinite(expiresAtMs) && observedAt.getTime() >= expiresAtMs) {
          const nextRecord = await recordLiveTradingWorkerClaimAbsence({
            owner_commitment: recoveryRecord.owner_commitment,
            plan_digest: recoveryRecord.plan_digest,
            observed_at: observedAt,
          }).catch(() => null);
          const nextProbe = nextRecord?.worker_claim_absence_probe;
          if (nextRecord && nextProbe) {
            recoveryRecord = nextRecord;
            const firstObservedAtMs = Date.parse(nextProbe.first_observed_at);
            if (nextProbe.observation_count >= 2 &&
                observedAt.getTime() - firstObservedAtMs >= WORKER_CLAIM_ABSENCE_OBSERVATION_SPACING_MS &&
                observedAt.getTime() - expiresAtMs >= WORKER_CLAIM_ABSENCE_PROPAGATION_GRACE_MS) {
              return {
                commitment: gholaCommitment("live_trade_worker_no_broadcast", {
                  work_order_commitment: recoveryRecord.work_order_commitment,
                  plan_digest: recoveryRecord.plan_digest,
                  instruction_expires_at: recoveryRecord.instruction_expires_at,
                  first_observed_at: nextProbe.first_observed_at,
                  checked_at: nextProbe.last_observed_at,
                }),
                filled: false,
                noFill: false,
                notDispatched: true,
                orderId: null,
                provenFill: null,
              };
            }
          }
        }
      }
      continue;
    }
    const receipt = inspectWorkerReconciliationReceipt(responseBody, {
      workOrderCommitment: recoveryRecord.work_order_commitment,
      vaultCommitment: recoveryRecord.vault_commitment,
      requireProtection: input.requireProtection,
      protectionSlippageBps: input.protectionSlippageBps,
    });
    if (receipt) return receipt;
  }
  return null;
}

/** No-broadcast venue reconciliation for the exact durable work order; never submits an order. */
export async function reconcileLiveTradingWorkOrder(input: {
  owner_commitment: string;
  plan_digest: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<Response> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  let recovery = await getLiveTradingWorkOrderReconciliation({
    owner_commitment: input.owner_commitment,
    plan_digest: input.plan_digest,
  }).catch(() => null);
  if (!recovery) {
    const absence = await inspectLiveTradingDispatchAbsence({
      owner_commitment: input.owner_commitment,
      plan_digest: input.plan_digest,
      now: input.now,
    }).catch(() => null);
    if (!absence) return reconciliationAbsencePendingResponse(input.plan_digest);
    if (absence.status === "proven") {
      return Response.json({
        version: 1,
        status: "not_dispatched",
        planDigest: input.plan_digest,
        dispatchAbsenceProofCommitment: absence.proof_commitment,
        dispatchAbsenceEvidence: {
          workOrderRecord: false,
          reservation: false,
          workerClaim: false,
          workerIdempotency: false,
          workerCallRequiresDurableRecord: true,
          graceMs: LIVE_TRADING_DISPATCH_ABSENCE_GRACE_MS,
        },
        firstCheckedAt: absence.first_observed_at,
        checkedAt: absence.checked_at,
      }, { status: 200, headers: dispositionHeaders("not_dispatched") });
    }
    if (absence.status === "evidence_present") {
      recovery = await getLiveTradingWorkOrderReconciliation({
        owner_commitment: input.owner_commitment,
        plan_digest: input.plan_digest,
      }).catch(() => null);
    }
    if (!recovery) return reconciliationAbsencePendingResponse(
      input.plan_digest,
      absence.status === "pending" ? absence : undefined,
    );
  }
  if (recovery.owner_commitment !== input.owner_commitment || recovery.plan_digest !== input.plan_digest) {
    return failure(404, "live_work_order_not_found");
  }
  if (recovery.status === "not_dispatched") {
    await settleRecoveryReservation(recovery);
    return recovery.result_commitment
      ? liveRunResponse({
          status: "not_dispatched",
          commitment: recovery.result_commitment,
          workOrderCommitment: recovery.work_order_commitment,
          planDigest: recovery.plan_digest,
        })
      : failure(409, "live_work_order_not_dispatched");
  }
  if (recovery.status === "reconciled" || recovery.status === "no_fill") {
    await settleRecoveryReservation(recovery);
    return liveRunResponse({
      status: recovery.status,
      commitment: recovery.result_commitment as string,
      workOrderCommitment: recovery.work_order_commitment,
      orderId: recovery.order_id,
      provenFill: recovery.proven_fill ?? null,
      planDigest: recovery.plan_digest,
    });
  }

  const release = currentLiveTradingReleaseIdentity(env);
  if (!release.valid || normalizeDigest(release.worker_image_digest) !== normalizeDigest(recovery.worker_image_digest)) {
    return failure(409, "live_work_order_release_mismatch", "submitted");
  }
  const vault = await getHyperliquidExecutionVaultByAccount(recovery.account_commitment).catch(() => null);
  const vaultAad = vault?.vault?.encrypted_execution_vault?.aad;
  const vaultScope = typeof vaultAad === "string" ? parseHyperliquidVaultAssociatedData(vaultAad) : null;
  if (
    !vault ||
    vault.owner_commitment !== recovery.owner_commitment ||
    vault.account_commitment !== recovery.account_commitment ||
    vault.vault_commitment !== recovery.vault_commitment ||
    vault.policy_commitment !== recovery.vault_policy_commitment ||
    vault.status !== "sealed" ||
    vaultScope?.network !== "mainnet" ||
    vaultScope.account_commitment !== recovery.account_commitment
  ) {
    return failure(409, "live_work_order_vault_binding_mismatch", "submitted");
  }
  const recipientResult = await fetchWorkerRecipient(fetchImpl, env, release.worker_image_digest);
  if (!recipientResult.ok || recipientResult.recipient.recipient_id !== recovery.worker_recipient) {
    return failure(503, recipientResult.ok
      ? "live_work_order_recipient_mismatch"
      : recipientResult.error, "submitted");
  }
  const config = autopilotWorkerConfig(env);
  if (!config.url) return failure(503, "live_worker_not_configured", "submitted");
  const receipt = await reconcileSubmittedWorkOrder({
    record: recovery,
    fetchImpl,
    env,
    workerUrl: String(config.url),
    requireProtection: recovery.require_protection,
    protectionSlippageBps: recovery.protection_slippage_bps ?? undefined,
    waitImpl: async () => undefined,
  });
  if (!receipt) return reconciliationPollPendingResponse(recovery);
  const status: LiveTradingWorkOrderReconciliationStatus = receipt.notDispatched
    ? "not_dispatched"
    : receipt.filled ? "reconciled" : "no_fill";
  const persisted = await persistReconciliationStatus(recovery, status, receipt);
  if (!persisted) return reconciliationPollPendingResponse(recovery);
  const terminal = {
    ...recovery,
    status,
    result_commitment: receipt.commitment,
    order_id: receipt.orderId,
    proven_fill: receipt.provenFill,
  };
  await settleRecoveryReservation(terminal);
  return liveRunResponse({
    status,
    commitment: receipt.commitment,
    workOrderCommitment: recovery.work_order_commitment,
    orderId: receipt.orderId,
    provenFill: receipt.provenFill,
    planDigest: recovery.plan_digest,
  });
}

function reconciliationBody(record: LiveTradingWorkOrderReconciliation) {
  const request = record.worker_request;
  return {
    version: 1,
    reconciliation_binding_version: 1,
    owner_commitment: record.owner_commitment,
    account_commitment: record.account_commitment,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "reconcile",
    original_operation_class: "limit_order",
    work_order_commitment: record.work_order_commitment,
    vault_commitment: record.vault_commitment,
    policy_commitment: record.vault_policy_commitment,
    order_policy_commitment: record.order_policy_commitment,
    plan_digest: record.plan_digest,
    request_commitment: record.request_commitment,
    original_request_digest: record.worker_request_digest,
    encrypted_execution_vault: request.encrypted_execution_vault,
    encrypted_execution_instruction_bundle: request.encrypted_execution_instruction_bundle,
    session_policy: request.session_policy,
    market: record.market,
  };
}

async function persistReconciliationStatus(
  record: LiveTradingWorkOrderReconciliation,
  status: LiveTradingWorkOrderReconciliationStatus,
  receipt?: { commitment: string; orderId: string | null; provenFill?: LiveTradingProvenFill | null },
) {
  return putLiveTradingWorkOrderReconciliation({
    ...record,
    status,
    result_commitment: receipt?.commitment ?? record.result_commitment,
    order_id: receipt?.orderId ?? record.order_id,
    proven_fill: receipt?.provenFill ?? record.proven_fill ?? null,
    updated_at: new Date().toISOString(),
  }).catch(() => false);
}

async function settleRecoveryReservation(record: LiveTradingWorkOrderReconciliation) {
  if (!record.reservation_id) return;
  await settleLiveTradingNotionalReservation({
    reservation_id: record.reservation_id,
    status: record.status === "reconciled" ? "filled" : "released",
  }).catch(() => undefined);
}

function reconciliationPendingResponse(record: LiveTradingWorkOrderReconciliation) {
  return Response.json({
    error: "live_worker_reconciliation_pending",
    planDigest: record.plan_digest,
    workerWorkOrderCommitment: record.work_order_commitment,
  }, { status: 503, headers: dispositionHeaders("submitted") });
}

function reconciliationPollPendingResponse(record: LiveTradingWorkOrderReconciliation) {
  return Response.json({
    version: 1,
    status: "pending",
    planDigest: record.plan_digest,
    workerWorkOrderCommitment: record.work_order_commitment,
    checkedAt: new Date().toISOString(),
  }, { status: 202, headers: dispositionHeaders("submitted") });
}

function reconciliationAbsencePendingResponse(
  planDigest: string,
  probe?: { first_observed_at: string; checked_at: string },
) {
  return Response.json({
    version: 1,
    status: "pending",
    planDigest,
    dispatchAbsencePending: true,
    ...(probe ? { firstCheckedAt: probe.first_observed_at, checkedAt: probe.checked_at } : {
      checkedAt: new Date().toISOString(),
    }),
  }, { status: 202, headers: dispositionHeaders("submitted") });
}

function workerOutcomeRequiresReconciliation(response: Response | null, value: unknown) {
  // Once the worker call begins, an HTTP rejection alone is not proof that no
  // venue broadcast occurred. Hyperliquid can return `venue_rejected` after
  // exchange.order (for example, on partial-fill/readback failure). Only an
  // exact terminal reconciliation may release the execution lock.
  if (!response || !response.ok) return true;
  const body = record(value);
  if (response.ok && body?.status === "submitted") return true;
  return false;
}

async function fetchWorkerRecipient(
  fetchImpl: typeof fetch,
  env: Record<string, string | undefined>,
  expectedImageDigest: string | null,
): Promise<
  | { ok: true; recipient: { recipient_id: string; x25519_pub_hex: string } }
  | { ok: false; error: string }
> {
  const config = autopilotWorkerConfig(env);
  if (!config.url) return { ok: false, error: "live_worker_not_configured" };
  const response = await fetchImpl(new URL("/.well-known/private-agent-recipient", config.url), {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!response?.ok) return { ok: false, error: "live_worker_recipient_unavailable" };
  const metadata = await response.json().catch(() => null) as RecipientMetadata | null;
  const recipientId = safeString(metadata?.recipient_id);
  const x25519PubHex = safeString(metadata?.x25519_pub_hex)?.toLowerCase() ?? "";
  const fundingSigner = safeString(metadata?.funding_signer_public_key_b64);
  const pinnedFundingSigners = new Set(configuredLiveTradingFundingSignerKeys(env));
  const reportData = safeString(metadata?.report_data_hex)?.toLowerCase();
  const releaseDigest = normalizeDigest(expectedImageDigest);
  if (
    metadata?.attested_ready !== true ||
    !recipientId ||
    !/^[a-f0-9]{64}$/u.test(x25519PubHex) ||
    !fundingSigner ||
    !pinnedFundingSigners.has(fundingSigner) ||
    !releaseDigest ||
    normalizeDigest(safeString(metadata?.image_digest)) !== releaseDigest ||
    reportData !== expectedRecipientReportDataHex({
      recipientId,
      x25519PubHex,
      fundingSignerPublicKeyB64: fundingSigner,
    }).toLowerCase()
  ) {
    return { ok: false, error: "live_worker_recipient_attestation_invalid" };
  }
  return { ok: true, recipient: { recipient_id: recipientId, x25519_pub_hex: x25519PubHex } };
}

async function sealInstruction(input: {
  recipient: { recipient_id: string; x25519_pub_hex: string };
  workOrderCommitment: string;
  plan: TradeOrderPlan;
}) {
  const privateKey = ed25519.utils.randomPrivateKey();
  const senderDid = didKeyFromVerifying(ed25519.getPublicKey(privateKey));
  const aad = [
    "ghola/private-execution-instruction-v1",
    `work_order:${input.workOrderCommitment}`,
    "venue:hyperliquid",
    `recipient:${input.recipient.recipient_id}`,
  ].join("|");
  const expiresAt = new Date(Date.now() + LIVE_INSTRUCTION_TTL_MS).toISOString();
  const plaintext = {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    expires_at: expiresAt,
    order: {
      market: input.plan.coin,
      side: input.plan.side,
      base_size: input.plan.base_size,
      limit_price: input.plan.limit_price,
      order_type: "limit",
      size_mode: "base",
      tif: "Ioc",
      post_only: false,
      reduce_only: input.plan.execution_policy.reduce_only,
      max_slippage_bps: String(input.plan.max_slippage_bps),
      leverage: 1,
      margin_mode: "isolated",
    },
    ...(input.plan.protection_intent ? {
      position_protection: {
        mode: "normal_tpsl",
        trigger_source: input.plan.protection_intent.trigger_source,
        take_profit_trigger_price: input.plan.protection_intent.take_profit_level,
        stop_loss_trigger_price: input.plan.protection_intent.stop_level,
        max_slippage_bps: String(input.plan.protection_intent.max_slippage_bps),
      },
    } : {}),
  };
  const sealed = await seal({
    senderDid,
    recipientId: input.recipient.recipient_id,
    recipientX25519: hexBytes(input.recipient.x25519_pub_hex),
    kind: RecipientKind.ModelBridge,
    associatedData: new TextEncoder().encode(aad),
    plaintext: new TextEncoder().encode(JSON.stringify(plaintext)),
    signBody: async (digest) => ed25519.sign(digest, privateKey),
  });
  return {
    expiresAt,
    bundle: {
      alg: "sealed-provider-v1" as const,
      ciphertext: Buffer.from(sealed).toString("base64"),
      recipient: input.recipient.recipient_id,
      aad,
    },
  };
}

function inspectWorkerReceipt(
  value: unknown,
  expected: { workOrderCommitment: string; vaultCommitment: string; expectedBaseSize?: string; requireProtection?: boolean; protectionSlippageBps?: number },
) {
  const body = record(value);
  const finalProof = record(body?.final_proof);
  const fillSummary = record(body?.fill_summary);
  const fillCount = Number(fillSummary?.fill_count);
  const directOrderId = hyperliquidOrderId(finalProof?.venue_order_oid);
  const terminalFill = body?.status === "filled" &&
    finalProof?.proof_kind === "hyperliquid_execution_proof_v1" &&
    finalProof?.status === "filled" &&
    finalProof?.final_fill_proven === true &&
    finalProof?.final_no_fill_proven !== true &&
    finalProof?.venue_order_readback_proven === true &&
    finalProof?.venue_order_status === "filled" &&
    directOrderId !== null &&
    hyperliquidCloid(finalProof?.venue_order_cloid) !== null &&
    Number.isInteger(fillCount) && fillCount >= 1;
  const status = terminalFill ? "reconciled" : body?.status === "submitted" ? "submitted" : null;
  const commitment = safeString(body?.result_commitment);
  if (
    !status ||
    !commitment ||
    !SAFE_COMMITMENT.test(commitment) ||
    body?.version !== 1 ||
    body?.platform_class !== "hyperliquid_style_market" ||
    body?.execution_mode !== "byo_api_key" ||
    body?.work_order_commitment !== expected.workOrderCommitment ||
    body?.vault_commitment !== expected.vaultCommitment ||
    finalProof?.venue_id !== "hyperliquid" ||
    finalProof?.network !== "mainnet" ||
    finalProof?.broadcast_performed !== true ||
    finalProof?.final_venue_execution_proven !== true ||
    finalProof?.execution_configuration_proven !== true ||
    finalProof?.margin_mode !== "isolated" ||
    finalProof?.leverage !== 1 ||
    finalProof?.market_data_freshness_proven !== true ||
    finalProof?.market_slippage_bound_proven !== true ||
    finalProof?.market_max_age_ms !== 2_000 ||
    !boundedInteger(finalProof?.market_source_age_ms, 0, 2_000) ||
    finalProof?.action_expiry_proven !== true ||
    !boundedInteger(finalProof?.expires_after_ms, 1, Number.MAX_SAFE_INTEGER) ||
    (expected.requireProtection === true && (
      finalProof?.position_protection_proven !== true ||
      finalProof?.protection_grouping !== "normalTpsl" ||
      finalProof?.protection_trigger_source !== "mark" ||
      finalProof?.protection_trigger_order_type !== "bounded_limit" ||
      finalProof?.protection_max_slippage_bps !== expected.protectionSlippageBps
    ))
  ) return null;
  const provenFill = terminalFill
    ? inspectProvenHyperliquidFill(fillSummary, finalProof, expected)
    : null;
  return {
    status,
    commitment,
    orderId: terminalFill ? directOrderId : null,
    provenFill,
  };
}

function inspectWorkerReconciliationReceipt(
  value: unknown,
  expected: { workOrderCommitment: string; vaultCommitment: string; requireProtection?: boolean; protectionSlippageBps?: number },
) {
  const body = record(value);
  const finalProof = record(body?.final_proof);
  const fillSummary = record(body?.fill_summary);
  const commitment = safeString(body?.result_commitment);
  const fillCount = Number(fillSummary?.fill_count);
  const finalFill = finalProof?.final_fill_proven === true;
  const finalNoFill = finalProof?.final_no_fill_proven === true;
  const finalNoBroadcast = finalProof?.final_no_broadcast_proven === true;
  const orderId = hyperliquidOrderId(finalProof?.venue_order_oid);
  const cloid = hyperliquidCloid(finalProof?.venue_order_cloid);
  const terminalStatus = safeString(finalProof?.terminal_status);
  const venueOrderStatus = safeString(finalProof?.venue_order_status);
  const terminalStatusProven = Boolean(
    terminalStatus && venueOrderStatus && terminalStatus === venueOrderStatus &&
    TERMINAL_HYPERLIQUID_ORDER_STATUSES.has(normalizeHyperliquidStatus(terminalStatus)),
  );
  const venueOutcome = finalFill || finalNoFill;
  const venueSizeOutcome = inspectHyperliquidVenueSizeOutcome(finalProof);
  const noBroadcastOutcome = finalNoBroadcast &&
    finalProof?.broadcast_performed === false &&
    finalProof?.final_venue_execution_proven === true &&
    finalProof?.venue_order_readback_proven === false &&
    orderId === null && cloid === null && fillCount === 0 &&
    ["cancelled", "failed", "nosubmit", "rejected"].includes(normalizeHyperliquidStatus(terminalStatus));
  if (
    !commitment ||
    !SAFE_COMMITMENT.test(commitment) ||
    body?.version !== 1 ||
    body?.platform_class !== "hyperliquid_style_market" ||
    body?.execution_mode !== "byo_api_key" ||
    body?.work_order_commitment !== expected.workOrderCommitment ||
    body?.vault_commitment !== expected.vaultCommitment ||
    finalProof?.proof_kind !== "hyperliquid_execution_proof_v1" ||
    finalProof?.venue_id !== "hyperliquid" ||
    finalProof?.network !== "mainnet" ||
    Number(finalFill) + Number(finalNoFill) + Number(finalNoBroadcast) !== 1 ||
    finalProof?.final_venue_execution_proven !== true ||
    !Number.isInteger(fillCount) ||
    (venueOutcome && (
      finalProof?.broadcast_performed !== true ||
      finalProof?.venue_order_readback_proven !== true ||
      orderId === null || cloid === null || !terminalStatusProven || !venueSizeOutcome ||
      venueSizeOutcome.filled !== finalFill ||
      (finalFill && (fillCount < 1 || finalProof?.status !== "filled")) ||
      (finalNoFill && (fillCount !== 0 || normalizeHyperliquidStatus(terminalStatus) === "filled" ||
        finalProof?.status !== terminalStatus))
    )) ||
    (finalNoBroadcast && !noBroadcastOutcome) ||
    (expected.requireProtection === true && finalFill && (
      finalProof?.position_protection_proven !== true ||
      finalProof?.protection_grouping !== "normalTpsl" ||
      finalProof?.protection_trigger_source !== "mark" ||
      finalProof?.protection_trigger_order_type !== "bounded_limit" ||
      finalProof?.protection_max_slippage_bps !== expected.protectionSlippageBps
    ))
  ) return null;
  const provenFill = finalFill
    ? inspectProvenHyperliquidFill(fillSummary, finalProof, expected)
    : null;
  return {
    commitment,
    filled: finalFill,
    noFill: finalNoFill,
    notDispatched: finalNoBroadcast,
    orderId: venueOutcome ? orderId : null,
    provenFill,
  };
}

function inspectProvenHyperliquidFill(
  fillSummary: Record<string, unknown> | null,
  finalProof: Record<string, unknown> | null,
  expected: { expectedBaseSize?: string; requireProtection?: boolean; protectionSlippageBps?: number },
): LiveTradingProvenFill | null {
  const baseSize = exactUnsignedDecimalValue(fillSummary?.filled_base_size);
  const averagePrice = exactUnsignedDecimalValue(fillSummary?.average_fill_price);
  const feeUsd = exactUnsignedDecimalValue(fillSummary?.fee_usd);
  if (!baseSize || baseSize.units === BigInt(0) || !averagePrice || averagePrice.units === BigInt(0) ||
      !feeUsd || fillSummary?.fee_status !== "reported") return null;

  const provenSize = finalProof?.venue_order_filled_size != null
    ? exactUnsignedDecimalValue(finalProof.venue_order_filled_size)
    : exactUnsignedDecimalValue(expected.expectedBaseSize);
  if (!provenSize || !sameExactUnsignedDecimal(baseSize, provenSize)) return null;

  let protection: LiveTradingProvenFill["protection"] = { status: "not_requested" };
  if (expected.requireProtection === true) {
    if (finalProof?.position_protection_proven !== true ||
        finalProof.protection_grouping !== "normalTpsl" ||
        finalProof.protection_trigger_source !== "mark" ||
        finalProof.protection_trigger_order_type !== "bounded_limit" ||
        finalProof.protection_max_slippage_bps !== expected.protectionSlippageBps ||
        expected.protectionSlippageBps == null) return null;
    protection = {
      status: "proven",
      grouping: "normalTpsl",
      trigger_source: "mark",
      trigger_order_type: "bounded_limit",
      max_slippage_bps: expected.protectionSlippageBps,
    };
  }
  return {
    filled_base_size: baseSize.text,
    average_fill_price: averagePrice.text,
    fee_usd: feeUsd.text,
    protection,
  };
}

function publicProvenFill(fill: LiveTradingProvenFill) {
  return {
    filledBaseSize: fill.filled_base_size,
    averageFillPrice: fill.average_fill_price,
    feeUsd: fill.fee_usd,
    protection: fill.protection.status === "proven" ? {
      status: "proven" as const,
      grouping: fill.protection.grouping,
      triggerSource: fill.protection.trigger_source,
      triggerOrderType: fill.protection.trigger_order_type,
      maxSlippageBps: fill.protection.max_slippage_bps,
    } : { status: "not_requested" as const },
  };
}

function inspectHyperliquidVenueSizeOutcome(finalProof: Record<string, unknown> | null) {
  const original = exactUnsignedDecimal(finalProof?.venue_order_original_size);
  const remaining = exactUnsignedDecimal(finalProof?.venue_order_remaining_size);
  const reportedFilled = exactUnsignedDecimal(finalProof?.venue_order_filled_size);
  if (!original || !remaining || !reportedFilled || original.units === BigInt(0)) return null;
  const scale = Math.max(original.scale, remaining.scale, reportedFilled.scale);
  const originalUnits = original.units * BigInt(10) ** BigInt(scale - original.scale);
  const remainingUnits = remaining.units * BigInt(10) ** BigInt(scale - remaining.scale);
  const reportedFilledUnits = reportedFilled.units * BigInt(10) ** BigInt(scale - reportedFilled.scale);
  if (remainingUnits > originalUnits || originalUnits - remainingUnits !== reportedFilledUnits) return null;
  return { filled: reportedFilledUnits > BigInt(0) };
}

function exactUnsignedDecimal(value: unknown) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) || value.length > 80) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function exactUnsignedDecimalValue(value: unknown) {
  const text = typeof value === "number" && Number.isFinite(value) && value >= 0
    ? String(value)
    : typeof value === "string" ? value : null;
  if (text == null) return null;
  const parsed = exactUnsignedDecimal(text);
  return parsed ? { ...parsed, text } : null;
}

function sameExactUnsignedDecimal(
  left: { units: bigint; scale: number },
  right: { units: bigint; scale: number },
) {
  const scale = Math.max(left.scale, right.scale);
  return left.units * BigInt(10) ** BigInt(scale - left.scale) ===
    right.units * BigInt(10) ** BigInt(scale - right.scale);
}

function hyperliquidOrderId(value: unknown) {
  const oid = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === "string" && /^[1-9]\d{0,31}$/u.test(value)
      ? value
      : null;
  return oid ? `hyperliquid:${oid}` : null;
}

function hyperliquidCloid(value: unknown) {
  return typeof value === "string" && /^0x[a-f0-9]{32}$/u.test(value)
    ? value
    : null;
}

function normalizeHyperliquidStatus(value: string | null) {
  return value?.toLowerCase().replace(/[^a-z0-9]+/gu, "") ?? "";
}

function publicWorkerFailure(value: unknown) {
  const body = record(value);
  const error = safeString(body?.error);
  const errorCode = safeString(body?.error_code);
  return {
    error: error && /^[A-Za-z0-9 _.:/()-]{3,200}$/u.test(error)
      ? error
      : "live_worker_submit_failed",
    ...(errorCode && /^[A-Za-z0-9_.:-]{3,96}$/u.test(errorCode)
      ? { error_code: errorCode }
      : {}),
  };
}

function dispositionHeaders(disposition: LiveTradingDispatchDisposition) {
  return {
    [LIVE_TRADING_DISPATCH_DISPOSITION_HEADER]: disposition,
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
  };
}

function failure(
  status: number,
  error: string,
  disposition: LiveTradingDispatchDisposition = "not_dispatched",
) {
  return Response.json({ error }, { status, headers: dispositionHeaders(disposition) });
}

function normalizeDigest(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase().replace(/^sha256:/u, "") ?? "";
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function safeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedInteger(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function hexBytes(value: string) {
  return Uint8Array.from(Buffer.from(value, "hex"));
}
