import { verifyConsumerWithdrawalProof } from "@/lib/consumer-withdrawal-proof";
import {
  cancelConsumerWithdrawal,
  consumeConsumerNonce,
  getConsumerWalletBinding,
  getConsumerWithdrawal,
} from "@/lib/consumer-production-store";
import { json, privateAccountOwnerFromRequest, readJson, unauthorized } from "../../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const body = await readJson(request) as Record<string, unknown> | null;
  const { id } = await context.params;
  const [withdrawal, wallet] = await Promise.all([
    getConsumerWithdrawal({ withdrawal_id: id, owner_commitment: owner.owner_commitment }),
    getConsumerWalletBinding(owner.owner_commitment),
  ]);
  if (!withdrawal) return json({ error: "withdrawal_not_found" }, 404);
  if (!wallet || wallet.wallet_commitment !== withdrawal.destination_wallet_commitment) {
    return json({ error: "fresh_bound_wallet_step_up_required" }, 403);
  }
  const proof = verifyConsumerWithdrawalProof(body ?? {}, {
    owner_commitment: owner.owner_commitment,
    wallet_pubkey: wallet.wallet_pubkey,
    action: "cancel",
    withdrawal_id: id,
  });
  if (!proof.ok) return json({ error: "fresh_bound_wallet_step_up_required" }, 403);
  const accepted = await consumeConsumerNonce({
    namespace: "consumer_withdrawal_cancel",
    owner_commitment: owner.owner_commitment,
    nonce: proof.nonce,
    expires_at_ms: proof.expires_at_ms,
  });
  if (!accepted) return json({ error: "withdrawal_step_up_replayed" }, 403);
  const cancelled = await cancelConsumerWithdrawal({ withdrawal_id: id, owner_commitment: owner.owner_commitment });
  if (!cancelled) return json({ error: "withdrawal_not_cancellable", status: withdrawal.status }, 409);
  return json({ version: 1, withdrawal_id: cancelled.withdrawal_id, status: cancelled.status });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}
