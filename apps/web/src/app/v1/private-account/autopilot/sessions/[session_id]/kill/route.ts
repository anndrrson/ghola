import {
  json,
  privateAccountLiveGuard,
} from "../../../../_lib";
import { controlAutonomousAutopilotSessionFromBody } from "@/lib/private-account-autopilot";

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
  const result = await controlAutonomousAutopilotSessionFromBody(id, "kill", guarded.owner);
  if ("error" in result) return json({ error: result.error }, 404);
  return json({ version: 1, ...result });
}
