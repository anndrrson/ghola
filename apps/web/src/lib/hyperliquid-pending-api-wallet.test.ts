import { sha512 } from "@noble/hashes/sha512";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingHyperliquidApiWallet,
  resumeOrCreatePendingHyperliquidApiWallet,
  resumePendingHyperliquidApiWallet,
} from "./hyperliquid-pending-api-wallet";

const OWNER_A = `0x${"11".repeat(20)}`;
const OWNER_B = `0x${"22".repeat(20)}`;

describe("pending Hyperliquid API wallet", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });

  it("resumes the exact encrypted wallet after an interrupted setup", async () => {
    const signBytes = deterministicSigner(7);
    const created = await resumeOrCreatePendingHyperliquidApiWallet({
      userDid: "did:key:investor-a",
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes,
    });
    const resumed = await resumePendingHyperliquidApiWallet({
      userDid: "did:key:investor-a",
      network: "mainnet",
      signBytes,
    });

    expect(created.resumed).toBe(false);
    expect(resumed).toMatchObject({
      ownerAddress: OWNER_A,
      agentAddress: created.agentAddress,
      privateKey: created.privateKey,
      resumed: true,
    });
  });

  it("reuses the one pending wallet instead of generating for another owner", async () => {
    const signBytes = deterministicSigner(8);
    const created = await resumeOrCreatePendingHyperliquidApiWallet({
      userDid: "did:key:investor-b",
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes,
    });
    const conflicted = await resumeOrCreatePendingHyperliquidApiWallet({
      userDid: "did:key:investor-b",
      network: "mainnet",
      ownerAddress: OWNER_B,
      signBytes,
    });

    expect(conflicted).toMatchObject({
      ownerAddress: OWNER_A,
      agentAddress: created.agentAddress,
      privateKey: created.privateKey,
      resumed: true,
      ownerConflict: true,
    });
  });

  it("keeps one wallet when two browser tabs create at the same time", async () => {
    const signBytes = deterministicSigner(12);
    const [first, second] = await Promise.all([
      resumeOrCreatePendingHyperliquidApiWallet({
        userDid: "did:key:investor-race",
        network: "mainnet",
        ownerAddress: OWNER_A,
        signBytes,
      }),
      resumeOrCreatePendingHyperliquidApiWallet({
        userDid: "did:key:investor-race",
        network: "mainnet",
        ownerAddress: OWNER_A,
        signBytes,
      }),
    ]);
    const resumed = await resumePendingHyperliquidApiWallet({
      userDid: "did:key:investor-race",
      network: "mainnet",
      signBytes,
    });

    expect(first.agentAddress).toBe(second.agentAddress);
    expect(resumed?.agentAddress).toBe(first.agentAddress);
  });

  it("fails closed when another signing identity tries to unlock the wallet", async () => {
    await resumeOrCreatePendingHyperliquidApiWallet({
      userDid: "did:key:investor-c",
      network: "mainnet",
      ownerAddress: OWNER_A,
      signBytes: deterministicSigner(9),
    });

    await expect(resumePendingHyperliquidApiWallet({
      userDid: "did:key:investor-c",
      network: "mainnet",
      signBytes: deterministicSigner(10),
    })).rejects.toThrow("pending_wallet_unlock_failed");
  });

  it("permits a new wallet only after the pending record is explicitly cleared", async () => {
    const signBytes = deterministicSigner(11);
    const first = await resumeOrCreatePendingHyperliquidApiWallet({
      userDid: "did:key:investor-d",
      network: "testnet",
      ownerAddress: OWNER_A,
      signBytes,
    });
    await clearPendingHyperliquidApiWallet({
      userDid: "did:key:investor-d",
      network: "testnet",
      ownerAddress: OWNER_A,
    });
    const second = await resumeOrCreatePendingHyperliquidApiWallet({
      userDid: "did:key:investor-d",
      network: "testnet",
      ownerAddress: OWNER_B,
      signBytes,
    });

    expect(second.ownerAddress).toBe(OWNER_B);
    expect(second.agentAddress).not.toBe(first.agentAddress);
  });
});

function deterministicSigner(seed: number) {
  return async (message: Uint8Array) => {
    const input = new Uint8Array(message.length + 1);
    input[0] = seed;
    input.set(message, 1);
    return sha512(input);
  };
}
