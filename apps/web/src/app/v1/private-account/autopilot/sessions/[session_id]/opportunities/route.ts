import {
  json,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../../../_lib";
import { listAutopilotOpportunitiesForOwner } from "@/lib/private-account-autopilot";

export const dynamic = "force-dynamic";

function sessionId(params: unknown): string | null {
  const value =
    params && typeof params === "object" && "session_id" in params
      ? (params as { session_id?: unknown }).session_id
      : null;
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
  const result = await listAutopilotOpportunitiesForOwner(id, owner);
  if ("error" in result) {
    return json({ error: result.error }, result.error === "autopilot_session_not_found" ? 404 : 503);
  }
  return json({
    version: 1,
    ...result,
  });
}
