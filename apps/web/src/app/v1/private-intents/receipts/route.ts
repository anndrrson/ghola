import { listPrivateExecutionReceipts } from "@/lib/private-execution-store";
import { agentForRequest, json } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const agent = agentForRequest(req);
  if (!agent) return json({ error: "valid agent API key required" }, 401);
  const url = new URL(req.url);
  const limit = Number.parseInt(url.searchParams.get("limit") || "25", 10);
  return json({
    version: 1,
    data: await listPrivateExecutionReceipts(agent.agent_id, limit),
  });
}
