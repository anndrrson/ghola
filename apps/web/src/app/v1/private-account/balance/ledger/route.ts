import { getConsumerBalance, listConsumerLedger } from "@/lib/consumer-production-store";
import {
  createOrGetStoredPrivateAccount,
  json,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = await privateAccountOwnerFromRequest(request);
  if (!owner) return unauthorized();
  const account = await createOrGetStoredPrivateAccount(owner);
  const [balance, transactions] = await Promise.all([
    getConsumerBalance({ owner_commitment: owner.owner_commitment, account_commitment: account.account_commitment }),
    listConsumerLedger({ owner_commitment: owner.owner_commitment, account_commitment: account.account_commitment }),
  ]);
  return json({ version: 1, balance, transactions });
}
