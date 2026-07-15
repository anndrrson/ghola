import { buildConsumerWithdrawalChallenge, type ConsumerWithdrawalAction } from "@/lib/consumer-withdrawal-proof";
import { getConsumerWalletBinding, getConsumerWithdrawal } from "@/lib/consumer-production-store";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const url = new URL(request.url);
  const action = url.searchParams.get("action") as ConsumerWithdrawalAction | null;
  const withdrawalId = url.searchParams.get("withdrawal_id")?.trim() || null;
  if (action !== "create" && action !== "cancel") return json({ error: "withdrawal_action_invalid" }, 400);
  const wallet = await getConsumerWalletBinding(owner.owner_commitment);
  if (!wallet) return json({ error: "bound_solana_wallet_required" }, 403);
  if (action === "cancel") {
    if (!withdrawalId) return json({ error: "withdrawal_id_required" }, 400);
    const withdrawal = await getConsumerWithdrawal({ withdrawal_id: withdrawalId, owner_commitment: owner.owner_commitment });
    if (!withdrawal || withdrawal.destination_wallet_commitment !== wallet.wallet_commitment) return json({ error: "withdrawal_not_found" }, 404);
  }
  return json(buildConsumerWithdrawalChallenge({
    owner_commitment: owner.owner_commitment,
    wallet_pubkey: wallet.wallet_pubkey,
    action,
    withdrawal_id: withdrawalId,
  }));
}
