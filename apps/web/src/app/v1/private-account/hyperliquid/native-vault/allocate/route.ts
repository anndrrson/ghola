import {
  allocateHyperliquidNativeVaultFromBody,
  json,
  privateAccountLiveGuard,
} from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const allocated = await allocateHyperliquidNativeVaultFromBody(guarded.body, guarded.owner);
  if ("error" in allocated) return json({ error: allocated.error }, 400);
  return json(allocated, 201);
}
