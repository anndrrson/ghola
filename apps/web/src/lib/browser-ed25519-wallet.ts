import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

export interface BrowserEd25519Wallet {
  walletAddress: string;
  secretKeyHex: string;
  walletId: string;
  subOrgId: string;
}

const SECRET_KEY_BYTES = 32;

export function createBrowserEd25519Wallet(label = "ghola-browser"): BrowserEd25519Wallet {
  const secret = ed25519.utils.randomPrivateKey();
  return browserWalletFromSecret(secret, label);
}

export function browserWalletFromSecret(secret: Uint8Array, label = "ghola-browser"): BrowserEd25519Wallet {
  if (secret.length !== SECRET_KEY_BYTES) {
    throw new Error(`browser Ed25519 secret must be ${SECRET_KEY_BYTES} bytes`);
  }
  const publicKey = ed25519.getPublicKey(secret);
  const walletAddress = bs58.encode(publicKey);
  const fingerprint = walletAddress.slice(0, 12);
  return {
    walletAddress,
    secretKeyHex: bytesToHex(secret),
    walletId: `${label}-wallet-${fingerprint}`,
    subOrgId: `${label}-org-${fingerprint}`,
  };
}

export function signBrowserEd25519Bytes(secretKeyHex: string, bytes: Uint8Array): Uint8Array {
  const secret = hexToBytes(secretKeyHex);
  if (secret.length !== SECRET_KEY_BYTES) {
    throw new Error("browser Ed25519 secret is invalid");
  }
  return ed25519.sign(bytes, secret);
}

export function isBrowserEd25519SecretKeyHex(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
