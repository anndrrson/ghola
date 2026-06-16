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
  const result = await submitTriVenueWorkerCommand({
    action: "kill",
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
