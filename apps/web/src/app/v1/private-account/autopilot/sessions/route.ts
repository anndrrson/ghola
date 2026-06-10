import {
  json,
  privateAccountLiveGuard,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../_lib";
import {
  createAutonomousAutopilotSessionFromBody,
  listAutopilotSessionsForOwner,
} from "@/lib/private-account-autopilot";

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
  const created = await createAutonomousAutopilotSessionFromBody(guarded.body, guarded.owner);
  return json({
    version: 1,
    ...created,
  }, 201);
}
