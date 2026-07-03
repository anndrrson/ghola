import {
  executeStoredActionFromBody,
  json,
  privateAccountLiveGuard,
  releasePrivateAccountLiveRevenueReservation,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guarded = await privateAccountLiveGuard(req, { requireRevenue: true });
  if (!guarded.ok) return guarded.response;
  try {
    const execution = await executeStoredActionFromBody(guarded.body, guarded.owner);
    if ("error" in execution) {
      await releasePrivateAccountLiveRevenueReservation(guarded.revenue, "failed");
      return json({ error: execution.error }, 400);
    }
    return json(execution, 201);
  } catch (error) {
    await releasePrivateAccountLiveRevenueReservation(guarded.revenue, "failed");
    throw error;
  }
}
