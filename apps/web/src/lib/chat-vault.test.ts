import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ed25519 } from "@noble/curves/ed25519";

import {
  didKeyFromVerifying,
  open as openEnvelope,
} from "./envelope";
import { createChatVault } from "./chat-vault";
import { deriveVaultX25519Keypair } from "./vault-x25519";

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

    // The chat-vault encrypts to a deterministic-from-Turnkey X25519
    // keypair (see vault-x25519). Re-deriving with the same signer
    // produces the same secret.
    const recipient = await deriveVaultX25519Keypair(async (msg) =>
      ed25519.sign(msg, secret),
    );
    const opened = await openEnvelope(wire, recipient.secret);

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

  it("returns a cloud-storable envelope without message plaintext", async () => {
    const secret = ed25519.utils.randomPrivateKey();
    const userDid = didKeyFromVerifying(ed25519.getPublicKey(secret));
    const vault = createChatVault({
      userDid,
      signBytes: async (msg) => ed25519.sign(msg, secret),
    });

    const secretBody = "native e2ee storage regression sentinel";
    const sealed = await vault.sealUserMessage("s-no-plaintext", secretBody);
    expect(Object.keys(sealed)).toEqual(["envelopeB64"]);

    const bin = atob(sealed.envelopeB64);
    const wire = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) wire[i] = bin.charCodeAt(i);

    const wireText = new TextDecoder().decode(wire);
    expect(wireText).not.toContain(secretBody);
    expect(wireText).not.toContain('"content"');
    expect(wireText).toContain("session=s-no-plaintext;role=user");
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

    const recipient = await deriveVaultX25519Keypair(async (msg) =>
      ed25519.sign(msg, secret),
    );
    await expect(openEnvelope(wire, recipient.secret)).rejects.toThrow();
  });
});
