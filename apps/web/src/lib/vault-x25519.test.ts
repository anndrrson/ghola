import { describe, it, expect } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519";

import { deriveVaultX25519Keypair } from "./vault-x25519";

/**
 * Determinism is load-bearing for the entire encrypt-at-rest path:
 * if Turnkey ever switched to randomized Ed25519 (Ed25519ph or any
 * RFC-8032 deviation), users would write blobs they could never read
 * back. These tests freeze the RFC-8032 §5.1.6 contract — the
 * keypair MUST be byte-identical on every call with the same signer.
 */

function deterministicSigner(secret: Uint8Array) {
  return async (msg: Uint8Array) => ed25519.sign(msg, secret);
}

describe("deriveVaultX25519Keypair", () => {
  it("returns byte-identical output across two calls with the same signer", async () => {
    const secret = ed25519.utils.randomPrivateKey();
    const sign = deterministicSigner(secret);

    const a = await deriveVaultX25519Keypair(sign);
    const b = await deriveVaultX25519Keypair(sign);

    expect(Array.from(a.secret)).toEqual(Array.from(b.secret));
    expect(Array.from(a.publicKey)).toEqual(Array.from(b.publicKey));
  });

  it("returns different keypairs for different signers", async () => {
    const k1 = ed25519.utils.randomPrivateKey();
    const k2 = ed25519.utils.randomPrivateKey();
    const a = await deriveVaultX25519Keypair(deterministicSigner(k1));
    const b = await deriveVaultX25519Keypair(deterministicSigner(k2));
    expect(Array.from(a.secret)).not.toEqual(Array.from(b.secret));
    expect(Array.from(a.publicKey)).not.toEqual(Array.from(b.publicKey));
  });

  it("public matches x25519.getPublicKey(secret) — the keypair is internally consistent", async () => {
    const secret = ed25519.utils.randomPrivateKey();
    const kp = await deriveVaultX25519Keypair(deterministicSigner(secret));
    const recomputedPub = x25519.getPublicKey(kp.secret);
    expect(Array.from(kp.publicKey)).toEqual(Array.from(recomputedPub));
  });

  it("rejects a signer that returns a non-64-byte signature", async () => {
    const wrongLen = async () => new Uint8Array(63);
    await expect(deriveVaultX25519Keypair(wrongLen)).rejects.toThrow(/64/);
  });

  it("is deterministic across many sequential calls (regression guard)", async () => {
    // If a future @noble/curves upgrade ever changed Ed25519 signing
    // semantics, this loop would expose it as a flaky failure rather
    // than as silent data loss in production.
    const secret = ed25519.utils.randomPrivateKey();
    const sign = deterministicSigner(secret);
    const first = await deriveVaultX25519Keypair(sign);
    for (let i = 0; i < 20; i++) {
      const next = await deriveVaultX25519Keypair(sign);
      expect(Array.from(next.secret)).toEqual(Array.from(first.secret));
      expect(Array.from(next.publicKey)).toEqual(Array.from(first.publicKey));
    }
  });
});
