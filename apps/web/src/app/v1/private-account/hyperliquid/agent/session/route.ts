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
  if ("error" in session) return json({ error: session.error }, 400);
  return json(session, 201);
}
