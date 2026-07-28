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

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  return json(await hyperliquidVaultStatusForOwner(owner));
}

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const testnetVault = isTestnetVaultBundle(guarded.body);
  if (!testnetVault && !verifiedEmail(guarded.owner.user.email_verified)) {
    return json({ error: "verified_email_required" }, 403);
  }
  if (!testnetVault && !await verifyConsumerStepUp(req)) {
    return json({ error: "step_up_authentication_required" }, 403);
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

export function isTestnetVaultBundle(body: unknown) {
  if (!body || typeof body !== "object") return false;
  const encrypted = (body as Record<string, unknown>).encrypted_execution_vault;
  if (!encrypted || typeof encrypted !== "object") return false;
  const aad = (encrypted as Record<string, unknown>).aad;
  return typeof aad === "string" &&
    aad.startsWith("ghola/hyperliquid-execution-vault-v1|") &&
    aad.endsWith("|network:testnet");
}
