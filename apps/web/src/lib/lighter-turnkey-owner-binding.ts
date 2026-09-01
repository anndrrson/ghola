import { getAddress, isAddress } from "viem";

export const LIGHTER_TURNKEY_PERPS_WALLET_NAME = "Ghola Perps";
export const LIGHTER_TURNKEY_PERPS_OWNER_PATH = "m/44'/60'/0'/0/0";

const IDENTIFIER = /^[A-Za-z0-9_-]{1,256}$/;
const BINDING_KEYS = [
  "organization_id",
  "owner_address",
  "path",
  "wallet_account_id",
  "wallet_id",
] as const;

export type LighterTurnkeyPerpsOwnerBinding = Readonly<{
  organization_id: string;
  wallet_id: string;
  wallet_account_id: string;
  path: typeof LIGHTER_TURNKEY_PERPS_OWNER_PATH;
  owner_address: `0x${string}`;
}>;

export function validatedLighterTurnkeyPerpsOwnerBinding(
  value: unknown,
  expectedOwnerAddress?: string,
): LighterTurnkeyPerpsOwnerBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidBinding();
  const binding = value as Record<string, unknown>;
  if (
    Object.keys(binding).sort().join("\n") !== [...BINDING_KEYS].sort().join("\n") ||
    typeof binding.organization_id !== "string" || !IDENTIFIER.test(binding.organization_id) ||
    typeof binding.wallet_id !== "string" || !IDENTIFIER.test(binding.wallet_id) ||
    typeof binding.wallet_account_id !== "string" || !IDENTIFIER.test(binding.wallet_account_id) ||
    binding.path !== LIGHTER_TURNKEY_PERPS_OWNER_PATH ||
    typeof binding.owner_address !== "string" || !isAddress(binding.owner_address, { strict: true })
  ) throw invalidBinding();
  const ownerAddress = getAddress(binding.owner_address).toLowerCase() as `0x${string}`;
  if (
    expectedOwnerAddress &&
    (!isAddress(expectedOwnerAddress, { strict: true }) || ownerAddress !== expectedOwnerAddress.toLowerCase())
  ) throw invalidBinding();
  return Object.freeze({
    organization_id: binding.organization_id,
    wallet_id: binding.wallet_id,
    wallet_account_id: binding.wallet_account_id,
    path: LIGHTER_TURNKEY_PERPS_OWNER_PATH,
    owner_address: ownerAddress,
  });
}

export function sameLighterTurnkeyPerpsOwnerBinding(
  left: LighterTurnkeyPerpsOwnerBinding,
  right: LighterTurnkeyPerpsOwnerBinding,
) {
  return left.organization_id === right.organization_id &&
    left.wallet_id === right.wallet_id &&
    left.wallet_account_id === right.wallet_account_id &&
    left.path === right.path &&
    left.owner_address.toLowerCase() === right.owner_address.toLowerCase();
}

function invalidBinding() {
  return new Error("lighter_turnkey_owner_binding_invalid");
}
