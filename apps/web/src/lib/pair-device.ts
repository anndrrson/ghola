/**
 * Pair Device — wallet-to-wallet transfer of session DEKs over an
 * untrusted cloud mailbox.
 *
 * The flow is asymmetric. There is a **receiver** (a fresh browser that
 * needs to inherit the user's existing chat sessions) and a **sender**
 * (a browser already holding session DEKs in its
 * {@link SessionVault}).
 *
 * 1. The receiver calls {@link createReceiverHandshake} to generate an
 *    ephemeral X25519 keypair, a high-entropy mailbox id, and a small
 *    JSON descriptor that the UI encodes into a QR code.
 * 2. The sender calls {@link sendHandshake}, passing the receiver's
 *    QR-decoded descriptor, the user's vault, and a sealed-envelope
 *    signing callback (Turnkey in production, local key in tests). It
 *    builds an envelope addressed to the receiver's ephemeral pubkey
 *    and POSTs it to `/api/devices/handshake`.
 * 3. The receiver calls {@link awaitHandshake}, which polls the cloud
 *    until the envelope arrives, opens it with the ephemeral X25519
 *    secret, verifies the sender's signature against the **expected
 *    sender DID** (the receiver UI must show this DID and let the user
 *    confirm before importing — that's the only step where the cloud
 *    cannot impersonate), and imports each DEK into the receiver's
 *    vault.
 *
 * The cloud sees only opaque ciphertext + an unguessable id. See
 * `crates/thumper-cloud/src/routes/handshake.rs` for the server side
 * and `crates/said-envelope/src/lib.rs` for the wire format.
 */

import { ed25519, x25519 } from "@noble/curves/ed25519";

import {
  RecipientKind,
  didKeyFromVerifying,
  open as openEnvelope,
  seal as sealEnvelope,
  type SealOptions,
} from "./envelope";
import {
  SessionVault,
  VaultRecipientKind,
  type VaultRecipientKindByte,
} from "./session-vault";

const THUMPER_API_BASE =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_THUMPER_API_URL) ||
  "http://localhost:3000";

const HANDSHAKE_AD = new TextEncoder().encode("ghola/pair-device-v1");

// Server-side validate_id requires ≥16 decoded bytes; we go a little
// over to leave room for entropy growth.
const HANDSHAKE_ID_BYTES = 24;

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 110_000; // a bit under the server-side TTL

// ── Wire payload (envelope plaintext) ───────────────────────────────────

interface DekTransferPayload {
  /** Schema version. Bumps when the inner format changes. */
  v: 1;
  sessions: Array<{
    sessionId: string;
    /** Base64-encoded 32-byte DEK. */
    dekB64: string;
    recipientKind: VaultRecipientKindByte;
    /** Unix-ms when the original DEK was generated, for audit only. */
    createdAt: number;
  }>;
}

// ── Receiver: descriptor + await ────────────────────────────────────────

export interface HandshakeDescriptor {
  /** Schema version. */
  v: 1;
  /** The mailbox id the sender will POST to. */
  id: string;
  /** Receiver's ephemeral X25519 pubkey, base64url-no-pad. */
  ephemPubB64: string;
  /** The DID of the **expected sender** (the user's own DID). UIs MUST
   *  show this to the receiving user before any import — it's the only
   *  trust anchor the receiver has against a malicious cloud
   *  substituting a different envelope. */
  expectedSenderDid: string;
}

export interface ReceiverHandshake {
  /** Encoded descriptor — embed in a QR code or copy/paste fallback. */
  descriptor: HandshakeDescriptor;
  /** Receiver's ephemeral X25519 secret. Held in memory only; if the
   *  user navigates away before {@link awaitHandshake} resolves, the
   *  envelope cannot be recovered. */
  ephemSecret: Uint8Array;
}

/**
 * Generate a fresh receiver handshake. `userDid` is the
 * **expected sender DID** — the user's wallet DID on the existing
 * device — which the receiver pins so the cloud can't substitute a
 * different sender.
 */
export function createReceiverHandshake(userDid: string): ReceiverHandshake {
  const idBytes = new Uint8Array(HANDSHAKE_ID_BYTES);
  crypto.getRandomValues(idBytes);
  const id = b64urlEncode(idBytes);

  const ephemSecret = x25519.utils.randomPrivateKey();
  const ephemPub = x25519.getPublicKey(ephemSecret);

  return {
    descriptor: {
      v: 1,
      id,
      ephemPubB64: b64urlEncode(ephemPub),
      expectedSenderDid: userDid,
    },
    ephemSecret,
  };
}

export interface AwaitHandshakeOptions {
  receiver: ReceiverHandshake;
  vault: SessionVault;
  /** Signal to abort polling early (e.g. user closed the modal). */
  signal?: AbortSignal;
}

export interface AwaitHandshakeResult {
  /** How many session DEKs were imported into the vault. */
  imported: number;
  /** The DID of the sender (always equals
   *  `receiver.descriptor.expectedSenderDid` if verification passed). */
  senderDid: string;
}

/**
 * Poll the mailbox until the sender's envelope arrives. Verifies the
 * signature, decrypts, and imports every DEK into the vault.
 *
 * Throws if the envelope's `senderDid` does not match the receiver's
 * pinned `expectedSenderDid` — i.e. the cloud handed us an envelope
 * from someone other than the user's own wallet.
 */
