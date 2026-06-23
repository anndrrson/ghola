import {
  connectorSubmitFromBody,
  json,
  privateAccountLiveGuard,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req, { requireRevenue: true });
  if (!guarded.ok) return guarded.response;
  const submitted = await connectorSubmitFromBody(guarded.body, guarded.owner);
  if ("error" in submitted) return json({ error: submitted.error }, 400);
  return json(submitted, 201);
}
