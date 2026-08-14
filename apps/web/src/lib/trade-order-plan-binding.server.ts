import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  stableTradeStringify,
  validateTradeOrderPlan,
  type TradeOrderPlan,
  type TradeOrderPlanBindingEnvelope,
  type TradeOrderVenueId,
} from "./trade-order-plan";

export const TRADE_ORDER_PLAN_BINDING_VERSION = 1 as const;
const PURPOSE = "ghola_trade_order_plan_binding" as const;

export type TradeOrderPlanBinding = TradeOrderPlanBindingEnvelope;

interface BindingTokenPayload {
  version: typeof TRADE_ORDER_PLAN_BINDING_VERSION;
  purpose: typeof PURPOSE;
  preview_commitment: string;
  plan_digest: string;
  subject_commitment: string;
  issued_at: string;
  expires_at: string;
}

export type TradeOrderPlanBindingVerification =
  | { ok: true; binding: TradeOrderPlanBinding; subject_commitment: string }
  | { ok: false; error: string };

export type TradeExecutionIdentityVerification =
  | {
      ok: true;
      executionCredentialHandleCommitment: string;
      venueAccountCommitment: string | null;
      upstreamAccountId: string;
    }
  | { ok: false; error: string };

/** Recomputes browser commitment v1 from the authenticated session subject. */
export function tradeExecutionIdentityCommitments(
  verifiedSubjectId: string,
  venueId: TradeOrderVenueId,
) {
  if (!verifiedSubjectId) throw new Error("execution_identity_subject_missing");
  const executionCredentialHandleCommitment = sha256Commitment({
    type: "ghola_trade_page_execution_credential_handle_v1",
    webUserId: verifiedSubjectId,
    venueId,
  });
  const venueAccountCommitment = venueId === "hyperliquid"
    ? sha256Commitment({
        type: "ghola_trade_page_hyperliquid_account_commitment_v1",
        webUserId: verifiedSubjectId,
      })
    : venueId === "coinbase"
      ? sha256Commitment({
          type: "ghola_trade_page_coinbase_account_commitment_v1",
          webUserId: verifiedSubjectId,
        })
      : null;
  return {
    executionCredentialHandleCommitment,
    venueAccountCommitment,
    upstreamAccountId: venueAccountCommitment ?? executionCredentialHandleCommitment,
  };
}

/** Authorizes every upstream identity selector against the verified subject. */
export function verifyTradeExecutionIdentityCommitments(
  requestInput: unknown,
  input: { verifiedSubjectId: string; venueId: TradeOrderVenueId },
): TradeExecutionIdentityVerification {
  const request = objectValue(requestInput);
  if (!request || !input.verifiedSubjectId) {
    return { ok: false, error: "execution_identity_subject_missing" };
  }
  const expected = tradeExecutionIdentityCommitments(input.verifiedSubjectId, input.venueId);
  const credentialCommitments = objectValue(request.executionCredentialHandleCommitmentsByVenue);
  if (
    !credentialCommitments ||
    Object.keys(credentialCommitments).length !== 1 ||
    !commitmentEqual(
      credentialCommitments[input.venueId],
      expected.executionCredentialHandleCommitment,
    )
  ) {
    return { ok: false, error: "execution_credential_subject_mismatch" };
  }
  const accountField = input.venueId === "hyperliquid"
    ? request.hyperliquidAccountCommitment
    : input.venueId === "coinbase"
      ? request.coinbaseAccountCommitment
      : undefined;
  if (
    expected.venueAccountCommitment !== null &&
    !commitmentEqual(accountField, expected.venueAccountCommitment)
  ) {
    return { ok: false, error: "execution_account_subject_mismatch" };
  }
  return { ok: true, ...expected };
}

export function tradeOrderPlanBindingSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GHOLA_ORDER_PLAN_BINDING_SECRET?.trim()
    || env.GHOLA_EXECUTION_BRIDGE_SIGNING_SECRET?.trim()
    || env.GHOLA_EXECUTION_BRIDGE_AUTH_TOKEN?.trim()
    || env.BRIDGE_AUTH_TOKEN?.trim()
    || null;
}

