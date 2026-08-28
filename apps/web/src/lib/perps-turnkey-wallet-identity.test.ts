import { describe, expect, it, vi } from "vitest";
import type { Wallet, WalletAccount } from "@turnkey/react-wallet-kit";
import {
  bindExactPerpsWalletIdentity,
  exactWalletAccount,
  readPerpsWalletIdentityBinding,
  selectBoundPerpsWallet,
  withOneStableTurnkeyRefresh,
} from "./perps-turnkey-wallet-identity";

const ORGANIZATION = "turnkey-org";
const OWNER_PATH = "m/44'/60'/0'/0/0";
const STORAGE_KEY = "wallet-bindings";
const USER = "user-scope";
const LOWER_ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const CHECKSUM_ADDRESS = "0xABcdefABcdefABcdefABcdefABcdefABcdefABCD";

describe("exact Turnkey perps wallet identity", () => {
  it("never guesses between duplicate named wallets", () => {
    expect(() => selectBoundPerpsWallet([
      wallet("wallet-a"),
      wallet("wallet-b"),
    ], "Ghola Perps", null)).toThrow("Multiple Ghola perps wallets");
  });

  it("selects only the exact bound wallet ID", () => {
    const selected = selectBoundPerpsWallet([
      wallet("wallet-a"),
      wallet("wallet-b"),
    ], "Ghola Perps", "wallet-b");
    expect(selected?.walletId).toBe("wallet-b");
    expect(() => selectBoundPerpsWallet([wallet("wallet-a")], "Ghola Perps", "wallet-b"))
      .toThrow("bound Ghola perps wallet is unavailable");
  });

  it("binds exact wallet-account IDs and rejects identity replacement", () => {
    const storage = memoryStorage();
    const owner = account("wallet-a", "account-owner", LOWER_ADDRESS);
    bindExactPerpsWalletIdentity({
      storage,
      storageKey: STORAGE_KEY,
      userScope: USER,
      organizationId: ORGANIZATION,
      walletId: "wallet-a",
      accounts: { owner },
    });
    expect(readPerpsWalletIdentityBinding(storage, STORAGE_KEY, USER, ORGANIZATION))
      .toMatchObject({
        walletId: "wallet-a",
        accounts: { owner: { walletAccountId: "account-owner", address: LOWER_ADDRESS } },
      });
    expect(() => bindExactPerpsWalletIdentity({
      storage,
      storageKey: STORAGE_KEY,
      userScope: USER,
      organizationId: ORGANIZATION,
      walletId: "wallet-a",
      accounts: { owner: account("wallet-a", "replacement-owner", LOWER_ADDRESS) },
    })).toThrow("identity changed");
  });

  it("upgrades a legacy wallet-only binding without changing its wallet", () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({
        [USER]: { organizationId: ORGANIZATION, walletId: "wallet-a" },
      }),
    });
    const owner = account("wallet-a", "account-owner", LOWER_ADDRESS);
    bindExactPerpsWalletIdentity({
      storage,
      storageKey: STORAGE_KEY,
      userScope: USER,
      organizationId: ORGANIZATION,
      walletId: "wallet-a",
      accounts: { owner },
    });
    expect(readPerpsWalletIdentityBinding(storage, STORAGE_KEY, USER, ORGANIZATION)?.accounts?.owner)
      .toMatchObject({ walletAccountId: "account-owner", address: LOWER_ADDRESS });
  });

  it("rejects cross-wallet accounts even when their derivation path matches", () => {
    const malformed = wallet("wallet-a", [account("wallet-b", "account-owner", LOWER_ADDRESS)]);
    expect(() => exactWalletAccount(malformed, ORGANIZATION, OWNER_PATH))
      .toThrow("different organization or wallet");
  });

  it("refreshes once and forwards the exact refreshed address only for unchanged identity", async () => {
    const pairs = [pair(LOWER_ADDRESS), pair(CHECKSUM_ADDRESS)];
    const load = vi.fn(async () => pairs.shift()!);
    const execute = vi.fn(async (loaded: ReturnType<typeof pair>) => {
      if (execute.mock.calls.length === 1) throw resourceMissing();
      return loaded.owner.address;
    });
    await expect(withOneStableTurnkeyRefresh({
      load,
      account: (loaded) => loaded.owner,
      execute,
    })).resolves.toBe(CHECKSUM_ADDRESS);
    expect(load).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([loaded]) => loaded.owner.address))
      .toEqual([LOWER_ADDRESS, CHECKSUM_ADDRESS]);
  });

  it("never retries signing after the bound account identity changes", async () => {
    const pairs = [
      pair(LOWER_ADDRESS),
      { owner: account("wallet-a", "replacement-owner", LOWER_ADDRESS) },
    ];
    const execute = vi.fn(async () => { throw resourceMissing(); });
    await expect(withOneStableTurnkeyRefresh({
      load: async () => pairs.shift()!,
      account: (loaded) => loaded.owner,
      execute,
    })).rejects.toThrow("identity changed");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("performs no third attempt when the one safe retry fails", async () => {
    const execute = vi.fn(async () => { throw resourceMissing(); });
    await expect(withOneStableTurnkeyRefresh({
      load: async () => pair(LOWER_ADDRESS),
      account: (loaded) => loaded.owner,
      execute,
    })).rejects.toThrow("Could not find any resource");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

function pair(address: string) {
  return { owner: account("wallet-a", "account-owner", address) };
}

function wallet(walletId: string, accounts = [account(walletId, `owner-${walletId}`, LOWER_ADDRESS)]) {
  return {
    walletId,
    walletName: "Ghola Perps",
    accounts,
  } as unknown as Wallet;
}

function account(walletId: string, walletAccountId: string, address: string) {
  return {
    organizationId: ORGANIZATION,
    walletId,
    walletAccountId,
    path: OWNER_PATH,
    address,
  } as WalletAccount;
}

function resourceMissing() {
  return new Error("Could not find any resource to sign with. Addresses are case sensitive");
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}
