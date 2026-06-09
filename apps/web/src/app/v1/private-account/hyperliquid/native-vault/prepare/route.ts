import {
  json,
  prepareHyperliquidNativeVaultFromBody,
  privateAccountLiveGuard,
} from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const prepared = await prepareHyperliquidNativeVaultFromBody(guarded.body, guarded.owner);
  if ("error" in prepared) return json({ error: prepared.error }, 400);
  return json(prepared, 201);
}
