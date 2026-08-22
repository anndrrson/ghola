import { createHash, createHmac } from "node:crypto";
import {
  json,
  privateAccountLiveGuard,
} from "@/app/v1/private-account/_lib";
import {
  callKrakenV2Worker,
  isKrakenV2Operation,
} from "@/lib/kraken-v2";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  context: { params: Promise<{ operation: string }> },
) {
  const { operation } = await context.params;
  if (!isKrakenV2Operation(operation)) return json({ error: "not_found" }, 404);
  const guarded = await privateAccountLiveGuard(req, { allowMobileWalletProof: true });
  if (!guarded.ok) return guarded.response;
  if (!guarded.body || typeof guarded.body !== "object" || Array.isArray(guarded.body)) {
    return json({ error: "invalid_request" }, 400);
  }
  const input = guarded.body as Record<string, unknown>;
  const body: Record<string, unknown> = {
    ...input,
    owner_commitment: guarded.owner.owner_commitment,
    account_commitment: accountCommitment(guarded.owner.owner_commitment),
  };
  if (operation === "connections" && isRecord(input.jurisdiction)) {
    const secret = process.env.PRIVATE_AGENT_KRAKEN_JURISDICTION_SECRET ||
      process.env.PRIVATE_AGENT_WORKER_CAPABILITY_SECRET ||
      process.env.GHOLA_WORKER_CAPABILITY_SECRET ||
      "";
    if (!secret) return json({ error: "jurisdiction_signer_not_configured" }, 503);
    body.jurisdiction = signJurisdiction(input.jurisdiction, secret);
  }
  return callKrakenV2Worker(operation, body);
}

function accountCommitment(ownerCommitment: string): string {
  return `ghola_kraken_account_${createHash("sha256")
    .update(`ghola/kraken-v2/account\0${ownerCommitment}`)
    .digest("hex")}`;
}

function signJurisdiction(
  value: Record<string, unknown>,
  secret: string,
): Record<string, unknown> {
  const claims = { ...value };
  delete claims.signature_commitment;
  const signature = createHmac("sha256", secret)
    .update(stableJson(claims))
    .digest("base64url");
  return { ...claims, signature_commitment: `ghjur_v1.${signature}` };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
