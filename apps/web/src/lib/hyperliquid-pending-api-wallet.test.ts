import { sha512 } from "@noble/hashes/sha512";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingHyperliquidApiWallet,
  resumeOrCreatePendingHyperliquidApiWallet,
  resumePendingHyperliquidApiWallet,
} from "./hyperliquid-pending-api-wallet";

const DB_NAME = "ghola-hyperliquid-pending-wallets";
const STORE_PENDING = "pending_wallets";
const STORE_QUARANTINED = "quarantined_wallets";
const AUTH_SCOPE_A = "account-commitment-a";
const AUTH_SCOPE_B = "account-commitment-b";
const USER_DID = "did:key:browser-wallet";
const OWNER_A = `0x${"11".repeat(20)}`;
const OWNER_B = `0x${"22".repeat(20)}`;

describe("pending Hyperliquid API wallet v2 isolation", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });

  it("resumes only the exact authenticated scope and owner lane", async () => {
    const signBytes = deterministicSigner(7);
    const created = await resumeOrCreatePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes,
    });
    const resumed = await resumePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes,
    });

    expect(created.resumed).toBe(false);
    expect(resumed).toMatchObject({
      ownerAddress: OWNER_A,
      agentAddress: created.agentAddress,
      privateKey: created.privateKey,
      resumed: true,
    });
  });

  it("denies account B access to account A's pending lane", async () => {
    const signBytes = deterministicSigner(8);
    const accountA = await resumeOrCreatePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes,
    });

    await expect(resumePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_B,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes,
    })).resolves.toBeNull();

    const accountB = await resumeOrCreatePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_B,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes,
    });
    expect(accountB.agentAddress).not.toBe(accountA.agentAddress);
  });

  it("cryptographically binds the wrapped key to the authenticated scope", async () => {
    const signBytes = deterministicSigner(9);
    await resumeOrCreatePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes,
    });

    const db = await openTestDb(2);
    const sourceId = laneId(AUTH_SCOPE_A, USER_DID, "mainnet", OWNER_A);
    const targetId = laneId(AUTH_SCOPE_B, USER_DID, "mainnet", OWNER_A);
    const source = await getRow(db, STORE_PENDING, sourceId) as Record<string, unknown>;
    await putRow(db, STORE_PENDING, {
      ...source,
      id: targetId,
      authScope: AUTH_SCOPE_B,
    });
    db.close();

    await expect(resumePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_B,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes,
    })).rejects.toThrow("pending_wallet_unlock_failed");
  });

  it("keeps different Phantom owners in distinct lanes within one scope", async () => {
    const signBytes = deterministicSigner(10);
    const ownerA = await resumeOrCreatePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes,
    });
    const ownerB = await resumeOrCreatePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_B,
      signBytes,
    });

    expect(ownerA.ownerAddress).toBe(OWNER_A);
    expect(ownerB.ownerAddress).toBe(OWNER_B);
    expect(ownerB.agentAddress).not.toBe(ownerA.agentAddress);
    expect((await resumePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes,
    }))?.agentAddress).toBe(ownerA.agentAddress);
  });

  it("converges same-scope and same-owner browser tabs on one wallet", async () => {
    const signBytes = deterministicSigner(11);
    const input = {
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "mainnet" as const,
      ownerAddress: OWNER_A,
      signBytes,
    };
    const [first, second] = await Promise.all([
      resumeOrCreatePendingHyperliquidApiWallet(input),
      resumeOrCreatePendingHyperliquidApiWallet(input),
    ]);

    expect(first.agentAddress).toBe(second.agentAddress);
    expect(first.privateKey).toBe(second.privateKey);
  });

  it("fails closed when another browser signing identity tries to unlock an exact lane", async () => {
    await resumeOrCreatePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes: deterministicSigner(12),
    });

    await expect(resumePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes: deterministicSigner(13),
    })).rejects.toThrow("pending_wallet_unlock_failed");
  });

  it("clears only the exact scope and owner lane", async () => {
    const signBytes = deterministicSigner(14);
    const ownerA = await resumeOrCreatePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "testnet",
      ownerAddress: OWNER_A,
      signBytes,
    });
    const ownerB = await resumeOrCreatePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "testnet",
      ownerAddress: OWNER_B,
      signBytes,
    });

    await clearPendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_B,
      userDid: USER_DID,
      network: "testnet",
      ownerAddress: OWNER_A,
    });
    expect((await resumePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "testnet",
      ownerAddress: OWNER_A,
      signBytes,
    }))?.agentAddress).toBe(ownerA.agentAddress);

    await clearPendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "testnet",
      ownerAddress: OWNER_A,
    });
    await expect(resumePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "testnet",
      ownerAddress: OWNER_A,
      signBytes,
    })).resolves.toBeNull();
    expect((await resumePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "testnet",
      ownerAddress: OWNER_B,
      signBytes,
    }))?.agentAddress).toBe(ownerB.agentAddress);
  });

  it("quarantines legacy v1 and ownerless rows during the v2 upgrade", async () => {
    await seedLegacyDatabase();

    await expect(resumePendingHyperliquidApiWallet({
      authScope: AUTH_SCOPE_A,
      userDid: USER_DID,
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes: deterministicSigner(15),
    })).resolves.toBeNull();

    const db = await openTestDb(2);
    expect(await getAllRows(db, STORE_PENDING)).toHaveLength(0);
    const quarantined = await getAllRows(db, STORE_QUARANTINED) as Array<Record<string, unknown>>;
    expect(quarantined).toHaveLength(2);
    expect(quarantined.every((row) => row.reason === "legacy_or_ownerless_row")).toBe(true);
    db.close();
  });

  it("learns the injected Phantom owner before resuming its exact lane", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/private-account/PrivateAccountCockpit.tsx"),
      "utf8",
    );
    const modal = source.slice(source.indexOf("function HyperliquidConnectModal("));
    const ownerConnectedAt = modal.indexOf("const ownerAddress = await connectInjectedHyperliquidOwner(provider);");
    const exactResumeAt = modal.indexOf("const pending = await resumePendingHyperliquidApiWallet(pendingInput)");

    expect(ownerConnectedAt).toBeGreaterThanOrEqual(0);
    expect(exactResumeAt).toBeGreaterThan(ownerConnectedAt);
    expect(modal.match(/resumePendingHyperliquidApiWallet\(/g)).toHaveLength(1);
    expect(modal).toContain("authScope: accountCommitment");
  });
});

