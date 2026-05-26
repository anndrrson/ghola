import { NextResponse } from "next/server";
import {
  DEFAULT_PRIVATE_EXECUTION_FEE_BPS,
  DEFAULT_PRIVATE_EXECUTION_MIN_FEE_MICRO_USDC,
  containsPrivateExecutionPlaintextLeak,
  parsePrivateExecutionAgentKeys,
  privateExecutionFeeQuote,
  signPrivateExecutionReceipt,
  verifyPrivateExecutionProviderResultSignature,
  type PrivateExecutionAgentConfig,
  type PrivateExecutionExecuteRequestV1,
  type PrivateExecutionReceiptV1,
  type PrivateExecutionStatusV1,
} from "@/lib/private-execution";

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

export function privateExecutionEnv() {
  const feeBps = Number.parseInt(
    process.env.GHOLA_PRIVATE_EXECUTION_FEE_BPS || "",
    10,
  );
  const minFee = Number.parseInt(
    process.env.GHOLA_PRIVATE_EXECUTION_MIN_FEE_MICRO_USDC || "",
    10,
  );
  const feeRecipient = process.env.GHOLA_PRIVATE_EXECUTION_FEE_RECIPIENT || "";
  const providerId = process.env.GHOLA_PRIVATE_EXECUTION_PROVIDER_ID || "mock_attested";
  const signingSecret =
    process.env.GHOLA_PRIVATE_EXECUTION_RECEIPT_SECRET || "ghola-dev-private-execution-receipts";
  return {
    feeBps: Number.isFinite(feeBps) && feeBps > 0 ? feeBps : DEFAULT_PRIVATE_EXECUTION_FEE_BPS,
    minFeeMicroUsdc:
      Number.isFinite(minFee) && minFee > 0
        ? minFee
        : DEFAULT_PRIVATE_EXECUTION_MIN_FEE_MICRO_USDC,
    feeRecipient,
    providerId,
    signingSecret,
    providerResultSecret:
      process.env.GHOLA_PRIVATE_EXECUTION_PROVIDER_RESULT_SECRET || "",
    allowMockProviderResult:
      process.env.GHOLA_PRIVATE_EXECUTION_ALLOW_MOCK_RESULT === "true",
  };
}

export function privateExecutionStatus(): PrivateExecutionStatusV1 {
  const env = privateExecutionEnv();
  const shieldedRailOverride = process.env.GHOLA_PRIVATE_EXECUTION_SHIELDED_RAIL_READY;
  const shieldedRailReady =
    shieldedRailOverride === "true" ||
    (shieldedRailOverride !== "false" &&
      process.env.RAILGUN_EVM_ADAPTER_URL !== undefined);
  const sealedProviderReady =
    process.env.GHOLA_PRIVATE_EXECUTION_PROVIDER_READY !== "false";
  const blockingReasons = [
    env.feeRecipient ? null : "fee_recipient_unconfigured",
    shieldedRailReady ? null : "shielded_rail_unavailable",
    sealedProviderReady ? null : "sealed_provider_unavailable",
  ].filter((item): item is string => Boolean(item));

  return {
    version: 1,
    ready: blockingReasons.length === 0,
    supported_rails: shieldedRailReady ? ["railgun_private_swap"] : [],
    fee_bps: env.feeBps,
    min_fee_micro_usdc: env.minFeeMicroUsdc,
    fee_recipient_configured: Boolean(env.feeRecipient),
    shielded_rail_ready: shieldedRailReady,
    sealed_provider_ready: sealedProviderReady,
    provider_result_required: !env.allowMockProviderResult,
    blocking_reasons: blockingReasons,
  };
}

export function agentForRequest(req: Request): PrivateExecutionAgentConfig | null {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const key = auth.slice("Bearer ".length).trim();
  if (!key) return null;
  try {
    return parsePrivateExecutionAgentKeys(process.env.GHOLA_AGENT_API_KEYS).get(key) ?? null;
  } catch {
    return null;
  }
}

