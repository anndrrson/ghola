// Shared browser Solana-wallet helpers for flows that seal or sign with the
// user's injected wallet. Extracted from TriVenueArbConsole so
// connect/seal components don't duplicate provider plumbing.

type SolanaConnectOptions = { onlyIfTrusted?: boolean };
type SolanaProviderEvent = "connect" | "accountChanged" | "disconnect";
type SolanaProviderListener = (value?: unknown) => void;

export type SolanaProvider = {
  connect?: (options?: SolanaConnectOptions) => Promise<{ publicKey?: unknown } | unknown>;
  disconnect?: () => Promise<unknown>;
  signMessage?: (
    message: Uint8Array,
    encoding?: string,
  ) => Promise<Uint8Array | { signature?: Uint8Array | number[]; publicKey?: unknown }>;
  signTransaction?: <T>(transaction: T) => Promise<T>;
  signAndSendTransaction?: <T>(transaction: T) => Promise<{ signature?: string } | string>;
  publicKey?: unknown;
  isConnected?: boolean;
  isPhantom?: boolean;
  on?: (event: SolanaProviderEvent, listener: SolanaProviderListener) => void;
};

type SolanaWindow = Window & {
  phantom?: { solana?: SolanaProvider };
  solana?: SolanaProvider;
};

type ProviderConnectionState = {
  wallet: string;
  disconnected: boolean;
  accountEventSeen: boolean;
};

const connectInFlight = new WeakMap<SolanaProvider, Promise<string>>();
const providerConnectionStates = new WeakMap<SolanaProvider, ProviderConnectionState>();

export function solanaProvider(): SolanaProvider | undefined {
  if (typeof window === "undefined") return undefined;
  const walletWindow = window as SolanaWindow;
  const canonical = walletWindow.phantom?.solana;
  if (canonical?.isPhantom === true) return trackedProvider(canonical);
  const legacy = walletWindow.solana;
  return legacy ? trackedProvider(legacy) : undefined;
}

export function requiredSolanaProvider(): SolanaProvider {
  const provider = solanaProvider();
  if (!provider?.signMessage) throw new Error("Wallet message signing is required.");
  return provider;
}

export async function connectSolanaWallet(): Promise<string> {
  const provider = solanaProvider();
  if (!provider?.connect) throw new Error("Open this page with a Solana wallet installed.");

  const pending = connectInFlight.get(provider);
  if (pending) return pending;
  const currentWallet = connectedProviderWallet(provider);
  if (currentWallet && provider.isPhantom !== true) return currentWallet;

  const promise = provider.isPhantom === true
    ? connectPhantomProvider(provider)
    : connectInjectedProvider(provider);
  connectInFlight.set(provider, promise);
  try {
    return await promise;
  } finally {
    if (connectInFlight.get(provider) === promise) connectInFlight.delete(provider);
  }
}

export async function walletSignBytes(
  provider: SolanaProvider,
  bytes: Uint8Array,
  expectedWallet?: string,
): Promise<Uint8Array> {
  if (!provider.signMessage) throw new Error("Wallet message signing is required.");
  if (expectedWallet) assertCurrentSolanaWallet(provider, expectedWallet);
  const signed = await provider.signMessage(bytes, "utf8");
  const signingWallet = publicKeyString((signed as { publicKey?: unknown } | undefined)?.publicKey);
  if (expectedWallet && signingWallet && signingWallet !== expectedWallet) {
    throw new Error(`${providerName(provider)} account changed. Reconnect the intended account and try again.`);
  }
  if (expectedWallet) assertCurrentSolanaWallet(provider, expectedWallet);
  if (signed instanceof Uint8Array) return signed;
  if (signed?.signature instanceof Uint8Array) return signed.signature;
  if (Array.isArray(signed?.signature)) return Uint8Array.from(signed.signature);
  throw new Error("Wallet did not return a message signature.");
}

function trackedProvider(provider: SolanaProvider): SolanaProvider {
  if (providerConnectionStates.has(provider)) return provider;
  const state: ProviderConnectionState = {
    wallet: provider.isConnected === true ? publicKeyString(provider.publicKey) : "",
    disconnected: provider.isConnected === false,
    accountEventSeen: false,
  };
  providerConnectionStates.set(provider, state);
  provider.on?.("connect", (publicKey) => {
    state.wallet = publicKeyString(publicKey) || publicKeyString(provider.publicKey);
    state.disconnected = false;
    state.accountEventSeen = false;
  });
  provider.on?.("accountChanged", (publicKey) => {
    state.wallet = publicKeyString(publicKey);
    state.disconnected = !state.wallet;
    state.accountEventSeen = true;
  });
  provider.on?.("disconnect", () => {
    state.wallet = "";
    state.disconnected = true;
    state.accountEventSeen = true;
  });
  return provider;
}

