import { randomUUID } from "node:crypto";
import {
  createConsumerDepositIntent,
  getConsumerEligibilityAcceptance,
  getConsumerWalletBinding,
} from "@/lib/consumer-production-store";
import { CONSUMER_RISK_VERSION, CONSUMER_TERMS_VERSION, type ConsumerFundingRail } from "@/lib/consumer-production";
import {
  createOrGetStoredPrivateAccount,
  json,
  privateAccountOwnerFromRequest,
  readJson,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const body = await readJson(request) as Record<string, unknown> | null;
  const amount = Number(body?.amount_micro_usdc);
  const rail = fundingRail(body?.rail);
  if (!rail) return json({ error: "supported_funding_rail_required" }, 400);
  if (!Number.isSafeInteger(amount) || amount < 1_000_000) {
    return json({ error: "deposit_amount_must_be_at_least_one_usdc" }, 400);
  }
  const [wallet, acceptance] = await Promise.all([
    getConsumerWalletBinding(owner.owner_commitment),
    getConsumerEligibilityAcceptance(owner.owner_commitment),
  ]);
  if (!wallet) return json({ error: "bound_solana_wallet_required" }, 403);
  if (
    acceptance?.terms_version !== CONSUMER_TERMS_VERSION ||
    acceptance.risk_version !== CONSUMER_RISK_VERSION ||
    acceptance.not_prohibited_person !== true
  ) {
    return json({ error: "current_consumer_acceptance_required" }, 403);
  }
  const account = await createOrGetStoredPrivateAccount(owner);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || randomUUID();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return json({ error: "idempotency_key_invalid" }, 400);
  }
  const intent = await createConsumerDepositIntent({
    owner_commitment: owner.owner_commitment,
    account_commitment: account.account_commitment,
    rail,
    expected_wallet_pubkey: rail === "solana_usdc" ? wallet.wallet_pubkey : null,
    amount_micro_usdc: amount,
    idempotency_key: idempotencyKey,
  });
  return json({
    ...intent,
    expected_wallet_pubkey: undefined,
    deposit_instructions: rail === "solana_usdc"
      ? {
          asset: "USDC",
          network: "solana-mainnet",
          treasury_recipient: process.env.GHOLA_CONSUMER_SOLANA_USDC_TREASURY_RECIPIENT?.trim() || null,
          source_wallet_commitment: wallet.wallet_commitment,
          finality_required: "finalized",
        }
      : {
          asset: "USDCx",
          network: "solana-shielded-pool",
          verifier_required: true,
          public_fallback_allowed: false,
        },
  }, 201);
}

function fundingRail(value: unknown): ConsumerFundingRail | null {
  return value === "solana_usdc" || value === "solana_shielded_usdcx" ? value : null;
}
