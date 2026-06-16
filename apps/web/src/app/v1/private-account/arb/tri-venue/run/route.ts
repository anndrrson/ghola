import { json } from "../../../_lib";
import {
  getTriVenueStatus,
  submitTriVenueWorkerCommand,
} from "@/lib/private-account-tri-venue-arb";
import { triVenueLiveGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await triVenueLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const status = await getTriVenueStatus({ probeWorker: true });
  if (!status.can_live_submit) {
    return json({
      version: 1,
      error: "tri_venue_live_not_ready",
      blockers: status.gates.flatMap((gate) => gate.reason_codes.map((reason) => `${gate.id}:${reason}`)),
      status,
    }, 409);
  }
  const result = await submitTriVenueWorkerCommand({
    action: "run",
    owner_commitment: guarded.owner.owner_commitment,
    payload: record(guarded.body),
  });
  if ("error" in result) {
    return json({
      version: 1,
      error: result.error,
      status,
      worker_body: "worker_body" in result ? result.worker_body : undefined,
    }, result.status);
  }
  return json({
    version: 1,
    access_mode: guarded.access_mode,
    status,
    result: result.body,
  }, result.status);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
