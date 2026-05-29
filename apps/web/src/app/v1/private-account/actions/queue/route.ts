import {
  json,
  listQueueForOwner,
  privateAccountOwnerFromRequest,
  queueActionFromBody,
  readJson,
  rejectForbiddenFields,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  return json(await listQueueForOwner(req, owner));
}

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const queued = await queueActionFromBody(body, owner);
  if ("error" in queued) return json({ error: queued.error }, 400);
  return json(queued, 201);
}
