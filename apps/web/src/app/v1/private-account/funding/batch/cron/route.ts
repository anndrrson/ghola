import {
  internalUnauthorized,
  json,
  privateAccountCronAuth,
  runFundingBatchCoordinatorFromBody,
} from "../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!privateAccountCronAuth(req)) return internalUnauthorized();
  return json(await runFundingBatchCoordinatorFromBody({}));
}
