// Shared browser Solana-wallet helpers for flows that seal or sign with the
// user's injected wallet. Extracted from TriVenueArbConsole so
// connect/seal components don't duplicate provider plumbing.

import { ed25519 } from "@noble/curves/ed25519";
import type {
  SolanaSignInInput,
  SolanaSignInOutput,
} from "@solana/wallet-standard-features";
import { parseSignInMessage, verifySignIn } from "@solana/wallet-standard-util";
import bs58 from "bs58";

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

type StandardWalletAccount = {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: readonly string[];
  readonly features: readonly string[];
};

type StandardWallet = {
  readonly version: string;
  readonly name: string;
  readonly accounts: readonly StandardWalletAccount[];
  readonly chains: readonly string[];
  readonly features: Record<string, unknown>;
};

type StandardWalletRegistry = {
  readonly get: () => readonly unknown[];
  readonly on: (
    event: "unregister",
    listener: (...wallets: readonly unknown[]) => void,
  ) => () => void;
};

type StandardConnectFeature = {
  readonly version: string;
  readonly connect: (input?: { readonly silent?: boolean }) => Promise<{
    readonly accounts: readonly StandardWalletAccount[];
  }>;
};

type StandardEventsFeature = {
  readonly version: string;
  readonly on: (
    event: "change",
    listener: (properties: { readonly accounts?: readonly StandardWalletAccount[] }) => void,
  ) => () => void;
};

type StandardSignInFeature = {
  readonly version: "1.0.0";
  readonly signIn: (...inputs: readonly SolanaSignInInput[]) => Promise<readonly SolanaSignInOutput[]>;
};

const connectInFlight = new WeakMap<SolanaProvider, Promise<string>>();
const providerConnectionStates = new WeakMap<SolanaProvider, ProviderConnectionState>();
const PHANTOM_RECOVERY_ATTEMPTS = 5;
const PHANTOM_RECOVERY_DELAY_MS = 75;
const PHANTOM_STANDARD_RECOVERY_ATTEMPTS = 10;
const PHANTOM_STANDARD_RECOVERY_DELAY_MS = 50;
const PHANTOM_SIGN_IN_TTL_MS = 2 * 60_000;
const PHANTOM_SIGN_IN_STATEMENT = "This sign-in message alone cannot move funds or place trades.";

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
  if (currentWallet) return currentWallet;

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
    disconnected: false,
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
  try {
    return rememberDirectConnectedWallet(provider, await provider.connect?.({ onlyIfTrusted: true }));
  } catch (error) {
    const code = providerErrorCode(error);
    if (code === -32603) {
      const recovered = await recoverConnectedPhantomWallet(provider);
      if (recovered) return recovered;
    } else if (code !== 4001 && code !== 4100) {
      throw usefulProviderError(error, provider);
    }
  }

  try {
    return rememberDirectConnectedWallet(provider, await provider.connect?.());
  } catch (error) {
    if (providerErrorCode(error) === -32603) {
      const recovered = await recoverConnectedPhantomWallet(provider);
      if (recovered) return recovered;
      const standardWallet = await connectPhantomStandardWallet(provider);
      if (standardWallet) return standardWallet;
    }
    throw usefulProviderError(error, provider);
  }
}

function rememberDirectConnectedWallet(provider: SolanaProvider, connected: unknown): string {
  return rememberConnectedWallet(provider, connected);
}

async function connectInjectedProvider(provider: SolanaProvider): Promise<string> {
  try {
    return rememberConnectedWallet(provider, await provider.connect?.());
  } catch (error) {
    throw usefulProviderError(error, provider);
  }
}

function rememberConnectedWallet(provider: SolanaProvider, connected: unknown): string {
  const responseWallet = publicKeyString((connected as { publicKey?: unknown } | undefined)?.publicKey);
  const providerWallet = publicKeyString(provider.publicKey);
  const wallet = responseWallet || providerWallet;
  if (!wallet) throw new Error(`${providerName(provider)} did not return a Solana public key.`);
  const state = providerConnectionStates.get(provider);
  if (provider.isPhantom === true) {
    if (!validSolanaPublicKey(wallet)) {
      throw new Error("Phantom did not return a valid Solana public key.");
    }
    if (state?.disconnected) {
      throw new Error("Phantom disconnected. Reconnect it and try again.");
    }
    if ((providerWallet && providerWallet !== wallet) || (state?.accountEventSeen && state.wallet !== wallet)) {
      throw new Error("Phantom account changed. Reconnect the intended account and try again.");
    }
  }
  if (state) {
    state.wallet = wallet;
    state.disconnected = false;
    state.accountEventSeen = false;
  }
  return wallet;
}

