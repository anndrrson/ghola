import {
  allocateHyperliquidManagedFromBody,
  json,
  privateAccountLiveGuard,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const allocation = await allocateHyperliquidManagedFromBody(guarded.body, guarded.owner);
  if ("error" in allocation) return json({ error: allocation.error }, 400);
  return json(allocation, 201);
}
