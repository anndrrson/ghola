import { getPrivateExecutionReceiptRecord } from "@/lib/private-execution-store";
import { agentForRequest, json } from "../../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  const agent = agentForRequest(req);
  if (!agent) return json({ error: "valid agent API key required" }, 401);
  const { id } = await params;
  const record = await getPrivateExecutionReceiptRecord(id);
  if (!record || record.agent_id !== agent.agent_id) {
    return json({ error: "receipt not found" }, 404);
  }
  return json(record);
}
