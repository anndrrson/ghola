import {
  allocatePooledVenueFromBody,
  json,
  privateAccountLiveGuard,
} from "../../../../_lib";
import { venueIdFromParams } from "../../_venue";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<unknown> },
) {
  const venueId = venueIdFromParams(await params);
  if (!venueId) return json({ error: "venue_not_supported" }, 404);
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const allocated = await allocatePooledVenueFromBody(guarded.body, guarded.owner, venueId);
  if ("error" in allocated) return json({ error: allocated.error }, 400);
  return json(allocated, 201);
}
