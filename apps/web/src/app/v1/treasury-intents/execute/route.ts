import {
  agentForRequest,
  buildReceiptForRequest,
  json,
  treasuryStatus,
} from "../_lib";
import { recordTreasuryExecution } from "@/lib/treasury-execution-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const agent = agentForRequest(req);
  if (!agent) return json({ error: "valid agent API key required" }, 401);

  const status = treasuryStatus();
  if (!status.ready) {
    return json(
      {
        error: "treasury execution unavailable",
        blocking_reasons: status.blocking_reasons,
      },
      503,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const result = await buildReceiptForRequest({ request: body, agent });
  if (!result.ok || !("receipt" in result)) {
    return json({ error: result.error ?? "invalid treasury execution request" }, 400);
  }
  const record = await recordTreasuryExecution({
    receipt: result.receipt,
    submissions: result.submissions,
  });

  return json(
    {
      version: 1,
      ok: true,
      receipt: result.receipt,
      reconciliation_state: record.state,
      partner_refs: record.partner_refs,
    },
    201,
  );
}