function connectedProviderWallet(provider: SolanaProvider): string {
  if (provider.isPhantom === true && !isCanonicalPhantomProvider(provider)) return "";
  const state = providerConnectionStates.get(provider);
  if (provider.isConnected !== true || state?.disconnected) return "";
  const wallet = publicKeyString(provider.publicKey);
  if (!validSolanaPublicKey(wallet)) return "";
  if (state?.accountEventSeen && state.wallet !== wallet) return "";
  if (state) {
    state.wallet = wallet;
    state.disconnected = false;
  }
  return wallet;
}

async function recoverConnectedPhantomWallet(provider: SolanaProvider): Promise<string> {
  let candidate = "";
  for (let attempt = 0; attempt < PHANTOM_RECOVERY_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, PHANTOM_RECOVERY_DELAY_MS));
    if (!isCanonicalPhantomProvider(provider)) {
      candidate = "";
      continue;
    }
    const wallet = connectedProviderWallet(provider);
    if (wallet && wallet === candidate) return wallet;
    candidate = wallet;
  }
  return "";
}

async function connectPhantomStandardWallet(injectedProvider: SolanaProvider): Promise<string> {
  if (!isCanonicalPhantomProvider(injectedProvider) || typeof injectedProvider.signMessage !== "function") return "";
  const { getWallets } = await import("@wallet-standard/app");
  const registry = getWallets() as unknown as StandardWalletRegistry;
  let selectedWallet: StandardWallet | undefined;
  let off: () => void = () => undefined;
  let eventAccount: StandardWalletAccount | undefined;
  let accountEventCount = 0;
  let eventPoisoned = false;
  let registryPoisoned = false;
  let eventsOn: StandardEventsFeature["on"] | undefined;
  let signIn: StandardSignInFeature["signIn"] | undefined;

  try {
    for (let attempt = 0; attempt < PHANTOM_STANDARD_RECOVERY_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, PHANTOM_STANDARD_RECOVERY_DELAY_MS));
      const injectedState = coherentCanonicalProviderWallet(injectedProvider);
      if (!injectedState.coherent) return "";

      const namedWallets = (registry.get() as readonly unknown[]).filter(isNamedPhantomStandardWallet);
      if (namedWallets.length > 1) return "";
      const candidate = namedWallets[0];
      if (!candidate) {
        if (selectedWallet) return "";
        continue;
      }
      if (!isUsablePhantomStandardWallet(candidate) || !isBoundPhantomStandardWallet(candidate, injectedProvider)) {
        return "";
      }
      const wallet = candidate;

      if (selectedWallet && wallet !== selectedWallet) return "";

      if (wallet !== selectedWallet) {
        safeOff(off);
        selectedWallet = wallet;
        eventAccount = undefined;
        accountEventCount = 0;
        eventPoisoned = false;
        registryPoisoned = false;
        if (wallet.accounts.length !== 0) return "";
        const events = standardEventsFeature(wallet);
        const signInFeature = standardSignInFeature(wallet);
        eventsOn = events.on;
        signIn = signInFeature.signIn;
        const accountOff = events.on("change", (properties) => {
          if (properties.accounts === undefined) return;
          accountEventCount += 1;
          const account = singleCoherentStandardAccount(properties.accounts);
          if (!account || accountEventCount !== 1) {
            eventPoisoned = true;
            return;
          }
          eventAccount = account;
        });
        if (typeof accountOff !== "function") return "";
        let registryOff: (() => void) | undefined;
        try {
          registryOff = registry.on("unregister", (...wallets) => {
            if (!wallets.includes(wallet)) return;
            registryPoisoned = true;
          });
        } catch {
          safeOff(accountOff);
          return "";
        }
        if (typeof registryOff !== "function") {
          safeOff(accountOff);
          return "";
        }
        off = combinedOff(accountOff, registryOff);
      }
      if (eventPoisoned || registryPoisoned) return "";
      if (injectedState.wallet || wallet.accounts.length !== 0 || eventAccount || accountEventCount !== 0) return "";
      if (!eventsOn || !signIn) return "";
      if (!standardWalletRegistrationIsStable(registry, wallet, injectedProvider, eventsOn, signIn)) return "";

      const input = phantomStandardSignInInput();
      let outputs: readonly SolanaSignInOutput[];
      try {
        outputs = await signIn(input);
      } catch (error) {
        throw usefulProviderError(error, injectedProvider);
      }
      if (!Array.isArray(outputs) || outputs.length !== 1) return "";
      const output = outputs[0];
      if (!output || eventPoisoned || registryPoisoned || !exactlyOne(accountEventCount)) return "";
      const account = verifiedPhantomStandardSignIn(input, output);
      if (!account || eventAccount !== output.account || account !== output.account) return "";
      const currentAccounts = wallet.accounts;
      if (currentAccounts.length !== 1 || currentAccounts[0] !== output.account) return "";
      if (!standardWalletRegistrationIsStable(registry, wallet, injectedProvider, eventsOn, signIn)) return "";
      if (window.location.host !== input.domain || window.location.origin !== input.uri) return "";
      if (connectedProviderWallet(injectedProvider) !== account.address) return "";
      const finalState = coherentCanonicalProviderWallet(injectedProvider);
      if (!finalState.coherent || finalState.wallet !== account.address) return "";
      return account.address;
    }
    return "";
  } finally {
    safeOff(off);
  }
}

