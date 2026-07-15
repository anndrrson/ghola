import { submitPreparedUsdcWithdrawal, transactionMessageCommitment } from "@/lib/consumer-turnkey-treasury";
import {
  getConsumerWalletBinding,
  getConsumerWithdrawal,
  haltConsumerCircuit,
  submitPreparedConsumerWithdrawal,
} from "@/lib/consumer-production-store";
import { Transaction } from "@solana/web3.js";
import { json, privateAccountOwnerFromRequest, readJson, unauthorized } from "../../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const { id } = await context.params;
  const body = await readJson(request) as Record<string, unknown> | null;
  const transactionBase64 = typeof body?.transaction_base64 === "string" ? body.transaction_base64.trim() : "";
  if (!transactionBase64 || transactionBase64.length > 4_000) return json({ error: "withdrawal_transaction_required" }, 400);
  const [withdrawal, wallet] = await Promise.all([
    getConsumerWithdrawal({ withdrawal_id: id, owner_commitment: owner.owner_commitment }),
    getConsumerWalletBinding(owner.owner_commitment),
  ]);
  if (!withdrawal) return json({ error: "withdrawal_not_found" }, 404);
  if (!wallet || wallet.wallet_commitment !== withdrawal.destination_wallet_commitment) {
    return json({ error: "withdrawal_recipient_binding_stale" }, 409);
  }
  if (withdrawal.status !== "prepared" || !withdrawal.prepared_message_commitment || !withdrawal.prepared_expires_at) {
    return json({ error: "withdrawal_not_prepared", status: withdrawal.status }, 409);
  }
  if (new Date(withdrawal.prepared_expires_at).getTime() <= Date.now()) return json({ error: "withdrawal_transaction_expired" }, 409);
  try {
    const transaction = Transaction.from(Buffer.from(transactionBase64, "base64"));
    const messageCommitment = transactionMessageCommitment(transaction);
    const broadcast = await submitPreparedUsdcWithdrawal({
      transaction_base64: transactionBase64,
      expected_message_commitment: withdrawal.prepared_message_commitment,
      expected_fee_payer: wallet.wallet_pubkey,
    });
    const stored = await submitPreparedConsumerWithdrawal({
      withdrawal_id: withdrawal.withdrawal_id,
      owner_commitment: owner.owner_commitment,
      message_commitment: messageCommitment,
      transaction_signature: broadcast.transaction_signature,
    });
    if (!stored) {
      await haltConsumerCircuit({ reasons: ["reconciliation_drift"], acknowledged_by: "system:withdrawal_broadcast_store_drift" });
      console.error(JSON.stringify({ level: "error", message: "consumer_withdrawal_broadcast_store_drift", withdrawal_id: id }));
      return json({ error: "withdrawal_broadcast_store_drift", transaction_signature: broadcast.transaction_signature }, 503);
    }
    return json({ version: 1, withdrawal_id: stored.withdrawal_id, status: stored.status, transaction_signature: stored.transaction_signature }, 202);
  } catch (error) {
    const code = safeSubmitError(error);
    return json({ error: code }, code.includes("mismatch") || code.includes("signature") || code.includes("invalid") ? 400 : 502);
  }
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

function safeSubmitError(error: unknown) {
  const message = error instanceof Error ? error.message : "withdrawal_submit_failed";
  return /^[a-z0-9_]{3,80}$/.test(message) ? message : "withdrawal_submit_failed";
}