export function issueTradeOrderPlanBinding(input: {
  orderPlan: TradeOrderPlan;
  previewCommitment: string;
  subjectCommitment: string;
  previewExpiresAt: string;
  secret: string;
  nowMs?: number;
}): TradeOrderPlanBinding {
  const nowMs = input.nowMs ?? Date.now();
  const validation = validateTradeOrderPlan(input.orderPlan, { nowMs, requireFresh: true });
  if (!validation.ok) throw new Error(validation.error);
  if (!input.previewCommitment.trim() || !input.subjectCommitment.trim()) throw new Error("order_plan_binding_context_invalid");
  if (!input.secret.trim()) throw new Error("order_plan_binding_secret_missing");
  const plan = validation.plan;
  const marketExpiryMs = Date.parse(plan.market_context.fetched_at) + plan.market_context.max_age_ms;
  const previewExpiryMs = Date.parse(input.previewExpiresAt);
  if (!Number.isFinite(previewExpiryMs)) throw new Error("order_plan_preview_expiry_invalid");
  const expiresAtMs = Math.min(marketExpiryMs, previewExpiryMs, nowMs + 120_000);
  if (expiresAtMs <= nowMs) throw new Error("order_plan_market_stale");
  const planDigest = tradeOrderPlanDigest(plan);
  const payload: BindingTokenPayload = {
    version: TRADE_ORDER_PLAN_BINDING_VERSION,
    purpose: PURPOSE,
    preview_commitment: input.previewCommitment,
    plan_digest: planDigest,
    subject_commitment: input.subjectCommitment,
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
  };
  const encodedPayload = Buffer.from(stableTradeStringify(payload)).toString("base64url");
  const signature = bindingSignature(encodedPayload, input.secret);
  return {
    version: TRADE_ORDER_PLAN_BINDING_VERSION,
    algorithm: "HMAC-SHA256",
    preview_commitment: payload.preview_commitment,
    plan_digest: planDigest,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    token: `${encodedPayload}.${signature}`,
    order_plan: plan,
  };
}

export function verifyTradeOrderPlanBinding(
  input: unknown,
  options: { secret: string; nowMs?: number },
): TradeOrderPlanBindingVerification {
  const binding = objectValue(input);
  if (!binding || !hasExactBindingKeys(binding)) return { ok: false, error: "order_plan_binding_missing" };
  if (binding.version !== TRADE_ORDER_PLAN_BINDING_VERSION || binding.algorithm !== "HMAC-SHA256") {
    return { ok: false, error: "order_plan_binding_version_invalid" };
  }
  if (!options.secret.trim()) return { ok: false, error: "order_plan_binding_secret_missing" };
  const token = typeof binding.token === "string" ? binding.token : "";
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra) return { ok: false, error: "order_plan_binding_token_invalid" };
  const expected = bindingSignature(encodedPayload, options.secret);
  if (!safeEqual(signature, expected)) return { ok: false, error: "order_plan_binding_signature_invalid" };

  let payload: BindingTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as BindingTokenPayload;
  } catch {
    return { ok: false, error: "order_plan_binding_token_invalid" };
  }
  if (
    payload.version !== TRADE_ORDER_PLAN_BINDING_VERSION ||
    payload.purpose !== PURPOSE ||
    typeof payload.preview_commitment !== "string" ||
    typeof payload.plan_digest !== "string" ||
    typeof payload.subject_commitment !== "string" ||
    typeof payload.issued_at !== "string" ||
    typeof payload.expires_at !== "string"
  ) return { ok: false, error: "order_plan_binding_token_invalid" };

  const nowMs = options.nowMs ?? Date.now();
  const issuedAtMs = Date.parse(payload.issued_at);
  const expiresAtMs = Date.parse(payload.expires_at);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || issuedAtMs > nowMs + 5_000) {
    return { ok: false, error: "order_plan_binding_time_invalid" };
  }
  if (expiresAtMs <= nowMs) return { ok: false, error: "order_plan_binding_expired" };

  const planValidation = validateTradeOrderPlan(binding.order_plan, { nowMs, requireFresh: true });
  if (!planValidation.ok) return { ok: false, error: planValidation.error };
  const planDigest = tradeOrderPlanDigest(planValidation.plan);
  if (
    binding.preview_commitment !== payload.preview_commitment ||
    binding.plan_digest !== payload.plan_digest ||
    binding.issued_at !== payload.issued_at ||
    binding.expires_at !== payload.expires_at ||
    planDigest !== payload.plan_digest
  ) return { ok: false, error: "order_plan_binding_mismatch" };

  return {
    ok: true,
    subject_commitment: payload.subject_commitment,
    binding: {
      version: TRADE_ORDER_PLAN_BINDING_VERSION,
      algorithm: "HMAC-SHA256",
      preview_commitment: payload.preview_commitment,
      plan_digest: planDigest,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
      token,
      order_plan: planValidation.plan,
    },
  };
}

export function tradeOrderPlanDigest(plan: TradeOrderPlan) {
  return `sha256:${createHash("sha256").update(stableTradeStringify(plan)).digest("hex")}`;
}

function sha256Commitment(value: unknown) {
  return createHash("sha256").update(stableTradeStringify(value)).digest("hex");
}

function commitmentEqual(actual: unknown, expected: string) {
  return typeof actual === "string" && /^[0-9a-f]{64}$/.test(actual) && safeEqual(actual, expected);
}

function bindingSignature(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`${PURPOSE}\n${encodedPayload}`)
    .digest("base64url");
}

function safeEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasExactBindingKeys(binding: Record<string, unknown>) {
  const allowed = new Set(["version", "algorithm", "preview_commitment", "plan_digest", "issued_at", "expires_at", "token", "order_plan"]);
  const keys = Object.keys(binding);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}
