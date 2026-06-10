import {
  internalUnauthorized,
  json,
  privateAccountInternalAuth,
  readJson,
  rejectForbiddenFields,
  runCanariesFromBody,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!privateAccountInternalAuth(req)) return internalUnauthorized();
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const result = await runCanariesFromBody(body);
  if ("error" in result) return json(result, 400);
  return json(result);
}
