import { prepareTurnkeyUsdcWithdrawal } from "@/lib/consumer-turnkey-treasury";
import {
  getConsumerWalletBinding,
  getConsumerWithdrawal,
  prepareConsumerWithdrawal,
} from "@/lib/consumer-production-store";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const { id } = await context.params;
  const [withdrawal, wallet] = await Promise.all([
    getConsumerWithdrawal({ withdrawal_id: id, owner_commitment: owner.owner_commitment }),
    getConsumerWalletBinding(owner.owner_commitment),
  ]);
  if (!withdrawal) return json({ error: "withdrawal_not_found" }, 404);
  if (!wallet || wallet.wallet_commitment !== withdrawal.destination_wallet_commitment) {
    return json({ error: "withdrawal_recipient_binding_stale" }, 409);
  }
  if (withdrawal.status !== "queued" && withdrawal.status !== "prepared") {
    return json({ error: "withdrawal_not_preparable", status: withdrawal.status }, 409);
  }
  try {
    const prepared = await prepareTurnkeyUsdcWithdrawal({
      destination_owner: wallet.wallet_pubkey,
      amount_micro_usdc: withdrawal.amount_micro_usdc,
    });
    const stored = await prepareConsumerWithdrawal({
      withdrawal_id: withdrawal.withdrawal_id,
      owner_commitment: owner.owner_commitment,
      message_commitment: prepared.message_commitment,
      expires_at: new Date(prepared.expires_at),
    });
    if (!stored) return json({ error: "withdrawal_prepare_race" }, 409);
    return json({
      version: 1,
      withdrawal_id: withdrawal.withdrawal_id,
      status: stored.status,
      transaction_base64: prepared.transaction_base64,
      fee_payer: prepared.fee_payer,
      expires_at: prepared.expires_at,
      network: "solana-mainnet",
      asset: "USDC",
    });
  } catch (error) {
    const code = safeTreasuryError(error);
    console.error(JSON.stringify({ level: "error", message: "consumer_withdrawal_prepare_failed", error_code: code, withdrawal_id: id }));
    return json({ error: code }, code === "consumer_treasury_usdc_insufficient" ? 503 : 502);
  }
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

function safeTreasuryError(error: unknown) {
  const message = error instanceof Error ? error.message : "consumer_treasury_unavailable";
  return /^[a-z0-9_]{3,80}$/.test(message) ? message : "consumer_treasury_unavailable";
}
