import {
  executeStoredActionFromBody,
  json,
  privateAccountLiveGuard,
  privateAccountTradingBillingPolicy,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const billingPolicy = await privateAccountTradingBillingPolicy(req);
  const execution = await executeStoredActionFromBody(guarded.body, guarded.owner, billingPolicy);
  if ("error" in execution) {
    const status = execution.error === "trading_subscription_required" ? 402 : 400;
    return json({ error: execution.error }, status);
  }
  return json(execution, 201);
}
