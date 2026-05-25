import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ed25519 } from "@noble/curves/ed25519";

import { didKeyFromVerifying } from "./envelope";
import { createChatVault } from "./chat-vault";
import { loadSessions, saveSessions } from "./chat-history-store";
import type { ThumperSession } from "./thumper-types";

function freshIdb() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
}

function makeVault() {
  const secret = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(secret);
  const userDid = didKeyFromVerifying(pub);
  return createChatVault({
    userDid,
    signBytes: async (msg) => ed25519.sign(msg, secret),
  });
}

const sample: ThumperSession[] = [
  {
    id: "s-1",
    title: "First chat",
    lastMessage: "hi",
    lastMessageAt: "2026-01-02T00:00:00Z",
    messages: [
      { role: "user", content: "hi", timestamp: "2026-01-02T00:00:00Z" },
    ],
  },
];

describe("chat-history-store", () => {
  beforeEach(() => {
    freshIdb();
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  afterEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  it("with no vault, keeps history off-record and clears legacy plaintext", async () => {
    localStorage.setItem("ghola_sessions", JSON.stringify(sample));

    await saveSessions(sample, null);
    expect(localStorage.getItem("ghola_sessions")).toBeNull();

    const got = await loadSessions(null);
    expect(got).toEqual([]);
  });

  it("with a vault, persists ciphertext to IndexedDB and round-trips", async () => {
    const vault = makeVault();
    await saveSessions(sample, vault);

    // localStorage was not used.
    expect(localStorage.getItem("ghola_sessions")).toBeNull();

    const got = await loadSessions(vault);
    expect(got).toEqual(sample);
  });

  it("migrates legacy localStorage into the encrypted store on first read", async () => {
    // Plant a legacy plaintext blob.
    localStorage.setItem("ghola_sessions", JSON.stringify(sample));

    const vault = makeVault();
    const got = await loadSessions(vault);
    expect(got).toEqual(sample);

    // Migration drops the legacy key once the encrypted write succeeded.
    expect(localStorage.getItem("ghola_sessions")).toBeNull();

    // A second read goes through the encrypted store and returns the
    // same content.
    const got2 = await loadSessions(vault);
    expect(got2).toEqual(sample);
  });

  it("a different vault (different DID) cannot read another DID's blob", async () => {
    const aliceVault = makeVault();
    await saveSessions(sample, aliceVault);

    const bobVault = makeVault();
    // Bob's vault has its own row (none yet) → empty list, with no
    // legacy fallback because we cleared localStorage in beforeEach.
    expect(await loadSessions(bobVault)).toEqual([]);
  });
});
