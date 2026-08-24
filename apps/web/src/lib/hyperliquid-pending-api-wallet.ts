import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import {
  generateHyperliquidApiWallet,
  hyperliquidApiWalletAddress,
} from "./hyperliquid-api-wallet";
import type { SignBytes } from "./session-vault";

const DB_NAME = "ghola-hyperliquid-pending-wallets";
const DB_VERSION = 2;
const STORE_PENDING = "pending_wallets";
const STORE_QUARANTINED = "quarantined_wallets";
const LEGACY_INDEX_USER_NETWORK = "by_user_network";
const INDEX_EXACT_LANE = "by_auth_scope_user_network_owner";
const RECORD_VERSION = 2;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;
const WRAP_CONTEXT = new TextEncoder().encode("ghola-hyperliquid-pending-wallet-wrap-v2");

type Network = "mainnet" | "testnet";

type PendingWalletRow = {
  version: 2;
  id: string;
  authScope: string;
  userDid: string;
  network: Network;
  ownerAddress: string;
  agentAddress: string;
  salt: Uint8Array;
  wrappedPrivateKey: Uint8Array;
  createdAt: number;
};

type PendingWalletLane = {
  authScope: string;
  userDid: string;
  network: Network;
  ownerAddress: string;
};

export type PendingHyperliquidApiWallet = {
  network: Network;
  ownerAddress: string;
  agentAddress: string;
  privateKey: `0x${string}`;
  createdAt: number;
  resumed: boolean;
};

export async function resumePendingHyperliquidApiWallet(input: {
  authScope: string;
  userDid: string;
  network: Network;
  ownerAddress: string;
  signBytes: SignBytes;
}): Promise<PendingHyperliquidApiWallet | null> {
  const lane = normalizeLane(input);
  const userDid = lane.userDid;
  const db = await openDb();
  await quarantineLegacyPendingRow(db, pendingSlotId(userDid, input.network));
  const row = await getPendingRow(db, pendingSlotId(
    lane.authScope,
    lane.userDid,
    lane.network,
    lane.ownerAddress,
  ));
  if (!row) return null;
  if (!isPendingWalletRow(row)) {
    await quarantinePendingRow(db, row, "malformed_v2_row");
    return null;
  }
  assertExactLane(row, lane);
  return openPendingRow(row, input.signBytes, true);
}

export async function resumeOrCreatePendingHyperliquidApiWallet(input: {
  authScope: string;
  userDid: string;
  network: Network;
  ownerAddress: string;
  signBytes: SignBytes;
}): Promise<PendingHyperliquidApiWallet> {
  const lane = normalizeLane(input);
  const id = pendingSlotId(lane.authScope, lane.userDid, lane.network, lane.ownerAddress);
  const db = await openDb();
  await quarantineLegacyPendingRow(db, pendingSlotId(lane.userDid, input.network));
  const existing = await getPendingRow(db, id);
  if (existing) {
    if (!isPendingWalletRow(existing)) {
      await quarantinePendingRow(db, existing, "malformed_v2_row");
    } else {
      assertExactLane(existing, lane);
      return openPendingRow(existing, input.signBytes, true);
    }
  }

  const generated = generateHyperliquidApiWallet();
  const privateKey = hexToBytes(generated.privateKey);
  const salt = randomBytes(KEY_LENGTH);
  let wrappingKey: Uint8Array | null = null;
  let wrappedPrivateKey: Uint8Array;
  try {
    wrappingKey = await deriveWrappingKey({
      ...lane,
      salt,
      signBytes: input.signBytes,
    });
    wrappedPrivateKey = await aesGcmWrap(wrappingKey, privateKey);
  } finally {
    privateKey.fill(0);
    wrappingKey?.fill(0);
  }
  const row: PendingWalletRow = {
    version: RECORD_VERSION,
    id,
    ...lane,
    agentAddress: generated.address.toLowerCase(),
    salt,
    wrappedPrivateKey,
    createdAt: Date.now(),
  };
  try {
    await addPendingRow(row);
  } catch (error) {
    if (!isConstraintError(error)) throw error;
    const raced = await getPendingRow(db, id);
    if (!raced || !isPendingWalletRow(raced)) throw new Error("pending_wallet_race_unresolved");
    assertExactLane(raced, lane);
    return openPendingRow(raced, input.signBytes, true);
  }
  return openPendingRow(row, input.signBytes, false);
}

