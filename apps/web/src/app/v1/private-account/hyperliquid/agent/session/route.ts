import {
  armHyperliquidAgentSessionFromBody,
  json,
  privateAccountLiveGuard,
} from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const session = await armHyperliquidAgentSessionFromBody(guarded.body, guarded.owner);
  if ("error" in session) {
    const status = session.error === "worker_unavailable" || session.error === "connector_endpoint_missing"
      ? 503
      : 400;
    return json({ error: session.error }, status);
  }
  return json(session, 201);
}
