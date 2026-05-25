import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ed25519 } from "@noble/curves/ed25519";

import { createChatVault } from "./chat-vault";
import { didKeyFromVerifying } from "./envelope";
import { compileTradingStrategy } from "./trading-strategy";
import {
  loadTradingStrategies,
  saveTradingStrategies,
} from "./trading-strategy-store";
import type { TradingStrategyRecord } from "./trading-strategy";

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

function sampleRecord(): TradingStrategyRecord {
  const vault = makeVault();
  const result = compileTradingStrategy("DCA $25 into ETH every Friday", vault.userDid);
  if (!result.ok) throw new Error("compile failed");
  return {
    id: result.policy.strategy_id,
    source: "DCA $25 into ETH every Friday",
    policy: result.policy,
    review_summary: result.review_summary,
    receipts: [],
    active: true,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
  };
}

describe("trading-strategy-store", () => {
  beforeEach(() => {
    freshIdb();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("without a vault, refuses durable plaintext storage", async () => {
    const sample = sampleRecord();
    await saveTradingStrategies([sample], null);

    expect(localStorage.getItem("ghola-trading-strategies")).toBeNull();
    expect(await loadTradingStrategies(null)).toEqual([]);
  });

  it("with a vault, persists encrypted strategies and round-trips", async () => {
    const vault = makeVault();
    const sample = sampleRecord();
    await saveTradingStrategies([sample], vault);

    expect(localStorage.getItem("ghola-trading-strategies")).toBeNull();
    const got = await loadTradingStrategies(vault);
    expect(got).toEqual([sample]);
  });

  it("a different vault cannot read another user's strategy blob", async () => {
    const alice = makeVault();
    const bob = makeVault();
    await saveTradingStrategies([sampleRecord()], alice);

    expect(await loadTradingStrategies(bob)).toEqual([]);
  });
});
