import {
  json,
  poolAuditForVenue,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../../../_lib";
import { venueIdFromParams } from "../../_venue";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<unknown> },
) {
  const venueId = venueIdFromParams(await params);
  if (!venueId) return json({ error: "venue_not_supported" }, 404);
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const audit = await poolAuditForVenue(venueId);
  if ("error" in audit) return json({ error: audit.error }, 400);
  return json(audit);
}
