import {
  json,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../_lib";
import { autopilotReadinessForOwner } from "@/lib/private-account-autopilot";
import { getActivePrivateMobileWalletBinding } from "@/lib/private-account-store";
import {
  mobileWalletCommitment,
  normalizeMobileWalletPubkey,
} from "@/lib/private-account-wallet-binding";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const url = new URL(req.url);
  const productId = url.searchParams.get("product_id") || "BTC-USD";
  const wallet = normalizeMobileWalletPubkey(url.searchParams.get("wallet_pubkey"));
  const walletBindingStatus = wallet
    ? await getActivePrivateMobileWalletBinding({
        owner_commitment: owner.owner_commitment,
        wallet_commitment: mobileWalletCommitment(wallet),
      })
      ? "active" as const
      : "missing" as const
    : "unknown" as const;
  return json(autopilotReadinessForOwner(productId, process.env, walletBindingStatus));
}
