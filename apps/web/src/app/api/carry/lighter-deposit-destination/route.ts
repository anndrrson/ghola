import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import {
  applyNoStore,
  fetchSessionUser,
  sameOrigin,
  SESSION_COOKIE_NAME,
} from "@/app/api/auth/session/_lib";
import {
  LIGHTER_DEPOSIT_DESTINATION_MARKET,
  LIGHTER_DEPOSIT_SOURCE_ASSET,
  LIGHTER_DEPOSIT_SOURCE_CHAIN,
  LIGHTER_DEPOSIT_SOURCE_CHAIN_ID,
  verifyLighterDepositAuthorizationSignature,
  verifyLighterDepositAuthorizationToken,
} from "@/lib/lighter-deposit-authorization.server";
import {
  assertLighterUdaCreateConfigured,
  createLighterUniversalDepositAddress,
  LIGHTER_UDA_ACTION_TYPE,
  type LighterUniversalDepositAddress,
} from "@/lib/lighter-universal-deposit-address.server";
import { gholaCommitment } from "@/lib/private-account";
import {
  claimPrivateLighterUdaAttempt,
  settlePrivateLighterUdaAttempt,
  type PrivateLighterUdaDestinationV1,
} from "@/lib/private-account-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_KEYS = ["challenge_token", "signature", "version"];
const BASE_USDC_TOKEN_ADDRESS = getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return json({ error: "lighter_uda_cross_site_rejected" }, 403);
  if (!isJson(req)) return json({ error: "lighter_uda_json_required" }, 415);
  const body = await readObject(req);
  if (
    !body ||
    !exactKeys(body, BODY_KEYS) ||
    body.version !== 1 ||
    typeof body.challenge_token !== "string" ||
    typeof body.signature !== "string"
  ) {
    return json({ error: "lighter_uda_destination_request_invalid" }, 400);
  }
  const sessionToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionToken) return json({ error: "lighter_uda_session_required" }, 401);
  const session = await verifiedSession(sessionToken);
  if (!session.ok) return json({ error: session.error }, session.status);

  const ownerCommitment = gholaCommitment("owner", session.userId);
  let ownerAddress: `0x${string}`;
  let claimToken: string;
  try {
    const authorization = verifyLighterDepositAuthorizationToken({
      challengeToken: body.challenge_token,
      ownerCommitment,
      secret: process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET ?? "",
    });
    ownerAddress = await verifyLighterDepositAuthorizationSignature({
      authorization,
      signature: body.signature,
    });
    claimToken = authorization.payload.nonce;
  } catch (caught) {
    return knownFailure(caught, "lighter_uda_authorization_invalid");
  }
  const walletCommitment = gholaCommitment("wallet", ownerAddress.toLowerCase());

  try {
    assertLighterUdaCreateConfigured();
  } catch (caught) {
    return knownFailure(caught, "lighter_uda_builder_key_unconfigured", {
      deposit_destination_verified: false,
      funding_action_enabled: false,
    });
  }

  let claim: Awaited<ReturnType<typeof claimPrivateLighterUdaAttempt>>;
  try {
    claim = await claimPrivateLighterUdaAttempt({
      attempt_id: gholaCommitment("lighter_uda_attempt", {
        owner_commitment: ownerCommitment,
        wallet_commitment: walletCommitment,
      }),
      owner_commitment: ownerCommitment,
      wallet_commitment: walletCommitment,
      owner_address: ownerAddress,
      claim_token: claimToken,
      now: new Date(),
    });
  } catch (caught) {
    return knownFailure(caught, "lighter_uda_attempt_ledger_unavailable", {
      deposit_destination_verified: false,
      funding_action_enabled: false,
    });
  }

  if (!claim.acquired) {
    if (
      claim.record.owner_commitment !== ownerCommitment ||
      claim.record.wallet_commitment !== walletCommitment ||
      claim.record.owner_address.toLowerCase() !== ownerAddress.toLowerCase()
    ) {
      return retryForbidden("lighter_uda_attempt_binding_mismatch");
    }
    if (claim.record.status === "verified" && claim.record.destination) {
      return verifiedDestinationResponse(claim.record.destination);
    }
    return retryForbidden(
      claim.record.status === "ambiguous"
        ? "lighter_uda_attempt_ambiguous"
        : "lighter_uda_attempt_pending",
    );
  }

  try {
    // Exactly one provider call. Never retry an ambiguous response.
    const destination = await createLighterUniversalDepositAddress({ ownerAddress });
    let verified: PrivateLighterUdaDestinationV1;
    try {
      verified = (await settlePrivateLighterUdaAttempt({
        owner_commitment: ownerCommitment,
        wallet_commitment: walletCommitment,
        owner_address: ownerAddress,
        claim_token: claimToken,
        status: "verified",
        destination,
        failure_code: null,
        now: new Date(),
      })).destination as PrivateLighterUdaDestinationV1;
    } catch {
      await settlePrivateLighterUdaAttempt({
        owner_commitment: ownerCommitment,
        wallet_commitment: walletCommitment,
        owner_address: ownerAddress,
        claim_token: claimToken,
        status: "ambiguous",
        destination: null,
        failure_code: "lighter_uda_attempt_verification_persistence_failed",
        now: new Date(),
      }).catch(() => null);
      return retryForbidden("lighter_uda_attempt_verification_persistence_failed");
    }
    return verifiedDestinationResponse(verified);
  } catch (caught) {
    const failure = caught as { code?: unknown };
    const code = typeof failure.code === "string" && /^lighter_uda_[a-z0-9_]{3,100}$/.test(failure.code)
      ? failure.code
      : "lighter_uda_destination_failed";
    await settlePrivateLighterUdaAttempt({
      owner_commitment: ownerCommitment,
      wallet_commitment: walletCommitment,
      owner_address: ownerAddress,
      claim_token: claimToken,
      status: "ambiguous",
      destination: null,
      failure_code: code,
      now: new Date(),
    }).catch(() => null);
    return knownFailure(caught, "lighter_uda_destination_failed", {
      ambiguity: true,
      retry_forbidden: true,
      manual_reconciliation_required: true,
      deposit_destination_verified: false,
      funding_action_enabled: false,
    });
  }
}

