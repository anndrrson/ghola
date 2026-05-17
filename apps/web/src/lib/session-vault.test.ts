import { describe, it, expect, beforeEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { SessionVault, VaultError, VaultRecipientKind } from "./session-vault";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeSigner() {
  // A deterministic local Ed25519 key — stand-in for Turnkey in tests.
  // Production callers route signing through Turnkey so the secret
  // never lives in JS memory.
  const secret = ed25519.utils.randomPrivateKey();
  const sign = async (msg: Uint8Array) => ed25519.sign(msg, secret);
  return { secret, sign };
}

function fakeDid(label = "alpha"): string {
  return `did:key:zFake${label}`;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("SessionVault", () => {
  beforeEach(() => {
    // setup.ts wipes the IDB universe between tests; nothing else needed.
  });

  it("rejects operations before unlock", async () => {
    const v = new SessionVault(fakeDid());
    expect(v.isUnlocked()).toBe(false);
    await expect(v.createSessionDek("s-1")).rejects.toBeInstanceOf(VaultError);
    await expect(v.getSessionDek("s-1")).rejects.toBeInstanceOf(VaultError);
    await expect(v.listSessions()).rejects.toBeInstanceOf(VaultError);
  });

  it("creates and reads back a session DEK round-trip", async () => {
    const { sign } = makeSigner();
    const v = new SessionVault(fakeDid());
    await v.unlock(sign);
    const dek = await v.createSessionDek("s-rt", VaultRecipientKind.SelfRecipient);
    expect(dek.length).toBe(32);

    const got = await v.getSessionDek("s-rt");
    expect(got).toEqual(dek);
  });

  it("re-unlock with the same signer recovers the same KEK and existing DEKs", async () => {
    const { sign } = makeSigner();
    const did = fakeDid();

    const v1 = new SessionVault(did);
    await v1.unlock(sign);
    const dek1 = await v1.createSessionDek("s-persist");
    v1.lock();
    expect(v1.isUnlocked()).toBe(false);

    const v2 = new SessionVault(did);
    await v2.unlock(sign);
    const dek2 = await v2.getSessionDek("s-persist");
    expect(dek2).toEqual(dek1);
  });

  it("a different signer cannot unlock another DID's vault", async () => {
    const did = fakeDid();
    const a = makeSigner();
    const b = makeSigner();

    const v1 = new SessionVault(did);
    await v1.unlock(a.sign);
    await v1.createSessionDek("s-priv");

    // Construct a fresh vault for the same DID. The second signer
    // produces a different Ed25519 signature → different wrapping key
    // → AES-GCM auth-tag mismatch → VaultError.
    const v2 = new SessionVault(did);
    await expect(v2.unlock(b.sign)).rejects.toBeInstanceOf(VaultError);
  });

  it("listSessions returns only this DID's sessions", async () => {
    const aliceDid = fakeDid("alice");
    const bobDid = fakeDid("bob");
    const aSigner = makeSigner();
    const bSigner = makeSigner();

    const alice = new SessionVault(aliceDid);
    await alice.unlock(aSigner.sign);
    await alice.createSessionDek("s-alice-1");
    await alice.createSessionDek("s-alice-2");

    const bob = new SessionVault(bobDid);
    await bob.unlock(bSigner.sign);
    await bob.createSessionDek("s-bob-1");

    const aliceList = await alice.listSessions();
    const bobList = await bob.listSessions();
    expect(aliceList.map((s) => s.sessionId).sort()).toEqual(["s-alice-1", "s-alice-2"]);
    expect(bobList.map((s) => s.sessionId)).toEqual(["s-bob-1"]);
  });

  it("import overwrites an existing DEK and the new one round-trips", async () => {
    const { sign } = makeSigner();
    const v = new SessionVault(fakeDid());
    await v.unlock(sign);

    const original = await v.createSessionDek("s-import");

    const replacement = new Uint8Array(32);
    crypto.getRandomValues(replacement);
    expect(replacement).not.toEqual(original);

    await v.importSessionDek("s-import", replacement);
    const got = await v.getSessionDek("s-import");
    expect(got).toEqual(replacement);
  });

  it("createSessionDek refuses to overwrite an existing session", async () => {
    const { sign } = makeSigner();
    const v = new SessionVault(fakeDid());
    await v.unlock(sign);
    await v.createSessionDek("s-collide");
    await expect(v.createSessionDek("s-collide")).rejects.toBeInstanceOf(VaultError);
  });

  it("deleteSession removes the DEK and listSessions reflects it", async () => {
    const { sign } = makeSigner();
    const v = new SessionVault(fakeDid());
    await v.unlock(sign);
    await v.createSessionDek("s-go");
    await v.deleteSession("s-go");
    expect(await v.getSessionDek("s-go")).toBeNull();
    expect(await v.listSessions()).toHaveLength(0);
  });

  it("wipe clears every session and the master KEK row", async () => {
    const { sign } = makeSigner();
    const did = fakeDid();
    const v = new SessionVault(did);
    await v.unlock(sign);
    await v.createSessionDek("s-1");
    await v.createSessionDek("s-2");

    await v.wipe();
    expect(v.isUnlocked()).toBe(false);

    // Re-unlock now creates a fresh vault — old DEKs are gone.
    const v2 = new SessionVault(did);
    await v2.unlock(sign);
    expect(await v2.getSessionDek("s-1")).toBeNull();
    expect(await v2.getSessionDek("s-2")).toBeNull();
  });
});
