import {
  json,
  privateAccountOwnerFromRequest,
  readJson,
  rejectForbiddenFields,
  unauthorized,
} from "../_lib";
import {
  normalizeMobileWalletPubkey,
  privateMobileWalletBindingRecord,
  verifyPrivateMobileWalletBindingProof,
} from "@/lib/private-account-wallet-binding";
import { putPrivateMobileWalletBinding } from "@/lib/private-account-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const wallet = normalizeMobileWalletPubkey(value.wallet_pubkey);
  const message = typeof value.message === "string" ? value.message : "";
  const signature = typeof value.signature_b64 === "string"
    ? value.signature_b64
    : typeof value.signature === "string"
      ? value.signature
      : "";
  if (!wallet || !message || !signature) {
    return json({ error: "mobile_wallet_binding_invalid" }, 403);
  }
  const verified = verifyPrivateMobileWalletBindingProof({
    owner_commitment: owner.owner_commitment,
    wallet_pubkey: wallet,
    message,
    signature_b64: signature,
    max_skew_ms: positiveIntegerEnv("GHOLA_PRIVATE_ACCOUNT_WALLET_BINDING_MAX_SKEW_MS", 5 * 60_000),
  });
  if (!verified.ok) return json({ error: verified.error }, verified.status);
  const record = privateMobileWalletBindingRecord({
    owner_commitment: owner.owner_commitment,
    wallet_pubkey: wallet,
    proof_commitment: verified.proof_commitment,
  });
  const stored = await putPrivateMobileWalletBinding(record);
  return json({
    version: 1,
    status: stored.status,
    binding_commitment: stored.binding_commitment,
    wallet_commitment: stored.wallet_commitment,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
  }, 201);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
