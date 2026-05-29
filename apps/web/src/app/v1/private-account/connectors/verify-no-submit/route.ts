import {
  connectorVerifyNoSubmitFromBody,
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
  const verified = await connectorVerifyNoSubmitFromBody(body, owner, {
    site_origin: new URL(req.url).origin,
  });
  if ("error" in verified) return json({ error: verified.error }, 400);
  return json(verified);
}
