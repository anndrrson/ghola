// Shared browser Solana-wallet helpers for flows that seal or sign with the
// user's injected wallet (window.solana). Extracted from TriVenueArbConsole so
// connect/seal components don't duplicate provider plumbing.

export type SolanaProvider = {
  connect?: () => Promise<{ publicKey?: unknown } | unknown>;
  signMessage?: (
    message: Uint8Array,
    encoding?: string,
  ) => Promise<Uint8Array | { signature?: Uint8Array | number[]; publicKey?: unknown }>;
  signTransaction?: <T>(transaction: T) => Promise<T>;
  signAndSendTransaction?: <T>(transaction: T) => Promise<{ signature?: string } | string>;
  publicKey?: unknown;
};

type SolanaWindow = Window & {
  solana?: SolanaProvider;
};

export function solanaProvider(): SolanaProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as SolanaWindow).solana;
}

export function requiredSolanaProvider(): SolanaProvider {
  const provider = solanaProvider();
  if (!provider?.signMessage) throw new Error("Wallet message signing is required.");
  return provider;
}

export async function connectSolanaWallet(): Promise<string> {
  const provider = solanaProvider();
  if (!provider?.connect) throw new Error("Open this page with a Solana wallet installed.");
  const connected = await provider.connect();
  const pubkey = publicKeyString((connected as { publicKey?: unknown })?.publicKey || provider.publicKey);
  if (!pubkey) throw new Error("No Solana public key was returned.");
  return pubkey;
}

export async function walletSignBytes(provider: SolanaProvider, bytes: Uint8Array): Promise<Uint8Array> {
  if (!provider.signMessage) throw new Error("Wallet message signing is required.");
  const signed = await provider.signMessage(bytes, "utf8");
  if (signed instanceof Uint8Array) return signed;
  if (signed?.signature instanceof Uint8Array) return signed.signature;
  if (Array.isArray(signed?.signature)) return Uint8Array.from(signed.signature);
  throw new Error("Wallet did not return a message signature.");
}

export function publicKeyString(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof (value as { toBase58?: unknown }).toBase58 === "function") {
    return String((value as { toBase58: () => string }).toBase58());
  }
  if (typeof (value as { toString?: unknown }).toString === "function") return String(value);
  return "";
}

export interface PrivateAccountMobileProofHeadersInput {
  method?: "POST" | "DELETE";
  path: string;
  body: unknown;
  wallet: string;
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  nowMs?: number;
  nonce?: string;
}

export async function privateAccountMobileProofHeaders(
  input: PrivateAccountMobileProofHeadersInput,
): Promise<Record<string, string>> {
  const wallet = input.wallet.trim();
  if (!wallet) throw new Error("Wallet public key is required.");
  if (!input.path.startsWith("/") || input.path.startsWith("//")) {
    throw new Error("Private-account proof path is invalid.");
  }
  const timestamp = String(input.nowMs ?? Date.now());
  const nonce = input.nonce ?? crypto.randomUUID();
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(nonce)) {
    throw new Error("Private-account proof nonce is invalid.");
  }
  const bodyHash = await sha256Hex(stableJson(input.body));
  const method = input.method ?? "POST";
  const message = [
    "ghola_mobile_live_proof_v1",
    `method:${method}`,
    `path:${input.path}`,
    `timestamp_ms:${timestamp}`,
    `nonce:${nonce}`,
    `body_sha256:${bodyHash}`,
    `wallet:${wallet}`,
    "purpose:private_account_autopilot",
  ].join("\n");
  const signature = await input.signBytes(new TextEncoder().encode(message));
  if (signature.length !== 64) throw new Error("Wallet did not return an Ed25519 signature.");
  return {
    "x-ghola-mobile-proof-version": "1",
    "x-ghola-mobile-wallet": wallet,
    "x-ghola-mobile-proof-timestamp": timestamp,
    "x-ghola-mobile-proof-nonce": nonce,
    "x-ghola-mobile-proof-signature-b64": bytesToBase64(signature),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
