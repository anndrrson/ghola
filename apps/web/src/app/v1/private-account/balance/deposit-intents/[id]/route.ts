import { getConsumerDepositIntent } from "@/lib/consumer-production-store";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const { id } = await context.params;
  const intent = await getConsumerDepositIntent({ deposit_intent_id: id, owner_commitment: owner.owner_commitment });
  if (!intent) return json({ error: "deposit_intent_not_found" }, 404);
  return json({ ...intent, expected_wallet_pubkey: undefined });
}