export async function clearPendingHyperliquidApiWallet(input: {
  authScope: string;
  userDid: string;
  network: Network;
  ownerAddress: string;
}): Promise<void> {
  const lane = normalizeLane(input);
  const db = await openDb();
  await quarantineLegacyPendingRow(db, pendingSlotId(lane.userDid, input.network));
  const id = pendingSlotId(lane.authScope, lane.userDid, lane.network, lane.ownerAddress);
  const row = await getPendingRow(db, id);
  if (!row) return;
  if (!isPendingWalletRow(row)) {
    await quarantinePendingRow(db, row, "malformed_v2_row");
    return;
  }
  assertExactLane(row, lane);
  await deleteRow(db, id);
}

async function openPendingRow(
  row: PendingWalletRow,
  signBytes: SignBytes,
  resumed: boolean,
): Promise<PendingHyperliquidApiWallet> {
  const wrappingKey = await deriveWrappingKey({
    authScope: row.authScope,
    userDid: row.userDid,
    network: row.network,
    ownerAddress: row.ownerAddress,
    salt: row.salt,
    signBytes,
  });
  let privateKey: Uint8Array;
  try {
    privateKey = await aesGcmUnwrap(wrappingKey, row.wrappedPrivateKey);
  } catch {
    throw new Error("pending_wallet_unlock_failed");
  } finally {
    wrappingKey.fill(0);
  }
  if (privateKey.length !== KEY_LENGTH) throw new Error("pending_wallet_key_invalid");
  const agentAddress = hyperliquidApiWalletAddress(privateKey).toLowerCase();
  if (agentAddress !== row.agentAddress) {
    privateKey.fill(0);
    throw new Error("pending_wallet_integrity_failed");
  }
  const privateKeyHex = bytesToHex(privateKey);
  privateKey.fill(0);
  return {
    network: row.network,
    ownerAddress: row.ownerAddress,
    agentAddress,
    privateKey: `0x${privateKeyHex}`,
    createdAt: row.createdAt,
    resumed,
  };
}

async function deriveWrappingKey(input: {
  authScope: string;
  userDid: string;
  network: Network;
  ownerAddress: string;
  salt: Uint8Array;
  signBytes: SignBytes;
}) {
  const identity = new TextEncoder().encode(
    `${input.authScope}\0${input.userDid}\0${input.network}\0${input.ownerAddress}\0`,
  );
  const challenge = new Uint8Array(WRAP_CONTEXT.length + identity.length + input.salt.length);
  challenge.set(WRAP_CONTEXT, 0);
  challenge.set(identity, WRAP_CONTEXT.length);
  challenge.set(input.salt, WRAP_CONTEXT.length + identity.length);
  const signature = await input.signBytes(challenge);
  if (signature.length !== 64) throw new Error("pending_wallet_signature_invalid");
  return hkdf(sha256, signature, input.salt, WRAP_CONTEXT, KEY_LENGTH);
}

function normalizeLane(input: {
  authScope: string;
  userDid: string;
  network: Network;
  ownerAddress: string;
}): PendingWalletLane {
  return {
    authScope: normalizeIdentity(input.authScope, "pending_wallet_auth_scope_required"),
    userDid: normalizeIdentity(input.userDid, "pending_wallet_identity_required"),
    network: input.network,
    ownerAddress: normalizeOwnerAddress(input.ownerAddress),
  };
}

function normalizeIdentity(value: string, errorCode: string) {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) throw new Error(errorCode);
  return normalized;
}

function normalizeOwnerAddress(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("pending_wallet_owner_invalid");
  }
  return normalized;
}

function pendingSlotId(userDid: string, network: Network): string;
function pendingSlotId(authScope: string, userDid: string, network: Network, ownerAddress: string): string;
function pendingSlotId(
  authScopeOrUserDid: string,
  userDidOrNetwork: string,
  network?: Network,
  ownerAddress?: string,
) {
  if (!network || !ownerAddress) return `${authScopeOrUserDid}\0${userDidOrNetwork}`;
  return `${authScopeOrUserDid}\0${userDidOrNetwork}\0${network}\0${ownerAddress}`;
}

function assertExactLane(row: PendingWalletRow, lane: PendingWalletLane) {
  if (
    row.id !== pendingSlotId(lane.authScope, lane.userDid, lane.network, lane.ownerAddress) ||
    row.authScope !== lane.authScope ||
    row.userDid !== lane.userDid ||
    row.network !== lane.network ||
    row.ownerAddress !== lane.ownerAddress
  ) {
    throw new Error("pending_wallet_lane_mismatch");
  }
}

