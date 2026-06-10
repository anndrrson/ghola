import {
  json,
  privateAccountOwnerFromRequest,
  readJson,
  refreshQueuedActionFromBody,
  rejectForbiddenFields,
  unauthorized,
} from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const refreshed = await refreshQueuedActionFromBody(body, owner);
  if ("error" in refreshed) return json({ error: refreshed.error }, 400);
  return json(refreshed);
}
