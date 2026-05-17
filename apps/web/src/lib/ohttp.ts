/**
 * OHTTP (RFC 9458) client wrapper.
 *
 * Encapsulates an inner BHTTP request into an `message/ohttp-req`
 * capsule against the Ghola Gateway's published keyconfig, and
 * decapsulates the corresponding `message/ohttp-res` reply.
 *
 * Suite is fixed to DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 +
 * AES-256-GCM — matches the gateway implementation in
 * `crates/thumper-relay/src/ohttp.rs` and the rest of the codebase.
 *
 * Wire format (RFC 9458 §4):
 *
 *   request  : hdr(7) || enc(32) || ct
 *   response : enc_nonce(32) || ct
 *
 * where hdr = key_id(1) || kem_id(2) || kdf_id(2) || aead_id(2).
 */

import { Aead, CipherSuite, Kdf, Kem } from "hpke-js";

// ── Suite constants ────────────────────────────────────────────────────

export const KEM_ID_DHKEM_X25519_SHA256 = 0x0020;
export const KDF_ID_HKDF_SHA256 = 0x0001;
export const AEAD_ID_AES_256_GCM = 0x0002;

const OHTTP_REQUEST_LABEL = new TextEncoder().encode("message/bhttp request");
const OHTTP_RESPONSE_LABEL = new TextEncoder().encode("message/bhttp response");

const NK = 32; // AES-256 key size
const NN = 12; // AES-GCM nonce size
const NPK = 32; // X25519 pubkey / enc length
const RESP_NONCE_LEN = NK; // max(Nk, Nn) = 32

