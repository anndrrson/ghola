import {
  json,
  privateAccountOwnerFromRequest,
  privateReceiptExportFromBody,
  readJson,
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
  const exported = await privateReceiptExportFromBody(body, owner);
  if ("error" in exported) return json({ error: exported.error }, 400);
  return json(exported);
}
