import {
  json,
  preflightVenueTradeFromBody,
  privateAccountLiveGuard,
} from "../../../_lib";
import { venueIdFromParams } from "../_venue";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<unknown> },
) {
  const venueId = venueIdFromParams(await params);
  if (!venueId) return json({ error: "venue_not_supported" }, 404);
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  return json(await preflightVenueTradeFromBody(guarded.body, guarded.owner, venueId));
}
