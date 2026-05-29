import {
  hyperliquidVaultStatusForOwner,
  json,
  privateAccountOwnerFromRequest,
  readJson,
  rejectForbiddenFields,
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
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const sealed = await sealHyperliquidVaultFromBody(body, owner);
  if ("error" in sealed) return json({ error: sealed.error }, 400);
  return json(sealed, 201);
}