function buildSuite(): CipherSuite {
  return new CipherSuite({
    kem: Kem.DhkemX25519HkdfSha256,
    kdf: Kdf.HkdfSha256,
    aead: Aead.Aes256Gcm,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

function u16be(v: number): Uint8Array {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function ab(view: Uint8Array): ArrayBuffer {
  // Return a freshly-allocated ArrayBuffer that exactly contains view's bytes.
  // hpke-js accepts both, but be defensive — many subtle-crypto paths choke on
  // views with non-zero byteOffset.
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out.buffer;
}

// ── Keyconfig parsing (RFC 9458 §3) ────────────────────────────────────

export interface OhttpKeyConfig {
  keyId: number;
  kemId: number;
  publicKey: Uint8Array;
  /** Selected ciphersuite ids (we always pick the first compatible one). */
  kdfId: number;
  aeadId: number;
}

export function parseKeyConfig(bytes: Uint8Array): OhttpKeyConfig {
  if (bytes.length < 1 + 2 + NPK + 2 + 4) {
    throw new Error(`ohttp keyconfig too short (${bytes.length} bytes)`);
  }
  const keyId = bytes[0];
  const kemId = (bytes[1] << 8) | bytes[2];
  if (kemId !== KEM_ID_DHKEM_X25519_SHA256) {
    throw new Error(`ohttp keyconfig: unsupported KEM 0x${kemId.toString(16)}`);
  }
  const publicKey = bytes.slice(3, 3 + NPK);
  const suitesLen = (bytes[3 + NPK] << 8) | bytes[4 + NPK];
  const suitesStart = 5 + NPK;
  if (bytes.length < suitesStart + suitesLen) {
    throw new Error("ohttp keyconfig: ciphersuites overrun");
  }
  // Walk pairs (kdf_id, aead_id), pick the first HKDF-SHA256 + AES-256-GCM match.
  let chosenKdf = -1;
  let chosenAead = -1;
  for (let i = 0; i + 4 <= suitesLen; i += 4) {
    const kdfId = (bytes[suitesStart + i] << 8) | bytes[suitesStart + i + 1];
    const aeadId = (bytes[suitesStart + i + 2] << 8) | bytes[suitesStart + i + 3];
    if (kdfId === KDF_ID_HKDF_SHA256 && aeadId === AEAD_ID_AES_256_GCM) {
      chosenKdf = kdfId;
      chosenAead = aeadId;
      break;
    }
  }
  if (chosenKdf < 0) {
    throw new Error(
      "ohttp keyconfig: no compatible ciphersuite (need HKDF-SHA256 + AES-256-GCM)",
    );
  }
  return {
    keyId,
    kemId,
    publicKey,
    kdfId: chosenKdf,
    aeadId: chosenAead,
  };
}

// ── Capsule encap/decap ────────────────────────────────────────────────

export interface OhttpRequestCapsule {
  /** Wire bytes ready for `POST` to an OHTTP relay. */
  capsule: Uint8Array;
  /** Context required to decrypt the matching response capsule. */
  context: OhttpResponseContext;
}

export interface OhttpResponseContext {
  /** Encapsulated KEM share echoed into the response key derivation. */
  enc: Uint8Array;
  /** 32-byte HPKE export secret tied to this request. */
  exportSecret: Uint8Array;
}

function buildHeader(keyId: number, kdfId: number, aeadId: number): Uint8Array {
  return concat(
    new Uint8Array([keyId & 0xff]),
    u16be(KEM_ID_DHKEM_X25519_SHA256),
    u16be(kdfId),
    u16be(aeadId),
  );
}

function requestInfo(hdr: Uint8Array): Uint8Array {
  return concat(OHTTP_REQUEST_LABEL, new Uint8Array([0x00]), hdr);
}

/**
 * Encapsulate an inner BHTTP request against the gateway's keyconfig.
 */
export async function encapsulateRequest(
  keyConfig: OhttpKeyConfig,
  innerRequest: Uint8Array,
): Promise<OhttpRequestCapsule> {
  const suite = buildSuite();
  const hdr = buildHeader(keyConfig.keyId, keyConfig.kdfId, keyConfig.aeadId);
  const info = requestInfo(hdr);

  const recipientPublicKey = await suite.kem.deserializePublicKey(
    ab(keyConfig.publicKey),
  );

  const sender = await suite.createSenderContext({
    recipientPublicKey,
    info: ab(info),
  });

  const ct = new Uint8Array(
    await sender.seal(ab(innerRequest), new Uint8Array(0)),
  );
  const enc = new Uint8Array(sender.enc);
  const exportSecret = new Uint8Array(
    await sender.export(ab(OHTTP_RESPONSE_LABEL), NK),
  );

  return {
    capsule: concat(hdr, enc, ct),
    context: { enc, exportSecret },
  };
}

/**
 * Decapsulate the gateway's `message/ohttp-res` reply. Returns the
 * inner BHTTP response bytes — the caller is responsible for parsing
 * the BHTTP framing.
 */
export async function decapsulateResponse(
  ctx: OhttpResponseContext,
  capsule: Uint8Array,
): Promise<Uint8Array> {
  if (capsule.length < RESP_NONCE_LEN + 16) {
    throw new Error(`ohttp response capsule too short (${capsule.length} bytes)`);
  }
  const responseNonce = capsule.slice(0, RESP_NONCE_LEN);
  const ct = capsule.slice(RESP_NONCE_LEN);

  const salt = concat(ctx.enc, responseNonce);
  // RFC 9458 §4.4:
  //   secret = Export("message/bhttp response", Nk)   -- already in ctx
  //   prk    = HKDF-Extract(salt = enc || resp_nonce, secret)
  //   key    = HKDF-Expand(prk, "key",   Nk)
  //   nonce  = HKDF-Expand(prk, "nonce", Nn)
  const subtle = globalThis.crypto.subtle;
  const prkKey = await subtle.importKey(
    "raw",
    ab(ctx.exportSecret),
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  // We need raw HKDF (extract + expand). WebCrypto's HKDF deriveBits does
  // both in one shot but takes (salt, info, length). We split into two
  // calls keyed by info=key / info=nonce, with the same salt+secret.
  const keyBits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ab(salt),
      info: new TextEncoder().encode("key"),
    },
    prkKey,
    NK * 8,
  );
  const nonceBits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ab(salt),
      info: new TextEncoder().encode("nonce"),
    },
    prkKey,
    NN * 8,
  );

  const aesKey = await subtle.importKey(
    "raw",
    keyBits,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: nonceBits },
    aesKey,
    ab(ct),
  );
  return new Uint8Array(pt);
}

// ── BHTTP minimal codec ────────────────────────────────────────────────
//
// We only support what `POST /inference/sealed` needs: known-length
// framing per RFC 9292 §3.2 with control byte 0x00 (request) / 0x01
// (response). Variable-length integers per RFC 9000 §16.

