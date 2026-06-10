import {
  connectorVerifyNoSubmitFromBody,
  json,
  privateAccountLiveGuard,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const verified = await connectorVerifyNoSubmitFromBody(guarded.body, guarded.owner, {
    site_origin: new URL(req.url).origin,
  });
  if ("error" in verified) return json({ error: verified.error }, 400);
  return json(verified);
}
