import { describe, it, expect } from "vitest";
import { ed25519, edwardsToMontgomeryPub } from "@noble/curves/ed25519";

import {
  EnvelopeError,
  RecipientKind,
  SIGNATURE_LEN,
  didKeyFromVerifying,
  ed25519SignToX25519SecretForTests,
  localEd25519Signer,
  open,
  seal,
  verifyingFromDidKey,
} from "./envelope";

function makeWallet() {
  const secret = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(secret);
  const did = didKeyFromVerifying(pub);
  return { secret, pub, did };
}

describe("envelope", () => {
  it("did:key round-trips", () => {
    const { secret, pub, did } = makeWallet();
    expect(did.startsWith("did:key:z")).toBe(true);
    expect(verifyingFromDidKey(did)).toEqual(pub);
    // Re-deriving from the secret must match.
    expect(ed25519.getPublicKey(secret)).toEqual(pub);
  });

  it("rejects malformed did:key", () => {
    expect(() => verifyingFromDidKey("did:web:example.com")).toThrow(EnvelopeError);
    expect(() => verifyingFromDidKey("did:key:zNotBase58!!")).toThrow(EnvelopeError);
  });

  it("peer round-trip seal then open recovers plaintext + AD", async () => {
    const alice = makeWallet();
    const bob = makeWallet();

    const ad = new TextEncoder().encode("session=abc;ts=1700000000");
    const pt = new TextEncoder().encode("hello bob from alice");

    const wire = await seal({
      senderDid: alice.did,
      recipientId: bob.did,
      recipientX25519: edwardsToMontgomeryPub(bob.pub),
      kind: RecipientKind.PeerDid,
      associatedData: ad,
      plaintext: pt,
      signBody: localEd25519Signer(alice.secret),
    });

    const bobX25519Secret = await ed25519SignToX25519SecretForTests(bob.secret);
    const opened = await open(wire, bobX25519Secret);

    expect(opened.kind).toBe(RecipientKind.PeerDid);
    expect(opened.senderDid).toBe(alice.did);
    expect(opened.recipientId).toBe(bob.did);
    expect(Array.from(opened.associatedData)).toEqual(Array.from(ad));
    expect(Array.from(opened.plaintext)).toEqual(Array.from(pt));
  });

  it("wrong recipient cannot open", async () => {
    const alice = makeWallet();
    const bob = makeWallet();
    const mallory = makeWallet();

    const wire = await seal({
      senderDid: alice.did,
      recipientId: bob.did,
      recipientX25519: edwardsToMontgomeryPub(bob.pub),
      kind: RecipientKind.PeerDid,
      associatedData: new Uint8Array(),
      plaintext: new TextEncoder().encode("secret"),
      signBody: localEd25519Signer(alice.secret),
    });

    const malloryX25519Secret = await ed25519SignToX25519SecretForTests(
      mallory.secret,
    );
    await expect(open(wire, malloryX25519Secret)).rejects.toBeInstanceOf(
      EnvelopeError,
    );
  });

  it("ciphertext tampering is rejected via signature verification", async () => {
    const alice = makeWallet();
    const bob = makeWallet();

    const wire = await seal({
      senderDid: alice.did,
      recipientId: bob.did,
      recipientX25519: edwardsToMontgomeryPub(bob.pub),
      kind: RecipientKind.PeerDid,
      associatedData: new Uint8Array(),
      plaintext: new TextEncoder().encode("hello"),
      signBody: localEd25519Signer(alice.secret),
    });

    // Flip a byte in the body (just before the trailing 64-byte signature).
    const tampered = wire.slice();
    tampered[tampered.length - SIGNATURE_LEN - 4] ^= 0x01;

    const bobSecret = await ed25519SignToX25519SecretForTests(bob.secret);
    await expect(open(tampered, bobSecret)).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("signature truncation is rejected", async () => {
    const alice = makeWallet();
    const bob = makeWallet();

    const wire = await seal({
      senderDid: alice.did,
      recipientId: bob.did,
      recipientX25519: edwardsToMontgomeryPub(bob.pub),
      kind: RecipientKind.PeerDid,
      associatedData: new Uint8Array(),
      plaintext: new TextEncoder().encode("hello"),
      signBody: localEd25519Signer(alice.secret),
    });

    const truncated = wire.slice(0, wire.length - 10);
    const bobSecret = await ed25519SignToX25519SecretForTests(bob.secret);
    await expect(open(truncated, bobSecret)).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("self-recipient envelopes round-trip too", async () => {
    const me = makeWallet();
    const wire = await seal({
      senderDid: me.did,
      recipientId: me.did,
      recipientX25519: edwardsToMontgomeryPub(me.pub),
      kind: RecipientKind.SelfRecipient,
      associatedData: new TextEncoder().encode("session-header"),
      plaintext: new TextEncoder().encode("note to self"),
      signBody: localEd25519Signer(me.secret),
    });
    const mySecret = await ed25519SignToX25519SecretForTests(me.secret);
    const opened = await open(wire, mySecret);
    expect(opened.kind).toBe(RecipientKind.SelfRecipient);
    expect(new TextDecoder().decode(opened.plaintext)).toBe("note to self");
  });
});
