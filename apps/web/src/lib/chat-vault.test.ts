import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ed25519 } from "@noble/curves/ed25519";

import {
  didKeyFromVerifying,
  ed25519SignToX25519SecretForTests,
  open as openEnvelope,
} from "./envelope";
import { createChatVault } from "./chat-vault";

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});

describe("chat-vault", () => {
  it("seals a user message that the user's own X25519 secret can open", async () => {
    const secret = ed25519.utils.randomPrivateKey();
    const userDid = didKeyFromVerifying(ed25519.getPublicKey(secret));

    const vault = createChatVault({
      userDid,
      signBytes: async (msg) => ed25519.sign(msg, secret),
    });

    const sessionId = "s-rt";
    const sealed = await vault.sealUserMessage(sessionId, "hello, ghola");

    // Decode the standard-base64 wire bytes.
    const bin = atob(sealed.envelopeB64);
    const wire = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) wire[i] = bin.charCodeAt(i);

    // The chat-vault always seals to the user's own DID, so the
    // recipient's X25519 secret is derivable from the user's Ed25519
    // signing key. (Production replaces this with a Pair-Device-imported
    // key; the round-trip property is the same.)
    const userX25519Secret = await ed25519SignToX25519SecretForTests(secret);
    const opened = await openEnvelope(wire, userX25519Secret);

    expect(opened.senderDid).toBe(userDid);
    expect(opened.recipientId).toBe(userDid);
    const ad = new TextDecoder().decode(opened.associatedData);
    expect(ad).toBe(`session=${sessionId};role=user`);

    const payload = JSON.parse(new TextDecoder().decode(opened.plaintext));
    expect(payload.v).toBe(1);
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.role).toBe("user");
    expect(payload.content).toBe("hello, ghola");
  });

  it("reuses the same session DEK for subsequent messages in a session", async () => {
    const secret = ed25519.utils.randomPrivateKey();
    const userDid = didKeyFromVerifying(ed25519.getPublicKey(secret));
    const vault = createChatVault({
      userDid,
      signBytes: async (msg) => ed25519.sign(msg, secret),
    });
    const sid = "s-reuse";
    const dek1 = await vault.getOrCreateSessionDek(sid);
    const dek2 = await vault.getOrCreateSessionDek(sid);
    expect(Array.from(dek1)).toEqual(Array.from(dek2));
  });

  it("rejects an envelope whose AD has been tampered with", async () => {
    const secret = ed25519.utils.randomPrivateKey();
    const userDid = didKeyFromVerifying(ed25519.getPublicKey(secret));
    const vault = createChatVault({
      userDid,
      signBytes: async (msg) => ed25519.sign(msg, secret),
    });
    const sealed = await vault.sealUserMessage("s-tamper", "hi");

    const bin = atob(sealed.envelopeB64);
    const wire = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) wire[i] = bin.charCodeAt(i);

    // Locate the AD bytes (just the role tail) and flip a bit.
    const adFragment = new TextEncoder().encode(`role=user`);
    let pos = -1;
    for (let i = 0; i < wire.length - adFragment.length; i++) {
      let match = true;
      for (let j = 0; j < adFragment.length; j++) {
        if (wire[i + j] !== adFragment[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        pos = i;
        break;
      }
    }
    expect(pos).toBeGreaterThan(0);
    wire[pos] ^= 0x01;

    const userSecret = await ed25519SignToX25519SecretForTests(secret);
    await expect(openEnvelope(wire, userSecret)).rejects.toThrow();
  });
});
