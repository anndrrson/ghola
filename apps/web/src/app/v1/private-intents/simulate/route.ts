import { simulatePrivateExecution } from "@/lib/private-execution";
import { json, privateExecutionEnv } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "request body must be an object" }, 400);
  }
  const value = body as Record<string, unknown>;
  if (value.version !== 1) return json({ error: "version must be 1" }, 400);
  if (!value.policy || typeof value.policy !== "object") {
    return json({ error: "policy is required" }, 400);
  }
  if (!value.proposal || typeof value.proposal !== "object") {
    return json({ error: "proposal is required" }, 400);
  }

  const env = privateExecutionEnv();
  return json(
    simulatePrivateExecution({
      policy: value.policy as never,
      proposal: value.proposal as never,
      feeRecipient: env.feeRecipient || undefined,
      feeBps: env.feeBps,
      minFeeMicroUsdc: env.minFeeMicroUsdc,
    }),
  );
}
