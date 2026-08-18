import { ed25519 } from "@noble/curves/ed25519";
import type { SolanaSignInInput, SolanaSignInOutput } from "@solana/wallet-standard-features";
import { createSignInMessage } from "@solana/wallet-standard-util";
import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";

const standardRegistry = vi.hoisted(() => ({
  wallets: [] as unknown[],
  unregisterListeners: new Set<(...wallets: unknown[]) => void>(),
}));

vi.mock("@wallet-standard/app", () => ({
  getWallets: () => ({
    get: () => standardRegistry.wallets,
    on: (event: string, listener: (...wallets: unknown[]) => void) => {
      if (event === "unregister") standardRegistry.unregisterListeners.add(listener);
      return () => standardRegistry.unregisterListeners.delete(listener);
    },
  }),
}));

function unregisterStandardWallet(wallet: unknown) {
  standardRegistry.wallets = standardRegistry.wallets.filter((candidate) => candidate !== wallet);
  for (const listener of standardRegistry.unregisterListeners) listener(wallet);
}

type TestProvider = {
  isPhantom?: boolean;
  isConnected?: boolean;
  publicKey?: unknown;
  connect?: ReturnType<typeof vi.fn>;
  disconnect?: ReturnType<typeof vi.fn>;
  signMessage?: ReturnType<typeof vi.fn>;
  on?: ReturnType<typeof vi.fn>;
};

type TestSignIn = (...inputs: readonly SolanaSignInInput[]) => Promise<readonly SolanaSignInOutput[]>;

function installProviders(phantom?: TestProvider, legacy?: TestProvider) {
  Object.defineProperty(window, "phantom", {
    configurable: true,
    value: phantom ? { solana: phantom } : undefined,
  });
  Object.defineProperty(window, "solana", {
    configurable: true,
    value: legacy,
  });
}

function publicKey(value: string) {
  return { toBase58: () => value };
}

const VALID_WALLET = bs58.encode(new Uint8Array(32));
const VALID_WALLET_A = bs58.encode(new Uint8Array(32).fill(1));
const VALID_WALLET_B = bs58.encode(new Uint8Array(32).fill(2));

function standardPhantom(
  provider: TestProvider,
  secretKey = new Uint8Array(32).fill(7),
  options: { connected?: boolean } = {},
) {
  const account = {
    address: bs58.encode(ed25519.getPublicKey(secretKey)),
    publicKey: ed25519.getPublicKey(secretKey),
    chains: ["solana:mainnet"] as const,
    features: ["solana:signMessage", "solana:signIn"] as const,
  };
  let accounts = options.connected === false ? [] : [account];
  const listeners = new Set<(properties: { accounts?: typeof accounts }) => void>();
  const unsubscribes: ReturnType<typeof vi.fn>[] = [];
  const connect = vi.fn();
  const signMessage = vi.fn(async ({ message }: { message: Uint8Array }) => [{
    signedMessage: message,
    signature: ed25519.sign(message, secretKey),
    signatureType: "ed25519" as const,
  }]);
  const signIn = vi.fn(async (...inputs: readonly SolanaSignInInput[]): Promise<readonly SolanaSignInOutput[]> => {
    const outputs = inputs.map((input) => {
      const signedMessage = createSignInMessage({
        ...input,
        domain: input.domain ?? window.location.host,
        address: account.address,
      });
      return {
        account,
        signedMessage,
        signature: ed25519.sign(signedMessage, secretKey),
        signatureType: "ed25519" as const,
      };
    });
    provider.isConnected = true;
    provider.publicKey = publicKey(account.address);
    accounts = [account];
    for (const listener of listeners) listener({ accounts });
    return outputs;
  });
  const wallet = {
    version: "1.0.0",
    name: "Phantom",
    chains: ["solana:mainnet"],
    get accounts() {
      return accounts;
    },
    features: {
      "phantom:": { version: "1.0.0", phantom: provider },
      "standard:connect": { version: "1.0.0", connect },
      "standard:events": {
        version: "1.0.0",
        on: vi.fn((_event: "change", listener: (properties: { accounts?: typeof accounts }) => void) => {
          listeners.add(listener);
          const unsubscribe = vi.fn(() => listeners.delete(listener));
          unsubscribes.push(unsubscribe);
          return unsubscribe;
        }),
      },
      "solana:signMessage": { version: "1.0.0", signMessage },
      "solana:signIn": { version: "1.0.0", signIn },
    },
  };
  return {
    account,
    connect,
    signIn,
    signMessage,
    unsubscribes,
    wallet,
    change(nextAccounts: typeof accounts) {
      accounts = nextAccounts;
      for (const listener of listeners) listener({ accounts });
    },
  };
}

