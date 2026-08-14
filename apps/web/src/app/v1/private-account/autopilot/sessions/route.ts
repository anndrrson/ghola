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
import { privateAgentSpendPolicy } from "@/lib/private-agent-spend-policy";
import { levelTriggerExactPlanError } from "./_handler";

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
  const spendPolicy = privateAgentSpendPolicy("session");
  if (!spendPolicy.allowed && spendPolicy.environment !== "test") {
    return json({ error: "private_agent_remote_execution_disabled" }, 503);
  }
  const guarded = await privateAccountLiveGuard(req, { allowMobileWalletProof: true });
  if (!guarded.ok) return guarded.response;
  const exactPlanError = levelTriggerExactPlanError(guarded.body);
  if (exactPlanError) return json({ error: exactPlanError }, 400);
  let created;
  try {
    created = await createAutonomousAutopilotSessionFromBody(guarded.body, guarded.owner);
  } catch (error) {
    if (error instanceof Error && error.message === "level_trigger_exact_plan_required") {
      return json({ error: error.message }, 400);
    }
    throw error;
  }
  return json({
    version: 1,
    ...created,
  }, 201);
}
