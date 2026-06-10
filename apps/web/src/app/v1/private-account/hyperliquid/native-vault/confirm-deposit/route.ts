import {
  confirmHyperliquidNativeVaultDepositFromBody,
  json,
  privateAccountLiveGuard,
} from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const confirmed = await confirmHyperliquidNativeVaultDepositFromBody(guarded.body, guarded.owner);
  if ("error" in confirmed) {
    return json({
      error: confirmed.error,
    }, confirmed.error === "hyperliquid_native_vault_deposit_verifier_unavailable" ? 503 : 400);
  }
  return json(confirmed, 201);
}
