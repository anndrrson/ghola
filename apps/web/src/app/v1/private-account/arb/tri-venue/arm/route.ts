import { json } from "../../../_lib";
import {
  buildTriVenueAutopilotPolicy,
  getTriVenueStatus,
  pooledTriVenueAccessForWorker,
} from "@/lib/private-account-tri-venue-arb";
import { createAutonomousAutopilotSessionFromBody } from "@/lib/private-account-autopilot";
import { triVenueLiveGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await triVenueLiveGuard(req);
  if (!guarded.ok) return guarded.response;

  const body = record(guarded.body);
  const mode = stringValue(body.mode) === "no_submit" ? "no_submit" : "tiny_live";
  const strategy = stringValue(body.strategy) === "maker" ? "maker" : "arb";
  const status = await getTriVenueStatus({ probeWorker: true });
  if (mode === "tiny_live" && !status.can_live_submit) {
    return json({
      version: 1,
      error: "tri_venue_live_not_ready",
      blockers: status.gates.flatMap((gate) => gate.reason_codes.map((reason) => `${gate.id}:${reason}`)),
      status,
    }, 409);
  }

  const created = await createAutonomousAutopilotSessionFromBody({
    session_policy: buildTriVenueAutopilotPolicy(strategy),
    venue_access: pooledTriVenueAccessForWorker(),
  }, guarded.owner);

  if (!created.session.worker_autopilot_session_id || !created.session.execution_enabled) {
    return json({
      version: 1,
      error: "tri_venue_worker_not_armed",
      mode,
      status,
      session: created.session,
      events: created.events,
    }, 502);
  }

  return json({
    version: 1,
    mode,
    strategy,
    access_mode: guarded.access_mode,
    status,
    ...created,
  }, 201);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
