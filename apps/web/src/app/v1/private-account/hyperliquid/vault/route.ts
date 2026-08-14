import {
  hyperliquidVaultStatusForOwner,
  json,
  privateAccountLiveGuard,
  privateAccountOwnerFromRequest,
  revokeHyperliquidVaultForOwner,
  sealHyperliquidVaultFromBody,
  unauthorized,
} from "../../_lib";
import { verifyConsumerStepUp } from "@/lib/consumer-step-up";
import { isTestnetVaultBundle } from "./vault-bundle";
import { hyperliquidMainnetVaultAuthError } from "./vault-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  return json(await hyperliquidVaultStatusForOwner(owner));
}

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req, { allowMobileWalletProof: true });
  if (!guarded.ok) return guarded.response;
  const testnetVault = isTestnetVaultBundle(guarded.body);
  const mobileWalletProofVerified = guarded.request_proof_kind === "mobile_wallet";
  const emailVerified = verifiedEmail(guarded.owner.user.email_verified);
  const consumerStepUpVerified = testnetVault || mobileWalletProofVerified || !emailVerified
    ? false
    : await verifyConsumerStepUp(req);
  const authError = hyperliquidMainnetVaultAuthError({
    testnetVault,
    emailVerified,
    mobileWalletProofVerified,
    consumerStepUpVerified,
  });
  if (authError) {
    return json({ error: authError }, 403);
  }
  const sealed = await sealHyperliquidVaultFromBody(guarded.body, guarded.owner);
  if ("error" in sealed) return json({ error: sealed.error }, 400);
  return json(sealed, 201);
}

export async function DELETE(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const current = await hyperliquidVaultStatusForOwner(owner);
  const replacingTestnetVault = current.hyperliquid_execution_vault?.network === "testnet";
  if (!replacingTestnetVault && !verifiedEmail(owner.user.email_verified)) {
    return json({ error: "verified_email_required" }, 403);
  }
  if (!replacingTestnetVault && !await verifyConsumerStepUp(req)) {
    return json({ error: "step_up_authentication_required" }, 403);
  }
  const revoked = await revokeHyperliquidVaultForOwner(owner);
  if ("error" in revoked) return json({ error: revoked.error }, 404);
  return json(revoked);
}

function verifiedEmail(value: boolean | undefined) {
  return value === true || (process.env.NODE_ENV === "test" && process.env.GHOLA_PRIVATE_ACCOUNT_LOCAL_AUTH_BYPASS === "true");
}
