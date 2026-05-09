import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ed25519 } from "@noble/curves/ed25519";

import { didKeyFromVerifying, localEd25519Signer } from "./envelope";
import {
  awaitHandshake,
  createReceiverHandshake,
  sendHandshake,
} from "./pair-device";
import { SessionVault, VaultRecipientKind } from "./session-vault";

// ── In-process fake of the /api/devices/handshake mailbox ───────────────

interface MailboxEntry {
  envelope_b64: string;
}

function installFetchMailbox() {
  const mailbox = new Map<string, MailboxEntry>();
  const original = globalThis.fetch;

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.endsWith("/api/devices/handshake") && method === "POST") {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        id: string;
        envelope_b64: string;
      };
      if (mailbox.has(body.id)) {
        return new Response(JSON.stringify({ error: "id already used" }), {
          status: 400,
        });
      }
      mailbox.set(body.id, { envelope_b64: body.envelope_b64 });
      return new Response(
        JSON.stringify({ ok: true, expires_at_ms: Date.now() + 120_000 }),
        { status: 200 },
      );
    }

    const m = url.match(/\/api\/devices\/handshake\/([^/?#]+)/);
    if (m && method === "GET") {
      const id = decodeURIComponent(m[1]);
      const entry = mailbox.get(id);
      if (!entry) return new Response("not found", { status: 404 });
      mailbox.delete(id); // delete-on-read
      return new Response(JSON.stringify(entry), { status: 200 });
    }

    return new Response("unexpected url in test", { status: 500 });
  };

  globalThis.fetch = fakeFetch;
  return {
    mailbox,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ── Per-device IndexedDB simulation ─────────────────────────────────────
//
// In real use, each browser has its own IndexedDB. To simulate two
// devices in one process, we keep two `IDBFactory` instances and
// `useDevice()` swaps `globalThis.indexedDB` to the right one before
// each operation. The vault module reads `globalThis.indexedDB` afresh
// on every call (no cached handle), so this swap is sufficient.

interface FakeDevice {
  idb: IDBFactory;
}

function makeDevice(): FakeDevice {
  return { idb: new IDBFactory() };
}

function useDevice(device: FakeDevice) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = device.idb;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function makeWallet() {
  const secret = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(secret);
  return { secret, did: didKeyFromVerifying(pub) };
}

/**
 * Open the vault for the active device's IDB and populate it with
 * fresh session DEKs. Returns the vault, the local signing key for
 * unlock, and a snapshot of the DEKs we created.
 */
async function vaultWithSessions(
  did: string,
  sessions: Array<{ id: string; kind?: number }>,
): Promise<{
  vault: SessionVault;
  vaultSk: Uint8Array;
  deks: Map<string, Uint8Array>;
}> {
  const vault = new SessionVault(did);
  // Use a deterministic local signer so the wrapping survives a
  // re-instantiation of the vault. Production = Turnkey.
  const vaultSk = ed25519.utils.randomPrivateKey();
  await vault.unlock(async (msg) => ed25519.sign(msg, vaultSk));

  const deks = new Map<string, Uint8Array>();
  for (const s of sessions) {
    const kind = (s.kind ?? VaultRecipientKind.SelfRecipient) as 0 | 1 | 2;
    const dek = await vault.createSessionDek(s.id, kind);
    deks.set(s.id, dek);
  }
  return { vault, vaultSk, deks };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("pair-device", () => {
  let net: ReturnType<typeof installFetchMailbox>;

  beforeEach(() => {
    net = installFetchMailbox();
  });

  afterEach(() => {
    net.restore();
  });

  it("end-to-end: sender's DEKs land in receiver's vault", async () => {
    const sender = makeWallet();
    const senderDevice = makeDevice();
    const receiverDevice = makeDevice();

    // ── On device A (sender): populate the vault.
    useDevice(senderDevice);
    const { vault: senderVault, deks: senderDeks } = await vaultWithSessions(
      sender.did,
      [
        { id: "s-alpha" },
        { id: "s-beta", kind: VaultRecipientKind.PeerDid },
      ],
    );

    // ── On device B (receiver): create handshake + open empty vault.
    useDevice(receiverDevice);
    const handshake = createReceiverHandshake(sender.did);
    const receiverVaultSk = ed25519.utils.randomPrivateKey();
    const receiverVault = new SessionVault(sender.did);
    await receiverVault.unlock(async (msg) => ed25519.sign(msg, receiverVaultSk));
    expect(await receiverVault.listSessions()).toHaveLength(0);

    // ── Sender sends. The mailbox is in fakeFetch state, not IDB,
    //     so this is fine to do with senderDevice active.
    useDevice(senderDevice);
    const sentCount = await sendHandshake({
      descriptor: handshake.descriptor,
      vault: senderVault,
      senderDid: sender.did,
      signBody: localEd25519Signer(sender.secret),
    });
    expect(sentCount).toBe(2);

    // ── Receiver awaits + imports.
    useDevice(receiverDevice);
    const result = await awaitHandshake({ receiver: handshake, vault: receiverVault });

    expect(result.imported).toBe(2);
    expect(result.senderDid).toBe(sender.did);

    // Receiver vault now holds the same DEKs as the sender.
    const got = new Map<string, Uint8Array>();
    for (const s of await receiverVault.listSessions()) {
      const dek = await receiverVault.getSessionDek(s.sessionId);
      if (dek) got.set(s.sessionId, dek);
    }
    expect(got.size).toBe(2);
    for (const [sid, originalDek] of senderDeks) {
      expect(Array.from(got.get(sid)!)).toEqual(Array.from(originalDek));
    }
  });

  it("rejects an envelope from an unexpected sender DID", async () => {
    const realSender = makeWallet();
    const attacker = makeWallet();
    const attackerDevice = makeDevice();
    const receiverDevice = makeDevice();

    // Attacker preps their own vault on a separate "device."
    useDevice(attackerDevice);
    const { vault: attackerVault } = await vaultWithSessions(attacker.did, [
      { id: "attacker-session" },
    ]);

    // Receiver pins the *real* sender's DID.
    useDevice(receiverDevice);
    const handshake = createReceiverHandshake(realSender.did);
    const receiverVaultSk = ed25519.utils.randomPrivateKey();
    const receiverVault = new SessionVault(realSender.did);
    await receiverVault.unlock(async (msg) => ed25519.sign(msg, receiverVaultSk));

    // Attacker POSTs an envelope signed by a different DID.
    useDevice(attackerDevice);
    await expect(
      sendHandshake({
        descriptor: handshake.descriptor,
        vault: attackerVault,
        senderDid: attacker.did,
        signBody: localEd25519Signer(attacker.secret),
      }),
    ).resolves.toBeGreaterThan(0);

    // Receiver rejects it as "unexpected sender DID."
    useDevice(receiverDevice);
    await expect(
      awaitHandshake({ receiver: handshake, vault: receiverVault }),
    ).rejects.toThrow(/unexpected sender DID/);
    expect(await receiverVault.listSessions()).toHaveLength(0);
  });

  it("rejects a duplicate POST for the same handshake id", async () => {
    const sender = makeWallet();
    const senderDevice = makeDevice();
    useDevice(senderDevice);
    const { vault } = await vaultWithSessions(sender.did, [{ id: "s-1" }]);
    const handshake = createReceiverHandshake(sender.did);

    await sendHandshake({
      descriptor: handshake.descriptor,
      vault,
      senderDid: sender.did,
      signBody: localEd25519Signer(sender.secret),
    });

    await expect(
      sendHandshake({
        descriptor: handshake.descriptor,
        vault,
        senderDid: sender.did,
        signBody: localEd25519Signer(sender.secret),
      }),
    ).rejects.toThrow(/handshake POST failed/);
  });

  it("respects the sessionIds whitelist", async () => {
    const sender = makeWallet();
    const senderDevice = makeDevice();
    const receiverDevice = makeDevice();

    useDevice(senderDevice);
    const { vault: senderVault } = await vaultWithSessions(sender.did, [
      { id: "s-a" },
      { id: "s-b" },
      { id: "s-c" },
    ]);
    const handshake = createReceiverHandshake(sender.did);

    useDevice(receiverDevice);
    const receiverVaultSk = ed25519.utils.randomPrivateKey();
    const receiverVault = new SessionVault(sender.did);
    await receiverVault.unlock(async (msg) => ed25519.sign(msg, receiverVaultSk));

    useDevice(senderDevice);
    const sent = await sendHandshake({
      descriptor: handshake.descriptor,
      vault: senderVault,
      senderDid: sender.did,
      signBody: localEd25519Signer(sender.secret),
      sessionIds: ["s-a", "s-c"],
    });

    useDevice(receiverDevice);
    const result = await awaitHandshake({ receiver: handshake, vault: receiverVault });

    expect(sent).toBe(2);
    expect(result.imported).toBe(2);
    const ids = (await receiverVault.listSessions()).map((s) => s.sessionId).sort();
    expect(ids).toEqual(["s-a", "s-c"]);
  });
});
