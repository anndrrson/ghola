import {
  json,
  privateAccountOwnerFromRequest,
  readJson,
  rejectForbiddenFields,
  revokePrivateReceiptExportFromBody,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const revoked = await revokePrivateReceiptExportFromBody(body, owner);
  if ("error" in revoked) return json({ error: revoked.error }, 400);
  return json(revoked);
}
