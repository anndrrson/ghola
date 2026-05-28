import { webcrypto } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";

const crypto = globalThis.crypto ?? webcrypto;

export const MAGIC = new Uint8Array([0x53, 0x45, 0x76, 0x31]);
export const VERSION = 0x01;
export const RECIPIENT_KIND = {
  SelfRecipient: 0x00,
  PeerDid: 0x01,
  ModelBridge: 0x02,
};

const EPHEM_PUB_LEN = 32;
const NONCE_LEN = 12;
const SIGNATURE_LEN = 64;
const HKDF_INFO_PREFIX = new TextEncoder().encode("said-envelope-v1/");
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);

export class EnvelopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnvelopeError";
    this.status = 400;
  }
}

class Cursor {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  take(n) {
    if (this.pos + n > this.buf.length) throw new EnvelopeError("truncated envelope");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u16() {
    const b = this.take(2);
    return (b[0] << 8) | b[1];
  }

  u32() {
    const b = this.take(4);
    return (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
  }
}

export function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

export function hexToBytes(hex) {
  const clean = String(hex || "").startsWith("0x") ? String(hex).slice(2) : String(hex || "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new EnvelopeError("invalid hex");
  }
  return new Uint8Array(Buffer.from(clean, "hex"));
}

export function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new EnvelopeError("ciphertext is required");
  }
  try {
    return new Uint8Array(Buffer.from(value, "base64"));
  } catch {
    throw new EnvelopeError("ciphertext is not valid base64");
  }
}

export function didKeyFromVerifying(pub) {
  if (pub.length !== 32) throw new EnvelopeError("Ed25519 pub must be 32 bytes");
  const buf = new Uint8Array(34);
  buf.set(ED25519_MULTICODEC, 0);
  buf.set(pub, 2);
  return `did:key:z${bs58.encode(buf)}`;
}

function verifyingFromDidKey(did) {
  if (!did.startsWith("did:key:z")) throw new EnvelopeError("not a did:key");
  let bytes;
  try {
    bytes = bs58.decode(did.slice("did:key:z".length));
  } catch {
    throw new EnvelopeError("invalid did:key base58");
  }
  if (
    bytes.length !== 34 ||
    bytes[0] !== ED25519_MULTICODEC[0] ||
    bytes[1] !== ED25519_MULTICODEC[1]
  ) {
    throw new EnvelopeError("did:key not Ed25519 multicodec");
  }
  return bytes.slice(2);
}

function deriveDek(sharedSecret, recipientId) {
  const salt = new Uint8Array(MAGIC.length + 1);
  salt.set(MAGIC, 0);
  salt[MAGIC.length] = VERSION;

  const recipientBytes = new TextEncoder().encode(recipientId);
  const info = new Uint8Array(HKDF_INFO_PREFIX.length + recipientBytes.length);
  info.set(HKDF_INFO_PREFIX, 0);
  info.set(recipientBytes, HKDF_INFO_PREFIX.length);
  return hkdf(sha256, sharedSecret, salt, info, 32);
}

function arrayBuffer(bytes) {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

async function aesGcmDecrypt(key, nonce, ad, ciphertext) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(key),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: arrayBuffer(nonce), additionalData: arrayBuffer(ad), tagLength: 128 },
    cryptoKey,
    arrayBuffer(ciphertext),
  );
  return new Uint8Array(plaintext);
}

async function aesGcmEncrypt(key, nonce, ad, plaintext) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(key),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: arrayBuffer(nonce), additionalData: arrayBuffer(ad), tagLength: 128 },
    cryptoKey,
    arrayBuffer(plaintext),
  );
  return new Uint8Array(ciphertext);
}

function writeU16BE(buf, n, field) {
  if (n < 0 || n > 0xffff) throw new EnvelopeError(`length overflow: ${field}`);
  buf.push((n >>> 8) & 0xff, n & 0xff);
}

