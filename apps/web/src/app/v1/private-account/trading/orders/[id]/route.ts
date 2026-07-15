import { getConsumerVenueOrder } from "@/lib/consumer-production-store";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const { id } = await context.params;
  const order = await getConsumerVenueOrder({ venue_order_id: id, owner_commitment: owner.owner_commitment });
  if (!order) return json({ error: "venue_order_not_found" }, 404);
  return json({ version: 1, order });
}
