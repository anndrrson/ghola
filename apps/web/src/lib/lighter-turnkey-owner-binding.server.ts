import "server-only";

import { Turnkey } from "@turnkey/sdk-server";
import { getAddress, isAddress } from "viem";
import {
  LIGHTER_TURNKEY_PERPS_OWNER_PATH,
  LIGHTER_TURNKEY_PERPS_WALLET_NAME,
  validatedLighterTurnkeyPerpsOwnerBinding,
  type LighterTurnkeyPerpsOwnerBinding,
} from "./lighter-turnkey-owner-binding";

type TurnkeyApiClient = Pick<
  ReturnType<InstanceType<typeof Turnkey>["apiClient"]>,
  "getSubOrgIds" | "getWalletAccounts" | "getWallets"
>;

const MAX_SUBORGANIZATIONS = 10;
const MAX_PERPS_WALLETS = 10;

export async function resolveLighterTurnkeyPerpsOwnerBinding(input: {
  sessionEmail: string;
  ownerAddress: string;
  env?: Record<string, string | undefined>;
  client?: TurnkeyApiClient;
}): Promise<LighterTurnkeyPerpsOwnerBinding> {
  const env = input.env ?? process.env;
  const email = input.sessionEmail.trim().toLowerCase();
  if (!email || email.length > 254 || !email.includes("@")) fail("session_invalid", 403);
  if (!isAddress(input.ownerAddress, { strict: true })) fail("address_invalid", 400);
  const expectedOwner = getAddress(input.ownerAddress).toLowerCase();
  const parentOrganizationId = env.NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID?.trim() || "";
  const queryOrganizationId = env.GHOLA_TURNKEY_QUERY_ORGANIZATION_ID?.trim() || parentOrganizationId;
  if (!identifier(parentOrganizationId) || queryOrganizationId !== parentOrganizationId) {
    fail("unconfigured", 503);
  }
  const client = input.client ?? configuredClient(env, queryOrganizationId);

  let organizationIds: string[];
  try {
    const response = await client.getSubOrgIds({
      organizationId: parentOrganizationId,
      filterType: "EMAIL",
      filterValue: email,
    });
    organizationIds = Array.from(new Set((response.organizationIds || []).filter(identifier)));
  } catch {
    fail("unavailable", 503);
  }
  if (organizationIds.length === 0) fail("mismatch", 403);
  if (organizationIds.length > MAX_SUBORGANIZATIONS) fail("ambiguous", 409);

  const candidates: LighterTurnkeyPerpsOwnerBinding[] = [];
  try {
    for (const organizationId of organizationIds) {
      const wallets = await client.getWallets({ organizationId });
      const perpsWallets = (wallets.wallets || []).filter((wallet) =>
        wallet.walletName === LIGHTER_TURNKEY_PERPS_WALLET_NAME &&
        wallet.exported === false &&
        wallet.imported === false
      );
      if (perpsWallets.length > MAX_PERPS_WALLETS) fail("ambiguous", 409);
      for (const wallet of perpsWallets) {
        if (!identifier(wallet.walletId)) continue;
        const accounts = await client.getWalletAccounts({ organizationId, walletId: wallet.walletId });
        for (const account of accounts.accounts || []) {
          if (
            account.organizationId !== organizationId ||
            account.walletId !== wallet.walletId ||
            account.curve !== "CURVE_SECP256K1" ||
            account.pathFormat !== "PATH_FORMAT_BIP32" ||
            account.path !== LIGHTER_TURNKEY_PERPS_OWNER_PATH ||
            account.addressFormat !== "ADDRESS_FORMAT_ETHEREUM" ||
            !identifier(account.walletAccountId) ||
            !isAddress(account.address, { strict: true })
          ) continue;
          candidates.push(validatedLighterTurnkeyPerpsOwnerBinding({
            organization_id: organizationId,
            wallet_id: wallet.walletId,
            wallet_account_id: account.walletAccountId,
            path: account.path,
            owner_address: account.address,
          }));
        }
      }
    }
  } catch (caught) {
    if (bindingError(caught)) throw caught;
    fail("unavailable", 503);
  }
  if (candidates.length === 0) fail("mismatch", 403);
  if (candidates.length !== 1) fail("ambiguous", 409);
  if (candidates[0].owner_address !== expectedOwner) fail("mismatch", 403);
  return candidates[0];
}

function configuredClient(env: Record<string, string | undefined>, organizationId: string): TurnkeyApiClient {
  const apiPublicKey = env.GHOLA_TURNKEY_QUERY_API_PUBLIC_KEY?.trim();
  const apiPrivateKey = env.GHOLA_TURNKEY_QUERY_API_PRIVATE_KEY?.trim();
  if (!apiPublicKey || !apiPrivateKey) fail("unconfigured", 503);
  return new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: organizationId,
  }).apiClient();
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function bindingError(value: unknown) {
  return value instanceof Error && /^lighter_turnkey_owner_binding_/.test(value.message);
}

function fail(reason: string, status: number): never {
  const code = `lighter_turnkey_owner_binding_${reason}`;
  throw Object.assign(new Error(code), { code, status });
}
