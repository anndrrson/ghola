import {
  json,
  privateAccountOwnerFromRequest,
  readJson,
  rejectForbiddenFields,
  settleStoredActionFromBody,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const settled = await settleStoredActionFromBody(body, owner);
  if ("error" in settled) return json({ error: settled.error }, 400);
  return json(settled, 201);
}
