import {
  agentForRequest,
  buildExecutionReceipt,
  json,
  privateExecutionStatus,
  validateProviderResult,
  validateExecuteRequest,
} from "../_lib";
import { recordPrivateExecutionReceipt } from "@/lib/private-execution-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const agent = agentForRequest(req);
  if (!agent) return json({ error: "valid agent API key required" }, 401);

  const status = privateExecutionStatus();
  if (!status.ready) {
    return json(
      {
        error: "private execution unavailable",
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

  const validation = validateExecuteRequest(body);
  if (!validation.ok || !validation.request) {
    return json({ error: validation.error ?? "invalid private execution request" }, 400);
  }
  const providerResult = validateProviderResult({
    request: validation.request,
    agent,
  });
  if (!providerResult.ok) {
    return json({ error: providerResult.error }, 400);
  }
  const receipt = buildExecutionReceipt({
    request: validation.request,
    agent,
  });
  await recordPrivateExecutionReceipt({ receipt, agent });

  return json(
    {
      version: 1,
      ok: true,
      receipt,
    },
    201,
  );
}