afterEach(() => {
  Reflect.deleteProperty(window, "phantom");
  Reflect.deleteProperty(window, "solana");
  standardRegistry.wallets = [];
  standardRegistry.unregisterListeners.clear();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("Phantom provider connection", () => {
  it("prefers the canonical verified Phantom provider", async () => {
    const canonical = { isPhantom: true };
    const legacy = { isPhantom: true };
    installProviders(canonical, legacy);
    const { solanaProvider } = await import("./wallet-request-proof");

    expect(solanaProvider()).toBe(canonical);
  });

  it("preserves a legacy injected-wallet fallback", async () => {
    const legacy = {};
    installProviders({}, legacy);
    const { solanaProvider } = await import("./wallet-request-proof");

    expect(solanaProvider()).toBe(legacy);
  });

  it("does not apply Phantom recovery to another injected wallet", async () => {
    const connect = vi.fn().mockResolvedValue({ publicKey: publicKey("wallet-a") });
    const disconnect = vi.fn();
    installProviders(undefined, { connect, disconnect });
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).resolves.toBe("wallet-a");
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("preserves an existing generic-wallet connection without another request", async () => {
    const connect = vi.fn();
    installProviders(undefined, {
      isConnected: true,
      publicKey: publicKey(VALID_WALLET),
      connect,
    });
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).resolves.toBe(VALID_WALLET);
    expect(connect).not.toHaveBeenCalled();
  });

  it("reuses a valid existing Phantom connection without refreshing it", async () => {
    const connect = vi.fn();
    const disconnect = vi.fn();
    installProviders({
      isPhantom: true,
      isConnected: true,
      publicKey: publicKey(VALID_WALLET),
      connect,
      disconnect,
    });
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).resolves.toBe(VALID_WALLET);
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("does not reuse a legacy provider merely claiming to be Phantom", async () => {
    const connect = vi.fn().mockResolvedValue({ publicKey: publicKey(VALID_WALLET) });
    installProviders(undefined, {
      isPhantom: true,
      isConnected: true,
      publicKey: publicKey(VALID_WALLET),
      connect,
    });
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).resolves.toBe(VALID_WALLET);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({ onlyIfTrusted: true });
  });

  it("does not reuse an invalid connected Phantom public-key string", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: true,
      publicKey: publicKey("not-a-solana-public-key"),
    };
    const connect = vi.fn(async () => {
      provider.publicKey = publicKey(VALID_WALLET);
      return { publicKey: provider.publicKey };
    });
    provider.connect = connect;
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).resolves.toBe(VALID_WALLET);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({ onlyIfTrusted: true });
  });

  it("does not reuse Phantom after a disconnect event even if its public flag is stale", async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: true,
      publicKey: publicKey(VALID_WALLET_A),
      on: vi.fn((event: string, listener: (value?: unknown) => void) => listeners.set(event, listener)),
    };
    const connect = vi.fn(async () => {
      listeners.get("connect")?.(provider.publicKey);
      return { publicKey: provider.publicKey };
    });
    provider.connect = connect;
    installProviders(provider);
    const { connectSolanaWallet, solanaProvider } = await import("./wallet-request-proof");
    solanaProvider();
    listeners.get("disconnect")?.();

    await expect(connectSolanaWallet()).resolves.toBe(VALID_WALLET_A);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({ onlyIfTrusted: true });
  });

  it("does not reuse a Phantom public key that contradicts its account event", async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: true,
      publicKey: publicKey(VALID_WALLET_A),
      on: vi.fn((event: string, listener: (value?: unknown) => void) => listeners.set(event, listener)),
    };
    const connect = vi.fn(async () => {
      provider.publicKey = publicKey(VALID_WALLET_B);
      listeners.get("connect")?.(provider.publicKey);
      return { publicKey: provider.publicKey };
    });
    provider.connect = connect;
    installProviders(provider);
    const { connectSolanaWallet, solanaProvider } = await import("./wallet-request-proof");
    solanaProvider();
    listeners.get("accountChanged")?.(publicKey(VALID_WALLET_B));

    await expect(connectSolanaWallet()).resolves.toBe(VALID_WALLET_B);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({ onlyIfTrusted: true });
  });

  it("single-flights concurrent trusted connection requests", async () => {
    let resolveConnection: ((value: unknown) => void) | undefined;
    const pending = new Promise((resolve) => {
      resolveConnection = resolve;
    });
    const connect = vi.fn(() => pending);
    installProviders({ isPhantom: true, isConnected: false, connect });
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    const first = connectSolanaWallet();
    const second = connectSolanaWallet();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({ onlyIfTrusted: true });

    resolveConnection?.({ publicKey: publicKey(VALID_WALLET_A) });
    await expect(Promise.all([first, second])).resolves.toEqual([VALID_WALLET_A, VALID_WALLET_A]);
  });

  it("accepts coherent connected state when interactive Phantom approval ends with an internal error", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      disconnect: vi.fn(),
    };
    const connect = vi.fn()
      .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
      .mockImplementationOnce(async () => {
        setTimeout(() => {
          provider.isConnected = true;
          provider.publicKey = publicKey(VALID_WALLET_A);
        }, 100);
        throw { code: -32603, message: "Unexpected error" };
      });
    provider.connect = connect;
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).resolves.toBe(VALID_WALLET_A);
    expect(connect).toHaveBeenNthCalledWith(1, { onlyIfTrusted: true });
    expect(connect).toHaveBeenNthCalledWith(2);
    expect(provider.disconnect).not.toHaveBeenCalled();
  });

  it("bootstraps exact Phantom Wallet Standard 0→1 state with SIWS, then uses the direct signer", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      connect: vi.fn()
        .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
        .mockRejectedValueOnce({ code: -32603, message: "Unexpected error" }),
      signMessage: vi.fn().mockImplementation(async () => ({
        publicKey: provider.publicKey,
        signature: new Uint8Array(64),
      })),
    };
    const standard = standardPhantom(provider, new Uint8Array(32).fill(7), { connected: false });
    standardRegistry.wallets = [standard.wallet];
    installProviders(provider);
    const { connectSolanaWallet, requiredSolanaProvider, walletSignBytes } = await import("./wallet-request-proof");

    const wallet = await connectSolanaWallet();
    await expect(walletSignBytes(requiredSolanaProvider(), new Uint8Array([1]), wallet)).resolves.toHaveLength(64);

    expect(wallet).toBe(standard.account.address);
    expect(provider.connect).toHaveBeenCalledTimes(2);
    expect(standard.connect).not.toHaveBeenCalled();
    expect(standard.signIn).toHaveBeenCalledOnce();
    expect(standard.signMessage).not.toHaveBeenCalled();
    expect(provider.signMessage).toHaveBeenCalledOnce();
    expect(standard.unsubscribes[0]).toHaveBeenCalledOnce();
    expect(standardRegistry.unregisterListeners.size).toBe(0);

    const input = standard.signIn.mock.calls[0]?.[0] as SolanaSignInInput;
    expect(input).toMatchObject({
      domain: window.location.host,
      statement: "This sign-in message alone cannot move funds or place trades.",
      uri: window.location.origin,
      version: "1",
      chainId: "mainnet",
    });
    expect(input.address).toBeUndefined();
    expect(input.nonce).toMatch(/^[0-9a-f]{32}$/u);
    expect(input.notBefore).toBe(input.issuedAt);
    expect(Date.parse(input.expirationTime ?? "") - Date.parse(input.issuedAt ?? "")).toBe(120_000);
    expect(input.requestId).toBeUndefined();
    expect(input.resources).toBeUndefined();

    await expect(connectSolanaWallet()).resolves.toBe(wallet);
    expect(standard.signIn).toHaveBeenCalledOnce();
  });

  it("never calls SIWS unless the interactive direct connection returns exact -32603", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      connect: vi.fn()
        .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
        .mockRejectedValueOnce({ code: 4001, message: "Cancelled" }),
      signMessage: vi.fn(),
    };
    const standard = standardPhantom(provider, new Uint8Array(32).fill(7), { connected: false });
    standardRegistry.wallets = [standard.wallet];
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom connection was cancelled.");
    expect(standard.signIn).not.toHaveBeenCalled();
    expect(standard.connect).not.toHaveBeenCalled();
  });

  it("requires the Wallet Standard account set to start at exactly zero", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      connect: vi.fn()
        .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
        .mockRejectedValueOnce({ code: -32603, message: "Unexpected error" }),
      signMessage: vi.fn(),
    };
    const standard = standardPhantom(provider);
    standardRegistry.wallets = [standard.wallet];
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom could not refresh its connection.");
    expect(standard.signIn).not.toHaveBeenCalled();
    expect(standard.connect).not.toHaveBeenCalled();
  });

  it("rejects ambiguous Phantom registrations without SIWS", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      connect: vi.fn()
        .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
        .mockRejectedValueOnce({ code: -32603, message: "Unexpected error" }),
      signMessage: vi.fn(),
    };
    const first = standardPhantom(provider, new Uint8Array(32).fill(7), { connected: false });
    const second = standardPhantom(provider, new Uint8Array(32).fill(8), { connected: false });
    standardRegistry.wallets = [first.wallet, second.wallet];
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom could not refresh its connection.");
    expect(first.signIn).not.toHaveBeenCalled();
    expect(second.signIn).not.toHaveBeenCalled();
  });

  it("rejects a non-canonically-bound Phantom registration without SIWS", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      connect: vi.fn()
        .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
        .mockRejectedValueOnce({ code: -32603, message: "Unexpected error" }),
      signMessage: vi.fn(),
    };
    const unbound = standardPhantom({ isPhantom: true }, new Uint8Array(32).fill(9), { connected: false });
    standardRegistry.wallets = [unbound.wallet];
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom could not refresh its connection.");
    expect(unbound.signIn).not.toHaveBeenCalled();
  });

  it("requires the exact event, wallet account, and SIWS output account object", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      connect: vi.fn()
        .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
        .mockRejectedValueOnce({ code: -32603, message: "Unexpected error" }),
      signMessage: vi.fn(),
    };
    const standard = standardPhantom(provider, new Uint8Array(32).fill(7), { connected: false });
    const implementation = standard.signIn.getMockImplementation() as TestSignIn | undefined;
    standard.signIn.mockImplementationOnce(async (...inputs: readonly SolanaSignInInput[]) => {
      const outputs = await implementation!(...inputs);
      const output = outputs[0]!;
      return [{ ...output, account: { ...output.account } }];
    });
    standardRegistry.wallets = [standard.wallet];
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom could not refresh its connection.");
    expect(standard.connect).not.toHaveBeenCalled();
    expect(standard.unsubscribes[0]).toHaveBeenCalledOnce();
    expect(standardRegistry.unregisterListeners.size).toBe(0);
  });

  it("rejects invalid SIWS signatures even when the account transition is coherent", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      connect: vi.fn()
        .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
        .mockRejectedValueOnce({ code: -32603, message: "Unexpected error" }),
      signMessage: vi.fn(),
    };
    const standard = standardPhantom(provider, new Uint8Array(32).fill(7), { connected: false });
    const implementation = standard.signIn.getMockImplementation() as TestSignIn | undefined;
    standard.signIn.mockImplementationOnce(async (...inputs: readonly SolanaSignInInput[]) => {
      const outputs = await implementation!(...inputs);
      return [{ ...outputs[0]!, signature: new Uint8Array(64).fill(1) }];
    });
    standardRegistry.wallets = [standard.wallet];
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom could not refresh its connection.");
    expect(standard.connect).not.toHaveBeenCalled();
  });

  it("poisons SIWS on a second account event or direct-provider account mismatch", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      connect: vi.fn()
        .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
        .mockRejectedValueOnce({ code: -32603, message: "Unexpected error" }),
      signMessage: vi.fn(),
    };
    const standard = standardPhantom(provider, new Uint8Array(32).fill(7), { connected: false });
    const implementation = standard.signIn.getMockImplementation() as TestSignIn | undefined;
    standard.signIn.mockImplementationOnce(async (...inputs: readonly SolanaSignInInput[]) => {
      const outputs = await implementation!(...inputs);
      standard.change([standard.account]);
      provider.publicKey = publicKey(VALID_WALLET_B);
      return outputs;
    });
    standardRegistry.wallets = [standard.wallet];
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom could not refresh its connection.");
    expect(standard.connect).not.toHaveBeenCalled();
  });

  it("rejects wallet unregister or feature replacement during SIWS and cleans up listeners", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      connect: vi.fn()
        .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
        .mockRejectedValueOnce({ code: -32603, message: "Unexpected error" }),
      signMessage: vi.fn(),
    };
    const standard = standardPhantom(provider, new Uint8Array(32).fill(7), { connected: false });
    const implementation = standard.signIn.getMockImplementation() as TestSignIn | undefined;
    standard.signIn.mockImplementationOnce(async (...inputs: readonly SolanaSignInInput[]) => {
      const outputs = await implementation!(...inputs);
      standard.wallet.features["solana:signIn"] = {
        version: "1.0.0",
        signIn: vi.fn(),
      };
      unregisterStandardWallet(standard.wallet);
      return outputs;
    });
    standardRegistry.wallets = [standard.wallet];
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom could not refresh its connection.");
    expect(standard.connect).not.toHaveBeenCalled();
    expect(standard.unsubscribes[0]).toHaveBeenCalledOnce();
    expect(standardRegistry.unregisterListeners.size).toBe(0);
  });

  it("propagates an exact SIWS rejection instead of masking it as the earlier connect error", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      connect: vi.fn()
        .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
        .mockRejectedValueOnce({ code: -32603, message: "Unexpected error" }),
      signMessage: vi.fn(),
    };
    const standard = standardPhantom(provider, new Uint8Array(32).fill(7), { connected: false });
    standard.signIn.mockRejectedValueOnce({ code: 4001, message: "Cancelled" });
    standardRegistry.wallets = [standard.wallet];
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom connection was cancelled.");
    expect(standard.connect).not.toHaveBeenCalled();
    expect(standard.unsubscribes[0]).toHaveBeenCalledOnce();
    expect(standardRegistry.unregisterListeners.size).toBe(0);
  });
  it("surfaces an actionable error without disconnecting when internal-error state stays disconnected", async () => {
    const connect = vi.fn().mockRejectedValue({ code: -32603, message: "Unexpected error" });
    const disconnect = vi.fn();
    installProviders({
      isPhantom: true,
      isConnected: false,
      connect,
      disconnect,
    });
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow(
      "Phantom could not refresh its connection. Unlock Phantom, switch to the intended account, reload this page, and try again.",
    );
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenNthCalledWith(1, { onlyIfTrusted: true });
    expect(connect).toHaveBeenNthCalledWith(2);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("does not recover an invalid public key after an interactive internal error", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      disconnect: vi.fn(),
    };
    const connect = vi.fn()
      .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
      .mockImplementationOnce(async () => {
        provider.isConnected = true;
        provider.publicKey = publicKey("not-a-solana-public-key");
        throw { code: -32603, message: "Unexpected error" };
      });
    provider.connect = connect;
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom could not refresh its connection.");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(provider.disconnect).not.toHaveBeenCalled();
  });

  it("does not recover a legacy provider merely claiming to be Phantom", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      disconnect: vi.fn(),
    };
    const connect = vi.fn()
      .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
      .mockImplementationOnce(async () => {
        provider.isConnected = true;
        provider.publicKey = publicKey(VALID_WALLET_A);
        throw { code: -32603, message: "Unexpected error" };
      });
    provider.connect = connect;
    installProviders(undefined, provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom could not refresh its connection.");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(provider.disconnect).not.toHaveBeenCalled();
  });

  it("does not accept connected state after the user cancels interactive approval", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      disconnect: vi.fn(),
    };
    const connect = vi.fn()
      .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
      .mockImplementationOnce(async () => {
        provider.isConnected = true;
        provider.publicKey = publicKey(VALID_WALLET_A);
        throw { code: 4001, message: "User rejected" };
      });
    provider.connect = connect;
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom connection was cancelled.");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(provider.disconnect).not.toHaveBeenCalled();
  });

  it("prompts once after onlyIfTrusted reports the wallet is not trusted", async () => {
    const connect = vi.fn()
      .mockRejectedValueOnce({ code: "4001", message: "Not trusted" })
      .mockResolvedValueOnce({ publicKey: publicKey(VALID_WALLET_A) });
    installProviders({ isPhantom: true, isConnected: false, connect });
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).resolves.toBe(VALID_WALLET_A);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenNthCalledWith(1, { onlyIfTrusted: true });
    expect(connect).toHaveBeenNthCalledWith(2);
  });

  it("rejects internal-error recovery when an account event contradicts the provider key", async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      disconnect: vi.fn(),
      on: vi.fn((event: string, listener: (value?: unknown) => void) => listeners.set(event, listener)),
    };
    const connect = vi.fn()
      .mockRejectedValueOnce({ code: 4100, message: "Not trusted" })
      .mockImplementationOnce(async () => {
        provider.isConnected = true;
        provider.publicKey = publicKey(VALID_WALLET_A);
        listeners.get("accountChanged")?.(publicKey(VALID_WALLET_B));
        throw { code: -32603, message: "Unexpected error" };
      });
    provider.connect = connect;
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow(
      "Phantom could not refresh its connection. Unlock Phantom, switch to the intended account, reload this page, and try again.",
    );
    expect(connect).toHaveBeenCalledTimes(2);
    expect(provider.disconnect).not.toHaveBeenCalled();
  });

  it("does not clear an account-event contradiction from a resolved connection", async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      on: vi.fn((event: string, listener: (value?: unknown) => void) => listeners.set(event, listener)),
    };
    provider.connect = vi.fn(async () => {
      provider.isConnected = true;
      provider.publicKey = publicKey(VALID_WALLET_B);
      listeners.get("accountChanged")?.(provider.publicKey);
      return { publicKey: publicKey(VALID_WALLET_A) };
    });
    installProviders(provider);
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow("Phantom account changed.");
    expect(provider.connect).toHaveBeenCalledOnce();
  });

  it("rejects a signature if Phantom changes accounts during approval", async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      on: vi.fn((event: string, listener: (value?: unknown) => void) => listeners.set(event, listener)),
    };
    provider.connect = vi.fn(async () => {
      provider.isConnected = true;
      provider.publicKey = publicKey(VALID_WALLET_A);
      listeners.get("connect")?.(provider.publicKey);
      return { publicKey: provider.publicKey };
    });
    provider.signMessage = vi.fn(async () => {
      provider.publicKey = publicKey(VALID_WALLET_B);
      listeners.get("accountChanged")?.(publicKey(VALID_WALLET_B));
      return new Uint8Array(64);
    });
    installProviders(provider);
    const { connectSolanaWallet, requiredSolanaProvider, walletSignBytes } = await import("./wallet-request-proof");
    const wallet = await connectSolanaWallet();

    await expect(walletSignBytes(requiredSolanaProvider(), new Uint8Array([1]), wallet)).rejects.toThrow(
      "Phantom account changed",
    );
  });

  it("rejects a signature returned for a different account", async () => {
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: true,
      publicKey: publicKey(VALID_WALLET_A),
      connect: vi.fn().mockResolvedValue({ publicKey: publicKey(VALID_WALLET_A) }),
      signMessage: vi.fn().mockResolvedValue({
        publicKey: publicKey(VALID_WALLET_B),
        signature: new Uint8Array(64),
      }),
    };
    installProviders(provider);
    const { connectSolanaWallet, requiredSolanaProvider, walletSignBytes } = await import("./wallet-request-proof");
    const wallet = await connectSolanaWallet();

    await expect(walletSignBytes(requiredSolanaProvider(), new Uint8Array([1]), wallet)).rejects.toThrow(
      "Phantom account changed",
    );
  });

  it("rejects signing after Phantom disconnects", async () => {
    const listeners = new Map<string, (value?: unknown) => void>();
    const provider: TestProvider = {
      isPhantom: true,
      isConnected: false,
      signMessage: vi.fn().mockResolvedValue(new Uint8Array(64)),
      on: vi.fn((event: string, listener: (value?: unknown) => void) => listeners.set(event, listener)),
    };
    provider.connect = vi.fn(async () => {
      provider.isConnected = true;
      provider.publicKey = publicKey(VALID_WALLET_A);
      listeners.get("connect")?.(provider.publicKey);
      return { publicKey: provider.publicKey };
    });
    installProviders(provider);
    const { connectSolanaWallet, requiredSolanaProvider, walletSignBytes } = await import("./wallet-request-proof");
    const wallet = await connectSolanaWallet();
    provider.isConnected = false;
    listeners.get("disconnect")?.();

    await expect(walletSignBytes(requiredSolanaProvider(), new Uint8Array([1]), wallet)).rejects.toThrow(
      "Phantom disconnected",
    );
    expect(provider.signMessage).not.toHaveBeenCalled();
  });
});
