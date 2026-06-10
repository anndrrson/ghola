import {
  json,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../_lib";
import {
  normalizeMobileWalletPubkey,
  privateMobileWalletBindingChallenge,
} from "@/lib/private-account-wallet-binding";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const url = new URL(req.url);
  const wallet = normalizeMobileWalletPubkey(url.searchParams.get("wallet_pubkey"));
  if (!wallet) return json({ error: "mobile_wallet_invalid" }, 400);
  return json(privateMobileWalletBindingChallenge({
    owner_commitment: owner.owner_commitment,
    wallet_pubkey: wallet,
  }));
}
