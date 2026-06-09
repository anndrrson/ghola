import {
  armVenueAgentSessionFromBody,
  json,
  privateAccountLiveGuard,
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
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const session = await armVenueAgentSessionFromBody(guarded.body, guarded.owner, platform);
  if ("error" in session) return json({ error: session.error }, 400);
  return json(session, 201);
}
