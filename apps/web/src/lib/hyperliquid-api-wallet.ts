import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

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
  const normalized = privateKey.trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(normalized)) {
    throw new Error("Hyperliquid API wallet key must be 32 bytes.");
  }
  return hyperliquidApiWalletAddress(
    Uint8Array.from(normalized.match(/.{2}/g) || [], (pair) => Number.parseInt(pair, 16)),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
