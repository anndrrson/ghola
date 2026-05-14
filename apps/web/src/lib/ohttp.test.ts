import { describe, it, expect } from "vitest";

import {
  decodeBhttpResponse,
  encodeBhttpRequest,
  ohttpSelfTest,
  parseKeyConfig,
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
