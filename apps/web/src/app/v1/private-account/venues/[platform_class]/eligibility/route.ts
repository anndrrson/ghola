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
  const verified = await verifyVenueEligibilityFromBody(guarded.body, guarded.owner, venueId, req);
  if ("error" in verified) {
    return json(verified, verified.error === "restricted_jurisdiction" ? 451 : 400);
  }
  return json(verified, 201);
}
