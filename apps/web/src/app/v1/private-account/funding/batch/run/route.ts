import {
  internalUnauthorized,
  json,
  privateAccountInternalAuth,
  readJson,
  rejectForbiddenFields,
  runFundingBatchCoordinatorFromBody,
} from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!privateAccountInternalAuth(req)) return internalUnauthorized();
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  return json(await runFundingBatchCoordinatorFromBody(body));
}
