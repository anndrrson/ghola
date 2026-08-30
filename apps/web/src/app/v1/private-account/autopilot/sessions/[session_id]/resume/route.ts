import {
  json,
  privateAccountLiveGuard,
} from "../../../../_lib";
import { controlAutonomousAutopilotSessionFromBody } from "@/lib/private-account-autopilot";
import {
  evaluateLiveTradingJurisdiction,
  liveTradingJurisdictionErrorBody,
} from "@/lib/live-trading-jurisdiction.server";

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
  const jurisdiction = evaluateLiveTradingJurisdiction(req);
  if (!jurisdiction.allowed) {
    return json(liveTradingJurisdictionErrorBody(jurisdiction), 451);
  }
  const result = await controlAutonomousAutopilotSessionFromBody(id, "resume", guarded.owner);
  if ("error" in result) {
    const status = result.error === "autopilot_session_not_found" ? 404 : 409;
    return json({
      error: result.error,
      ...(result.session ? { session: result.session, next_step: result.session.next_step } : {}),
    }, status);
  }
  return json({ version: 1, ...result });
}
