import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import {
  applyNoStore,
  fetchSessionUser,
  sameOrigin,
  SESSION_COOKIE_NAME,
} from "@/app/api/auth/session/_lib";
import {
  LIGHTER_UDA_BASE_CHAIN_ID,
  LIGHTER_UDA_BASE_USDC_TOKEN_ADDRESS,
  LIGHTER_UDA_MINIMUM_USDC_MICROUNITS,
} from "@/lib/lighter-universal-deposit-address.server";
import { assertLighterFundingEligibility } from "@/lib/lighter-funding-eligibility.server";
import { resolveLighterTurnkeyPerpsOwnerBinding } from "@/lib/lighter-turnkey-owner-binding.server";
import { readLighterUdaAttemptReconciliationEvidence } from "@/lib/lighter-uda-attempt-reconciliation.server";
import { gholaCommitment } from "@/lib/private-account";
import {
  getPrivateLighterUdaAttempt,
  type PrivateLighterUdaDestinationV1,
} from "@/lib/private-account-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_KEYS = ["eligibility_attestation", "owner_address", "version"];

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return json({ error: "lighter_uda_cross_site_rejected" }, 403);
  if (!isJson(req)) return json({ error: "lighter_uda_json_required" }, 415);
  const body = await readObject(req);
  if (!body || !exactKeys(body, BODY_KEYS) || body.version !== 1) {
    return json({ error: "lighter_uda_reconciliation_request_invalid" }, 400);
  }
  const sessionToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionToken) return json({ error: "lighter_uda_session_required" }, 401);
  const session = await verifiedSession(sessionToken);
  if (!session.ok) return json({ error: session.error }, session.status);

  let ownerAddress: `0x${string}`;
  try {
    ownerAddress = exactAddress(body.owner_address);
    assertLighterFundingEligibility({
      request: req,
      attestation: body.eligibility_attestation,
    });
    await resolveLighterTurnkeyPerpsOwnerBinding({
      sessionEmail: session.email,
      ownerAddress,
    });
  } catch (caught) {
    return knownFailure(caught, "lighter_uda_reconciliation_authorization_failed", lockedSafety());
  }
  const ownerCommitment = gholaCommitment("owner", session.userId);
  const walletCommitment = gholaCommitment("wallet", ownerAddress.toLowerCase());
  let attempt: Awaited<ReturnType<typeof getPrivateLighterUdaAttempt>>;
  try {
    attempt = await getPrivateLighterUdaAttempt({
      owner_commitment: ownerCommitment,
      wallet_commitment: walletCommitment,
    });
  } catch (caught) {
    return knownFailure(caught, "lighter_uda_attempt_ledger_unavailable", lockedSafety());
  }
  if (!attempt) {
    return json({ error: "lighter_uda_attempt_not_found", ...lockedSafety() }, 404);
  }
  if (
    attempt.owner_commitment !== ownerCommitment ||
    attempt.wallet_commitment !== walletCommitment ||
    attempt.owner_address.toLowerCase() !== ownerAddress.toLowerCase()
  ) {
    return json({ error: "lighter_uda_attempt_binding_mismatch", ...lockedSafety() }, 403);
  }
  if (attempt.status === "verified" && attempt.destination) {
    return verifiedDestinationResponse(attempt.destination, 0, 0);
  }

  try {
    const evidence = await readLighterUdaAttemptReconciliationEvidence({
      ownerAddress,
      attemptCreatedAt: attempt.created_at,
    });
    return json({
      error: evidence.historical_activity_observed
        ? "lighter_uda_reconciliation_history_observed_locked"
        : "lighter_uda_reconciliation_not_proven",
      version: 1,
      owner_address: ownerAddress,
      attempt_status: attempt.status,
      evidence_source: evidence.evidence_source,
      provider_transaction_count: evidence.provider_transaction_count,
      qualifying_transaction_count: evidence.qualifying_transaction_count,
      historical_activity_observed: evidence.historical_activity_observed,
      historical_destination_count: evidence.historical_destination_count,
      current_funding_destination_proven: false,
      ...lockedSafety(),
    }, 202);
  } catch (caught) {
    return knownFailure(caught, "lighter_uda_reconciliation_failed", lockedSafety());
  }
}

