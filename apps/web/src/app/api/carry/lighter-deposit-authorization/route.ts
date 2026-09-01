import { NextRequest, NextResponse } from "next/server";
import {
  applyNoStore,
  fetchSessionUser,
  sameOrigin,
  SESSION_COOKIE_NAME,
} from "@/app/api/auth/session/_lib";
import {
  issueLighterDepositAuthorization,
  LIGHTER_DEPOSIT_DESTINATION_MARKET,
  LIGHTER_DEPOSIT_SOURCE_ASSET,
  LIGHTER_DEPOSIT_SOURCE_CHAIN,
  LIGHTER_DEPOSIT_SOURCE_CHAIN_ID,
} from "@/lib/lighter-deposit-authorization.server";
import { assertLighterFundingEligibility } from "@/lib/lighter-funding-eligibility.server";
import { resolveLighterTurnkeyPerpsOwnerBinding } from "@/lib/lighter-turnkey-owner-binding.server";
import { gholaCommitment } from "@/lib/private-account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BODY_KEYS = ["eligibility_attestation", "owner_address", "version"];

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return json({ error: "lighter_uda_cross_site_rejected" }, 403);
  if (!isJson(req)) return json({ error: "lighter_uda_json_required" }, 415);
  const body = await readObject(req);
  if (!body || !exactKeys(body, BODY_KEYS) || body.version !== 1 || typeof body.owner_address !== "string") {
    return json({ error: "lighter_uda_authorization_request_invalid" }, 400);
  }
  let eligibility;
  try {
    eligibility = assertLighterFundingEligibility({
      request: req,
      attestation: body.eligibility_attestation,
    });
  } catch (caught) {
    return knownFailure(caught, "lighter_uda_eligibility_failed");
  }
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return json({ error: "lighter_uda_session_required" }, 401);
  const session = await verifiedSession(token);
  if (!session.ok) return json({ error: session.error }, session.status);
  try {
    await resolveLighterTurnkeyPerpsOwnerBinding({
      sessionEmail: session.email,
      ownerAddress: body.owner_address,
    });
    const authorization = issueLighterDepositAuthorization({
      ownerAddress: body.owner_address,
      ownerCommitment: gholaCommitment("owner", session.userId),
      secret: process.env.GHOLA_PRIVATE_ACCOUNT_REQUEST_PROOF_SECRET ?? "",
      eligibility,
    });
    return json({
      version: 1,
      challenge_token: authorization.challenge_token,
      message: authorization.message,
      owner_address: authorization.payload.owner_address,
      expires_at: new Date(authorization.payload.expires_at_ms).toISOString(),
      authorization: {
        action: "create_lighter_uda",
        source_chain_id: LIGHTER_DEPOSIT_SOURCE_CHAIN_ID,
        source_chain: LIGHTER_DEPOSIT_SOURCE_CHAIN,
        source_asset: LIGHTER_DEPOSIT_SOURCE_ASSET,
        destination_market: LIGHTER_DEPOSIT_DESTINATION_MARKET,
        eligibility: authorization.payload.eligibility,
        transfer_authorized: false,
        withdrawal_authorized: false,
        trade_authorized: false,
      },
    }, 200);
  } catch (caught) {
    return knownFailure(caught, "lighter_uda_authorization_failed");
  }
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

function knownFailure(caught: unknown, fallback: string) {
  const failure = caught as { code?: unknown; status?: unknown };
  const code = typeof failure.code === "string" && /^lighter_uda_[a-z0-9_]{3,100}$/.test(failure.code)
    ? failure.code
    : fallback;
  const status = typeof failure.status === "number" && failure.status >= 400 && failure.status <= 599
    ? failure.status
    : 500;
  return json({ error: code }, status);
}

function json(body: unknown, status: number) {
  return applyNoStore(NextResponse.json(body, { status }));
}
