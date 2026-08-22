import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { privateKeyToAccount } from "viem/accounts";
import {
  hyperliquidApiWalletBindingMessage,
  type HyperliquidApiWalletBindingProof,
} from "./hyperliquid-agent-binding";

export interface HyperliquidApiWalletKeypair {
  address: string;
  privateKey: string;
}

export function hyperliquidApiWalletAddress(privateKey: Uint8Array): string {
  if (privateKey.length !== 32 || !secp256k1.utils.isValidPrivateKey(privateKey)) {
    throw new Error("Could not create a valid Hyperliquid API wallet.");
  }
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const addressBytes = keccak_256(publicKey.slice(1)).slice(-20);
  return `0x${bytesToHex(addressBytes)}`;
}

export function generateHyperliquidApiWallet(
  generatePrivateKey: () => Uint8Array = () => secp256k1.utils.randomPrivateKey(),
): HyperliquidApiWalletKeypair {
  const privateKey = generatePrivateKey();
  return {
    address: hyperliquidApiWalletAddress(privateKey),
    privateKey: `0x${bytesToHex(privateKey)}`,
  };
}

export function hyperliquidApiWalletAddressFromPrivateKey(privateKey: string): string {
  const normalized = privateKey.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Enter a valid Hyperliquid API wallet private key.");
  }
  return hyperliquidApiWalletAddress(hexToBytes(normalized.slice(2)));
}

export async function signHyperliquidApiWalletBinding(input: {
  privateKey: string;
  accountCommitment: string;
  network: "mainnet" | "testnet";
  ownerAddress: string;
}): Promise<HyperliquidApiWalletBindingProof> {
  const normalizedKey = input.privateKey.trim().toLowerCase();
  const agentAddress = hyperliquidApiWalletAddressFromPrivateKey(normalizedKey).toLowerCase();
  const account = privateKeyToAccount(normalizedKey as `0x${string}`);
  if (account.address.toLowerCase() !== agentAddress) {
    throw new Error("Hyperliquid API wallet address derivation failed.");
  }
  const signature = await account.signMessage({
    message: hyperliquidApiWalletBindingMessage({
      accountCommitment: input.accountCommitment,
      network: input.network,
      ownerAddress: input.ownerAddress,
      agentAddress,
    }),
  });
  return {
    version: 1,
    network: input.network,
    owner_address: input.ownerAddress.trim().toLowerCase(),
    agent_address: agentAddress,
    signature,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("Enter a valid Hyperliquid API wallet private key.");
  return Uint8Array.from(value.match(/.{2}/g) || [], (byte) => Number.parseInt(byte, 16));
}
