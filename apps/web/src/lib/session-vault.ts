/**
 * IndexedDB-backed session vault.
 *
 * Holds two kinds of secret material per Turnkey DID:
 *   - a 32-byte **master KEK** that wraps every other secret in the vault
 *   - a 32-byte **session DEK** per chat `session_id`, used as the AES-256-GCM
 *     key for that session's message content
 *
 * ## Why a KEK at all (vs deriving everything from the Turnkey signature)
 * The KEK is a layer of indirection so DEK rotation, future recovery
 * methods, or a Pair-Device-imported DEK can all coexist without
 * changing the unlock primitive. The KEK itself never leaves the
 * browser; it lives encrypted in IndexedDB and decrypted in memory only
 * after `unlock()` succeeds.
 *
 * ## Unlock primitive — "tap your wallet"
 * Ed25519 signatures (per RFC 8032 §5.1.6) are deterministic for a given
 * `(secret_key, message)`. So the vault stores
 *   `wrappedKek = AES-GCM(HKDF(sig, salt, info), kek)`
 * where `sig = turnkey.signMessage("ghola-vault-unlock-v1\0" || userDid)`.
 * Re-signing the same challenge produces the same signature, the same
 * HKDF output, and unwraps the KEK — no passphrase, no server, no
 * recoverable backdoor. If the user loses their Turnkey access they
 * lose their vault; recovery is wallet-to-wallet via Pair Device.
 *
 * ## Threat model
 * - **Cloud / Postgres / network**: see only ciphertext. Cannot derive
 *   any DEK without the user's Turnkey signature.
 * - **Other tabs / extensions on the same origin**: subject to standard
 *   browser isolation. We do NOT defend against malicious browser
 *   extensions with the same-origin permission — that is a host-level
 *   problem, not solvable in JS.
 * - **A stolen IndexedDB dump**: useless without a Turnkey signature on
 *   the unlock challenge. Argon2/scrypt-style brute-force resistance is
 *   irrelevant: there is no password to guess, and Turnkey rate-limits
 *   signing attempts.
 */

import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

// ── Constants ───────────────────────────────────────────────────────────

const DB_NAME = "ghola-session-vault";
const DB_VERSION = 1;
const STORE_KEK = "master_keks";
const STORE_DEK = "session_deks";

const KEK_LEN = 32;
const DEK_LEN = 32;
const NONCE_LEN = 12;
const SALT_LEN = 16;

const UNLOCK_CHALLENGE_PREFIX = new TextEncoder().encode("ghola-vault-unlock-v1\0");
const KEK_WRAP_HKDF_SALT = new TextEncoder().encode("ghola-vault-kek-v1");

/** Recipient kinds mirror said-envelope/RecipientKind. */
export const VaultRecipientKind = {
  SelfRecipient: 0x00,
  PeerDid: 0x01,
  ModelBridge: 0x02,
} as const;
export type VaultRecipientKindByte =
  (typeof VaultRecipientKind)[keyof typeof VaultRecipientKind];

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

// ── IndexedDB row shapes ─────────────────────────────────────────────────

interface MasterKekRow {
  /** Turnkey wallet DID (`did:key:z…`). Primary key. */
  userDid: string;
  /** Per-device random salt mixed into the unlock-key derivation. Stops
   *  cross-device wrapping-key collisions even if the same Ed25519
   *  signature is somehow observable. */
  salt: Uint8Array;
  /** AES-GCM(unlockKey, kek): nonce(12) || ct || tag(16). */
  wrappedKek: Uint8Array;
  /** Format/version tag; v1 for this layout. */
  v: number;
  /** Unix milliseconds at first creation, for diagnostics only. */
  createdAt: number;
}

interface SessionDekRow {
  userDid: string;
  sessionId: string;
  /** AES-GCM(masterKek, dek): nonce(12) || ct || tag(16). */
  wrappedDek: Uint8Array;
  recipientKind: VaultRecipientKindByte;
  createdAt: number;
}

// ── Public types ────────────────────────────────────────────────────────

export interface SessionMeta {
  sessionId: string;
  recipientKind: VaultRecipientKindByte;
  createdAt: number;
}

/**
 * Signs an arbitrary byte sequence with the user's identity Ed25519 key.
 * Production callers route through Turnkey
 * (`apps/web/src/lib/turnkey-provider.tsx`), which signs server-side and
 * returns a 64-byte Ed25519 signature. Tests pass a local-key signer.
 */
export type SignBytes = (message: Uint8Array) => Promise<Uint8Array>;

// ── Vault API ───────────────────────────────────────────────────────────

export class SessionVault {
  private masterKek: Uint8Array | null = null;
  private readonly userDid: string;

  /** Construct a vault scoped to a specific Turnkey DID. Use
   *  {@link unlock} before any other method — every operation requires a
   *  master KEK in memory. */
  constructor(userDid: string) {
    if (!userDid) throw new VaultError("userDid required");
    this.userDid = userDid;
  }

