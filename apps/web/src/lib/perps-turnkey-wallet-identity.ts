import type { Wallet, WalletAccount } from "@turnkey/react-wallet-kit";

export interface TurnkeyWalletAccountIdentity {
  organizationId: string;
  walletId: string;
  walletAccountId: string;
  path: string;
  address: string;
}

export interface PerpsWalletIdentityBinding {
  version: 2;
  organizationId: string;
  walletId: string;
  accounts?: Partial<Record<"owner" | "agent" | "sealing" | "tombstone", TurnkeyWalletAccountIdentity>>;
}

type StorageBoundary = Pick<Storage, "getItem" | "setItem">;

export function selectBoundPerpsWallet(
  wallets: Wallet[],
  walletName: string,
  boundWalletId: string | null,
): Wallet | null {
  if (boundWalletId) {
    const matches = wallets.filter((wallet) => wallet.walletId === boundWalletId);
    if (matches.length !== 1 || matches[0].walletName !== walletName) {
      throw new Error("The bound Ghola perps wallet is unavailable or ambiguous; repair is required.");
    }
    return matches[0];
  }
  const candidates = wallets.filter((wallet) => wallet.walletName === walletName);
  if (candidates.length > 1) {
    throw new Error("Multiple Ghola perps wallets are active; bind one exact wallet before signing.");
  }
  return candidates[0] || null;
}

export function exactWalletAccount(
  wallet: Wallet,
  organizationId: string,
  path: string,
): WalletAccount {
  const accounts = wallet.accounts.filter((candidate) => candidate.path === path);
  if (accounts.length !== 1) {
    throw new Error(`Turnkey wallet account ${path} is unavailable or ambiguous.`);
  }
  const account = accounts[0];
  if (account.organizationId !== organizationId || account.walletId !== wallet.walletId) {
    throw new Error(`Turnkey wallet account ${path} is bound to a different organization or wallet.`);
  }
  if (!account.walletAccountId || !account.address) {
    throw new Error(`Turnkey wallet account ${path} has no stable signing identity.`);
  }
  return account;
}

export function walletAccountIdentity(account: WalletAccount): TurnkeyWalletAccountIdentity {
  return {
    organizationId: account.organizationId,
    walletId: account.walletId,
    walletAccountId: account.walletAccountId,
    path: account.path,
    address: account.address,
  };
}

export function readPerpsWalletIdentityBinding(
  storage: StorageBoundary,
  storageKey: string,
  userScope: string | null,
  organizationId: string,
): PerpsWalletIdentityBinding | null {
  if (!userScope) return null;
  const parsed = parseRecord(storage.getItem(storageKey));
  const raw = parsed[userScope];
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidBinding();
  const record = raw as Record<string, unknown>;
  if (record.organizationId !== organizationId || !nonempty(record.walletId)) throw invalidBinding();
  const accounts = parseAccounts(record.accounts);
  return {
    version: 2,
    organizationId,
    walletId: record.walletId,
    ...(accounts ? { accounts } : {}),
  };
}

export function bindExactPerpsWalletIdentity(input: {
  storage: StorageBoundary;
  storageKey: string;
  userScope: string | null;
  organizationId: string;
  walletId: string;
  accounts: Partial<Record<"owner" | "agent" | "sealing" | "tombstone", WalletAccount>>;
}): PerpsWalletIdentityBinding {
  if (!input.userScope || !input.walletId) throw new Error("A verified Ghola wallet identity is required.");
  const current = parseRecord(input.storage.getItem(input.storageKey));
  const previous = readPerpsWalletIdentityBinding(
    input.storage,
    input.storageKey,
    input.userScope,
    input.organizationId,
  );
  if (previous && previous.walletId !== input.walletId) throw identityChanged();
  const nextAccounts = { ...(previous?.accounts || {}) };
  for (const [role, account] of Object.entries(input.accounts)) {
    if (!account) continue;
    const identity = walletAccountIdentity(account);
    if (identity.organizationId !== input.organizationId || identity.walletId !== input.walletId) {
      throw identityChanged();
    }
    const previousIdentity = previous?.accounts?.[role as keyof typeof nextAccounts];
    if (previousIdentity && !sameWalletAccountIdentity(previousIdentity, identity)) throw identityChanged();
    nextAccounts[role as keyof typeof nextAccounts] = identity;
  }
  const binding: PerpsWalletIdentityBinding = {
    version: 2,
    organizationId: input.organizationId,
    walletId: input.walletId,
    accounts: nextAccounts,
  };
  input.storage.setItem(input.storageKey, JSON.stringify({
    ...current,
    [input.userScope]: binding,
  }));
  return binding;
}

export async function withOneStableTurnkeyRefresh<TPair, TResult>(input: {
  load: () => Promise<TPair>;
  account: (pair: TPair) => WalletAccount;
  execute: (pair: TPair) => Promise<TResult>;
}): Promise<TResult> {
  const first = await input.load();
  const identity = walletAccountIdentity(input.account(first));
  try {
    return await input.execute(first);
  } catch (caught) {
    if (!isTurnkeySigningResourceMissing(caught)) throw caught;
  }
  const refreshed = await input.load();
  if (!sameWalletAccountIdentity(identity, walletAccountIdentity(input.account(refreshed)))) {
    throw identityChanged();
  }
  return input.execute(refreshed);
}

export function isTurnkeySigningResourceMissing(caught: unknown) {
  const message = caught instanceof Error ? caught.message : String(caught || "");
  return message.includes("Could not find any resource to sign with") &&
    message.includes("Addresses are case sensitive");
}

function sameWalletAccountIdentity(
  left: TurnkeyWalletAccountIdentity,
  right: TurnkeyWalletAccountIdentity,
) {
  return left.organizationId === right.organizationId &&
    left.walletId === right.walletId &&
    left.walletAccountId === right.walletAccountId &&
    left.path === right.path &&
    left.address.toLowerCase() === right.address.toLowerCase();
}

function parseAccounts(value: unknown): PerpsWalletIdentityBinding["accounts"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidBinding();
  const result: PerpsWalletIdentityBinding["accounts"] = {};
  for (const role of ["owner", "agent", "sealing", "tombstone"] as const) {
    const raw = (value as Record<string, unknown>)[role];
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidBinding();
    const record = raw as Record<string, unknown>;
    if (![record.organizationId, record.walletId, record.walletAccountId, record.path, record.address].every(nonempty)) {
      throw invalidBinding();
    }
    result[role] = {
      organizationId: record.organizationId as string,
      walletId: record.walletId as string,
      walletAccountId: record.walletAccountId as string,
      path: record.path as string,
      address: record.address as string,
    };
  }
  return result;
}

function parseRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidBinding();
  return parsed as Record<string, unknown>;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function invalidBinding() {
  return new Error("The exact Ghola perps wallet binding is invalid; repair is required.");
}

function identityChanged() {
  return new Error("The bound Turnkey wallet account identity changed; signing was stopped.");
}
