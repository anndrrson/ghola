import {
  hyperliquidAccountSnapshotForOwner,
  json,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  return json(await hyperliquidAccountSnapshotForOwner(owner));
}
