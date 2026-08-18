import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";

type TestProvider = {
  isPhantom?: boolean;
  isConnected?: boolean;
  publicKey?: unknown;
  connect?: ReturnType<typeof vi.fn>;
  disconnect?: ReturnType<typeof vi.fn>;
  signMessage?: ReturnType<typeof vi.fn>;
  on?: ReturnType<typeof vi.fn>;
};

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

afterEach(() => {
  Reflect.deleteProperty(window, "phantom");
  Reflect.deleteProperty(window, "solana");
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