function deterministicSigner(seed: number) {
  return async (message: Uint8Array) => {
    const input = new Uint8Array(message.length + 1);
    input[0] = seed;
    input.set(message, 1);
    return sha512(input);
  };
}

function laneId(authScope: string, userDid: string, network: string, ownerAddress: string) {
  return `${authScope}\0${userDid}\0${network}\0${ownerAddress}`;
}

async function seedLegacyDatabase() {
  const db = await openTestDb(1, (legacyDb) => {
    const store = legacyDb.createObjectStore(STORE_PENDING, { keyPath: "id" });
    store.createIndex("by_user_network", ["userDid", "network"], { unique: false });
  });
  const tx = db.transaction(STORE_PENDING, "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_PENDING);
  store.put({
    version: 1,
    id: `${USER_DID}\0mainnet`,
    userDid: USER_DID,
    network: "mainnet",
    ownerAddress: OWNER_A,
    agentAddress: `0x${"33".repeat(20)}`,
    salt: new Uint8Array(32),
    wrappedPrivateKey: new Uint8Array(60),
    createdAt: 1,
  });
  store.put({
    version: 2,
    id: "ownerless-v2-row",
    authScope: AUTH_SCOPE_A,
    userDid: USER_DID,
    network: "mainnet",
    agentAddress: `0x${"44".repeat(20)}`,
    salt: new Uint8Array(32),
    wrappedPrivateKey: new Uint8Array(60),
    createdAt: 2,
  });
  await done;
  db.close();
}

function openTestDb(version: number, upgrade?: (db: IDBDatabase) => void) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getRow(db: IDBDatabase, storeName: string, id: string) {
  return new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllRows(db: IDBDatabase, storeName: string) {
  return new Promise<unknown[]>((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putRow(db: IDBDatabase, storeName: string, row: unknown) {
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(storeName, "readwrite").objectStore(storeName).put(row);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
