import {
  json,
  privateAccountOwnerFromRequest,
  readJson,
  rejectForbiddenFields,
  revokeVenueEligibilityFromBody,
  unauthorized,
} from "../../../../_lib";
import { venueIdFromParams } from "../../_venue";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<unknown> },
) {
  const venueId = venueIdFromParams(await params);
  if (!venueId) return json({ error: "venue_not_supported" }, 404);
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const revoked = await revokeVenueEligibilityFromBody(body, owner, venueId);
  if ("error" in revoked) return json({ error: revoked.error }, 404);
  return json(revoked);
}
