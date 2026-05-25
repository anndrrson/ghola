#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";

const require = createRequire(import.meta.url);
const { Aead, CipherSuite, Kdf, Kem } = require(
  require.resolve("hpke-js", {
    paths: [
      path.resolve(process.cwd(), "apps/web/node_modules"),
      path.resolve(process.cwd(), "node_modules"),
    ],
  }),
);

const KEM_ID_DHKEM_X25519_SHA256 = 0x0020;
const KDF_ID_HKDF_SHA256 = 0x0001;
const AEAD_ID_AES_256_GCM = 0x0002;
const NK = 32;
const NN = 12;
const NPK = 32;
const RESP_NONCE_LEN = NK;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const OHTTP_REQUEST_LABEL = textEncoder.encode("message/bhttp request");
const OHTTP_RESPONSE_LABEL = textEncoder.encode("message/bhttp response");

function usage() {
  process.stderr.write(`usage: scripts/canary/railgun-x402-ohttp-funded-canary.mjs [--replay-check]
       scripts/canary/railgun-x402-ohttp-funded-canary.mjs --self-test

Required:
  RAILGUN_X402_PROOF_JSON   path to funded railgun_evm_shielded x402 proof JSON
  GHOLA_OHTTP_RELAY_URL     public OHTTP relay URL

Optional:
  GHOLA_OHTTP_KEYS_URL      default: $GHOLA_RELAY_BASE_URL/ohttp-keys
  GHOLA_RELAY_BASE_URL      default: https://ghola-relay.onrender.com
  GHOLA_V1_CHAT_URL         default: https://ghola.xyz/v1/chat/completions
  GHOLA_CANARY_MODEL        default: agent:research-bot
  GHOLA_CANARY_PROMPT       default: Railgun funded OHTTP canary. Reply with ok.
  GHOLA_API_KEY             optional bearer token
`);
}

const replayCheck = process.argv.includes("--replay-check");
const selfTest = process.argv.includes("--self-test");
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  usage();
  process.exit(0);
}
for (const arg of process.argv.slice(2)) {
  if (arg !== "--replay-check" && arg !== "--self-test") {
    usage();
    process.exit(2);
  }
}

function needEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function concat(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function ab(view) {
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out.buffer;
}

function u16be(value) {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function varintEncode(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid varint");
  if (value < 1 << 6) return new Uint8Array([value]);
  if (value < 1 << 14) {
    const v = (value | 0x4000) & 0xffff;
    return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
  }
  if (value < 1 << 30) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value | 0x80000000, false);
    return out;
  }
  const out = new Uint8Array(8);
  const hi = Math.floor(value / 2 ** 32) | 0xc0000000;
  const lo = value >>> 0;
  new DataView(out.buffer).setUint32(0, hi, false);
  new DataView(out.buffer).setUint32(4, lo, false);
  return out;
}

function varintDecode(buf, offset) {
  if (offset >= buf.length) throw new Error("varint underflow");
  const prefix = buf[offset] >> 6;
  if (prefix === 0) return { value: buf[offset] & 0x3f, size: 1 };
  if (prefix === 1) {
    if (offset + 2 > buf.length) throw new Error("varint underflow");
    return { value: ((buf[offset] & 0x3f) << 8) | buf[offset + 1], size: 2 };
  }
  if (prefix === 2) {
    if (offset + 4 > buf.length) throw new Error("varint underflow");
    const dv = new DataView(buf.buffer, buf.byteOffset + offset, 4);
    return { value: dv.getUint32(0, false) & 0x3fffffff, size: 4 };
  }
  if (offset + 8 > buf.length) throw new Error("varint underflow");
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  const hi = dv.getUint32(0, false) & 0x3fffffff;
  const lo = dv.getUint32(4, false);
  return { value: hi * 2 ** 32 + lo, size: 8 };
}

function lenPrefixed(value) {
  return concat(varintEncode(value.length), value);
}

