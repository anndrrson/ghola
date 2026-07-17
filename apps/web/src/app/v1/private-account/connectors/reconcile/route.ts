import {
  connectorReconcileFromBody,
  json,
  meterPrivateAccountTradingFills,
  privateAccountBillingAuthorization,
  privateAccountLiveGuard,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req);
  if (!guarded.ok) return guarded.response;
  const reconciled = await connectorReconcileFromBody(guarded.body, guarded.owner);
  if ("error" in reconciled) return json({ error: reconciled.error }, 400);
  const billingMetering = await meterPrivateAccountTradingFills({
    authorization: privateAccountBillingAuthorization(req),
    result: reconciled.connector_result ?? null,
  });
  return json({ ...reconciled, billing_metering: billingMetering });
}
