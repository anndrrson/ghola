import {
  CONSUMER_RISK_VERSION,
  CONSUMER_TERMS_VERSION,
} from "@/lib/consumer-production";
import {
  consumeConsumerNonce,
  getConsumerEligibilityAcceptance,
  getConsumerWalletBinding,
  putConsumerEligibilityAcceptance,
  putConsumerWalletBinding,
} from "@/lib/consumer-production-store";
import {
  publicLiveWalletCommitment,
  verifyPublicLiveWalletProof,
} from "@/lib/private-account-public-live";
import {
  createOrGetStoredPrivateAccount,
  json,
  privateAccountOwnerFromRequest,
  readJson,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const account = await createOrGetStoredPrivateAccount(owner);
  const [wallet, acceptance] = await Promise.all([
    getConsumerWalletBinding(owner.owner_commitment),
    getConsumerEligibilityAcceptance(owner.owner_commitment),
  ]);
  return json({
    version: 1,
    authenticated: true,
    email_verified: owner.user.email_verified === true,
    account_commitment: account.account_commitment,
    wallet_binding: wallet ? publicWalletBinding(wallet) : null,
    eligibility: acceptance,
    ready: verifiedAuth(owner.user.email_verified) && currentAcceptance(acceptance) && Boolean(wallet),
  });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  if (!verifiedAuth(owner.user.email_verified)) {
    return json({ error: "verified_email_required" }, 403);
  }
  const body = await readJson(request) as Record<string, unknown> | null;
  if (!body || body.accepted_terms !== true || body.accepted_risk !== true || body.not_prohibited_person !== true) {
    return json({ error: "current_terms_risk_and_eligibility_acceptance_required" }, 400);
  }
  const proof = verifyPublicLiveWalletProof(body, { consumeNonce: false });
  if (!proof.ok) return json({ error: proof.error }, proof.status);
  const nonceAccepted = await consumeConsumerNonce({
    namespace: "wallet_binding",
    owner_commitment: owner.owner_commitment,
    nonce: proof.proof.nonce,
    expires_at_ms: proof.proof.timestamp_ms + 5 * 60_000,
  });
  if (!nonceAccepted) return json({ error: "public_live_wallet_proof_replayed" }, 403);
  const account = await createOrGetStoredPrivateAccount(owner);
  const now = new Date().toISOString();
  const [wallet, acceptance] = await Promise.all([
    putConsumerWalletBinding({
      owner_commitment: owner.owner_commitment,
      account_commitment: account.account_commitment,
      wallet_pubkey: proof.proof.wallet_pubkey,
      wallet_commitment: proof.proof.wallet_commitment || publicLiveWalletCommitment(proof.proof.wallet_pubkey),
    }),
    putConsumerEligibilityAcceptance({
      version: 1,
      owner_commitment: owner.owner_commitment,
      terms_version: CONSUMER_TERMS_VERSION,
      risk_version: CONSUMER_RISK_VERSION,
      not_prohibited_person: true,
      accepted_at: now,
    }),
  ]);
  return json({
    version: 1,
    ready: true,
    account_commitment: account.account_commitment,
    wallet_binding: publicWalletBinding(wallet),
    eligibility: acceptance,
  }, 201);
}

function currentAcceptance(value: Awaited<ReturnType<typeof getConsumerEligibilityAcceptance>>) {
  return value?.terms_version === CONSUMER_TERMS_VERSION &&
    value.risk_version === CONSUMER_RISK_VERSION &&
    value.not_prohibited_person === true;
}

function verifiedAuth(value: boolean | undefined) {
  if (value === true) return true;
  return process.env.GHOLA_CONSUMER_EMAIL_VERIFICATION_MODE === "report_only" && process.env.NODE_ENV !== "production";
}

function publicWalletBinding(value: Awaited<ReturnType<typeof putConsumerWalletBinding>>) {
  return {
    wallet_commitment: value.wallet_commitment,
    bound_at: value.bound_at,
    withdrawal_hold_until: value.withdrawal_hold_until,
    updated_at: value.updated_at,
  };
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.host === host && (url.protocol === "https:" || (local && url.protocol === "http:"));
  } catch {
    return false;
  }
}
