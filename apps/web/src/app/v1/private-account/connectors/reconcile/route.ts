import {
  connectorReconcileFromBody,
  json,
  privateAccountOwnerFromRequest,
  readJson,
  rejectForbiddenFields,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const reconciled = await connectorReconcileFromBody(body, owner);
  if ("error" in reconciled) return json({ error: reconciled.error }, 400);
  return json(reconciled);
}
