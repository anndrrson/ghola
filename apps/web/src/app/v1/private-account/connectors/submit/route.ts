import {
  connectorSubmitFromBody,
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
  const submitted = await connectorSubmitFromBody(body, owner);
  if ("error" in submitted) return json({ error: submitted.error }, 400);
  return json(submitted, 201);
}