function varintEncode(value: number): Uint8Array {
  if (value < 0) throw new Error("varint must be non-negative");
  if (value < 1 << 6) {
    return new Uint8Array([value]);
  }
  if (value < 1 << 14) {
    const v = (value | 0x4000) & 0xffff;
    return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
  }
  if (value < 1 << 30) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value | 0x80000000, false);
    return out;
  }
  // 8-byte varint (number is safe up to 2^53)
  const out = new Uint8Array(8);
  const hi = Math.floor(value / 2 ** 32) | 0xc0000000;
  const lo = value >>> 0;
  new DataView(out.buffer).setUint32(0, hi, false);
  new DataView(out.buffer).setUint32(4, lo, false);
  return out;
}

function varintDecode(buf: Uint8Array, offset: number): { value: number; size: number } {
  if (offset >= buf.length) throw new Error("varint underflow");
  const prefix = buf[offset] >> 6;
  switch (prefix) {
    case 0:
      return { value: buf[offset] & 0x3f, size: 1 };
    case 1: {
      if (offset + 2 > buf.length) throw new Error("varint underflow");
      const v = ((buf[offset] & 0x3f) << 8) | buf[offset + 1];
      return { value: v, size: 2 };
    }
    case 2: {
      if (offset + 4 > buf.length) throw new Error("varint underflow");
      const dv = new DataView(buf.buffer, buf.byteOffset + offset, 4);
      const v = dv.getUint32(0, false) & 0x3fffffff;
      return { value: v, size: 4 };
    }
    case 3: {
      if (offset + 8 > buf.length) throw new Error("varint underflow");
      const dv = new DataView(buf.buffer, buf.byteOffset + offset, 8);
      const hi = dv.getUint32(0, false) & 0x3fffffff;
      const lo = dv.getUint32(4, false);
      return { value: hi * 2 ** 32 + lo, size: 8 };
    }
    default:
      throw new Error("unreachable");
  }
}

function encodeLenPrefixed(value: Uint8Array): Uint8Array {
  return concat(varintEncode(value.length), value);
}

function encodeHeaders(headers: Array<[string, string]>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [k, v] of headers) {
    const kb = enc.encode(k);
    const vb = enc.encode(v);
    parts.push(varintEncode(kb.length), kb, varintEncode(vb.length), vb);
  }
  return concat(...parts);
}

