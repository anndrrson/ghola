import { getConsumerDepositIntent, getConsumerWalletBinding } from "@/lib/consumer-production-store";
import { prepareConsumerUsdcDepositTransaction } from "@/lib/consumer-solana-usdc-transfer";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  if (process.env.GHOLA_CONSUMER_PREPAID_BALANCE_ENABLED !== "true") return json({ error: "consumer_prepaid_balance_not_enabled" }, 503);
  const { id } = await context.params;
  const [intent, wallet] = await Promise.all([
    getConsumerDepositIntent({ deposit_intent_id: id, owner_commitment: owner.owner_commitment }),
    getConsumerWalletBinding(owner.owner_commitment),
  ]);
  if (!intent) return json({ error: "deposit_intent_not_found" }, 404);
  if (intent.status !== "pending" || intent.rail !== "solana_usdc") return json({ error: "public_usdc_deposit_intent_not_pending" }, 409);
  if (!wallet || intent.expected_wallet_pubkey !== wallet.wallet_pubkey) return json({ error: "deposit_wallet_binding_stale" }, 409);
  const treasury = process.env.GHOLA_CONSUMER_SOLANA_USDC_TREASURY_RECIPIENT?.trim() || "";
  if (!treasury) return json({ error: "consumer_public_usdc_configuration_incomplete" }, 503);
  try {
    return json(await prepareConsumerUsdcDepositTransaction({
      source_owner: wallet.wallet_pubkey,
      treasury_owner: treasury,
      amount_micro_usdc: intent.amount_micro_usdc,
    }));
  } catch (error) {
    const code = safeError(error);
    return json({ error: code }, code === "source_wallet_usdc_insufficient" ? 402 : 502);
  }
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "deposit_prepare_failed";
  return /^[a-z0-9_]{3,80}$/.test(message) ? message : "deposit_prepare_failed";
}
