import {
  executeStoredActionFromBody,
  json,
  privateAccountLiveGuard,
  releasePrivateAccountLiveRevenueReservation,
} from "../../_lib";
import { privateAgentSpendPolicy } from "@/lib/private-agent-spend-policy";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const spendPolicy = privateAgentSpendPolicy("execute");
  // Tests exercise only the in-memory settlement simulator; every remote
  // transport remains separately denied by the central spend policy.
  if (!spendPolicy.allowed && spendPolicy.environment !== "test") {
    return json({ error: "private_agent_remote_execution_disabled" }, 503);
  }
  const guarded = await privateAccountLiveGuard(req, { requireRevenue: true });
  if (!guarded.ok) return guarded.response;
  try {
    const execution = await executeStoredActionFromBody(guarded.body, guarded.owner);
    if ("error" in execution) {
      await releasePrivateAccountLiveRevenueReservation(guarded.revenue, "failed");
      return json({ error: execution.error }, 400);
    }
    return json(execution, 201);
  } catch (error) {
    await releasePrivateAccountLiveRevenueReservation(guarded.revenue, "failed");
    throw error;
  }
}
