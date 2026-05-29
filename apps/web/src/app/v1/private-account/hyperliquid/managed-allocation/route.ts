import {
  allocateHyperliquidManagedFromBody,
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
  const allocation = await allocateHyperliquidManagedFromBody(body, owner);
  if ("error" in allocation) return json({ error: allocation.error }, 400);
  return json(allocation, 201);
}
