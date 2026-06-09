import {
  json,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../../_lib";
import { syncWorkerAutopilotSession } from "@/lib/private-account-autopilot";

export const dynamic = "force-dynamic";

function sessionId(params: unknown): string | null {
  if (!params || typeof params !== "object" || !("session_id" in params)) return null;
  const value = (params as { session_id?: unknown }).session_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<unknown> },
) {
  const id = sessionId(await params);
  if (!id) return json({ error: "autopilot_session_not_found" }, 404);
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const result = await syncWorkerAutopilotSession(id, owner);
  if ("error" in result) return json({ error: result.error }, 404);
  return json({ version: 1, session: result.session });
}
