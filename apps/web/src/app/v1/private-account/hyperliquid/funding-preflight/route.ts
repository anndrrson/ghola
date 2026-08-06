import { inspectHyperliquidFundingPreflight } from "@/lib/hyperliquid-funding-preflight";
import { json, privateAccountOwnerFromRequest, unauthorized } from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const raw = await req.json().catch(() => null);
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const network = text(body.network) === "testnet" ? "testnet" : "mainnet";
  try {
    return json(await inspectHyperliquidFundingPreflight({
      network,
      masterAccountAddress: text(body.master_account_address),
      connectedWalletAddress: text(body.connected_wallet_address),
      apiWalletAddress: text(body.api_wallet_address),
    }));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Funding preflight failed" }, 400);
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
