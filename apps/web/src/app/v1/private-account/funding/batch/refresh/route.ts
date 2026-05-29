import {
  fundingBatchRefreshFromBody,
  json,
  privateAccountOwnerFromRequest,
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
  const batch = await fundingBatchRefreshFromBody(body, owner);
  if ("error" in batch) return json({ error: batch.error }, 400);
  return json(batch);
}