function verifiedDestinationResponse(
  destination: PrivateLighterUdaDestinationV1,
  providerTransactionCount: number,
  qualifyingTransactionCount: number,
) {
  return json({
    version: 1,
    venue_id: "lighter",
    network: "mainnet",
    owner_address: destination.owner_address,
    source: {
      chain_id: Number(LIGHTER_UDA_BASE_CHAIN_ID),
      chain: "base",
      asset: "USDC",
      token_address: LIGHTER_UDA_BASE_USDC_TOKEN_ADDRESS,
      minimum_microunits: LIGHTER_UDA_MINIMUM_USDC_MICROUNITS.toString(),
      recommended_microunits: "5500000",
    },
    destination: {
      deposit_address: destination.deposit_address,
      provider: "lighter_fun_uda",
      market: destination.market,
      asset: destination.asset,
      blocked: destination.blocked,
      resolved: {
        to_chain_id: destination.to_chain_id,
        to_token_address: destination.to_token_address,
        action_type: destination.action_type,
        recipient_address: destination.recipient_address,
        recipient_binding: destination.recipient_binding,
        owner_account_index: destination.owner_account_index,
        user_id: destination.resolved_user_id,
      },
    },
    provider_transaction_count: providerTransactionCount,
    qualifying_transaction_count: qualifyingTransactionCount,
    reconciliation_complete: true,
    deposit_destination_verified: true,
    funding_action_enabled: true,
    checked_at: new Date().toISOString(),
    safety: {
      address_generation_only: true,
      provider_status_read_only: true,
      creation_retry_performed: false,
      transfer_performed: false,
      withdrawal_performed: false,
      trade_performed: false,
      bounded_replay: "returns_only_the_original_owner_bound_destination",
    },
  }, 200);
}

function lockedSafety() {
  return {
    ambiguity: true,
    retry_forbidden: true,
    reconciliation_complete: false,
    deposit_destination_verified: false,
    funding_action_enabled: false,
    safety: {
      provider_status_read_only: true,
      creation_retry_performed: false,
      transfer_performed: false,
      withdrawal_performed: false,
      trade_performed: false,
    },
  } as const;
}

function exactAddress(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw lighterFailure("lighter_uda_owner_address_invalid", 400);
  }
  return getAddress(value);
}

async function verifiedSession(token: string): Promise<
  | { ok: true; userId: string; email: string }
  | { ok: false; error: string; status: number }
> {
  try {
    const session = await fetchSessionUser(token);
    if (session.ok) return { ok: true, userId: session.user.id, email: session.user.email };
    return session.status === 401 || session.status === 403
      ? { ok: false, error: "lighter_uda_session_invalid", status: 401 }
      : { ok: false, error: "lighter_uda_session_unavailable", status: 503 };
  } catch {
    return { ok: false, error: "lighter_uda_session_unavailable", status: 503 };
  }
}

function isJson(req: Request) {
  return req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

async function readObject(req: Request): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > 16_384) return null;
  const value = await req.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(body: Record<string, unknown>, keys: string[]) {
  return Object.keys(body).sort().join("\n") === [...keys].sort().join("\n");
}

function knownFailure(caught: unknown, fallback: string, extra: Record<string, unknown> = {}) {
  const failure = caught as { code?: unknown; status?: unknown };
  const code = typeof failure.code === "string" && /^lighter_uda_[a-z0-9_]{3,100}$/.test(failure.code)
    ? failure.code
    : fallback;
  const status = typeof failure.status === "number" && failure.status >= 400 && failure.status <= 599
    ? failure.status
    : 500;
  return json({ error: code, ...extra }, status);
}

function lighterFailure(code: string, status: number) {
  return Object.assign(new Error(code), { code, status });
}

function json(body: unknown, status: number) {
  return applyNoStore(NextResponse.json(body, { status }));
}
