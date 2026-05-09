/**
 * Sealed envelope v1 — Web Crypto port of `crates/said-envelope`.
 *
 * Wire format must remain byte-identical to the Rust crate; vector tests
 * live with the Rust crate (`crates/said-envelope/tests/vectors.json`,
 * coming with the streaming-protocol PR). For now this module is the
 * foundation: `seal()` produces wire bytes, `open()` consumes them, and
 * the helper conversions mirror `said-core::mesh::ed25519_to_x25519_*`.
 *
 * ## Why no JS AES library
 * AES-256-GCM, HKDF-SHA256, and SHA-256 are all native to Web Crypto.
 * X25519 ECDH is not universally available via Web Crypto yet, so we
 * delegate to `@noble/curves` (already in the bundle transitively via
 * `@solana/web3.js`/`@turnkey/*`).
 *
 * ## Identity vs content keys
 * - Sender identity (signing): in production, the wallet holds the
 *   Ed25519 private key inside Turnkey. This module accepts a
 *   `signMessage(bytes) => Promise<Uint8Array>` callback so the caller
 *   plugs in Turnkey directly. Tests here use an in-browser ephemeral
 *   key for round-tripping.
 * - Per-envelope content key: derived via X25519 ECDH between the
 *   sender's per-envelope ephemeral and the recipient's long-lived
 *   X25519 public key (which is itself the Edwards→Montgomery image of
 *   the recipient's Ed25519 wallet pubkey).
 */

import { ed25519, x25519, edwardsToMontgomeryPub } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
// Lightweight bs58 — already a direct dep.
import bs58 from "bs58";

// ── Wire constants (must mirror said-envelope/src/lib.rs) ──
export const MAGIC = new Uint8Array([0x53, 0x45, 0x76, 0x31]); // "SEv1"
export const VERSION = 0x01;
export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const EPHEM_PUB_LEN = 32;
export const SIGNATURE_LEN = 64;
const HKDF_INFO_PREFIX = new TextEncoder().encode("said-envelope-v1/");

const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);

export const RecipientKind = {
  SelfRecipient: 0x00,
  PeerDid: 0x01,
  ModelBridge: 0x02,
} as const;
export type RecipientKindByte = (typeof RecipientKind)[keyof typeof RecipientKind];

export interface SealOptions {
  /** `did:key:z…` of the sender (Ed25519 multicodec). */
  senderDid: string;
  /** `did:key:z…` of the recipient, OR an opaque model-id when `kind = ModelBridge`. */
  recipientId: string;
  /** X25519 public key the ephemeral DH targets. 32 bytes. */
  recipientX25519: Uint8Array;
  kind: RecipientKindByte;
  /** Associated data, authenticated but not encrypted. */
  associatedData: Uint8Array;
  /** Plaintext bytes to encrypt. */
  plaintext: Uint8Array;
  /**
   * Sign the body bytes (header + ciphertext, before the trailing 64-byte
   * signature) with the sender's Ed25519 identity key. Production callers
   * pass Turnkey here; tests pass a local-key signer.
   */
  signBody: (bodyBytes: Uint8Array) => Promise<Uint8Array>;
}

export interface Opened {
  kind: RecipientKindByte;
  senderDid: string;
  recipientId: string;
  associatedData: Uint8Array;
  plaintext: Uint8Array;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

// ── did:key helpers ─────────────────────────────────────────────────────

/** Encode a 32-byte Ed25519 verifying key as a `did:key:z…` string. */
export function didKeyFromVerifying(pub: Uint8Array): string {
  if (pub.length !== 32) throw new EnvelopeError("Ed25519 pub must be 32 bytes");
  const buf = new Uint8Array(2 + 32);
  buf.set(ED25519_MULTICODEC, 0);
  buf.set(pub, 2);
  return "did:key:z" + bs58.encode(buf);
}

/** Decode a `did:key:z…` string into the Ed25519 verifying key bytes. */
export function verifyingFromDidKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) throw new EnvelopeError("not a did:key");
  const rest = did.slice("did:key:z".length);
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(rest);
  } catch {
    throw new EnvelopeError("invalid base58 in did:key");
  }
  if (bytes.length !== 2 + 32) throw new EnvelopeError("did:key wrong length");
  if (bytes[0] !== ED25519_MULTICODEC[0] || bytes[1] !== ED25519_MULTICODEC[1]) {
    throw new EnvelopeError("did:key not Ed25519 multicodec");
  }
  return bytes.slice(2);
}

/** Map an Ed25519 verifying key to its X25519 (Montgomery) form. */
export function edwardsPubToX25519(pub: Uint8Array): Uint8Array {
  return edwardsToMontgomeryPub(pub);
}

// ── DEK derivation (matches Rust derive_dek) ────────────────────────────

