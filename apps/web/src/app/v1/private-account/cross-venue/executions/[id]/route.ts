import { getStoredCrossVenueExecution } from "@/lib/cross-venue-execution-store";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const { id } = await context.params;
  const execution = await getStoredCrossVenueExecution({ execution_id: id, owner_commitment: owner.owner_commitment });
  if (!execution) return json({ error: "cross_venue_execution_not_found" }, 404);
  return json({ version: 1, execution });
}
