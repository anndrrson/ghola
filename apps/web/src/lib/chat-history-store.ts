/**
 * Encrypted-at-rest local storage for the chat session list.
 *
 * Replaces the previous `localStorage["ghola_sessions"]` path: when the
 * user has a Turnkey wallet and the session vault is unlocked, the full
 * ThumperSession[] is sealed in the same self-recipient envelope shape
 * that user messages use, then persisted into IndexedDB. A page-side
 * dump of the DB now reveals only ciphertext.
 *
 * On first read we transparently migrate any pre-existing
 * `localStorage["ghola_sessions"]` blob into the encrypted store, then
 * delete the localStorage key. After migration the only on-disk
 * artifact is the encrypted blob.
 *
 * The vault-locked path is opt-in: if {@link ChatVault} is `null` (no
 * Turnkey wallet, vault unlock declined, etc.) we fall back to the
 * legacy localStorage path so chat keeps working.
 */

import {
  RecipientKind,
  open as openEnvelope,
  seal as sealEnvelope,
} from "./envelope";
import type { ChatVault } from "./chat-vault";
import type { ThumperSession } from "./thumper-types";
import { deriveVaultX25519Keypair } from "./vault-x25519";

const LEGACY_KEY = "ghola_sessions";
const DB_NAME = "ghola-chat-history";
const DB_VERSION = 1;
const STORE = "sessions_blob";
const AD = new TextEncoder().encode("ghola/chat-history-v1");

interface BlobRow {
  /** Turnkey wallet DID (`did:key:z…`). Primary key. */
  userDid: string;
  /** Wire-format envelope bytes. */
  blob: Uint8Array;
  /** Format/version tag. */
  v: number;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Read the user's chat session list. Tries the encrypted store first,
 * falls back to legacy plaintext localStorage. Migrates legacy
 * plaintext into the encrypted store on first successful read.
 *
 * Returns `[]` if nothing is stored or the user has no vault.
 */
export async function loadSessions(vault: ChatVault | null): Promise<ThumperSession[]> {
  if (!vault) return readLocalStorageLegacy();

  // Fast path: encrypted store has data.
  const row = await getRow(vault.userDid);
  if (row) {
    const sessions = await decryptBlob(row, vault);
    if (sessions) return sessions;
    // Decrypt failure → leave the row alone (user may need to
    // pair-device to recover); fall back to whatever legacy data
    // exists rather than show a blank screen.
  }

  // Migration path: legacy plaintext localStorage exists. Read, write
  // ciphertext, then drop the legacy key.
  const legacy = readLocalStorageLegacy();
  if (legacy.length > 0) {
    try {
      await saveSessions(legacy, vault);
      // Only drop the legacy blob once the encrypted write succeeds.
      if (typeof window !== "undefined") {
        localStorage.removeItem(LEGACY_KEY);
      }
    } catch {
      // Best-effort migration; if it fails we just don't drop the
      // legacy key and continue serving plaintext.
    }
  }
  return legacy;
}

/**
 * Persist the user's chat session list. Writes ciphertext to IndexedDB
 * when the vault is available; falls back to localStorage otherwise.
 */
export async function saveSessions(
  sessions: ThumperSession[],
  vault: ChatVault | null,
): Promise<void> {
  if (!vault) {
    writeLocalStorageLegacy(sessions);
    return;
  }
  await vault.ensureUnlocked();
  const blob = await encryptSessions(sessions, vault);
  await putRow({ userDid: vault.userDid, blob, v: 1 });
}

// ── Encrypted blob helpers ─────────────────────────────────────────────

async function encryptSessions(
  sessions: ThumperSession[],
  vault: ChatVault,
): Promise<Uint8Array> {
  // The recipient X25519 keypair is derived from a fixed Turnkey-
  // signed challenge — see vault-x25519.ts. Same derivation runs on
  // both sides so the user can read back their own data.
  const recipient = await deriveVaultX25519Keypair(vault.signBytes);
  const plaintext = new TextEncoder().encode(JSON.stringify(sessions));
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

async function decryptBlob(row: BlobRow, vault: ChatVault): Promise<ThumperSession[] | null> {
  await vault.ensureUnlocked();
  const recipient = await deriveVaultX25519Keypair(vault.signBytes);
  try {
    const opened = await openEnvelope(row.blob, recipient.secret);
    return JSON.parse(new TextDecoder().decode(opened.plaintext)) as ThumperSession[];
  } catch {
    return null;
  }
}

// ── IndexedDB plumbing ──────────────────────────────────────────────────

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

// ── Legacy localStorage paths ───────────────────────────────────────────

function readLocalStorageLegacy(): ThumperSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ThumperSession[];
  } catch {
    return [];
  }
}

function writeLocalStorageLegacy(sessions: ThumperSession[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(LEGACY_KEY, JSON.stringify(sessions));
}
