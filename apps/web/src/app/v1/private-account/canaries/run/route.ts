import {
  internalUnauthorized,
  json,
  privateAccountInternalAuth,
  runCanariesFromBody,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!privateAccountInternalAuth(req)) return internalUnauthorized();
  return json(await runCanariesFromBody());
}