function readSlice(buf, offset) {
  const { value: len, size } = varintDecode(buf, offset);
  const start = offset + size;
  const end = start + len;
  if (end > buf.length) throw new Error("bhttp field overruns buffer");
  return { slice: buf.slice(start, end), next: end };
}

function encodeHeaders(headers) {
  const parts = [];
  for (const [name, value] of headers) {
    if (/[\r\n]/.test(value)) throw new Error(`header injection rejected: ${name}`);
    parts.push(lenPrefixed(textEncoder.encode(name.toLowerCase())));
    parts.push(lenPrefixed(textEncoder.encode(value)));
  }
  return concat(...parts);
}

function encodeBhttpRequest({ method, scheme, authority, path: requestPath, headers, body }) {
  return concat(
    new Uint8Array([0x00]),
    lenPrefixed(textEncoder.encode(method)),
    lenPrefixed(textEncoder.encode(scheme)),
    lenPrefixed(textEncoder.encode(authority)),
    lenPrefixed(textEncoder.encode(requestPath)),
    lenPrefixed(encodeHeaders(headers)),
    lenPrefixed(body),
    varintEncode(0),
  );
}

function encodeBhttpResponse({ status, headers, body }) {
  return concat(
    new Uint8Array([0x01]),
    varintEncode(status),
    lenPrefixed(encodeHeaders(headers)),
    lenPrefixed(body),
    varintEncode(0),
  );
}

function decodeBhttpResponse(buf) {
  if (buf.length === 0 || buf[0] !== 0x01) {
    throw new Error("bhttp response framing byte was not 0x01");
  }
  let cursor = 1;
  const statusField = varintDecode(buf, cursor);
  cursor += statusField.size;
  const headerField = readSlice(buf, cursor);
  cursor = headerField.next;
  const bodyField = readSlice(buf, cursor);
  const headers = {};
  let hcur = 0;
  while (hcur < headerField.slice.length) {
    const key = readSlice(headerField.slice, hcur);
    hcur = key.next;
    const value = readSlice(headerField.slice, hcur);
    hcur = value.next;
    headers[textDecoder.decode(key.slice).toLowerCase()] = textDecoder.decode(value.slice);
  }
  return {
    status: statusField.value,
    headers,
    body: textDecoder.decode(bodyField.slice),
  };
}

function parseKeyConfig(bytes) {
  if (bytes.length < 1 + 2 + NPK + 2 + 4) {
    throw new Error(`OHTTP keyconfig too short (${bytes.length} bytes)`);
  }
  const keyId = bytes[0];
  const kemId = (bytes[1] << 8) | bytes[2];
  if (kemId !== KEM_ID_DHKEM_X25519_SHA256) {
    throw new Error(`unsupported OHTTP KEM 0x${kemId.toString(16)}`);
  }
  const publicKey = bytes.slice(3, 3 + NPK);
  const suitesLen = (bytes[3 + NPK] << 8) | bytes[4 + NPK];
  const suitesStart = 5 + NPK;
  if (bytes.length < suitesStart + suitesLen) throw new Error("OHTTP suites overrun");
  for (let i = 0; i + 4 <= suitesLen; i += 4) {
    const kdfId = (bytes[suitesStart + i] << 8) | bytes[suitesStart + i + 1];
    const aeadId = (bytes[suitesStart + i + 2] << 8) | bytes[suitesStart + i + 3];
    if (kdfId === KDF_ID_HKDF_SHA256 && aeadId === AEAD_ID_AES_256_GCM) {
      return { keyId, kdfId, aeadId, publicKey };
    }
  }
  throw new Error("OHTTP keyconfig has no HKDF-SHA256/AES-256-GCM suite");
}

function buildSuite() {
  return new CipherSuite({
    kem: Kem.DhkemX25519HkdfSha256,
    kdf: Kdf.HkdfSha256,
    aead: Aead.Aes256Gcm,
  });
}

function requestInfo(hdr) {
  return concat(OHTTP_REQUEST_LABEL, new Uint8Array([0x00]), hdr);
}

