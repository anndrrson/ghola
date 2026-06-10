import {
  compileConnectorIntentFromBody,
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
  const compiled = await compileConnectorIntentFromBody(body, owner);
  if ("error" in compiled) return json({ error: compiled.error }, 400);
  return json(compiled, 201);
}
