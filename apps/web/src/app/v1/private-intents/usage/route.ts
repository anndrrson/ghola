import { privateExecutionUsageSummary } from "@/lib/private-execution-store";
import { agentForRequest, json } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const agent = agentForRequest(req);
  if (!agent) return json({ error: "valid agent API key required" }, 401);
  return json(await privateExecutionUsageSummary(agent.agent_id));
}
