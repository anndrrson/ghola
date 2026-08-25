import { encodeFunctionData, getAddress, type Hex } from "viem";

export const LIGHTER_MAINNET_CHAIN_ID = 1 as const;
export const LIGHTER_MAINNET_API_URL = "https://mainnet.zklighter.elliot.ai";
export const LIGHTER_MAINNET_PROXY_ADDRESS = getAddress("0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7");
export const LIGHTER_MIN_GHOLA_API_KEY_INDEX = 2;
export const LIGHTER_MAX_API_KEY_INDEX = 254;
const LIGHTER_MAX_ACCOUNT_INDEX = 281_474_976_710_655;
const GOLDILOCKS_MODULUS = BigInt("0xffffffff00000001");

export const LIGHTER_CHANGE_PUB_KEY_ABI = [{
  type: "function",
  name: "changePubKey",
  stateMutability: "nonpayable",
  inputs: [
    { name: "accountIndex", type: "uint48" },
    { name: "apiKeyIndex", type: "uint8" },
    { name: "pubKey", type: "bytes" },
  ],
  outputs: [],
}] as const;

export interface LighterChangePubKeyIntent {
  chain_id: typeof LIGHTER_MAINNET_CHAIN_ID;
  from: `0x${string}`;
  to: typeof LIGHTER_MAINNET_PROXY_ADDRESS;
  value: "0x0";
  data: Hex;
  function: "changePubKey(uint48,uint8,bytes)";
  account_index: number;
  api_key_index: number;
  public_key: string;
  transaction_signed: false;
  transaction_broadcast: false;
  simulation_required_before_signing: true;
}

export interface LighterChangePubKeyTransactionPlan extends LighterChangePubKeyIntent {
  nonce: Hex;
  gas: Hex;
  max_fee_per_gas: Hex;
  max_priority_fee_per_gas: Hex;
  simulation: {
    performed: true;
    succeeded: true;
    chain_id_verified: true;
    exact_sender_verified: true;
    exact_contract_verified: true;
  };
}

export function buildLighterChangePubKeyIntent(input: {
  ownerAddress: string;
  accountIndex: number;
  apiKeyIndex: number;
  publicKey: string;
}): LighterChangePubKeyIntent {
  const owner = lighterOwnerAddress(input.ownerAddress);
  const accountIndex = lighterAccountIndex(input.accountIndex);
  const apiKeyIndex = lighterApiKeyIndex(input.apiKeyIndex);
  const publicKey = lighterPublicKey(input.publicKey);
  return {
    chain_id: LIGHTER_MAINNET_CHAIN_ID,
    from: owner,
    to: LIGHTER_MAINNET_PROXY_ADDRESS,
    value: "0x0",
    data: encodeFunctionData({
      abi: LIGHTER_CHANGE_PUB_KEY_ABI,
      functionName: "changePubKey",
      args: [accountIndex, apiKeyIndex, `0x${publicKey}`],
    }),
    function: "changePubKey(uint48,uint8,bytes)",
    account_index: accountIndex,
    api_key_index: apiKeyIndex,
    public_key: publicKey,
    transaction_signed: false,
    transaction_broadcast: false,
    simulation_required_before_signing: true,
  };
}

export function assertLighterOwnerAccount(input: {
  response: unknown;
  ownerAddress: string;
  accountIndex: number;
}) {
  const body = record(input.response);
  const owner = lighterOwnerAddress(input.ownerAddress);
  const accountIndex = lighterAccountIndex(input.accountIndex);
  const rows = Array.isArray(body.sub_accounts) ? body.sub_accounts.map(record) : [];
  if (
    Number(body.code) !== 200 ||
    string(body.l1_address).toLowerCase() !== owner ||
    !rows.some((row) => Number(row.index) === accountIndex && string(row.l1_address).toLowerCase() === owner)
  ) {
    throw new Error("The selected Lighter account is not owned by this Turnkey wallet.");
  }
  return { owner_address: owner, account_index: accountIndex };
}