export interface BhttpRequest {
  method: string;
  scheme: string;
  authority: string;
  path: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

export interface BhttpResponse {
  status: number;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

export function encodeBhttpRequest(req: BhttpRequest): Uint8Array {
  const enc = new TextEncoder();
  const headers = encodeHeaders(req.headers);
  return concat(
    new Uint8Array([0x00]),
    encodeLenPrefixed(enc.encode(req.method)),
    encodeLenPrefixed(enc.encode(req.scheme)),
    encodeLenPrefixed(enc.encode(req.authority)),
    encodeLenPrefixed(enc.encode(req.path)),
    encodeLenPrefixed(headers),
    encodeLenPrefixed(req.body),
    varintEncode(0), // trailers
  );
}

function readSlice(buf: Uint8Array, offset: number): { slice: Uint8Array; next: number } {
  const { value: len, size } = varintDecode(buf, offset);
  const start = offset + size;
  const end = start + len;
  if (end > buf.length) throw new Error("bhttp: length-prefixed field overruns buffer");
  return { slice: buf.slice(start, end), next: end };
}

export function decodeBhttpResponse(buf: Uint8Array): BhttpResponse {
  if (buf.length === 0 || buf[0] !== 0x01) {
    throw new Error("bhttp: not a known-length response (framing byte != 0x01)");
  }
  let cursor = 1;
  const { value: status, size } = varintDecode(buf, cursor);
  cursor += size;
  const hdr = readSlice(buf, cursor);
  cursor = hdr.next;
  const body = readSlice(buf, cursor);
  cursor = body.next;

  // Parse headers
  const headers: Array<[string, string]> = [];
  const dec = new TextDecoder();
  let hcur = 0;
  while (hcur < hdr.slice.length) {
    const k = readSlice(hdr.slice, hcur);
    hcur = k.next;
    const v = readSlice(hdr.slice, hcur);
    hcur = v.next;
    headers.push([dec.decode(k.slice), dec.decode(v.slice)]);
  }

  return { status, headers, body: body.slice };
}

// ── Self-test (call manually in dev / vitest) ──────────────────────────

/**
 * Quick HPKE round-trip self-test. Generates a fresh keypair, walks the
 * full request encap → decap → response encap → response decap loop
 * against the spec, and throws if any step fails. Used by vitest.
 */
export async function ohttpSelfTest(): Promise<void> {
  const suite = buildSuite();
  const recipientKey = await suite.kem.generateKeyPair();
  const rawPub = await suite.kem.serializePublicKey(recipientKey.publicKey);
  const rawPubBytes = new Uint8Array(rawPub);

  // Build a fake keyconfig
  const keyConfig: OhttpKeyConfig = {
    keyId: 0x42,
    kemId: KEM_ID_DHKEM_X25519_SHA256,
    publicKey: rawPubBytes,
    kdfId: KDF_ID_HKDF_SHA256,
    aeadId: AEAD_ID_AES_256_GCM,
  };

  const inner = new TextEncoder().encode(
    "GET /selftest HTTP/1.1 inner BHTTP payload",
  );
  const { capsule, context } = await encapsulateRequest(keyConfig, inner);

  // --- mirror what the gateway does ---
  // Decapsulate request server-side, then encapsulate a response.
  const hdr = capsule.slice(0, 7);
  const enc = capsule.slice(7, 7 + NPK);
  const ct = capsule.slice(7 + NPK);
  const info = requestInfo(hdr);

  const recipient = await suite.createRecipientContext({
    recipientKey,
    enc: ab(enc),
    info: ab(info),
  });
  const decoded = new Uint8Array(
    await recipient.open(ab(ct), new Uint8Array(0)),
  );
  if (new TextDecoder().decode(decoded) !== new TextDecoder().decode(inner)) {
    throw new Error("ohttp self-test: server decap mismatch");
  }
  const responseSecret = new Uint8Array(
    await recipient.export(ab(OHTTP_RESPONSE_LABEL), NK),
  );

  // Server-side response capsule
  const responsePlain = new TextEncoder().encode("ok response body");
  const responseNonce = globalThis.crypto.getRandomValues(
    new Uint8Array(RESP_NONCE_LEN),
  );
  const salt = concat(enc, responseNonce);
  const subtle = globalThis.crypto.subtle;
  const prkKey = await subtle.importKey(
    "raw",
    ab(responseSecret),
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const keyBits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ab(salt),
      info: new TextEncoder().encode("key"),
    },
    prkKey,
    NK * 8,
  );
  const nonceBits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ab(salt),
      info: new TextEncoder().encode("nonce"),
    },
    prkKey,
    NN * 8,
  );
  const aesKey = await subtle.importKey(
    "raw",
    keyBits,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const respCt = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv: nonceBits },
      aesKey,
      ab(responsePlain),
    ),
  );
  const respCapsule = concat(responseNonce, respCt);

  // Client opens it
  const opened = await decapsulateResponse(context, respCapsule);
  const openedText = new TextDecoder().decode(opened);
  if (openedText !== "ok response body") {
    throw new Error(`ohttp self-test: response mismatch (${openedText})`);
  }

  // BHTTP round-trip
  const reqEncoded = encodeBhttpRequest({
    method: "POST",
    scheme: "https",
    authority: "ghola-relay.onrender.com",
    path: "/inference/sealed",
    headers: [["content-type", "application/json"]],
    body: new TextEncoder().encode("{\"x\":1}"),
  });
  if (reqEncoded[0] !== 0x00) throw new Error("bhttp: bad framing byte");

  const respBytes = (() => {
    const enc = new TextEncoder();
    const hdrs = encodeHeaders([["content-type", "application/json"]]);
    return concat(
      new Uint8Array([0x01]),
      varintEncode(200),
      encodeLenPrefixed(hdrs),
      encodeLenPrefixed(enc.encode("{\"ok\":true}")),
      varintEncode(0),
    );
  })();
  const decoded2 = decodeBhttpResponse(respBytes);
  if (decoded2.status !== 200) throw new Error("bhttp decode status mismatch");
  if (new TextDecoder().decode(decoded2.body) !== "{\"ok\":true}") {
    throw new Error("bhttp decode body mismatch");
  }
}
