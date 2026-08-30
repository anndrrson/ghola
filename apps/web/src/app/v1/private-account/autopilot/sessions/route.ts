import {
  json,
  privateAccountLiveGuard,
  privateAccountOwnerFromRequest,
  releasePrivateAccountAutopilotCompute,
  reservePrivateAccountAutopilotCompute,
  unauthorized,
} from "../../_lib";
import {
  createAutonomousAutopilotSessionFromBody,
  listAutopilotSessionsForOwner,
} from "@/lib/private-account-autopilot";
import {
  evaluateLiveTradingJurisdiction,
  liveTradingJurisdictionErrorBody,
} from "@/lib/live-trading-jurisdiction.server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  return json({
    version: 1,
    autopilot_sessions: await listAutopilotSessionsForOwner(owner),
  });
}

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req, { allowMobileWalletProof: true });
  if (!guarded.ok) return guarded.response;
  const jurisdiction = evaluateLiveTradingJurisdiction(req);
  if (!jurisdiction.allowed) {
    return json(liveTradingJurisdictionErrorBody(jurisdiction), 451);
  }
  const reservation = await reservePrivateAccountAutopilotCompute(req);
  if (!reservation.ok) return reservation.response;
  let created: Awaited<ReturnType<typeof createAutonomousAutopilotSessionFromBody>>;
  try {
    const now = new Date();
    created = await createAutonomousAutopilotSessionFromBody(
      guarded.body,
      guarded.owner,
      now,
      process.env,
      fetch,
      {
        version: 1,
        reservation_id: reservation.reservation_id,
        metering_mode: "sparse_metered_v1",
        reserved_seconds: reservation.reserved_seconds,
        lease_started_at: now.toISOString(),
        lease_expires_at: new Date(now.getTime() + reservation.reserved_seconds * 1000).toISOString(),
      },
    );
  } catch (error) {
    await releasePrivateAccountAutopilotCompute(req, reservation.reservation_id, "failed", 0);
    throw error;
  }
  const armed = Boolean(
    created.session.worker_autopilot_session_id &&
    created.session.status === "running" &&
    created.session.execution_enabled === true,
  );
  if (!armed) {
    await releasePrivateAccountAutopilotCompute(req, reservation.reservation_id, "failed", 0);
  }
  const payload = {
    version: 1,
    billing: {
      tier: reservation.billing.tier,
      reserved_seconds: reservation.reserved_seconds,
      reservation_id: reservation.reservation_id,
      metering_mode: "sparse_metered_v1",
    },
    ...created,
  };
  if (!armed) {
    return json({
      error: "autopilot_not_armed",
      next_step: created.session.next_step,
      ...payload,
    }, 409);
  }
  return json(payload, 201);
}
