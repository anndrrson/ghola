import {
  connectorSubmitFromBody,
  json,
  meterPrivateAccountTradingFills,
  privateAccountLiveGuard,
  releasePrivateAccountLiveRevenueReservation,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req, { requireRevenue: true });
  if (!guarded.ok) return guarded.response;
  try {
    const submitted = await connectorSubmitFromBody(guarded.body, guarded.owner);
    if ("error" in submitted) {
      await releasePrivateAccountLiveRevenueReservation(guarded.revenue, "failed");
      return json({ error: submitted.error }, 400);
    }
    const billingMetering = await meterPrivateAccountTradingFills({
      authorization: guarded.revenue?.authorization ?? null,
      result: submitted.connector_result ?? null,
    });
    await releasePrivateAccountLiveRevenueReservation(guarded.revenue, "completed");
    return json({ ...submitted, billing_metering: billingMetering }, 201);
  } catch (error) {
    await releasePrivateAccountLiveRevenueReservation(guarded.revenue, "failed");
    throw error;
  }
}
