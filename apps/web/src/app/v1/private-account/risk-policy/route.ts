import { getConsumerBalance, getConsumerRiskPolicy, putConsumerRiskPolicy } from "@/lib/consumer-production-store";
import { validateConsumerRiskPolicy } from "@/lib/consumer-production";
import {
  createOrGetStoredPrivateAccount,
  json,
  privateAccountOwnerFromRequest,
  readJson,
  unauthorized,
} from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  return json({ version: 1, policy: await getConsumerRiskPolicy(owner.owner_commitment) });
}

export async function PUT(request: Request) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const account = await createOrGetStoredPrivateAccount(owner);
  const balance = await getConsumerBalance({ owner_commitment: owner.owner_commitment, account_commitment: account.account_commitment });
  const body = await readJson(request) as Record<string, unknown> | null;
  try {
    const validated = validateConsumerRiskPolicy({
      owner_commitment: owner.owner_commitment,
      account_commitment: account.account_commitment,
      max_order_micro_usdc: Number(body?.max_order_micro_usdc),
      max_daily_notional_micro_usdc: Number(body?.max_daily_notional_micro_usdc),
      max_position_micro_usdc: Number(body?.max_position_micro_usdc),
      max_slippage_bps: Number(body?.max_slippage_bps),
      market_allowlist: Array.isArray(body?.market_allowlist) ? body.market_allowlist.map(String) : [],
    }, balance.available_micro_usdc);
    const policy = await putConsumerRiskPolicy({ version: 1, ...validated, updated_at: new Date().toISOString() });
    return json({ version: 1, policy });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "risk_policy_invalid" }, 400);
  }
}