async function encapsulateRequest(keyConfig, innerRequest) {
  const suite = buildSuite();
  const hdr = concat(
    new Uint8Array([keyConfig.keyId & 0xff]),
    u16be(KEM_ID_DHKEM_X25519_SHA256),
    u16be(keyConfig.kdfId),
    u16be(keyConfig.aeadId),
  );
  const recipientPublicKey = await suite.kem.deserializePublicKey(ab(keyConfig.publicKey));
  const sender = await suite.createSenderContext({
    recipientPublicKey,
    info: ab(requestInfo(hdr)),
  });
  const ct = new Uint8Array(await sender.seal(ab(innerRequest), new Uint8Array(0)));
  const enc = new Uint8Array(sender.enc);
  const exportSecret = new Uint8Array(await sender.export(ab(OHTTP_RESPONSE_LABEL), NK));
  return { capsule: concat(hdr, enc, ct), context: { enc, exportSecret } };
}

async function decapsulateResponse(ctx, capsule) {
  if (capsule.length < RESP_NONCE_LEN + 16) {
    throw new Error(`OHTTP response capsule too short (${capsule.length} bytes)`);
  }
  const responseNonce = capsule.slice(0, RESP_NONCE_LEN);
  const ct = capsule.slice(RESP_NONCE_LEN);
  const salt = concat(ctx.enc, responseNonce);
  const subtle = globalThis.crypto?.subtle ?? webcrypto.subtle;
  const prkKey = await subtle.importKey(
    "raw",
    ab(ctx.exportSecret),
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const keyBits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: ab(salt), info: textEncoder.encode("key") },
    prkKey,
    NK * 8,
  );
  const nonceBits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: ab(salt), info: textEncoder.encode("nonce") },
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
  return new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv: nonceBits }, aesKey, ab(ct)),
  );
}

async function encryptResponseForSelfTest(enc, responseSecret, responsePlain) {
  const cryptoImpl = globalThis.crypto ?? webcrypto;
  const responseNonce = cryptoImpl.getRandomValues(new Uint8Array(RESP_NONCE_LEN));
  const salt = concat(enc, responseNonce);
  const subtle = cryptoImpl.subtle;
  const prkKey = await subtle.importKey(
    "raw",
    ab(responseSecret),
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const keyBits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: ab(salt), info: textEncoder.encode("key") },
    prkKey,
    NK * 8,
  );
  const nonceBits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: ab(salt), info: textEncoder.encode("nonce") },
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
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonceBits }, aesKey, ab(responsePlain)),
  );
  return concat(responseNonce, ct);
}

async function runSelfTest() {
  const suite = buildSuite();
  const recipientKey = await suite.kem.generateKeyPair();
  const rawPub = new Uint8Array(await suite.kem.serializePublicKey(recipientKey.publicKey));
  const keyConfig = {
    keyId: 1,
    kdfId: KDF_ID_HKDF_SHA256,
    aeadId: AEAD_ID_AES_256_GCM,
    publicKey: rawPub,
  };
  const inner = encodeBhttpRequest({
    method: "POST",
    scheme: "https",
    authority: "ghola.xyz",
    path: "/v1/chat/completions",
    headers: [["content-type", "application/json"]],
    body: textEncoder.encode('{"ok":true}'),
  });
  const { capsule, context } = await encapsulateRequest(keyConfig, inner);
  const hdr = capsule.slice(0, 7);
  const enc = capsule.slice(7, 7 + NPK);
  const ct = capsule.slice(7 + NPK);
  const recipient = await suite.createRecipientContext({
    recipientKey,
    enc: ab(enc),
    info: ab(requestInfo(hdr)),
  });
  const opened = new Uint8Array(await recipient.open(ab(ct), new Uint8Array(0)));
  if (opened.length !== inner.length || opened.some((byte, i) => byte !== inner[i])) {
    throw new Error("self-test request decapsulation mismatch");
  }
  const responseSecret = new Uint8Array(await recipient.export(ab(OHTTP_RESPONSE_LABEL), NK));
  const responsePlain = encodeBhttpResponse({
    status: 200,
    headers: [["content-type", "application/json"]],
    body: textEncoder.encode('{"ok":true}'),
  });
  const responseCapsule = await encryptResponseForSelfTest(enc, responseSecret, responsePlain);
  const decoded = decodeBhttpResponse(await decapsulateResponse(context, responseCapsule));
  if (decoded.status !== 200 || decoded.body !== '{"ok":true}') {
    throw new Error("self-test response decode mismatch");
  }
  const requestHash = "a".repeat(64);
  const challenge = decodeBhttpResponse(
    encodeBhttpResponse({
      status: 402,
      headers: [
        [
          "payment-required",
          Buffer.from(
            JSON.stringify({
              accepts: [
                {
                  scheme: "railgun_evm_shielded",
                  extra: { request_hash: requestHash },
                },
              ],
            }),
            "utf8",
          ).toString("base64"),
        ],
      ],
      body: new Uint8Array(0),
    }),
  );
  if (railgunRequestHashFromChallenge(challenge) !== requestHash) {
    throw new Error("self-test challenge request_hash parse mismatch");
  }
  process.stderr.write("OHTTP x402 canary self-test passed.\n");
}

