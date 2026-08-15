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
const SAFE_COMMITMENT = /^[A-Za-z0-9_:-]{8,200}$/u;
const LIVE_INSTRUCTION_TTL_MS = 15_000;
const LIVE_RECONCILIATION_DELAYS_MS = [200, 800] as const;

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
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  waitImpl?: (delayMs: number) => Promise<void>;
}): Promise<Response> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
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

  const [vault, recipientResult] = await Promise.all([
    getHyperliquidExecutionVaultByAccount(input.account_commitment),
    fetchWorkerRecipient(fetchImpl, env, release.worker_image_digest),
  ]);
  if (
    !vault ||
    vault.owner_commitment !== input.owner_commitment ||
    vault.vault_commitment !== input.vault_commitment ||
    vault.status !== "sealed"
  ) {
    return failure(409, "sealed_hyperliquid_vault_required");
  }
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
  const encryptedInstruction = await sealInstruction({
    recipient,
    workOrderCommitment,
    plan: input.order_plan,
  }).catch(() => null);
  if (!encryptedInstruction) return failure(503, "live_instruction_seal_failed");

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
  const body = {
    version: 1,
    owner_commitment: input.owner_commitment,
    account_commitment: input.account_commitment,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "limit_order",
    work_order_commitment: workOrderCommitment,
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
      body,
      market: input.order_plan.coin,
      fetchImpl,
      env,
      workerUrl: String(config.url),
      workOrderCommitment,
      vaultCommitment: vault.vault_commitment,
      requireProtection: Boolean(input.order_plan.protection_intent),
      protectionSlippageBps: input.order_plan.protection_intent?.max_slippage_bps,
      waitImpl: input.waitImpl,
    });
    if (reconciliation?.filled) {
      return liveRunResponse({
        status: "reconciled",
        commitment: reconciliation.commitment,
        workOrderCommitment,
      });
    }
    if (reconciliation?.noFill) {
      return Response.json({
        error: "live_order_reconciled_no_fill",
        workerWorkOrderCommitment: workOrderCommitment,
      }, { status: 409 });
    }
  }
  if (!response) {
    return Response.json({
      error: "live_worker_reconciliation_pending",
      workerWorkOrderCommitment: workOrderCommitment,
    }, { status: 503 });
  }
  if (!response.ok) {
    return Response.json(publicWorkerFailure(workerBody), {
      status: response.status >= 400 ? response.status : 502,
    });
  }
  const receipt = inspectWorkerReceipt(workerBody, {
    workOrderCommitment,
    vaultCommitment: vault.vault_commitment,
    requireProtection: Boolean(input.order_plan.protection_intent),
    protectionSlippageBps: input.order_plan.protection_intent?.max_slippage_bps,
  });
  if (!receipt) return failure(502, "live_worker_receipt_invalid");
  return liveRunResponse({
    status: receipt.status,
    commitment: receipt.commitment,
    workOrderCommitment,
  });
}

function liveRunResponse(input: { status: string; commitment: string; workOrderCommitment: string }) {
  return Response.json({
    appLiveTradingExecutionRun: {
      status: input.status,
      gholaAppLiveTradingExecutionRunCommitment: input.commitment,
      liveTradingOrder: null,
      workerWorkOrderCommitment: input.workOrderCommitment,
    },
  }, { status: 202 });
}

async function reconcileSubmittedWorkOrder(input: {
  body: Record<string, unknown>;
  market: string;
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
  workerUrl: string;
  workOrderCommitment: string;
  vaultCommitment: string;
  requireProtection: boolean;
  protectionSlippageBps?: number;
  waitImpl?: (delayMs: number) => Promise<void>;
}) {
  const reconcileBody = {
    version: 1,
    owner_commitment: input.body.owner_commitment,
    account_commitment: input.body.account_commitment,
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "byo_api_key",
    operation_class: "reconcile",
    work_order_commitment: input.workOrderCommitment,
    vault_commitment: input.vaultCommitment,
    policy_commitment: input.body.policy_commitment,
    encrypted_execution_vault: input.body.encrypted_execution_vault,
    encrypted_execution_instruction_bundle: input.body.encrypted_execution_instruction_bundle,
    market: input.market,
  };
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
  const waitImpl = input.waitImpl ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  for (const delayMs of LIVE_RECONCILIATION_DELAYS_MS) {
    await waitImpl(delayMs);
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
    if (!response?.ok) continue;
    const receipt = inspectWorkerReconciliationReceipt(await response.json().catch(() => null), {
      workOrderCommitment: input.workOrderCommitment,
      vaultCommitment: input.vaultCommitment,
      requireProtection: input.requireProtection,
      protectionSlippageBps: input.protectionSlippageBps,
    });
    if (receipt) return receipt;
  }
  return null;
}

function workerOutcomeRequiresReconciliation(response: Response | null, value: unknown) {
  if (!response || response.status >= 500) return true;
  const body = record(value);
  return response.status === 409 && (
    body?.error_code === "EXECUTION_CLAIM_RECONCILE_REQUIRED" ||
    body?.error === "execution claim is unresolved; reconciliation required"
  );
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
  const plaintext = {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "hyperliquid",
    operation_class: "limit_order",
    expires_at: new Date(Date.now() + LIVE_INSTRUCTION_TTL_MS).toISOString(),
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
    alg: "sealed-provider-v1" as const,
    ciphertext: Buffer.from(sealed).toString("base64"),
    recipient: input.recipient.recipient_id,
    aad,
  };
}

function inspectWorkerReceipt(
  value: unknown,
  expected: { workOrderCommitment: string; vaultCommitment: string; requireProtection?: boolean; protectionSlippageBps?: number },
) {
  const body = record(value);
  const finalProof = record(body?.final_proof);
  const status = body?.status === "reconciled" ? "reconciled" :
    body?.status === "submitted" || body?.status === "filled" ? "submitted" : null;
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
  return { status, commitment };
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
    finalProof?.broadcast_performed !== true ||
    finalProof?.final_venue_execution_proven !== true ||
    !safeString(finalProof?.terminal_status) ||
    (finalFill === finalNoFill) ||
    !Number.isInteger(fillCount) ||
    (finalFill && fillCount < 1) ||
    (finalNoFill && fillCount !== 0) ||
    (expected.requireProtection === true && finalFill && (
      finalProof?.position_protection_proven !== true ||
      finalProof?.protection_grouping !== "normalTpsl" ||
      finalProof?.protection_trigger_source !== "mark" ||
      finalProof?.protection_trigger_order_type !== "bounded_limit" ||
      finalProof?.protection_max_slippage_bps !== expected.protectionSlippageBps
    ))
  ) return null;
  return {
    commitment,
    filled: finalFill,
    noFill: finalNoFill,
  };
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

function failure(status: number, error: string) {
  return Response.json({ error }, { status });
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