function deriveDek(sharedSecret: Uint8Array, recipientId: string): Uint8Array {
  // salt = MAGIC || VERSION
  const salt = new Uint8Array(MAGIC.length + 1);
  salt.set(MAGIC, 0);
  salt[MAGIC.length] = VERSION;

  // info = "said-envelope-v1/" || recipient_id
  const recipientBytes = new TextEncoder().encode(recipientId);
  const info = new Uint8Array(HKDF_INFO_PREFIX.length + recipientBytes.length);
  info.set(HKDF_INFO_PREFIX, 0);
  info.set(recipientBytes, HKDF_INFO_PREFIX.length);

  return hkdf(sha256, sharedSecret, salt, info, 32);
}

// ── Wire encoding helpers ───────────────────────────────────────────────

function writeU16BE(buf: number[], n: number, field: string) {
  if (n < 0 || n > 0xffff) throw new EnvelopeError(`length overflow: ${field}`);
  buf.push((n >>> 8) & 0xff, n & 0xff);
}

function writeU32BE(buf: number[], n: number, field: string) {
  if (n < 0 || n > 0xffffffff) throw new EnvelopeError(`length overflow: ${field}`);
  buf.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

class Cursor {
  constructor(public buf: Uint8Array, public pos = 0) {}
  take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new EnvelopeError("truncated");
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }
  u16(): number {
    const b = this.take(2);
    return (b[0] << 8) | b[1];
  }
  u32(): number {
    const b = this.take(4);
    // `>>> 0` to keep it unsigned across the 31-bit boundary.
    return (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
  }
}

// ── seal / open ─────────────────────────────────────────────────────────

/**
 * Encrypt + sign a single envelope frame. Returns the wire bytes.
 *
 * The signing step is delegated to `opts.signBody` so production callers
 * can route through Turnkey while tests pass a local Ed25519 signer.
 */
export async function seal(opts: SealOptions): Promise<Uint8Array> {
  if (opts.recipientX25519.length !== EPHEM_PUB_LEN) {
    throw new EnvelopeError("recipient X25519 pub must be 32 bytes");
  }

  // Per-envelope ephemeral X25519 keypair.
  const ephemPriv = x25519.utils.randomPrivateKey();
  const ephemPub = x25519.getPublicKey(ephemPriv);
  const shared = x25519.getSharedSecret(ephemPriv, opts.recipientX25519);
  const dek = deriveDek(shared, opts.recipientId);

  // Encrypt plaintext under the DEK with a fresh CSPRNG nonce.
  const nonceBytes = new Uint8Array(NONCE_LEN);
  crypto.getRandomValues(nonceBytes);
  const ciphertext = await aesGcmEncrypt(dek, nonceBytes, opts.associatedData, opts.plaintext);

  // Build the body (everything that gets signed).
  const senderDidBytes = new TextEncoder().encode(opts.senderDid);
  const recipientIdBytes = new TextEncoder().encode(opts.recipientId);

  const body: number[] = [];
  body.push(...MAGIC);
  body.push(VERSION);
  body.push(opts.kind);
  writeU16BE(body, senderDidBytes.length, "sender_did");
  body.push(...senderDidBytes);
  writeU16BE(body, recipientIdBytes.length, "recipient_id");
  body.push(...recipientIdBytes);
  body.push(...ephemPub);
  body.push(...nonceBytes);
  writeU16BE(body, opts.associatedData.length, "associated_data");
  body.push(...opts.associatedData);
  writeU32BE(body, ciphertext.length, "ciphertext");
  body.push(...ciphertext);
  const bodyBytes = new Uint8Array(body);

  // Sign sha256(body) with the sender's Ed25519 identity key.
  const digest = sha256(bodyBytes);
  const sig = await opts.signBody(digest);
  if (sig.length !== SIGNATURE_LEN) {
    throw new EnvelopeError(`signature must be ${SIGNATURE_LEN} bytes, got ${sig.length}`);
  }

  const out = new Uint8Array(bodyBytes.length + SIGNATURE_LEN);
  out.set(bodyBytes, 0);
  out.set(sig, bodyBytes.length);
  return out;
}

/**
 * Verify the signature, derive the DEK, and decrypt.
 *
 * `recipientX25519Secret` is the long-lived X25519 secret of whoever owns
 * `recipient_id`. For peer/self envelopes this is derived from the
 * recipient's Ed25519 wallet key (see `signingToX25519Secret` in
 * follow-up work that integrates the Pair Device flow). For
 * model-bridge envelopes this is the cloud's per-session bridge secret.
 */
export async function open(
  wire: Uint8Array,
  recipientX25519Secret: Uint8Array,
): Promise<Opened> {
  if (wire.length < SIGNATURE_LEN + MAGIC.length + 2) {
    throw new EnvelopeError("envelope too short");
  }
  const bodyEnd = wire.length - SIGNATURE_LEN;
  const body = wire.subarray(0, bodyEnd);
  const sigBytes = wire.subarray(bodyEnd);

  const cur = new Cursor(body);

  const magic = cur.take(MAGIC.length);
  for (let i = 0; i < MAGIC.length; i++) {
    if (magic[i] !== MAGIC[i]) throw new EnvelopeError("bad magic");
  }
  const version = cur.take(1)[0];
  if (version !== VERSION) throw new EnvelopeError(`unsupported version: ${version}`);
  const kindByte = cur.take(1)[0];
  if (kindByte !== 0x00 && kindByte !== 0x01 && kindByte !== 0x02) {
    throw new EnvelopeError(`invalid recipient kind: ${kindByte}`);
  }
  const kind = kindByte as RecipientKindByte;

  const senderDidLen = cur.u16();
  const senderDidBytes = cur.take(senderDidLen);
  const senderDid = new TextDecoder().decode(senderDidBytes);

  const recipientIdLen = cur.u16();
  const recipientIdBytes = cur.take(recipientIdLen);
  const recipientId = new TextDecoder().decode(recipientIdBytes);

  const ephemPub = cur.take(EPHEM_PUB_LEN).slice();
  const nonceBytes = cur.take(NONCE_LEN).slice();

  const adLen = cur.u16();
  const associatedData = cur.take(adLen).slice();

  const ctLen = cur.u32();
  const ciphertext = cur.take(ctLen);

  if (cur.pos !== body.length) throw new EnvelopeError("trailing bytes in body");

  // Verify Ed25519 signature first — cheaper to bail than to attempt AEAD.
  const senderPub = verifyingFromDidKey(senderDid);
  const digest = sha256(body);
  const ok = ed25519.verify(sigBytes, digest, senderPub);
  if (!ok) throw new EnvelopeError("signature verification failed");

  // Derive DEK and decrypt.
  if (recipientX25519Secret.length !== EPHEM_PUB_LEN) {
    throw new EnvelopeError("recipient X25519 secret must be 32 bytes");
  }
  const shared = x25519.getSharedSecret(recipientX25519Secret, ephemPub);
  const dek = deriveDek(shared, recipientId);
  let plaintext: Uint8Array;
  try {
    plaintext = await aesGcmDecrypt(dek, nonceBytes, associatedData, ciphertext);
  } catch {
    throw new EnvelopeError("AEAD open failed (likely tamper or wrong recipient)");
  }

  return { kind, senderDid, recipientId, associatedData, plaintext };
}

// ── AES-256-GCM via Web Crypto ──────────────────────────────────────────
//
// TypeScript 5.7+ narrowed `Uint8Array` to be generic over its backing
// buffer (`Uint8Array<ArrayBufferLike>`), which no longer satisfies the
// `BufferSource` parameter type used by SubtleCrypto. Wrapping each
// argument with `bs(...)` guarantees an ArrayBuffer-backed view at the
// crypto boundary without runtime cost (the underlying bytes are shared).

function bs(arr: Uint8Array): ArrayBuffer {
  // `.buffer` may be a SharedArrayBuffer in some runtimes; copy through
  // a fresh ArrayBuffer to keep types and SubtleCrypto happy.
  const out = new ArrayBuffer(arr.byteLength);
  new Uint8Array(out).set(arr);
  return out;
}

async function aesGcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    bs(key),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bs(nonce), additionalData: bs(ad), tagLength: 128 },
    cryptoKey,
    bs(plaintext),
  );
  return new Uint8Array(ctBuf);
}