function paymentFromProof(file) {
  const proof = JSON.parse(fs.readFileSync(file, "utf8"));
  if (proof.scheme !== "railgun_evm_shielded") {
    throw new Error("proof.scheme must be railgun_evm_shielded");
  }
  if (proof.network == null || proof.payload?.extensions?.railgun == null) {
    throw new Error("proof must include network and payload.extensions.railgun");
  }
  return {
    header: Buffer.from(JSON.stringify(proof), "utf8").toString("base64"),
    requestHash: proof.payload?.request_hash ?? proof.payload?.extensions?.ghola?.request_hash,
  };
}

function jsonBody(model, prompt, maxTokens) {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
  });
}

function baseX402Headers() {
  const headers = [
    ["content-type", "application/json"],
    ["x-ghola-payment-rail", "railgun_evm_shielded"],
  ];
  if (process.env.GHOLA_API_KEY) {
    headers.push(["authorization", `Bearer ${process.env.GHOLA_API_KEY}`]);
  }
  return headers;
}

function paidX402Headers(paymentHeader) {
  return [
    ...baseX402Headers(),
    ["x402-payment", paymentHeader],
    ["payment-signature", paymentHeader],
  ];
}

function decodeBase64Json(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function railgunRequestHashFromChallenge(response) {
  let requirements = null;
  const header = response.headers["payment-required"] ?? response.headers["x-payment-required"];
  if (header) {
    requirements = decodeBase64Json(header);
  } else {
    const body = JSON.parse(response.body || "{}");
    requirements = body.payment_requirements;
  }
  const option = requirements?.accepts?.find(
    (candidate) =>
      candidate.scheme === "railgun_evm_shielded" ||
      candidate.extra?.payment_rail === "railgun_evm_shielded" ||
      candidate.extra?.canonical_rail === "railgun_evm_shielded",
  );
  const requestHash = option?.extra?.request_hash;
  if (typeof requestHash !== "string" || requestHash.length === 0) {
    throw new Error("OHTTP x402 challenge did not include a Railgun request_hash");
  }
  return requestHash;
}

async function postOhttp({ chatUrl, relayUrl, keysUrl, headers, bodyText }) {
  const keyRes = await fetch(keysUrl, { method: "GET", cache: "no-store" });
  if (!keyRes.ok) {
    throw new Error(`OHTTP keyconfig unavailable: HTTP ${keyRes.status}`);
  }
  const keyConfig = parseKeyConfig(new Uint8Array(await keyRes.arrayBuffer()));
  const innerUrl = new URL(chatUrl);
  const requestPath = `${innerUrl.pathname}${innerUrl.search}`;
  if (requestPath !== "/v1/chat/completions") {
    throw new Error(`OHTTP x402 canary only supports /v1/chat/completions, got ${requestPath}`);
  }
  const inner = encodeBhttpRequest({
    method: "POST",
    scheme: innerUrl.protocol.replace(":", ""),
    authority: innerUrl.host,
    path: requestPath,
    headers,
    body: textEncoder.encode(bodyText),
  });
  const { capsule, context } = await encapsulateRequest(keyConfig, inner);
  const outer = await fetch(relayUrl, {
    method: "POST",
    headers: { "content-type": "message/ohttp-req" },
    body: new Blob([capsule], { type: "message/ohttp-req" }),
  });
  if (!outer.ok) {
    throw new Error(`OHTTP relay failed before BHTTP response: HTTP ${outer.status}`);
  }
  const opened = await decapsulateResponse(context, new Uint8Array(await outer.arrayBuffer()));
  return decodeBhttpResponse(opened);
}

async function main() {
  if (selfTest) {
    await runSelfTest();
    return;
  }

  const proofJson = needEnv("RAILGUN_X402_PROOF_JSON");
  const relayUrl = needEnv("GHOLA_OHTTP_RELAY_URL");
  if (!fs.existsSync(proofJson)) throw new Error(`proof JSON not found: ${proofJson}`);
  const relayBase = process.env.GHOLA_RELAY_BASE_URL ?? "https://ghola-relay.onrender.com";
  const keysUrl = process.env.GHOLA_OHTTP_KEYS_URL ?? new URL("/ohttp-keys", relayBase).toString();
  const chatUrl = process.env.GHOLA_V1_CHAT_URL ?? "https://ghola.xyz/v1/chat/completions";
  const model = process.env.GHOLA_CANARY_MODEL ?? "agent:research-bot";
  const prompt = process.env.GHOLA_CANARY_PROMPT ?? "Railgun funded OHTTP canary. Reply with ok.";
  const payment = paymentFromProof(proofJson);
  const firstBody = jsonBody(model, prompt, 32);

  const challenge = await postOhttp({
    chatUrl,
    relayUrl,
    keysUrl,
    headers: baseX402Headers(),
    bodyText: firstBody,
  });
  if (challenge.status !== 402) {
    process.stderr.write(`OHTTP x402 challenge expected HTTP 402, got ${challenge.status}\n`);
    process.stderr.write(challenge.body);
    process.stderr.write("\n");
    process.exit(1);
  }
  const challengeRequestHash = railgunRequestHashFromChallenge(challenge);
  if (payment.requestHash && payment.requestHash !== challengeRequestHash) {
    throw new Error(
      `funded proof request_hash ${payment.requestHash} does not match OHTTP challenge ${challengeRequestHash}`,
    );
  }
  process.stderr.write(`OHTTP x402 challenge returned request_hash ${challengeRequestHash}.\n`);

  const first = await postOhttp({
    chatUrl,
    relayUrl,
    keysUrl,
    headers: paidX402Headers(payment.header),
    bodyText: firstBody,
  });
  if (first.status < 200 || first.status >= 300) {
    process.stderr.write(`Railgun OHTTP funded x402 canary failed with HTTP ${first.status}\n`);
    process.stderr.write(first.body);
    process.stderr.write("\n");
    process.exit(1);
  }
  process.stderr.write(`Railgun OHTTP funded x402 canary accepted by ${chatUrl} via ${relayUrl} (HTTP ${first.status}).\n`);

  if (replayCheck) {
    const replay = await postOhttp({
      chatUrl,
      relayUrl,
      keysUrl,
      headers: paidX402Headers(payment.header),
      bodyText: jsonBody(model, "Replay check. This should be rejected.", 16),
    });
    if (replay.status >= 200 && replay.status < 300) {
      process.stderr.write(`OHTTP replay check unexpectedly succeeded (HTTP ${replay.status})\n`);
      process.stderr.write(replay.body);
      process.stderr.write("\n");
      process.exit(1);
    }
    process.stderr.write(`OHTTP replay check rejected as expected (HTTP ${replay.status}).\n`);
  }

  process.stdout.write(first.body);
  if (!first.body.endsWith("\n")) process.stdout.write("\n");
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
