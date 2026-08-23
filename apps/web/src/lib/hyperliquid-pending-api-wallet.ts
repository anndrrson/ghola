import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import {
  generateHyperliquidApiWallet,
  hyperliquidApiWalletAddress,
} from "./hyperliquid-api-wallet";
import type { SignBytes } from "./session-vault";

const DB_NAME = "ghola-hyperliquid-pending-wallets";
const DB_VERSION = 1;
const STORE_PENDING = "pending_wallets";
const INDEX_USER_NETWORK = "by_user_network";
const RECORD_VERSION = 1;
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;
const WRAP_CONTEXT = new TextEncoder().encode("ghola-hyperliquid-pending-wallet-wrap-v1");

type Network = "mainnet" | "testnet";

type PendingWalletRow = {
  version: 1;
  id: string;
  userDid: string;
  network: Network;
  ownerAddress: string;
  agentAddress: string;
  salt: Uint8Array;
  wrappedPrivateKey: Uint8Array;
  createdAt: number;
};

export type PendingHyperliquidApiWallet = {
  network: Network;
  ownerAddress: string;
  agentAddress: string;
  privateKey: `0x${string}`;
  createdAt: number;
  resumed: boolean;
  ownerConflict: boolean;
};

export async function resumePendingHyperliquidApiWallet(input: {
  userDid: string;
  network: Network;
  signBytes: SignBytes;
}): Promise<PendingHyperliquidApiWallet | null> {
  const rows = await pendingRows(input.userDid, input.network);
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new Error("multiple_pending_hyperliquid_wallets");
  return openPendingRow(rows[0], input.signBytes, true, false);
}

export async function resumeOrCreatePendingHyperliquidApiWallet(input: {
  userDid: string;
  network: Network;
  ownerAddress: string;
  signBytes: SignBytes;
}): Promise<PendingHyperliquidApiWallet> {
  const userDid = input.userDid.trim();
  const ownerAddress = normalizeOwnerAddress(input.ownerAddress);
  if (!userDid) throw new Error("pending_wallet_identity_required");

  const existing = await pendingRows(userDid, input.network);
  if (existing.length > 1) throw new Error("multiple_pending_hyperliquid_wallets");
  if (existing.length === 1) {
    return openPendingRow(
      existing[0],
      input.signBytes,
      true,
      existing[0].ownerAddress !== ownerAddress,
    );
  }

  const generated = generateHyperliquidApiWallet();
  const privateKey = hexToBytes(generated.privateKey);
  const salt = randomBytes(KEY_LENGTH);
  const wrappingKey = await deriveWrappingKey({
    userDid,
    network: input.network,
    ownerAddress,
    salt,
    signBytes: input.signBytes,
  });
  const row: PendingWalletRow = {
    version: RECORD_VERSION,
    id: pendingSlotId(userDid, input.network),
    userDid,
    network: input.network,
    ownerAddress,
    agentAddress: generated.address.toLowerCase(),
    salt,
    wrappedPrivateKey: await aesGcmWrap(wrappingKey, privateKey),
    createdAt: Date.now(),
  };
  try {
    await addPendingRow(row);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "ConstraintError") throw error;
    const raced = await pendingRows(userDid, input.network);
    if (raced.length !== 1) throw new Error("pending_wallet_race_unresolved");
    privateKey.fill(0);
    wrappingKey.fill(0);
    return openPendingRow(raced[0], input.signBytes, true, raced[0].ownerAddress !== ownerAddress);
  }
  privateKey.fill(0);
  wrappingKey.fill(0);
  return openPendingRow(row, input.signBytes, false, false);
}

export async function clearPendingHyperliquidApiWallet(input: {
  userDid: string;
  network: Network;
  ownerAddress: string;
}): Promise<void> {
  const userDid = input.userDid.trim();
  const ownerAddress = normalizeOwnerAddress(input.ownerAddress);
  const db = await openDb();
  const id = pendingSlotId(userDid, input.network);
  const row = await getPendingRow(db, id);
  if (!row) return;
  if (row.ownerAddress !== ownerAddress) throw new Error("pending_wallet_owner_mismatch");
  await deleteRow(db, id);
}

async function openPendingRow(
  row: PendingWalletRow,
  signBytes: SignBytes,
  resumed: boolean,
  ownerConflict: boolean,
): Promise<PendingHyperliquidApiWallet> {
  if (row.version !== RECORD_VERSION) throw new Error("pending_wallet_version_unsupported");
  const wrappingKey = await deriveWrappingKey({
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
    ownerConflict,
  };
}

async function deriveWrappingKey(input: {
  userDid: string;
  network: Network;
  ownerAddress: string;
  salt: Uint8Array;
  signBytes: SignBytes;
}) {
  const identity = new TextEncoder().encode(
    `${input.userDid}\0${input.network}\0${input.ownerAddress}\0`,
  );
  const challenge = new Uint8Array(WRAP_CONTEXT.length + identity.length + input.salt.length);
  challenge.set(WRAP_CONTEXT, 0);
  challenge.set(identity, WRAP_CONTEXT.length);
  challenge.set(input.salt, WRAP_CONTEXT.length + identity.length);
  const signature = await input.signBytes(challenge);
  if (signature.length !== 64) throw new Error("pending_wallet_signature_invalid");
  return hkdf(sha256, signature, input.salt, WRAP_CONTEXT, KEY_LENGTH);
}

function normalizeOwnerAddress(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("pending_wallet_owner_invalid");
  }
  return normalized;
}

function pendingSlotId(userDid: string, network: Network) {
  return `${userDid}\0${network}`;
}

async function pendingRows(userDid: string, network: Network): Promise<PendingWalletRow[]> {
  const normalizedDid = userDid.trim();
  if (!normalizedDid) throw new Error("pending_wallet_identity_required");
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, "readonly");
    const request = tx.objectStore(STORE_PENDING)
      .index(INDEX_USER_NETWORK)
      .getAll(IDBKeyRange.only([normalizedDid, network]));
    request.onsuccess = () => resolve((request.result || []) as PendingWalletRow[]);
    request.onerror = () => reject(request.error);
  });
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
  return new Promise<PendingWalletRow | null>((resolve, reject) => {
    const tx = db.transaction(STORE_PENDING, "readonly");
    const request = tx.objectStore(STORE_PENDING).get(id);
    request.onsuccess = () => resolve((request.result as PendingWalletRow | undefined) || null);
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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PENDING)) {
        const store = db.createObjectStore(STORE_PENDING, { keyPath: "id" });
        store.createIndex(INDEX_USER_NETWORK, ["userDid", "network"], { unique: false });
      }
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
