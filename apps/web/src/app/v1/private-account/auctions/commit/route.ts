import {
  commitAuctionOrderFromBody,
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
  const result = await commitAuctionOrderFromBody(body, owner);
  if ("error" in result) return json(result, 400);
  return json(result, "idempotent" in result && result.idempotent ? 200 : 201);
}
