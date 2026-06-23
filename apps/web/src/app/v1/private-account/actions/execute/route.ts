import {
  executeStoredActionFromBody,
  json,
  privateAccountLiveGuard,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req, { requireRevenue: true });
  if (!guarded.ok) return guarded.response;
  const execution = await executeStoredActionFromBody(guarded.body, guarded.owner);
  if ("error" in execution) return json({ error: execution.error }, 400);
  return json(execution, 201);
}
