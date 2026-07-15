import { consumerCommitment } from "@/lib/consumer-production";
import {
  confirmConsumerDeposit,
  getConsumerDepositIntent,
  getConsumerWalletBinding,
} from "@/lib/consumer-production-store";
import { verifyConsumerSolanaUsdcDeposit } from "@/lib/consumer-solana-usdc-verifier";
import { verifyCustomShieldedDepositReceipt } from "@/lib/private-account-verifier";
import type { PrivateFundingInstructionRecordV1 } from "@/lib/private-account-store";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const { id } = await context.params;
  const intent = await getConsumerDepositIntent({ deposit_intent_id: id, owner_commitment: owner.owner_commitment });
  if (!intent) return json({ error: "deposit_intent_not_found" }, 404);
  if (intent.status !== "pending") return json({ error: "deposit_intent_not_pending" }, 409);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (intent.rail === "solana_usdc") {
    const signature = String(body?.transaction_signature || "").trim();
    const binding = await getConsumerWalletBinding(owner.owner_commitment);
    const treasury = process.env.GHOLA_CONSUMER_SOLANA_USDC_TREASURY_RECIPIENT?.trim() || "";
    if (!binding || !treasury) return json({ error: "consumer_public_usdc_configuration_incomplete" }, 503);
    const verified = await verifyConsumerSolanaUsdcDeposit({
      signature,
      expected_source_wallet: binding.wallet_pubkey,
      expected_treasury_wallet: treasury,
      expected_amount_micro_usdc: intent.amount_micro_usdc,
    });
    if (!verified.ok) return json({ error: verified.error }, 400);
    const confirmed = await confirmConsumerDeposit({
      deposit_intent_id: intent.deposit_intent_id,
      owner_commitment: owner.owner_commitment,
      transaction_signature: signature,
    });
    return confirmed.ok ? json({ version: 1, deposit: confirmed.intent, balance: confirmed.balance }) : json({ error: confirmed.error }, 409);
  }

  const receiptId = String(body?.receipt_id || "").trim();
  const destinationCommitment = process.env.GHOLA_CONSUMER_SHIELDED_DEPOSIT_DESTINATION_COMMITMENT?.trim() || "";
  const amountBucket = intent.amount_micro_usdc % 1_000_000 === 0 ? String(intent.amount_micro_usdc / 1_000_000) : "";
  if (!receiptId || !destinationCommitment || !["5", "10", "25", "50", "100"].includes(amountBucket)) {
    return json({ error: "consumer_shielded_deposit_configuration_incomplete" }, 503);
  }
  const instruction: PrivateFundingInstructionRecordV1 = {
    version: 1,
    funding_intent_id: intent.deposit_intent_id,
    owner_commitment: owner.owner_commitment,
    account_commitment: intent.account_commitment,
    funding_intent_commitment: consumerCommitment("shielded_funding", intent.deposit_intent_id),
    asset_bucket: "USDCx",
    amount_bucket: amountBucket,
    shielded_rail: "custom_shielded_deposit",
    destination_commitment: destinationCommitment,
    shielded_destination: "sealed",
    status: "pending",
    created_at: intent.created_at,
    expires_at: intent.expires_at,
    updated_at: intent.created_at,
  };
  const verified = await verifyCustomShieldedDepositReceipt({ instruction, receipt_id: receiptId });
  if (!verified.ok) return json({ error: verified.error }, 400);
  const confirmed = await confirmConsumerDeposit({
    deposit_intent_id: intent.deposit_intent_id,
    owner_commitment: owner.owner_commitment,
    nullifier_commitment: verified.result.nullifier_commitment,
  });
  return confirmed.ok ? json({ version: 1, deposit: confirmed.intent, balance: confirmed.balance }) : json({ error: confirmed.error }, 409);
}
