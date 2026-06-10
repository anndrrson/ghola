import {
  connectorReconcileFromBody,
  json,
  privateAccountLiveGuard,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const reconciled = await connectorReconcileFromBody(guarded.body, guarded.owner);
  if ("error" in reconciled) return json({ error: reconciled.error }, 400);
  return json(reconciled);
}
