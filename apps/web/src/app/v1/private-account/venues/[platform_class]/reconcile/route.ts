import {
  json,
  privateAccountOwnerFromRequest,
  readJson,
  reconcileVenueFromBody,
  rejectForbiddenFields,
  unauthorized,
} from "../../../_lib";
import { venueIdFromParams } from "../_venue";

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
  return json(await reconcileVenueFromBody(body, owner, venueId));
}
