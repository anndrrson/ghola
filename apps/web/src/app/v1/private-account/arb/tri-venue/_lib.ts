import {
  json,
  privateAccountLiveGuard,
  type PrivateAccountRequestOwner,
} from "../../_lib";
import {
  publicLivePhoenixOwnerFromBody,
} from "../../public-live/phoenix/_lib";
import type { PublicLiveWalletProofInput } from "@/lib/private-account-public-live";

export type TriVenueGuardResult =
  | {
      ok: true;
      body: Record<string, unknown>;
      owner: PrivateAccountRequestOwner;
      access_mode: "public_wallet" | "private_account";
    }
  | {
      ok: false;
      response: Response;
    };

export async function triVenueLiveGuard(req: Request): Promise<TriVenueGuardResult> {
  if (!isJson(req)) {
    return {
      ok: false,
      response: json({ error: "json_content_type_required" }, 415),
    };
  }
  const body = await req.clone().json().catch(() => null);
  const record = safeRecord(body);
  if (looksLikePublicWalletProof(record)) {
    const publicOwner = await publicLivePhoenixOwnerFromBody(record as unknown as PublicLiveWalletProofInput, {
      request: req,
      consumeNonce: true,
    });
    if (!publicOwner.ok) return publicOwner;
    return {
      ok: true,
      body: record,
      owner: publicOwner.owner,
      access_mode: "public_wallet",
    };
  }
  const guarded = await privateAccountLiveGuard(req, { allowMobileWalletProof: true });
  if (!guarded.ok) return guarded;
  return {
    ok: true,
    body: safeRecord(guarded.body),
    owner: guarded.owner,
    access_mode: "private_account",
  };
}

function looksLikePublicWalletProof(value: Record<string, unknown>): boolean {
  return typeof value.wallet_pubkey === "string" &&
    typeof value.message === "string" &&
    typeof value.signature_b64 === "string";
}

function isJson(req: Request): boolean {
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.split(";").some((part) => part.trim() === "application/json");
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
