import {
  connectorSubmitFromBody,
  json,
  privateAccountLiveGuard,
  privateAccountTradingBillingPolicy,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const billingPolicy = await privateAccountTradingBillingPolicy(req);
  const submitted = await connectorSubmitFromBody(guarded.body, guarded.owner, billingPolicy);
  if ("error" in submitted) {
    const status = submitted.error === "trading_subscription_required" ? 402 : 400;
    return json({ error: submitted.error }, status);
  }
  return json(submitted, 201);
}