export function validateExecuteRequest(body: unknown): {
  ok: boolean;
  request?: PrivateExecutionExecuteRequestV1;
  error?: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "request body must be an object" };
  }
  if (containsPrivateExecutionPlaintextLeak(body)) {
    return {
      ok: false,
      error: "request must not contain plaintext strategy, prompt, messages, portfolio, or financial context",
    };
  }
  const value = body as Partial<PrivateExecutionExecuteRequestV1>;
  if (value.version !== 1) return { ok: false, error: "version must be 1" };
  for (const key of ["intent_id", "owner_did", "policy_hash", "proposal_hash"] as const) {
    if (typeof value[key] !== "string" || !value[key]?.trim()) {
      return { ok: false, error: `${key} is required` };
    }
  }
  if (value.rail !== "railgun_private_swap") {
    return { ok: false, error: "rail must be railgun_private_swap" };
  }
  if (!Number.isFinite(value.amount_micro_usdc) || Number(value.amount_micro_usdc) <= 0) {
    return { ok: false, error: "amount_micro_usdc must be positive" };
  }
  const bundle = value.encrypted_intent_bundle;
  if (!bundle || typeof bundle !== "object") {
    return { ok: false, error: "encrypted_intent_bundle is required" };
  }
  if (
    bundle.alg !== "sealed-provider-v1" &&
    bundle.alg !== "hpke-x25519-aes256gcm"
  ) {
    return { ok: false, error: "encrypted_intent_bundle.alg is unsupported" };
  }
  for (const key of ["ciphertext", "recipient", "aad"] as const) {
    if (typeof bundle[key] !== "string" || !bundle[key].trim()) {
      return { ok: false, error: `encrypted_intent_bundle.${key} is required` };
    }
  }
  return { ok: true, request: value as PrivateExecutionExecuteRequestV1 };
}

export function validateProviderResult(input: {
  request: PrivateExecutionExecuteRequestV1;
  agent: PrivateExecutionAgentConfig;
}): { ok: true } | { ok: false; error: string } {
  const env = privateExecutionEnv();
  const fee = privateExecutionFeeQuote({
    amountMicroUsdc: input.request.amount_micro_usdc,
    feeRecipient: env.feeRecipient,
    feeBps: input.agent.fee_bps ?? env.feeBps,
    minFeeMicroUsdc: env.minFeeMicroUsdc,
  });
  const result = input.request.provider_result;
  if (!result) {
    return env.allowMockProviderResult
      ? { ok: true }
      : { ok: false, error: "provider_result is required" };
  }
  if (!env.providerResultSecret) {
    return {
      ok: false,
      error: "provider result verification secret is not configured",
    };
  }
  if (!verifyPrivateExecutionProviderResultSignature(result, env.providerResultSecret)) {
    return { ok: false, error: "provider_result signature is invalid" };
  }
  const checks: Array<[boolean, string]> = [
    [result.provider_id === env.providerId, "provider_result provider mismatch"],
    [result.rail === input.request.rail, "provider_result rail mismatch"],
    [result.policy_hash === input.request.policy_hash, "provider_result policy hash mismatch"],
    [result.proposal_hash === input.request.proposal_hash, "provider_result proposal hash mismatch"],
    [result.amount_micro_usdc === input.request.amount_micro_usdc, "provider_result amount mismatch"],
    [result.fee_micro_usdc === fee.fee_micro_usdc, "provider_result fee mismatch"],
    [result.fee_recipient === fee.fee_recipient, "provider_result fee recipient mismatch"],
    [Boolean(result.tx_ref.trim()), "provider_result tx_ref is required"],
  ];
  const failed = checks.find(([ok]) => !ok);
  return failed ? { ok: false, error: failed[1] } : { ok: true };
}

export function buildExecutionReceipt(input: {
  request: PrivateExecutionExecuteRequestV1;
  agent: PrivateExecutionAgentConfig;
}): PrivateExecutionReceiptV1 {
  const env = privateExecutionEnv();
  const providerResult = input.request.provider_result;
  const unsigned = {
    version: 1 as const,
    receipt_id: `pex_${crypto.randomUUID()}`,
    intent_id: input.request.intent_id,
    agent_id: input.agent.agent_id,
    policy_hash: input.request.policy_hash,
    proposal_hash: input.request.proposal_hash,
    rail: "railgun_private_swap" as const,
    amount_micro_usdc: input.request.amount_micro_usdc,
    fee_quote: privateExecutionFeeQuote({
      amountMicroUsdc: input.request.amount_micro_usdc,
      feeRecipient: env.feeRecipient,
      feeBps: input.agent.fee_bps ?? env.feeBps,
      minFeeMicroUsdc: env.minFeeMicroUsdc,
    }),
    provider_id: providerResult?.provider_id ?? env.providerId,
    executed_at: providerResult?.executed_at ?? new Date().toISOString(),
    tx_ref: providerResult?.tx_ref ?? `shielded:${input.request.intent_id}`,
    public_fallback_used: false as const,
  };
  return {
    ...unsigned,
    signature: signPrivateExecutionReceipt(unsigned, env.signingSecret),
  };
}