function phantomStandardSignInInput(nowMs = Date.now()): SolanaSignInInput {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const issuedAt = new Date(nowMs).toISOString();
  return {
    domain: window.location.host,
    statement: PHANTOM_SIGN_IN_STATEMENT,
    uri: window.location.origin,
    version: "1",
    chainId: "mainnet",
    nonce,
    issuedAt,
    notBefore: issuedAt,
    expirationTime: new Date(nowMs + PHANTOM_SIGN_IN_TTL_MS).toISOString(),
  };
}

function verifiedPhantomStandardSignIn(
  input: SolanaSignInInput,
  output: SolanaSignInOutput,
  nowMs = Date.now(),
): StandardWalletAccount | undefined {
  const account = singleCoherentStandardAccount([output.account as StandardWalletAccount]);
  const publicKey = account ? byteArrayCopy(account.publicKey) : undefined;
  const signedMessage = byteArrayCopy(output.signedMessage);
  const signature = byteArrayCopy(output.signature);
  if (
    !account
    || !account.features.includes("solana:signIn")
    || !publicKey
    || !signedMessage
    || !signature
    || signature.length !== 64
    || (output.signatureType !== undefined && output.signatureType !== "ed25519")
  ) return undefined;

  try {
    const parsed = parseSignInMessage(signedMessage);
    const issuedAtMs = Date.parse(input.issuedAt ?? "");
    const notBeforeMs = Date.parse(input.notBefore ?? "");
    const expirationTimeMs = Date.parse(input.expirationTime ?? "");
    const normalizedOutput = {
      ...output,
      account: { ...output.account, publicKey },
      signedMessage,
      signature,
    } as SolanaSignInOutput;
    if (
      !parsed
      || parsed.domain !== input.domain
      || parsed.address !== account.address
      || parsed.statement !== input.statement
      || parsed.uri !== input.uri
      || parsed.version !== input.version
      || parsed.chainId !== input.chainId
      || parsed.nonce !== input.nonce
      || parsed.issuedAt !== input.issuedAt
      || parsed.notBefore !== input.notBefore
      || parsed.expirationTime !== input.expirationTime
      || parsed.requestId !== undefined
      || parsed.resources !== undefined
      || !verifySignIn(input, normalizedOutput)
      || !ed25519.verify(signature, signedMessage, publicKey)
      || !Number.isFinite(issuedAtMs)
      || !Number.isFinite(notBeforeMs)
      || !Number.isFinite(expirationTimeMs)
      || notBeforeMs !== issuedAtMs
      || expirationTimeMs - issuedAtMs !== PHANTOM_SIGN_IN_TTL_MS
      || nowMs < notBeforeMs
      || nowMs > expirationTimeMs
    ) return undefined;
  } catch {
    return undefined;
  }
  return account;
}

function standardWalletRegistrationIsStable(
  registry: StandardWalletRegistry,
  wallet: StandardWallet,
  injectedProvider: SolanaProvider,
  eventsOn: StandardEventsFeature["on"],
  signIn: StandardSignInFeature["signIn"],
): boolean {
  try {
    const registered = registry.get().filter(isNamedPhantomStandardWallet);
    return registered.length === 1
      && registered[0] === wallet
      && isUsablePhantomStandardWallet(wallet)
      && isBoundPhantomStandardWallet(wallet, injectedProvider)
      && standardEventsFeature(wallet).on === eventsOn
      && standardSignInFeature(wallet).signIn === signIn;
  } catch {
    return false;
  }
}

