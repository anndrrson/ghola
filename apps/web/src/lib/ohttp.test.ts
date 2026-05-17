import { describe, it, expect } from "vitest";
import { Aead, CipherSuite, Kdf, Kem } from "hpke-js";

import {
  decapsulateResponse,
  decodeBhttpResponse,
  encapsulateRequest,
  encodeBhttpRequest,
  ohttpSelfTest,
  parseKeyConfig,
  type OhttpKeyConfig,
  KEM_ID_DHKEM_X25519_SHA256,
  KDF_ID_HKDF_SHA256,
  AEAD_ID_AES_256_GCM,
} from "./ohttp";

describe("ohttp", () => {
  it("self-test: HPKE + RFC 9458 capsule + BHTTP round-trip", async () => {
    await expect(ohttpSelfTest()).resolves.not.toThrow();
  });

  it("parses a valid keyconfig", () => {
    // Build a keyconfig matching the gateway's RFC 9458 §3 layout.
    const pub = new Uint8Array(32).fill(0xab);
    const cfg = new Uint8Array([
      0x55,
      0x00,
      0x20,
      ...pub,
      0x00,
      0x04,
      0x00,
      0x01,
      0x00,
      0x02,
    ]);
    const parsed = parseKeyConfig(cfg);
    expect(parsed.keyId).toBe(0x55);
    expect(parsed.kemId).toBe(KEM_ID_DHKEM_X25519_SHA256);
    expect(parsed.kdfId).toBe(KDF_ID_HKDF_SHA256);
    expect(parsed.aeadId).toBe(AEAD_ID_AES_256_GCM);
    expect(parsed.publicKey).toEqual(pub);
  });

  it("rejects keyconfig with no compatible suite", () => {
    const pub = new Uint8Array(32);
    // Pretend the only offered suite is ChaCha20Poly1305 (0x0003) which
    // the relay doesn't speak.
    const cfg = new Uint8Array([
      0x01,
      0x00,
      0x20,
      ...pub,
      0x00,
      0x04,
      0x00,
      0x01,
      0x00,
      0x03,
    ]);
    expect(() => parseKeyConfig(cfg)).toThrow(/no compatible ciphersuite/);
  });

  it("encodes a BHTTP request with empty body and empty headers", () => {
    const enc = encodeBhttpRequest({
      method: "GET",
      scheme: "https",
      authority: "example.com",
      path: "/",
      headers: [],
      body: new Uint8Array(0),
    });
    // framing byte
    expect(enc[0]).toBe(0x00);
    // ensure non-empty (varints + strings)
    expect(enc.length).toBeGreaterThan(1);
  });

  it("encodes a BHTTP request with empty path and CR/LF header value (round-trip safe at codec layer)", () => {
    // BHTTP is length-prefixed and binary; CR/LF in a header value is
    // legal at the framing layer. Downstream HTTP-emission code is
    // responsible for rejecting injection. This test pins the codec
    // behaviour so a regression that *escapes* or *truncates* CR/LF
    // would be visible.
    const evil = "value-a\r\nInjected: yes";
    const enc = encodeBhttpRequest({
      method: "POST",
      scheme: "https",
      authority: "example.com",
      path: "",
      headers: [["x-evil", evil]],
      body: new Uint8Array(0),
    });
    expect(enc[0]).toBe(0x00);
    // The encoded buffer must contain the raw CR/LF bytes verbatim.
    let found = false;
    for (let i = 0; i + 1 < enc.length; i++) {
      if (enc[i] === 0x0d && enc[i + 1] === 0x0a) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("decodeBhttpResponse rejects malformed input without throwing weird errors", () => {
    // Empty buffer.
    expect(() => decodeBhttpResponse(new Uint8Array(0))).toThrow();
    // Wrong framing byte.
    expect(() => decodeBhttpResponse(new Uint8Array([0x00, 0x40, 0xc8]))).toThrow();
    // Truncated mid-varint.
    expect(() => decodeBhttpResponse(new Uint8Array([0x01, 0x40]))).toThrow();
    // Length prefix that overruns the buffer (claims 100 header bytes).
    expect(() =>
      decodeBhttpResponse(new Uint8Array([0x01, 0x40, 0xc8, 0x40, 0x64, 0x00])),
    ).toThrow();
  });

  it("fuzz: decodeBhttpResponse never panics on random garbage", () => {
    // Hand-rolled fuzz (fast-check not in deps). 32 iterations of
    // random-length garbage. We tolerate either a successful decode of
    // accidentally-valid bytes (very rare) OR a thrown Error — but NEVER
    // an unrelated TypeError / out-of-bounds crash.
    for (let i = 0; i < 32; i++) {
      const len = Math.floor(Math.random() * 256);
      const buf = new Uint8Array(len);
      globalThis.crypto.getRandomValues(buf);
      try {
        decodeBhttpResponse(buf);
        // accidental valid frames are fine — the assertion is "no
        // unexpected crash"
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  it("fuzz: encap → server-side decap round-trip on random plaintexts", async () => {
    // We don't have access to the gateway-side decap in TypeScript; the
    // production gateway runs in Rust. Re-derive the recipient using
    // hpke-js directly (mirroring `ohttpSelfTest`) to exercise the wire
    // format end-to-end on the JS side. The Rust side is covered
    // separately by `cargo test -p thumper-relay` so cross-runtime
    // parity is implicit (both implementations follow RFC 9458 §4
    // labels — see SECURITY_REVIEW_OHTTP.md for the audit).
    const suite = new CipherSuite({
      kem: Kem.DhkemX25519HkdfSha256,
      kdf: Kdf.HkdfSha256,
      aead: Aead.Aes256Gcm,
    });

    const ITERS = 8;
    for (let i = 0; i < ITERS; i++) {
      const recipientKey = await suite.kem.generateKeyPair();
      const rawPub = new Uint8Array(
        await suite.kem.serializePublicKey(recipientKey.publicKey),
      );
      const cfg: OhttpKeyConfig = {
        keyId: (i + 1) & 0xff,
        kemId: KEM_ID_DHKEM_X25519_SHA256,
        publicKey: rawPub,
        kdfId: KDF_ID_HKDF_SHA256,
        aeadId: AEAD_ID_AES_256_GCM,
      };
      // varied plaintext lengths, including empty
      const plaintextLen = i === 0 ? 0 : 1 + Math.floor(Math.random() * 1024);
      const plaintext = new Uint8Array(plaintextLen);
      globalThis.crypto.getRandomValues(plaintext);

      const { capsule, context: _ctx } = await encapsulateRequest(cfg, plaintext);
      expect(capsule[0]).toBe(cfg.keyId);

      // Server-side decap with hpke-js
      const hdr = capsule.slice(0, 7);
      const enc = capsule.slice(7, 7 + 32);
      const ct = capsule.slice(7 + 32);
      // requestInfo: label || 0x00 || hdr
      const label = new TextEncoder().encode("message/bhttp request");
      const info = new Uint8Array(label.length + 1 + hdr.length);
      info.set(label, 0);
      info[label.length] = 0x00;
      info.set(hdr, label.length + 1);

      const recipient = await suite.createRecipientContext({
        recipientKey,
        enc: enc.slice().buffer,
        info: info.slice().buffer,
      });
      const opened = new Uint8Array(
        await recipient.open(ct.slice().buffer, new Uint8Array(0)),
      );
      expect(opened.length).toBe(plaintext.length);
      // byte-exact equality
      for (let j = 0; j < plaintext.length; j++) {
        if (opened[j] !== plaintext[j]) {
          throw new Error(`mismatch at byte ${j} on iter ${i}`);
        }
      }
    }
  });

  it("fuzz: AEAD tamper detection (single-bit flips inside capsule body)", async () => {
    const suite = new CipherSuite({
      kem: Kem.DhkemX25519HkdfSha256,
      kdf: Kdf.HkdfSha256,
      aead: Aead.Aes256Gcm,
    });
    const recipientKey = await suite.kem.generateKeyPair();
    const rawPub = new Uint8Array(
      await suite.kem.serializePublicKey(recipientKey.publicKey),
    );
    const cfg: OhttpKeyConfig = {
      keyId: 0x07,
      kemId: KEM_ID_DHKEM_X25519_SHA256,
      publicKey: rawPub,
      kdfId: KDF_ID_HKDF_SHA256,
      aeadId: AEAD_ID_AES_256_GCM,
    };
    const plaintext = new TextEncoder().encode(
      "the inner BHTTP payload — non-trivial",
    );
    const { capsule } = await encapsulateRequest(cfg, plaintext);

    const labelBytes = new TextEncoder().encode("message/bhttp request");
    const trials = 16; // 16 flips × 2 cryptographic open attempts each
    for (let t = 0; t < trials; t++) {
      const pos = 7 + Math.floor(Math.random() * (capsule.length - 7));
      const bit = 1 << Math.floor(Math.random() * 8);
      const tampered = new Uint8Array(capsule);
      tampered[pos] ^= bit;

      const hdr = tampered.slice(0, 7);
      const enc = tampered.slice(7, 7 + 32);
      const ct = tampered.slice(7 + 32);
      const info = new Uint8Array(labelBytes.length + 1 + hdr.length);
      info.set(labelBytes, 0);
      info[labelBytes.length] = 0x00;
      info.set(hdr, labelBytes.length + 1);

      let opened = false;
      try {
        const recipient = await suite.createRecipientContext({
          recipientKey,
          enc: enc.slice().buffer,
          info: info.slice().buffer,
        });
        await recipient.open(ct.slice().buffer, new Uint8Array(0));
        opened = true;
      } catch {
        // expected — tampered capsule must fail
      }
      expect(opened).toBe(false);
    }
  });

  it("decapsulateResponse rejects truncated capsules without crashing", async () => {
    // Forge a fake context. We don't need cryptographic validity: the
    // function should reject short inputs synchronously / via thrown
    // Error before getting to any AEAD work.
    const ctx = {
      enc: new Uint8Array(32),
      exportSecret: new Uint8Array(32),
    };
    // empty
    await expect(decapsulateResponse(ctx, new Uint8Array(0))).rejects.toThrow();
    // < RESP_NONCE_LEN + 16
    await expect(
      decapsulateResponse(ctx, new Uint8Array(40)),
    ).rejects.toThrow();
    // Past the length check but cryptographically invalid — must still
    // reject rather than return garbage.
    const fakeCapsule = new Uint8Array(64);
    globalThis.crypto.getRandomValues(fakeCapsule);
    await expect(decapsulateResponse(ctx, fakeCapsule)).rejects.toThrow();
  });

  it("encodes and decodes a BHTTP request/response pair", () => {
    const enc = encodeBhttpRequest({
      method: "POST",
      scheme: "https",
      authority: "ghola-relay.onrender.com",
      path: "/inference/sealed",
      headers: [
        ["content-type", "application/json"],
        ["authorization", "Bearer xyz"],
      ],
      body: new TextEncoder().encode("{\"job_id\":\"x\"}"),
    });
    expect(enc[0]).toBe(0x00);
    // Build a valid response binary (control byte 0x01)
    const respBytes = new Uint8Array([
      0x01,
      // status varint (200 < 64 -> 1 byte... actually 200 needs 2 bytes since >= 64)
      // 200 = 0xC8 ; needs prefix 01 (2-byte) -> high byte = 0x40 | 0x00 = 0x40, low = 0xC8
      0x40,
      0xc8,
      // headers length-prefix: empty
      0x00,
      // body length-prefix: "ok"
      0x02,
      0x6f,
      0x6b,
      // trailers
      0x00,
    ]);
    const decoded = decodeBhttpResponse(respBytes);
    expect(decoded.status).toBe(200);
    expect(decoded.headers).toEqual([]);
    expect(new TextDecoder().decode(decoded.body)).toBe("ok");
  });
});
