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
      publicKey: publicKey("wallet-a"),
      connect,
    });
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).resolves.toBe("wallet-a");
    expect(connect).not.toHaveBeenCalled();
  });

  it("refreshes Phantom even when a stale provider claims it is connected", async () => {
    const connect = vi.fn()
      .mockRejectedValueOnce({ code: -32603, message: "Unexpected error" })
      .mockResolvedValueOnce({ publicKey: publicKey("wallet-a") });
    const disconnect = vi.fn().mockResolvedValue(undefined);
    installProviders({
      isPhantom: true,
      isConnected: true,
      publicKey: publicKey("stale-wallet"),
      connect,
      disconnect,
    });
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).resolves.toBe("wallet-a");
    expect(disconnect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenNthCalledWith(1, { onlyIfTrusted: true });
    expect(connect).toHaveBeenNthCalledWith(2);
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

    resolveConnection?.({ publicKey: publicKey("wallet-a") });
    await expect(Promise.all([first, second])).resolves.toEqual(["wallet-a", "wallet-a"]);
  });

  it("resets one stale Phantom session after an internal connection error", async () => {
    const connect = vi.fn()
      .mockRejectedValueOnce({ code: -32603, message: "Unexpected error" })
      .mockResolvedValueOnce({ publicKey: publicKey("wallet-a") });
    const disconnect = vi.fn().mockResolvedValue(undefined);
    installProviders({ isPhantom: true, isConnected: false, connect, disconnect });
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).resolves.toBe("wallet-a");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenNthCalledWith(1, { onlyIfTrusted: true });
    expect(connect).toHaveBeenNthCalledWith(2);
  });

  it("surfaces an actionable error when stale-session recovery fails", async () => {
    const connect = vi.fn().mockRejectedValue({ code: -32603, message: "Unexpected error" });
    installProviders({
      isPhantom: true,
      isConnected: false,
      connect,
      disconnect: vi.fn().mockResolvedValue(undefined),
    });
    const { connectSolanaWallet } = await import("./wallet-request-proof");

    await expect(connectSolanaWallet()).rejects.toThrow(
      "Phantom could not refresh its connection. Unlock Phantom, switch to the intended account, reload this page, and try again.",
    );
    expect(connect).toHaveBeenCalledTimes(2);
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
      provider.publicKey = publicKey("wallet-a");
      listeners.get("connect")?.(provider.publicKey);
      return { publicKey: provider.publicKey };
    });
    provider.signMessage = vi.fn(async () => {
      provider.publicKey = publicKey("wallet-b");
      listeners.get("accountChanged")?.(publicKey("wallet-b"));
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
      publicKey: publicKey("wallet-a"),
      connect: vi.fn().mockResolvedValue({ publicKey: publicKey("wallet-a") }),
      signMessage: vi.fn().mockResolvedValue({
        publicKey: publicKey("wallet-b"),
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
      provider.publicKey = publicKey("wallet-a");
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
