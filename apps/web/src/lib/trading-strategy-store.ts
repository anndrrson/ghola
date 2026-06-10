import {
  RecipientKind,
  open as openEnvelope,
  seal as sealEnvelope,
} from "./envelope";
import type { ChatVault } from "./chat-vault";
import { deriveVaultX25519Keypair } from "./vault-x25519";
import type { TradingStrategyRecord } from "./trading-strategy";

const DB_NAME = "ghola-trading-strategies";
const DB_VERSION = 1;
const STORE = "strategies_blob";
const AD = new TextEncoder().encode("ghola/trading-strategies-v1");

interface BlobRow {
  userDid: string;
  blob: Uint8Array;
  v: number;
}

export async function loadTradingStrategies(
  vault: ChatVault | null,
): Promise<TradingStrategyRecord[]> {
  if (!vault) return [];
  const row = await getRow(vault.userDid);
  if (!row) return [];
  return (await decryptBlob(row, vault)) ?? [];
}

export async function saveTradingStrategies(
  strategies: TradingStrategyRecord[],
  vault: ChatVault | null,
): Promise<void> {
  if (!vault) return;
  await vault.ensureUnlocked();
  const blob = await encryptStrategies(strategies, vault);
  await putRow({ userDid: vault.userDid, blob, v: 1 });
}

async function encryptStrategies(
  strategies: TradingStrategyRecord[],
  vault: ChatVault,
): Promise<Uint8Array> {
  const recipient = await deriveVaultX25519Keypair(vault.signBytes);
  const plaintext = new TextEncoder().encode(JSON.stringify(strategies));
  return sealEnvelope({
    senderDid: vault.userDid,
    recipientId: vault.userDid,
    recipientX25519: recipient.publicKey,
    kind: RecipientKind.SelfRecipient,
    associatedData: AD,
    plaintext,
    signBody: async (bytes) => vault.signBytes(bytes),
  });
}

async function decryptBlob(
  row: BlobRow,
  vault: ChatVault,
): Promise<TradingStrategyRecord[] | null> {
  await vault.ensureUnlocked();
  const recipient = await deriveVaultX25519Keypair(vault.signBytes);
  try {
    const opened = await openEnvelope(row.blob, recipient.secret);
    const parsed = JSON.parse(
      new TextDecoder().decode(opened.plaintext),
    ) as TradingStrategyRecord[];
    return normalizeStrategies(parsed);
  } catch {
    return null;
  }
}

function normalizeStrategies(
  strategies: TradingStrategyRecord[],
): TradingStrategyRecord[] {
  if (!Array.isArray(strategies)) return [];
  return strategies.filter((strategy) => {
    return (
      typeof strategy?.id === "string" &&
      typeof strategy.source === "string" &&
      typeof strategy.review_summary === "string" &&
      typeof strategy.policy?.strategy_id === "string"
    );
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (ev) => {
      const db = (ev.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "userDid" });
      }
    };
  });
}

async function getRow(userDid: string): Promise<BlobRow | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(userDid);
    req.onsuccess = () => resolve(req.result as BlobRow | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function putRow(row: BlobRow): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).put(row);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