function verifiedDestinationResponse(destination: LighterUniversalDepositAddress) {
  return json({
    version: 1,
    venue_id: "lighter",
    network: "mainnet",
    owner_address: destination.owner_address,
    source: {
      chain_id: LIGHTER_DEPOSIT_SOURCE_CHAIN_ID,
      chain: LIGHTER_DEPOSIT_SOURCE_CHAIN,
      asset: LIGHTER_DEPOSIT_SOURCE_ASSET,
      token_address: BASE_USDC_TOKEN_ADDRESS,
      minimum_microunits: "5000000",
      recommended_microunits: "5500000",
    },
    destination: {
      deposit_address: destination.deposit_address,
      provider: "lighter_fun_uda",
      market: LIGHTER_DEPOSIT_DESTINATION_MARKET,
      asset: LIGHTER_DEPOSIT_SOURCE_ASSET,
      blocked: destination.blocked,
      resolved: {
        to_chain_id: destination.to_chain_id,
        to_token_address: destination.to_token_address,
        action_type: LIGHTER_UDA_ACTION_TYPE,
        recipient_address: destination.recipient_address,
        user_id: destination.resolved_user_id,
      },
    },
    deposit_destination_verified: true,
    funding_action_enabled: true,
    checked_at: new Date().toISOString(),
    safety: {
      address_generation_only: true,
      transfer_performed: false,
      withdrawal_performed: false,
      trade_performed: false,
      bounded_replay: "returns_only_the_original_owner_bound_destination",
    },
  }, 200);
}

function retryForbidden(error: string) {
  return json({
    error,
    ambiguity: true,
    retry_forbidden: true,
    manual_reconciliation_required: true,
    deposit_destination_verified: false,
    funding_action_enabled: false,
  }, 409);
}

async function verifiedSession(token: string): Promise<
  | { ok: true; userId: string }
  | { ok: false; error: string; status: number }
> {
  try {
    const session = await fetchSessionUser(token);
    if (session.ok) return { ok: true, userId: session.user.id };
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

function knownFailure(caught: unknown, fallback: string, details: Record<string, unknown> = {}) {
  const failure = caught as { code?: unknown; status?: unknown };
  const code = typeof failure.code === "string" && /^lighter_uda_[a-z0-9_]{3,100}$/.test(failure.code)
    ? failure.code
    : fallback;
  const status = typeof failure.status === "number" && failure.status >= 400 && failure.status <= 599
    ? failure.status
    : 500;
  return json({ error: code, ...details }, status);
}

function json(body: unknown, status: number) {
  return applyNoStore(NextResponse.json(body, { status }));
}
