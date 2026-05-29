import {
  armVenueAgentSessionFromBody,
  json,
  privateAccountOwnerFromRequest,
  readJson,
  rejectForbiddenFields,
  unauthorized,
} from "../../../../_lib";
import type { GholaPlatformClass } from "@/lib/private-account";

export const dynamic = "force-dynamic";

function platformClass(params: unknown): GholaPlatformClass | null {
  const value =
    params && typeof params === "object" && "platform_class" in params
      ? (params as { platform_class?: unknown }).platform_class
      : null;
  return value === "hyperliquid_style_market" || value === "coinbase_style_provider"
    ? value
    : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<unknown> },
) {
  const platform = platformClass(await params);
  if (!platform) return json({ error: "venue_not_supported" }, 404);
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const session = await armVenueAgentSessionFromBody(body, owner, platform);
  if ("error" in session) return json({ error: session.error }, 400);
  return json(session, 201);
}