async function connectPhantomProvider(provider: SolanaProvider): Promise<string> {
  let staleSessionReset = false;
  try {
    return rememberConnectedWallet(provider, await provider.connect?.({ onlyIfTrusted: true }));
  } catch (error) {
    const code = providerErrorCode(error);
    if (code === -32603) {
      await resetStaleProviderSession(provider);
      staleSessionReset = true;
    } else if (code !== 4001 && code !== 4100) {
      throw usefulProviderError(error, provider);
    }
  }

  try {
    return rememberConnectedWallet(provider, await provider.connect?.());
  } catch (error) {
    if (providerErrorCode(error) !== -32603 || staleSessionReset) {
      throw usefulProviderError(error, provider);
    }
    await resetStaleProviderSession(provider);
    try {
      return rememberConnectedWallet(provider, await provider.connect?.());
    } catch (retryError) {
      throw usefulProviderError(retryError, provider);
    }
  }
}

async function connectInjectedProvider(provider: SolanaProvider): Promise<string> {
  try {
    return rememberConnectedWallet(provider, await provider.connect?.());
  } catch (error) {
    throw usefulProviderError(error, provider);
  }
}

async function resetStaleProviderSession(provider: SolanaProvider): Promise<void> {
  try {
    await provider.disconnect?.();
  } catch {
    // Phantom can reject disconnect when its stale session is already gone.
  }
  const state = providerConnectionStates.get(provider);
  if (state) {
    state.wallet = "";
    state.disconnected = true;
    state.accountEventSeen = true;
  }
  await Promise.resolve();
}

function rememberConnectedWallet(provider: SolanaProvider, connected: unknown): string {
  const responseWallet = publicKeyString((connected as { publicKey?: unknown } | undefined)?.publicKey);
  const wallet = responseWallet || publicKeyString(provider.publicKey);
  if (!wallet) throw new Error(`${providerName(provider)} did not return a Solana public key.`);
  const state = providerConnectionStates.get(provider);
  if (state) {
    state.wallet = wallet;
    state.disconnected = false;
    state.accountEventSeen = false;
  }
  return wallet;
}

function connectedProviderWallet(provider: SolanaProvider): string {
  if (provider.isConnected !== true) return "";
  const wallet = publicKeyString(provider.publicKey);
  if (!wallet) return "";
  const state = providerConnectionStates.get(provider);
  if (state) {
    state.wallet = wallet;
    state.disconnected = false;
    state.accountEventSeen = false;
  }
  return wallet;
}

function assertCurrentSolanaWallet(provider: SolanaProvider, expectedWallet: string): void {
  const state = providerConnectionStates.get(provider);
  if (provider.isConnected === false || state?.disconnected) {
    throw new Error(`${providerName(provider)} disconnected. Reconnect it and try again.`);
  }
  const currentWallet = state?.accountEventSeen
    ? state.wallet
    : publicKeyString(provider.publicKey) || state?.wallet || "";
  if (!currentWallet) throw new Error(`${providerName(provider)} disconnected. Reconnect it and try again.`);
  if (currentWallet !== expectedWallet) {
    throw new Error(`${providerName(provider)} account changed. Reconnect the intended account and try again.`);
  }
}

function providerErrorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number") return code;
  if (typeof code === "string" && /^-?\d+$/u.test(code)) return Number(code);
  return undefined;
}

function usefulProviderError(error: unknown, provider?: SolanaProvider): Error {
  const name = providerName(provider);
  switch (providerErrorCode(error)) {
    case 4001:
      return new Error(`${name} connection was cancelled.`);
    case 4100:
      return new Error(`${name} has not authorized this account. Reconnect it and try again.`);
    case 4900:
      return new Error(`${name} is disconnected from Solana. Reconnect it and try again.`);
    case -32002:
      return new Error(`A ${name} approval is already open. Finish or close it, then try again.`);
    case -32603:
      return new Error(`${name} could not refresh its connection. Unlock ${name}, switch to the intended account, reload this page, and try again.`);
    default:
      return error instanceof Error ? error : new Error(`${name} could not connect.`);
  }
}

function providerName(provider?: SolanaProvider): "Phantom" | "Wallet" {
  return provider?.isPhantom === true ? "Phantom" : "Wallet";
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
