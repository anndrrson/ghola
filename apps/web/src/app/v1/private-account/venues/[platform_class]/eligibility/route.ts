import {
  json,
  privateAccountLiveGuard,
  privateAccountOwnerFromRequest,
  unauthorized,
  venueEligibilityStatusForOwner,
  verifyVenueEligibilityFromBody,
} from "../../../_lib";
import { venueIdFromParams } from "../_venue";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<unknown> },
) {
  const venueId = venueIdFromParams(await params);
  if (!venueId) return json({ error: "venue_not_supported" }, 404);
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  return json(await venueEligibilityStatusForOwner(owner, venueId));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<unknown> },
) {
  const venueId = venueIdFromParams(await params);
  if (!venueId) return json({ error: "venue_not_supported" }, 404);
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  return json(await verifyVenueEligibilityFromBody(guarded.body, guarded.owner, venueId), 201);
}