  isUnlocked(): boolean {
    return this.masterKek !== null;
  }

  /**
   * Unlock (or initialize) the vault for `userDid`. Requires `signBytes`
   * to be a function that signs an arbitrary byte sequence with the
   * user's Ed25519 identity key — Turnkey for production, an in-memory
   * key for tests. Idempotent within a single browser session.
   */
  async unlock(signBytes: SignBytes): Promise<void> {
    if (this.masterKek) return;

    const db = await openDb();
    const existing = await getRow<MasterKekRow>(db, STORE_KEK, this.userDid);

    if (existing) {
      this.masterKek = await unwrapKek(existing, this.userDid, signBytes);
    } else {
      // First-time setup for this DID on this device.
      const salt = randomBytes(SALT_LEN);
      const kek = randomBytes(KEK_LEN);
      const wrappedKek = await wrapKek(kek, this.userDid, salt, signBytes);
      const row: MasterKekRow = {
        userDid: this.userDid,
        salt,
        wrappedKek,
        v: 1,
        createdAt: Date.now(),
      };
      await putRow(db, STORE_KEK, row);
      this.masterKek = kek;
    }
  }

  /** Zero the in-memory KEK. The wrapped KEK in IndexedDB is unchanged. */
  lock(): void {
    if (this.masterKek) {
      this.masterKek.fill(0);
      this.masterKek = null;
    }
  }

  /**
   * Generate a fresh 32-byte session DEK, persist it under the master
   * KEK, and return the plaintext DEK to the caller. Throws if the
   * vault is locked, or if a DEK already exists for `sessionId` (use
   * {@link getSessionDek} to fetch existing ones).
   */
  async createSessionDek(
    sessionId: string,
    recipientKind: VaultRecipientKindByte = VaultRecipientKind.SelfRecipient,
  ): Promise<Uint8Array> {
    this.requireUnlocked();
    const db = await openDb();
    const existing = await getDekRow(db, this.userDid, sessionId);
    if (existing) throw new VaultError(`session DEK already exists: ${sessionId}`);

    const dek = randomBytes(DEK_LEN);
    await this.persistDek(db, sessionId, dek, recipientKind);
    return dek;
  }

  /**
   * Look up an existing session DEK and return the plaintext key. Returns
   * `null` if the session is unknown to this vault (caller should fall
   * back to the legacy plaintext path or trigger a Pair-Device sync).
   */
  async getSessionDek(sessionId: string): Promise<Uint8Array | null> {
    this.requireUnlocked();
    const db = await openDb();
    const row = await getDekRow(db, this.userDid, sessionId);
    if (!row) return null;
    return aesGcmUnwrap(this.masterKek!, row.wrappedDek);
  }

  /**
   * Import a session DEK received from another device (via Pair
   * Device). Overwrites any existing DEK for the same `sessionId`.
   */
  async importSessionDek(
    sessionId: string,
    dek: Uint8Array,
    recipientKind: VaultRecipientKindByte = VaultRecipientKind.SelfRecipient,
  ): Promise<void> {
    this.requireUnlocked();
    if (dek.length !== DEK_LEN) throw new VaultError("DEK must be 32 bytes");
    const db = await openDb();
    await this.persistDek(db, sessionId, dek, recipientKind);
  }

  /** Drop a session DEK from the vault. The corresponding ciphertext on
   *  the server is unaffected — without the DEK it just becomes opaque
   *  bytes. */
  async deleteSession(sessionId: string): Promise<void> {
    this.requireUnlocked();
    const db = await openDb();
    await deleteRow(db, STORE_DEK, [this.userDid, sessionId]);
  }

