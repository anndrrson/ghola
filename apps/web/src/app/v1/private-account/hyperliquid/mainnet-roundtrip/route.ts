import {
  HYPERLIQUID_MAINNET_PROOF_CONFIRMATION,
  hyperliquidMainnetProofUiEnabled,
  json,
  privateAccountLiveGuard,
  runHyperliquidMainnetProofForOwner,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!hyperliquidMainnetProofUiEnabled()) {
    return json({ error: "hyperliquid_mainnet_roundtrip_unavailable" }, 404);
  }
  const guarded = await privateAccountLiveGuard(req, { allowMobileWalletProof: true });
  if (!guarded.ok) return guarded.response;
  if (guarded.request_proof_kind !== "mobile_wallet") {
    return json({ error: "mobile_wallet_step_up_required" }, 403);
  }
  if (!exactConfirmation(guarded.body)) {
    return json({ error: "hyperliquid_mainnet_roundtrip_confirmation_required" }, 400);
  }
  const result = await runHyperliquidMainnetProofForOwner(guarded.owner);
  if ("error" in result) return json({ error: result.error }, result.status);
  return json(result.report, 200);
}

function exactConfirmation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 1 &&
    row.confirmation === HYPERLIQUID_MAINNET_PROOF_CONFIRMATION;
}
