import {
  json,
  privateAccountLiveGuard,
  privateAccountSessionTokenFromRequest,
} from "../../../../_lib";
import {
  autopilotControlErrorStatus,
  controlAutonomousAutopilotSessionFromBody,
} from "@/lib/private-account-autopilot";
import { authorizeLiveTradingRiskReduction } from "@/lib/live-trading-authorization.server";

export const dynamic = "force-dynamic";

function sessionId(params: unknown): string | null {
  if (!params || typeof params !== "object" || !("session_id" in params)) return null;
  const value = (params as { session_id?: unknown }).session_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<unknown> },
) {
  const id = sessionId(await params);
  if (!id) return json({ error: "autopilot_session_not_found" }, 404);
  const guarded = await privateAccountLiveGuard(req, { allowMobileWalletProof: true });
  if (!guarded.ok) return guarded.response;
  if (guarded.request_proof_kind !== "mobile_wallet") {
    return json({ error: "mobile_wallet_step_up_required" }, 403);
  }
  if (!guarded.body || typeof guarded.body !== "object" || Array.isArray(guarded.body) ||
      Object.keys(guarded.body as Record<string, unknown>).length !== 0) {
    return json({ error: "kill_and_flat_request_invalid" }, 400);
  }
  const webSessionToken = privateAccountSessionTokenFromRequest(req);
  if (!webSessionToken) return json({ error: "private_account_auth_required" }, 401);
  const authorization = await authorizeLiveTradingRiskReduction({
    owner_commitment: guarded.owner.owner_commitment,
    web_session_token: webSessionToken,
    emergency_action: "kill_and_flat",
    required_capabilities: ["cancel", "reduce_only"],
  });
  if (!authorization.ok) {
    return json({ error: authorization.error, reason_codes: authorization.reason_codes }, authorization.status);
  }
  const result = await controlAutonomousAutopilotSessionFromBody(id, "kill_and_flat", guarded.owner);
  if ("error" in result) return json({ version: 1, ...result }, autopilotControlErrorStatus(result.error));
  return json({ version: 1, ...result });
}
