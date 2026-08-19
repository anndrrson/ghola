import {
  HYPERLIQUID_MAINNET_PROOF_CONFIRMATION,
  hyperliquidMainnetProofUiEnabled,
  json,
  privateAccountLiveGuard,
  privateAccountSessionTokenFromRequest,
  releasePrivateAccountLiveRevenueReservation,
  runHyperliquidMainnetProofForOwner,
} from "../../_lib";
import { paidLiveTradingEntitlement } from "@/lib/live-trading-opening-access.server";
import { getLiveTradingLaunchControl } from "@/lib/live-trading-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!hyperliquidMainnetProofUiEnabled()) {
    return json({ error: "hyperliquid_mainnet_roundtrip_unavailable" }, 404);
  }
  const launch = await getLiveTradingLaunchControl();
  if (launch.state !== "canary" && launch.state !== "public") {
    return json({ error: launch.state === "killed" ? "live_trading_killed" : "live_trading_not_in_canary" }, 409);
  }
  if (launch.state === "canary") {
    const entitlement = await paidLiveTradingEntitlement(
      privateAccountSessionTokenFromRequest(req) ?? "",
      fetch,
      process.env,
      { requireComplimentaryPass: true },
    );
    if (!entitlement.ok) {
      return json({ error: entitlement.error, reason_codes: entitlement.reason_codes }, entitlement.status);
    }
  }
  const guarded = await privateAccountLiveGuard(req, { allowMobileWalletProof: true, requireRevenue: true });
  if (!guarded.ok) return guarded.response;
  if (guarded.request_proof_kind !== "mobile_wallet") {
    await releasePrivateAccountLiveRevenueReservation(guarded.revenue, "failed");
    return json({ error: "mobile_wallet_step_up_required" }, 403);
  }
  if (!exactConfirmation(guarded.body)) {
    await releasePrivateAccountLiveRevenueReservation(guarded.revenue, "failed");
    return json({ error: "hyperliquid_mainnet_roundtrip_confirmation_required" }, 400);
  }
  const result = await runHyperliquidMainnetProofForOwner(guarded.owner, {
    state: launch.state,
    revision: launch.revision,
  });
  if ("error" in result) {
    await releasePrivateAccountLiveRevenueReservation(guarded.revenue, "failed");
    return json({ error: result.error }, result.status);
  }
  await releasePrivateAccountLiveRevenueReservation(guarded.revenue, "completed");
  return json(result.report, 200);
}

function exactConfirmation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 1 &&
    row.confirmation === HYPERLIQUID_MAINNET_PROOF_CONFIRMATION;
}
