import {
  json,
  privateAccountOwnerFromRequest,
  readJson,
  receiptExportFromBody,
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
  const exported = await receiptExportFromBody(body, owner);
  if (!exported) return json({ error: "receipt_not_found" }, 404);
  return json(exported);
}
