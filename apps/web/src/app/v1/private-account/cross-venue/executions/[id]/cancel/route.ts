import { cancelStoredCrossVenueExecution, getStoredCrossVenueExecution } from "@/lib/cross-venue-execution-store";
import { cancelCrossVenueExecution } from "@/lib/cross-venue-worker";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const { id } = await context.params;
  const current = await getStoredCrossVenueExecution({ execution_id: id, owner_commitment: owner.owner_commitment });
  if (!current) return json({ error: "cross_venue_execution_not_found" }, 404);
  if (["both_filled", "hedged", "cancelled", "failed", "manual_intervention_required"].includes(current.status)) {
    return json({ version: 1, execution: current });
  }
  const cancellation = await cancelCrossVenueExecution({ plan: current });
  if (!cancellation.ok) return json({ error: cancellation.error, execution: current }, 503);
  const execution = await cancelStoredCrossVenueExecution({ execution_id: id, owner_commitment: owner.owner_commitment });
  return json({ version: 1, execution }, 202);
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
