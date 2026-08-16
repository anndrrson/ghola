import {
  getStoredCrossVenueExecution,
  markStoredCrossVenueExecutionClosed,
  markStoredCrossVenueExecutionClosing,
} from "@/lib/cross-venue-execution-store";
import { closeCrossVenueExecution } from "@/lib/cross-venue-worker";
import { privateAgentEmergencyControlPolicy } from "@/lib/private-agent-spend-policy";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  const controlPolicy = privateAgentEmergencyControlPolicy("close");
  if (!controlPolicy.allowed) return json({ version: 1, error: controlPolicy.reason }, 403);
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const { id } = await context.params;
  const current = await getStoredCrossVenueExecution({ execution_id: id, owner_commitment: owner.owner_commitment });
  if (!current) return json({ error: "cross_venue_execution_not_found" }, 404);
  if (current.status === "closed") return json({ version: 1, replayed: true, execution: current });
  if (!new Set(["both_filled", "closing"]).has(current.status)) {
    return json({ error: "cross_venue_close_requires_completed_pair", execution: current }, 409);
  }
  const closing = await markStoredCrossVenueExecutionClosing({ execution_id: id, owner_commitment: owner.owner_commitment });
  if (!closing) return json({ error: "cross_venue_execution_not_found" }, 404);
  const result = await closeCrossVenueExecution({ plan: closing });
  if (!result.ok) return json({ error: result.error, execution: closing }, result.status >= 500 ? 503 : 409);
  try {
    const execution = await markStoredCrossVenueExecutionClosed({
      execution_id: id,
      owner_commitment: owner.owner_commitment,
      worker_receipt: result.worker_receipt,
    });
    return json({ version: 1, replayed: result.status === 200, execution }, 200);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "cross_venue_close_flat_proof_required", execution: closing }, 409);
  }
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