function coherentCanonicalProviderWallet(provider: SolanaProvider): { coherent: boolean; wallet: string } {
  if (!isCanonicalPhantomProvider(provider)) return { coherent: false, wallet: "" };
  const state = providerConnectionStates.get(provider);
  if (state?.disconnected) return { coherent: false, wallet: "" };
  const providerWallet = publicKeyString(provider.publicKey);
  if (providerWallet && !validSolanaPublicKey(providerWallet)) return { coherent: false, wallet: "" };
  if (state?.accountEventSeen) {
    if (!validSolanaPublicKey(state.wallet)) return { coherent: false, wallet: "" };
    if (providerWallet && providerWallet !== state.wallet) return { coherent: false, wallet: "" };
    return { coherent: true, wallet: state.wallet };
  }
  if (state?.wallet) {
    if (!validSolanaPublicKey(state.wallet)) return { coherent: false, wallet: "" };
    if (providerWallet && providerWallet !== state.wallet) return { coherent: false, wallet: "" };
    return { coherent: true, wallet: state.wallet };
  }
  return { coherent: true, wallet: providerWallet };
}

function isNamedPhantomStandardWallet(value: unknown): value is { readonly name: "Phantom" } {
  return !!value && typeof value === "object" && (value as { readonly name?: unknown }).name === "Phantom";
}

function isUsablePhantomStandardWallet(value: unknown): value is StandardWallet {
  if (!value || typeof value !== "object") return false;
  const wallet = value as Partial<StandardWallet>;
  if (
    wallet.version !== "1.0.0"
    || wallet.name !== "Phantom"
    || !Array.isArray(wallet.accounts)
    || !Array.isArray(wallet.chains)
    || !wallet.chains.includes("solana:mainnet")
    || !wallet.features
  ) return false;
  const connect = wallet.features["standard:connect"] as Partial<StandardConnectFeature> | undefined;
  const events = wallet.features["standard:events"] as Partial<StandardEventsFeature> | undefined;
  const signIn = wallet.features["solana:signIn"] as Partial<StandardSignInFeature> | undefined;
  return connect?.version === "1.0.0"
    && typeof connect.connect === "function"
    && events?.version === "1.0.0"
    && typeof events.on === "function"
    && signIn?.version === "1.0.0"
    && typeof signIn.signIn === "function";
}

function isBoundPhantomStandardWallet(wallet: StandardWallet, provider: SolanaProvider): boolean {
  const phantom = wallet.features["phantom:"] as { readonly phantom?: unknown } | undefined;
  return phantom?.phantom === provider;
}

function standardEventsFeature(wallet: StandardWallet): StandardEventsFeature {
  return wallet.features["standard:events"] as StandardEventsFeature;
}

function standardSignInFeature(wallet: StandardWallet): StandardSignInFeature {
  return wallet.features["solana:signIn"] as StandardSignInFeature;
}

function singleCoherentStandardAccount(
  accounts: readonly StandardWalletAccount[],
): StandardWalletAccount | undefined {
  if (accounts.length !== 1) return undefined;
  const account = accounts[0];
  if (
    !account
    || !validSolanaPublicKey(account.address)
    || byteArrayCopy(account.publicKey)?.length !== 32
    || !account.chains.includes("solana:mainnet")
    || !account.features.includes("solana:signMessage")
  ) return undefined;
  const publicKey = byteArrayCopy(account.publicKey);
  return publicKey && bytesEqual(bs58.decode(account.address), publicKey) ? account : undefined;
}

function byteArrayCopy(value: unknown): Uint8Array | undefined {
  try {
    if (
      !ArrayBuffer.isView(value)
      || Object.prototype.toString.call(value) !== "[object Uint8Array]"
      || (value as Uint8Array).BYTES_PER_ELEMENT !== 1
    ) return undefined;
    return Uint8Array.from(value as Uint8Array);
  } catch {
    return undefined;
  }
}

function exactlyOne(value: number): boolean {
  return value === 1;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeOff(off: () => void): void {
  try {
    off();
  } catch {
    // A wallet listener must never prevent local session cleanup.
  }
}

function combinedOff(...listeners: readonly (() => void)[]): () => void {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const off of listeners) safeOff(off);
  };
}

function isCanonicalPhantomProvider(provider: SolanaProvider): boolean {
  if (typeof window === "undefined") return false;
  const canonical = (window as SolanaWindow).phantom?.solana;
  return canonical === provider && canonical?.isPhantom === true;
}

function validSolanaPublicKey(value: string): boolean {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
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