  /** Enumerate every session this vault has a DEK for. */
  async listSessions(): Promise<SessionMeta[]> {
    this.requireUnlocked();
    const db = await openDb();
    const rows = await listRows<SessionDekRow>(db, STORE_DEK, this.userDid);
    return rows.map((r) => ({
      sessionId: r.sessionId,
      recipientKind: r.recipientKind,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Wipe **everything** for `userDid`: the master KEK row and every
   * session DEK. After this the user's only path back into their old
   * sessions is via Pair Device from a device that still holds them.
   */
  async wipe(): Promise<void> {
    this.lock();
    const db = await openDb();
    await deleteRow(db, STORE_KEK, this.userDid);
    const rows = await listRows<SessionDekRow>(db, STORE_DEK, this.userDid);
    await Promise.all(
      rows.map((r) => deleteRow(db, STORE_DEK, [this.userDid, r.sessionId])),
    );
  }

  // ── private ───────────────────────────────────────────────────────────

  private requireUnlocked() {
    if (!this.masterKek) throw new VaultError("vault is locked");
  }

  private async persistDek(
    db: IDBDatabase,
    sessionId: string,
    dek: Uint8Array,
    recipientKind: VaultRecipientKindByte,
  ): Promise<void> {
    const wrappedDek = await aesGcmWrap(this.masterKek!, dek);
    const row: SessionDekRow = {
      userDid: this.userDid,
      sessionId,
      wrappedDek,
      recipientKind,
      createdAt: Date.now(),
    };
    await putRow(db, STORE_DEK, row);
  }
}

// ── KEK wrapping ────────────────────────────────────────────────────────

async function deriveKekWrappingKey(
  sig: Uint8Array,
  userDid: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  // info = userDid || "/" || salt — binding the wrapping key to both the
  // user's DID (so different DIDs on the same device get different keys)
  // and the per-device salt (so the same DID across devices gets
  // different keys).
  const userBytes = new TextEncoder().encode(userDid + "/");
  const info = new Uint8Array(userBytes.length + salt.length);
  info.set(userBytes, 0);
  info.set(salt, userBytes.length);
  return hkdf(sha256, sig, KEK_WRAP_HKDF_SALT, info, 32);
}

async function unlockChallenge(userDid: string, salt: Uint8Array): Promise<Uint8Array> {
  // The challenge bytes are not secret; their role is to ensure the
  // signature is unique to (vault unlock × user DID × device).
  const userBytes = new TextEncoder().encode(userDid);
  const out = new Uint8Array(
    UNLOCK_CHALLENGE_PREFIX.length + userBytes.length + salt.length,
  );
  out.set(UNLOCK_CHALLENGE_PREFIX, 0);
  out.set(userBytes, UNLOCK_CHALLENGE_PREFIX.length);
  out.set(salt, UNLOCK_CHALLENGE_PREFIX.length + userBytes.length);
  return out;
}

async function wrapKek(
  kek: Uint8Array,
  userDid: string,
  salt: Uint8Array,
  signBytes: SignBytes,
): Promise<Uint8Array> {
  const challenge = await unlockChallenge(userDid, salt);
  const sig = await signBytes(challenge);
  if (sig.length !== 64) throw new VaultError("expected 64-byte Ed25519 signature");
  const wrappingKey = await deriveKekWrappingKey(sig, userDid, salt);
  return aesGcmWrap(wrappingKey, kek);
}

async function unwrapKek(
  row: MasterKekRow,
  userDid: string,
  signBytes: SignBytes,
): Promise<Uint8Array> {
  const challenge = await unlockChallenge(userDid, row.salt);
  const sig = await signBytes(challenge);
  if (sig.length !== 64) throw new VaultError("expected 64-byte Ed25519 signature");
  const wrappingKey = await deriveKekWrappingKey(sig, userDid, row.salt);
  try {
    return await aesGcmUnwrap(wrappingKey, row.wrappedKek);
  } catch {
    throw new VaultError(
      "vault unlock failed — Turnkey may have rotated the wallet's signing key, or this row is from a different DID",
    );
  }
}

// ── AES-GCM helpers ─────────────────────────────────────────────────────

function bs(arr: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(arr.byteLength);
  new Uint8Array(out).set(arr);
  return out;
}

async function aesGcmWrap(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    bs(key),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const nonce = randomBytes(NONCE_LEN);
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bs(nonce), tagLength: 128 },
    cryptoKey,
    bs(plaintext),
  );
  const ct = new Uint8Array(ctBuf);
  const out = new Uint8Array(NONCE_LEN + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_LEN);
  return out;
}

async function aesGcmUnwrap(key: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < NONCE_LEN + 16) throw new VaultError("wrapped blob too short");
  const nonce = blob.slice(0, NONCE_LEN);
  const ct = blob.slice(NONCE_LEN);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    bs(key),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const ptBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bs(nonce), tagLength: 128 },
    cryptoKey,
    bs(ct),
  );
  return new Uint8Array(ptBuf);
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

// ── IndexedDB plumbing ──────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (ev) => {
      const db = (ev.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_KEK)) {
        db.createObjectStore(STORE_KEK, { keyPath: "userDid" });
      }
      if (!db.objectStoreNames.contains(STORE_DEK)) {
        const store = db.createObjectStore(STORE_DEK, {
          keyPath: ["userDid", "sessionId"],
        });
        store.createIndex("by_user", "userDid");
      }
    };
  });
}

function getRow<T>(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function getDekRow(
  db: IDBDatabase,
  userDid: string,
  sessionId: string,
): Promise<SessionDekRow | undefined> {
  return getRow<SessionDekRow>(db, STORE_DEK, [userDid, sessionId]);
}

function putRow<T>(db: IDBDatabase, store: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).put(value as object);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function deleteRow(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function listRows<T>(
  db: IDBDatabase,
  store: string,
  userDid: string,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const idx = tx.objectStore(store).index("by_user");
    const req = idx.getAll(IDBKeyRange.only(userDid));
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}
