import {
  json,
  privateAccountLiveGuard,
  privateAccountSessionTokenFromRequest,
} from "../../../_lib";
import {
  closeHyperliquidPositionForOwner,
  parseHyperliquidCloseRequest,
} from "@/lib/hyperliquid-risk-reduction.server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req, { allowMobileWalletProof: true });
  if (!guarded.ok) return guarded.response;
  if (guarded.request_proof_kind !== "mobile_wallet") {
    return json({ error: "mobile_wallet_step_up_required" }, 403);
  }
  const request = parseHyperliquidCloseRequest(guarded.body);
  if (!request) return json({ error: "hyperliquid_reduce_only_close_request_invalid" }, 400);
  const webSessionToken = privateAccountSessionTokenFromRequest(req);
  if (!webSessionToken) return json({ error: "private_account_auth_required" }, 401);
  const result = await closeHyperliquidPositionForOwner({
    owner_commitment: guarded.owner.owner_commitment,
    web_session_token: webSessionToken,
    request,
  });
  if (!result.ok) {
    return json({ error: result.error, reason_codes: result.reason_codes ?? [] }, result.status);
  }
  return json(result.report, 200);
}
