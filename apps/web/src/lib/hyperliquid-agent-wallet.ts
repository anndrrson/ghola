import type { Address, Hex } from "viem";

export const HYPERLIQUID_SIGNATURE_CHAIN_ID = "0x66eee" as const;
export const HYPERLIQUID_SIGNATURE_CHAIN_ID_NUMBER = 421_614;
export const HYPERLIQUID_AGENT_PRIMARY_TYPE = "HyperliquidTransaction:ApproveAgent" as const;
export const HYPERLIQUID_AGENT_VALIDITY_MS = 24 * 60 * 60 * 1_000;
export const HYPERLIQUID_AGENT_MIN_REMAINING_MS = 5 * 60 * 1_000;
export const HYPERLIQUID_AGENT_ACTION_MAX_AGE_MS = 5 * 60 * 1_000;
export const HYPERLIQUID_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export const HYPERLIQUID_APPROVE_AGENT_TYPES = {
  [HYPERLIQUID_AGENT_PRIMARY_TYPE]: [
    { name: "hyperliquidChain", type: "string" },
    { name: "agentAddress", type: "address" },
    { name: "agentName", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export interface HyperliquidApproveAgentAction {
  type: "approveAgent";
  hyperliquidChain: "Mainnet";
  signatureChainId: typeof HYPERLIQUID_SIGNATURE_CHAIN_ID;
  agentAddress: Address;
  agentName: string;
  nonce: number;
}

export interface HyperliquidApproveAgentSignature {
  r: Hex;
  s: Hex;
  v: 27 | 28;
}

export interface HyperliquidEncryptedAgentVault {
  alg: "sealed-provider-v1";
  ciphertext: string;
  recipient: string;
  aad: string;
  encapsulated_key?: string | null;
}

export interface HyperliquidAgentAuthorizationRequest {
  version: 1;
  action: HyperliquidApproveAgentAction;
  signature: HyperliquidApproveAgentSignature;
  nonce: number;
  encrypted_execution_vault: HyperliquidEncryptedAgentVault;
}

export interface HyperliquidAgentRevocationRequest {
  version: 1;
  action: HyperliquidApproveAgentAction;
  signature: HyperliquidApproveAgentSignature;
  nonce: number;
}

export function hyperliquidAgentBaseName(accountCommitment: string): string {
  if (!accountCommitment.trim()) throw new Error("Private account commitment is invalid.");
  return "ghola-mainnet";
}

export function createHyperliquidApproveAgentAction(input: {
  accountCommitment: string;
  agentAddress: string;
  nowMs?: number;
}): HyperliquidApproveAgentAction {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("Hyperliquid authorization time is invalid.");
  }
  const agentAddress = normalizedEvmAddress(input.agentAddress);
  const validUntil = nowMs + HYPERLIQUID_AGENT_VALIDITY_MS;
  if (!Number.isSafeInteger(validUntil)) throw new Error("Hyperliquid authorization expiry is invalid.");
  return {
    type: "approveAgent",
    hyperliquidChain: "Mainnet",
    signatureChainId: HYPERLIQUID_SIGNATURE_CHAIN_ID,
    agentAddress,
    agentName: `${hyperliquidAgentBaseName(input.accountCommitment)} valid_until ${validUntil}`,
    nonce: nowMs,
  };
}

export function hyperliquidApproveAgentTypedData(action: HyperliquidApproveAgentAction) {
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: HYPERLIQUID_SIGNATURE_CHAIN_ID_NUMBER,
      verifyingContract: HYPERLIQUID_ZERO_ADDRESS,
    },
    types: HYPERLIQUID_APPROVE_AGENT_TYPES,
    primaryType: HYPERLIQUID_AGENT_PRIMARY_TYPE,
    message: { ...action, nonce: BigInt(action.nonce) },
  } as const;
}

export function hyperliquidApproveAgentProviderPayload(action: HyperliquidApproveAgentAction) {
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: HYPERLIQUID_SIGNATURE_CHAIN_ID_NUMBER,
      verifyingContract: HYPERLIQUID_ZERO_ADDRESS,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...HYPERLIQUID_APPROVE_AGENT_TYPES,
    },
    primaryType: HYPERLIQUID_AGENT_PRIMARY_TYPE,
    message: action,
  } as const;
}

export function parseHyperliquidAgentName(input: string, accountCommitment: string): {
  base_name: string;
  valid_until_ms: number;
} | null {
  const expectedBase = hyperliquidAgentBaseName(accountCommitment);
  const match = input.match(/^([a-z0-9-]{1,16}) valid_until ([0-9]{13})$/);
  if (!match || match[1] !== expectedBase) return null;
  const validUntil = Number(match[2]);
  if (!Number.isSafeInteger(validUntil)) return null;
  return { base_name: expectedBase, valid_until_ms: validUntil };
}

export function parseHyperliquidEvmSignature(value: unknown): HyperliquidApproveAgentSignature {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value)) {
    throw new Error("Phantom returned an invalid Hyperliquid signature.");
  }
  const recovery = Number.parseInt(value.slice(130), 16);
  const v = recovery === 0 || recovery === 1 ? recovery + 27 : recovery;
  if (v !== 27 && v !== 28) throw new Error("Phantom returned an invalid recovery value.");
  return {
    r: `0x${value.slice(2, 66).toLowerCase()}`,
    s: `0x${value.slice(66, 130).toLowerCase()}`,
    v,
  };
}

export function signatureHex(value: HyperliquidApproveAgentSignature): Hex {
  const recovery = value.v - 27;
  return `${value.r}${value.s.slice(2)}${recovery.toString(16).padStart(2, "0")}` as Hex;
}

export function normalizedEvmAddress(value: string): Address {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error("Phantom did not return one valid EVM account.");
  return normalized as Address;
}