function writeU32BE(buf, n, field) {
  if (n < 0 || n > 0xffffffff) throw new EnvelopeError(`length overflow: ${field}`);
  buf.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

export function recipientSecretBytes(recipient) {
  if (recipient?.x25519_secret_hex) {
    return hexToBytes(recipient.x25519_secret_hex);
  }
  if (recipient?.private_key_pkcs8_pem) {
    const der = Buffer.from(
      String(recipient.private_key_pkcs8_pem)
        .replace(/-----BEGIN PRIVATE KEY-----/g, "")
        .replace(/-----END PRIVATE KEY-----/g, "")
        .replace(/\s+/g, ""),
      "base64",
    );
    return new Uint8Array(der.subarray(-32));
  }
  throw Object.assign(new Error("worker recipient private key is unavailable"), { status: 503 });
}

export function assertRecipientSecretMatches(recipient) {
  const secret = recipientSecretBytes(recipient);
  if (secret.length !== 32) {
    throw Object.assign(new Error("worker recipient private key must be 32 bytes"), { status: 503 });
  }
  const pub = bytesToHex(x25519.getPublicKey(secret));
  if (recipient?.x25519_pub_hex && pub !== recipient.x25519_pub_hex.toLowerCase()) {
    throw Object.assign(new Error("worker recipient private key does not match public key"), {
      status: 503,
    });
  }
}

export async function openEnvelope(wire, recipientSecret) {
  if (wire.length < SIGNATURE_LEN + MAGIC.length + 2) {
    throw new EnvelopeError("envelope too short");
  }
  const bodyEnd = wire.length - SIGNATURE_LEN;
  const body = wire.subarray(0, bodyEnd);
  const signature = wire.subarray(bodyEnd);
  const cur = new Cursor(body);

  const magic = cur.take(MAGIC.length);
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (magic[i] !== MAGIC[i]) throw new EnvelopeError("bad envelope magic");
  }
  const version = cur.take(1)[0];
  if (version !== VERSION) throw new EnvelopeError(`unsupported envelope version: ${version}`);
  const kind = cur.take(1)[0];
  if (![0x00, 0x01, 0x02].includes(kind)) throw new EnvelopeError("invalid recipient kind");

  const senderDid = new TextDecoder().decode(cur.take(cur.u16()));
  const recipientId = new TextDecoder().decode(cur.take(cur.u16()));
  const ephemPub = cur.take(EPHEM_PUB_LEN).slice();
  const nonce = cur.take(NONCE_LEN).slice();
  const associatedData = cur.take(cur.u16()).slice();
  const ciphertext = cur.take(cur.u32());
  if (cur.pos !== body.length) throw new EnvelopeError("trailing envelope bytes");

  const senderPub = verifyingFromDidKey(senderDid);
  if (!ed25519.verify(signature, sha256(body), senderPub)) {
    throw new EnvelopeError("envelope signature verification failed");
  }
  if (recipientSecret.length !== 32) {
    throw new EnvelopeError("recipient X25519 secret must be 32 bytes");
  }
  const shared = x25519.getSharedSecret(recipientSecret, ephemPub);
  const dek = deriveDek(shared, recipientId);
  let plaintext;
  try {
    plaintext = await aesGcmDecrypt(dek, nonce, associatedData, ciphertext);
  } catch {
    throw new EnvelopeError("envelope open failed");
  }
  return { kind, senderDid, recipientId, associatedData, plaintext };
}

export async function openSealedBundle(bundle, recipient, opts = {}) {
  if (!bundle || typeof bundle !== "object") throw new EnvelopeError("sealed bundle is required");
  if (bundle.alg !== "sealed-provider-v1") throw new EnvelopeError("sealed bundle alg is unsupported");
  if (bundle.recipient !== recipient.recipient_id) {
    throw new EnvelopeError("sealed bundle recipient must match worker recipient");
  }
  const opened = await openEnvelope(base64ToBytes(bundle.ciphertext), recipientSecretBytes(recipient));
  const aad = new TextDecoder().decode(opened.associatedData);
  if (opened.recipientId !== recipient.recipient_id) {
    throw new EnvelopeError("sealed bundle recipient id mismatch");
  }
  if (bundle.aad && aad !== bundle.aad) {
    throw new EnvelopeError("sealed bundle associated data mismatch");
  }
  if (opts.expectedAad && aad !== opts.expectedAad) {
    throw new EnvelopeError("sealed bundle associated data mismatch");
  }
  if (opts.aadPrefix && !aad.startsWith(opts.aadPrefix)) {
    throw new EnvelopeError("sealed bundle associated data prefix mismatch");
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(opened.plaintext));
  } catch {
    throw new EnvelopeError("sealed bundle plaintext is not valid JSON");
  }
  if (opts.expectedKind && parsed?.kind !== opts.expectedKind) {
    throw new EnvelopeError("sealed bundle kind mismatch");
  }
  return { ...opened, associatedDataText: aad, json: parsed };
}

export async function sealForTest(opts) {
  const ephemPriv = x25519.utils.randomPrivateKey();
  const ephemPub = x25519.getPublicKey(ephemPriv);
  const shared = x25519.getSharedSecret(ephemPriv, opts.recipientX25519);
  const dek = deriveDek(shared, opts.recipientId);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ciphertext = await aesGcmEncrypt(
    dek,
    nonce,
    new TextEncoder().encode(opts.associatedData),
    new TextEncoder().encode(JSON.stringify(opts.plaintext)),
  );
  const senderDidBytes = new TextEncoder().encode(opts.senderDid);
  const recipientIdBytes = new TextEncoder().encode(opts.recipientId);
  const adBytes = new TextEncoder().encode(opts.associatedData);
  const body = [];
  body.push(...MAGIC);
  body.push(VERSION);
  body.push(RECIPIENT_KIND.ModelBridge);
  writeU16BE(body, senderDidBytes.length, "sender_did");
  body.push(...senderDidBytes);
  writeU16BE(body, recipientIdBytes.length, "recipient_id");
  body.push(...recipientIdBytes);
  body.push(...ephemPub);
  body.push(...nonce);
  writeU16BE(body, adBytes.length, "associated_data");
  body.push(...adBytes);
  writeU32BE(body, ciphertext.length, "ciphertext");
  body.push(...ciphertext);
  const bodyBytes = new Uint8Array(body);
  const signature = await opts.signBody(sha256(bodyBytes));
  if (signature.length !== SIGNATURE_LEN) throw new EnvelopeError("signature must be 64 bytes");
  const out = new Uint8Array(bodyBytes.length + SIGNATURE_LEN);
  out.set(bodyBytes, 0);
  out.set(signature, bodyBytes.length);
  return out;
}