export function selectLighterOwnerAccount(input: {
  response: unknown;
  ownerAddress: string;
  requestedAccountIndex?: number | null;
}) {
  const body = record(input.response);
  const owner = lighterOwnerAddress(input.ownerAddress);
  const rows = Array.isArray(body.sub_accounts) ? body.sub_accounts.map(record) : [];
  if (Number(body.code) !== 200 || string(body.l1_address).toLowerCase() !== owner) {
    throw new Error("Lighter accounts could not be verified for this Turnkey wallet.");
  }
  const owned = rows
    .filter((row) => string(row.l1_address).toLowerCase() === owner)
    .map((row) => ({
      account_index: lighterAccountIndex(Number(row.index)),
      account_type: Number(row.account_type),
    }))
    .sort((left, right) => left.account_index - right.account_index);
  if (owned.length === 0) throw new Error("This Turnkey wallet does not have a Lighter account yet.");
  if (input.requestedAccountIndex != null) {
    const requested = lighterAccountIndex(input.requestedAccountIndex);
    const match = owned.find((row) => row.account_index === requested);
    if (!match) throw new Error("The selected Lighter account is not owned by this Turnkey wallet.");
    return match;
  }
  return owned.find((row) => row.account_type === 0) ?? owned[0];
}

export function assertLighterApiSlotVacant(input: {
  response: unknown;
  accountIndex: number;
  apiKeyIndex: number;
}) {
  const body = record(input.response);
  const accountIndex = lighterAccountIndex(input.accountIndex);
  const apiKeyIndex = lighterApiKeyIndex(input.apiKeyIndex);
  if (Number(body.code) !== 200 || !Array.isArray(body.api_keys)) {
    throw new Error("Lighter API-key availability could not be verified.");
  }
  const occupied = body.api_keys.map(record).some((row) =>
    Number(row.account_index) === accountIndex &&
    Number(row.api_key_index) === apiKeyIndex &&
    /^[0-9a-f]{80}$/i.test(string(row.public_key)) &&
    !/^0{80}$/.test(string(row.public_key))
  );
  if (occupied) throw new Error("That Lighter API-key slot is already occupied.");
  return { account_index: accountIndex, api_key_index: apiKeyIndex };
}

export function selectLighterApiKeyIndex(input: {
  response: unknown;
  accountIndex: number;
  requestedApiKeyIndex?: number | null;
}) {
  const body = record(input.response);
  const accountIndex = lighterAccountIndex(input.accountIndex);
  if (Number(body.code) !== 200 || !Array.isArray(body.api_keys)) {
    throw new Error("Lighter API-key availability could not be verified.");
  }
  const occupied = new Set(body.api_keys.map(record)
    .filter((row) => Number(row.account_index) === accountIndex && /^[0-9a-f]{80}$/i.test(string(row.public_key)))
    .map((row) => Number(row.api_key_index)));
  if (input.requestedApiKeyIndex != null) {
    const requested = lighterApiKeyIndex(input.requestedApiKeyIndex);
    if (occupied.has(requested)) throw new Error("That Lighter API-key slot is already occupied.");
    return requested;
  }
  for (let index = LIGHTER_MIN_GHOLA_API_KEY_INDEX; index <= LIGHTER_MAX_API_KEY_INDEX; index += 1) {
    if (!occupied.has(index)) return index;
  }
  throw new Error("No available Lighter API-key slot remains.");
}

export function lighterOwnerAddress(value: string): `0x${string}` {
  try {
    return getAddress(value.trim()).toLowerCase() as `0x${string}`;
  } catch {
    throw new Error("Lighter owner address is invalid.");
  }
}

export function lighterAccountIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > LIGHTER_MAX_ACCOUNT_INDEX) {
    throw new Error("Lighter account index must be a uint48 integer.");
  }
  return value;
}

export function lighterApiKeyIndex(value: number): number {
  if (!Number.isInteger(value) || value < LIGHTER_MIN_GHOLA_API_KEY_INDEX || value > LIGHTER_MAX_API_KEY_INDEX) {
    throw new Error("Choose a Lighter API-key slot from 2 through 254.");
  }
  return value;
}

export function lighterPublicKey(value: string): string {
  const key = value.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{80}$/.test(key) || /^0{80}$/.test(key)) {
    throw new Error("Lighter public key must be a nonzero 40-byte value.");
  }
  const bytes = Uint8Array.from({ length: 40 }, (_, index) => Number.parseInt(key.slice(index * 2, index * 2 + 2), 16));
  for (let offset = 0; offset < bytes.length; offset += 8) {
    let limb = BigInt(0);
    for (let index = 7; index >= 0; index -= 1) {
      limb = (limb << BigInt(8)) | BigInt(bytes[offset + index]);
    }
    if (limb >= GOLDILOCKS_MODULUS) {
      throw new Error("Lighter public key is not canonical.");
    }
  }
  return key;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