export async function awaitHandshake(
  opts: AwaitHandshakeOptions,
): Promise<AwaitHandshakeResult> {
  const { receiver, vault, signal } = opts;
  const id = receiver.descriptor.id;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("handshake aborted");
    const wire = await pollOnce(id, signal);
    if (wire) {
      return importEnvelope(wire, receiver, vault);
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }
  throw new Error("handshake timed out");
}

async function importEnvelope(
  wire: Uint8Array,
  receiver: ReceiverHandshake,
  vault: SessionVault,
): Promise<AwaitHandshakeResult> {
  const opened = await openEnvelope(wire, receiver.ephemSecret);

  if (opened.senderDid !== receiver.descriptor.expectedSenderDid) {
    throw new Error(
      `unexpected sender DID: got ${opened.senderDid}, expected ${receiver.descriptor.expectedSenderDid}`,
    );
  }

  const json = new TextDecoder().decode(opened.plaintext);
  const payload = JSON.parse(json) as DekTransferPayload;
  if (payload.v !== 1 || !Array.isArray(payload.sessions)) {
    throw new Error("invalid Pair-Device payload format");
  }

  for (const s of payload.sessions) {
    const dek = b64urlDecode(s.dekB64);
    if (dek.length !== 32) {
      throw new Error(`invalid DEK length for session ${s.sessionId}`);
    }
    await vault.importSessionDek(s.sessionId, dek, s.recipientKind);
  }

  return { imported: payload.sessions.length, senderDid: opened.senderDid };
}

async function pollOnce(
  id: string,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const url = `${THUMPER_API_BASE}/api/devices/handshake/${encodeURIComponent(id)}`;
  const res = await fetch(url, { method: "GET", signal });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`handshake poll failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { envelope_b64: string };
  return b64urlDecode(data.envelope_b64);
}

// ── Sender ─────────────────────────────────────────────────────────────

export interface SendHandshakeOptions {
  /** Descriptor scanned from the receiver's QR code. */
  descriptor: HandshakeDescriptor;
  /** Sender's unlocked vault. The DEKs returned by
   *  {@link SessionVault.listSessions} are wrapped onto the wire. */
  vault: SessionVault;
  /** Sender's `did:key:z…`. MUST equal `descriptor.expectedSenderDid`
   *  on the receiving side, otherwise the receiver rejects the
   *  envelope. */
  senderDid: string;
  /** Sealed-envelope signing callback. Production passes Turnkey;
   *  tests pass a local Ed25519 signer
   *  (see {@link envelope.localEd25519Signer}). */
  signBody: SealOptions["signBody"];
  /** Optional whitelist; if omitted, every session in the vault is
   *  transferred. */
  sessionIds?: string[];
}

/**
 * Build a sealed envelope from the sender's session DEKs and POST it to
 * the cloud mailbox. Returns the count transferred.
 */
export async function sendHandshake(opts: SendHandshakeOptions): Promise<number> {
  const { descriptor, vault, senderDid, signBody, sessionIds } = opts;

  if (descriptor.v !== 1) {
    throw new Error(`unsupported handshake descriptor version: ${descriptor.v}`);
  }

  const ephemPub = b64urlDecode(descriptor.ephemPubB64);
  if (ephemPub.length !== 32) throw new Error("descriptor ephemPub is wrong length");

  const allSessions = await vault.listSessions();
  const wanted = sessionIds
    ? allSessions.filter((s) => sessionIds.includes(s.sessionId))
    : allSessions;

  const payload: DekTransferPayload = {
    v: 1,
    sessions: [],
  };
  for (const s of wanted) {
    const dek = await vault.getSessionDek(s.sessionId);
    if (!dek) continue; // raced with deletion — drop it
    payload.sessions.push({
      sessionId: s.sessionId,
      dekB64: b64urlEncode(dek),
      recipientKind: s.recipientKind,
      createdAt: s.createdAt,
    });
  }

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  // recipientId is the receiver's ephem pub serialized as
  // `ephem-x25519:<base64>`. It's used as part of the HKDF info string,
  // not as the X25519 ECDH input — that's the raw pub bytes. Keeping
  // a stable string lets the receiver bind the DEK to the descriptor it
  // generated.
  const recipientId = `ephem-x25519:${descriptor.ephemPubB64}`;

  const wire = await sealEnvelope({
    senderDid,
    recipientId,
    recipientX25519: ephemPub,
    kind: RecipientKind.PeerDid,
    associatedData: HANDSHAKE_AD,
    plaintext,
    signBody,
  });

  const res = await fetch(`${THUMPER_API_BASE}/api/devices/handshake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: descriptor.id,
      envelope_b64: b64urlEncode(wire),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`handshake POST failed (${res.status}): ${body}`);
  }

  return payload.sessions.length;
}

// ── helpers ────────────────────────────────────────────────────────────

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa produces standard base64; convert to URL-safe no-pad.
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? padded : padded + "=".repeat(4 - (padded.length % 4));
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

// `_unused` so eslint doesn't flag the imports purely for type usage.
type _unused = typeof ed25519 | VaultRecipientKindByte;
void VaultRecipientKind; // referenced for re-export discoverability
