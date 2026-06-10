import {
  hyperliquidVaultStatusForOwner,
  json,
  privateAccountLiveGuard,
  privateAccountOwnerFromRequest,
  sealHyperliquidVaultFromBody,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  return json(await hyperliquidVaultStatusForOwner(owner));
}

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const sealed = await sealHyperliquidVaultFromBody(guarded.body, guarded.owner);
  if ("error" in sealed) return json({ error: sealed.error }, 400);
  return json(sealed, 201);
}
