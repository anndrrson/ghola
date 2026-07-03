// Shared browser Solana-wallet helpers for flows that seal or sign with the
// user's injected wallet (window.solana). Extracted from TriVenueArbConsole so
// connect/seal components don't duplicate provider plumbing.

export type SolanaProvider = {
  connect?: () => Promise<{ publicKey?: unknown } | unknown>;
  signMessage?: (
    message: Uint8Array,
    encoding?: string,
  ) => Promise<Uint8Array | { signature?: Uint8Array | number[]; publicKey?: unknown }>;
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