async function aesGcmDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    bs(key),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const ptBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bs(nonce), additionalData: bs(ad), tagLength: 128 },
    cryptoKey,
    bs(ciphertext),
  );
  return new Uint8Array(ptBuf);
}

// ── Convenience signers for tests ───────────────────────────────────────

/**
 * Build a `signBody` callback backed by an in-browser Ed25519 secret. NOT
 * for production use — production signs via Turnkey so the secret never
 * leaves the vault.
 */
export function localEd25519Signer(secretKey: Uint8Array) {
  if (secretKey.length !== 32) throw new EnvelopeError("Ed25519 secret must be 32 bytes");
  return async (bytes: Uint8Array): Promise<Uint8Array> => {
    return ed25519.sign(bytes, secretKey);
  };
}

/**
 * Convenience: derive an X25519 secret from an Ed25519 secret (for round-
 * trip tests). Mirrors `said-core::mesh::ed25519_to_x25519_secret`:
 * SHA-512(seed)[..32], then clamped per X25519's standard.
 *
 * NOT exported for production use — production X25519 secrets for the
 * client come from the Pair Device flow (next milestone), not from
 * dumping the wallet's Ed25519 secret into JS memory.
 */
export async function ed25519SignToX25519SecretForTests(
  edSecret: Uint8Array,
): Promise<Uint8Array> {
  if (edSecret.length !== 32) throw new EnvelopeError("Ed25519 secret must be 32 bytes");
  const hashBuf = await crypto.subtle.digest("SHA-512", bs(edSecret));
  return new Uint8Array(hashBuf).slice(0, 32);
}
