import { randomUUID } from "node:crypto";
import { createConsumerWithdrawal, getConsumerWalletBinding, getConsumerWithdrawal } from "@/lib/consumer-production-store";
import { verifyConsumerStepUp } from "@/lib/consumer-step-up";
import {
  createOrGetStoredPrivateAccount,
  json,
  privateAccountOwnerFromRequest,
  readJson,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const withdrawalId = new URL(request.url).searchParams.get("withdrawal_id")?.trim() || "";
  if (!withdrawalId) return json({ error: "withdrawal_id_required" }, 400);
  const withdrawal = await getConsumerWithdrawal({ withdrawal_id: withdrawalId, owner_commitment: owner.owner_commitment });
  if (!withdrawal) return json({ error: "withdrawal_not_found" }, 404);
  return json({ version: 1, withdrawal });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  if (!await verifyConsumerStepUp(request)) return json({ error: "step_up_authentication_required" }, 403);
  const wallet = await getConsumerWalletBinding(owner.owner_commitment);
  if (!wallet) return json({ error: "bound_solana_wallet_required" }, 403);
  if (new Date(wallet.withdrawal_hold_until).getTime() > Date.now()) {
    return json({ error: "wallet_change_withdrawal_hold_active", withdrawal_hold_until: wallet.withdrawal_hold_until }, 423);
  }
  const body = await readJson(request) as Record<string, unknown> | null;
  const amount = Number(body?.amount_micro_usdc);
  if (!Number.isSafeInteger(amount) || amount < 1_000_000) return json({ error: "withdrawal_amount_must_be_at_least_one_usdc" }, 400);
  const account = await createOrGetStoredPrivateAccount(owner);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || randomUUID();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return json({ error: "idempotency_key_invalid" }, 400);
  const result = await createConsumerWithdrawal({
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    idempotency_key: idempotencyKey,
    destination_wallet_commitment: wallet.wallet_commitment,
    amount_micro_usdc: amount,
  });
  if (!result.ok) return json({ error: result.error }, result.error === "insufficient_available_balance" ? 402 : 409);
  console.log(JSON.stringify({
    level: "warn",
    message: "consumer_withdrawal_queued",
    withdrawal_id: result.withdrawal.withdrawal_id,
    owner_commitment: owner.owner_commitment,
  }));
  return json({
    version: 1,
    withdrawal_id: result.withdrawal.withdrawal_id,
    status: result.withdrawal.status,
    destination_wallet_commitment: result.withdrawal.destination_wallet_commitment,
    amount_micro_usdc: result.withdrawal.amount_micro_usdc,
    created_at: result.withdrawal.created_at,
  }, 202);
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
