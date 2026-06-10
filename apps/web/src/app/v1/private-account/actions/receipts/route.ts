import {
  json,
  privateAccountOwnerFromRequest,
  receiptListForOwner,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  return json(await receiptListForOwner(req, owner));
}