function isPendingWalletRow(value: unknown): value is PendingWalletRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PendingWalletRow>;
  if (
    row.version !== RECORD_VERSION ||
    typeof row.id !== "string" ||
    typeof row.authScope !== "string" ||
    !row.authScope.trim() ||
    row.authScope.includes("\0") ||
    typeof row.userDid !== "string" ||
    !row.userDid.trim() ||
    row.userDid.includes("\0") ||
    (row.network !== "mainnet" && row.network !== "testnet") ||
    typeof row.ownerAddress !== "string" ||
    !/^0x[0-9a-f]{40}$/.test(row.ownerAddress) ||
    typeof row.agentAddress !== "string" ||
    !/^0x[0-9a-f]{40}$/.test(row.agentAddress) ||
    !isUint8Array(row.salt) ||
    !isUint8Array(row.wrappedPrivateKey) ||
    typeof row.createdAt !== "number" ||
    !Number.isFinite(row.createdAt)
  ) return false;
  return row.id === pendingSlotId(row.authScope, row.userDid, row.network, row.ownerAddress);
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function isConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "ConstraintError");
}

async function addPendingRow(row: PendingWalletRow) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, "readwrite");
    const request = tx.objectStore(STORE_PENDING).add(row);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function getPendingRow(db: IDBDatabase, id: string) {
  return new Promise<unknown | null>((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, "readonly");
    const request = tx.objectStore(STORE_PENDING).get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function deleteRow(db: IDBDatabase, id: string) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, "readwrite");
    const request = tx.objectStore(STORE_PENDING).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function quarantineLegacyPendingRow(db: IDBDatabase, legacyId: string) {
  const row = await getPendingRow(db, legacyId);
  if (!row) return;
  await quarantinePendingRow(db, row, "legacy_or_ownerless_row");
}

function quarantinePendingRow(db: IDBDatabase, row: unknown, reason: string) {
  const sourceId = row && typeof row === "object" && "id" in row
    ? String(row.id)
    : "unknown";
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_PENDING, STORE_QUARANTINED], "readwrite");
    const pending = tx.objectStore(STORE_PENDING);
    const quarantined = tx.objectStore(STORE_QUARANTINED);
    quarantined.put({
      id: `quarantine:${sourceId}`,
      sourceId,
      reason,
      quarantinedAt: Date.now(),
      record: row,
    });
    pending.delete(sourceId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) return;

      const quarantine = db.objectStoreNames.contains(STORE_QUARANTINED)
        ? tx.objectStore(STORE_QUARANTINED)
        : db.createObjectStore(STORE_QUARANTINED, { keyPath: "id" });
      const pending = db.objectStoreNames.contains(STORE_PENDING)
        ? tx.objectStore(STORE_PENDING)
        : db.createObjectStore(STORE_PENDING, { keyPath: "id" });

      if (pending.indexNames.contains(LEGACY_INDEX_USER_NETWORK)) {
        pending.deleteIndex(LEGACY_INDEX_USER_NETWORK);
      }
      if (!pending.indexNames.contains(INDEX_EXACT_LANE)) {
        pending.createIndex(
          INDEX_EXACT_LANE,
          ["authScope", "userDid", "network", "ownerAddress"],
          { unique: true },
        );
      }

      const cursorRequest = pending.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (!isPendingWalletRow(cursor.value)) {
          const sourceId = String(cursor.primaryKey);
          quarantine.put({
            id: `quarantine:${sourceId}`,
            sourceId,
            reason: "legacy_or_ownerless_row",
            quarantinedAt: Date.now(),
            record: cursor.value,
          });
          cursor.delete();
        }
        cursor.continue();
      };
    };
  });
}

async function aesGcmWrap(key: Uint8Array, plaintext: Uint8Array) {
  const cryptoKey = await crypto.subtle.importKey("raw", arrayBuffer(key), "AES-GCM", false, ["encrypt"]);
  const nonce = randomBytes(NONCE_LENGTH);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: arrayBuffer(nonce), tagLength: 128 },
    cryptoKey,
    arrayBuffer(plaintext),
  ));
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce, 0);
  result.set(encrypted, nonce.length);
  return result;
}

async function aesGcmUnwrap(key: Uint8Array, wrapped: Uint8Array) {
  if (wrapped.length <= NONCE_LENGTH + 16) throw new Error("pending_wallet_ciphertext_invalid");
  const cryptoKey = await crypto.subtle.importKey("raw", arrayBuffer(key), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: arrayBuffer(wrapped.slice(0, NONCE_LENGTH)), tagLength: 128 },
    cryptoKey,
    arrayBuffer(wrapped.slice(NONCE_LENGTH)),
  ));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.length);
  new Uint8Array(result).set(bytes);
  return result;
}

function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function hexToBytes(value: string) {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("pending_wallet_key_invalid");
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
