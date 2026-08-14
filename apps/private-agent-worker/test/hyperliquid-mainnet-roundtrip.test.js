import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import {
  bytesToBase64,
  bytesToHex,
  didKeyFromVerifying,
  sealForTest,
} from "../src/crypto/envelope.js";
import {
  MAINNET_PROOF_CONFIRMATION,
  hyperliquidMainnetRoundTripEnabled,
  runSealedHyperliquidMainnetRoundTrip,
  validateHyperliquidMainnetRoundTripRequest,
} from "../src/execution/hyperliquid-mainnet-roundtrip.js";
import { createWorkerState } from "../src/state/private-state.js";

describe("sealed Hyperliquid mainnet proof round trip", () => {
  it("requires every code-bounded live gate", () => {
    const env = {
      PRIVATE_AGENT_HYPERLIQUID_MAINNET_PROOF_ENABLED: "true",
      PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET: "true",
      PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE: "tiny_fill",
      PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "11",
      PRIVATE_AGENT_HYPERLIQUID_DAILY_NOTIONAL_CAP_USD: "25",
      PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "100",
    };
    assert.equal(hyperliquidMainnetRoundTripEnabled(env), true);
    assert.equal(hyperliquidMainnetRoundTripEnabled({ ...env, PRIVATE_AGENT_VENUE_DRY_RUN: "true" }), false);
    assert.equal(hyperliquidMainnetRoundTripEnabled({ ...env, PRIVATE_AGENT_HYPERLIQUID_LIVE_MAX_NOTIONAL_USD: "50" }), false);
    assert.equal(hyperliquidMainnetRoundTripEnabled({ ...env, PRIVATE_AGENT_HYPERLIQUID_MAX_SLIPPAGE_BPS: "101" }), false);
  });

  it("persists the proof receipt and replays it after a worker-state restart without another submit", async () => {
    const fixture = await sealedFixture();
    const dir = mkdtempSync(join(tmpdir(), "ghola-mainnet-proof."));
    let positionSize = "0";
    let orderCalls = 0;
    const receipts = new Map();
    const executeOrder = async ({ body }) => {
      orderCalls += 1;
      const existing = receipts.get(body.work_order_commitment);
      if (existing) return structuredClone(existing);
      const entry = body.work_order_commitment.endsWith("_entry");
      positionSize = entry ? "0.18" : "0";
      const receipt = {
        version: 1,
        status: "filled",
        work_order_commitment: body.work_order_commitment,
        fill_summary: {
          fill_count: 1,
          filled_base_size: "0.18",
          filled_notional_usd: 10.5,
          average_fill_price: entry ? 58.31 : 58.32,
          fee_usd: 0.004,
        },
        final_proof: {
          broadcast_performed: true,
          final_venue_execution_proven: true,
          final_fill_proven: true,
        },
      };
      receipts.set(body.work_order_commitment, receipt);
      return structuredClone(receipt);
    };
    const fetchImpl = async (_url, init) => {
      const request = JSON.parse(String(init.body));
      if (request.type === "openOrders") return Response.json([]);
      return Response.json({
        assetPositions: positionSize === "0"
          ? []
          : [{ position: { coin: "HYPE", szi: positionSize } }],
      });
    };
    const dependencies = {
      fetchImpl,
      executeOrder,
      readSnapshot: async () => ({ status: "ready_to_trade", trading_enabled: true }),
      reconcile: async ({ body }) => structuredClone(receipts.get(body.work_order_commitment)),
      submitEmergency: async () => { throw new Error("emergency flatten must not run"); },
    };
    try {
      const firstState = createWorkerState(dir);
      const first = await runSealedHyperliquidMainnetRoundTrip({
        body: fixture.body,
        recipient: fixture.recipient,
        state: firstState,
        ...dependencies,
      });
      const restartedState = createWorkerState(dir);
      const replay = await runSealedHyperliquidMainnetRoundTrip({
        body: fixture.body,
        recipient: fixture.recipient,
        state: restartedState,
        ...dependencies,
      });

      assert.equal(first.flat_after_exit, true);
      assert.equal(first.claim_store, "unverified");
      assert.equal(first.duplicate_entry_prevented, true);
      assert.equal(first.duplicate_exit_prevented, true);
      assert.equal(orderCalls, 4);
      assert.deepEqual(replay, first);
      assert.equal(positionSize, "0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function sealedFixture() {
  const recipientSecret = x25519.utils.randomPrivateKey();
  const recipient = {
    recipient_id: "phala:cvm:mainnet-proof-test",
    x25519_pub_hex: bytesToHex(x25519.getPublicKey(recipientSecret)),
    x25519_secret_hex: bytesToHex(recipientSecret),
  };
  const senderSecret = ed25519.utils.randomPrivateKey();
  const aad = [
    "ghola/hyperliquid-execution-vault-v1",
    "account:private_account_test",
    `recipient:${recipient.recipient_id}`,
    "network:mainnet",
  ].join("|");
  const wire = await sealForTest({
    recipientId: recipient.recipient_id,
    recipientX25519: x25519.getPublicKey(recipientSecret),
    senderDid: didKeyFromVerifying(ed25519.getPublicKey(senderSecret)),
    associatedData: aad,
    plaintext: {
      version: 1,
      kind: "ghola_hyperliquid_execution_vault",
      network: "mainnet",
      hyperliquid_account_address: `0x${"1".repeat(40)}`,
      api_wallet_private_key: `0x${"2".repeat(64)}`,
      agent_name: "proof-test",
    },
    signBody: async (digest) => ed25519.sign(digest, senderSecret),
  });
  const body = {
    version: 1,
    confirmation: MAINNET_PROOF_CONFIRMATION,
    execution_mode: "byo_api_key",
    account_commitment: "private_account_test",
    vault_commitment: "vault_mainnet_proof_test",
    policy_commitment: "policy_mainnet_proof_test",
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext: bytesToBase64(wire),
      recipient: recipient.recipient_id,
      aad,
    },
    market: "HYPE",
    notional_usd: 10.5,
    slippage_bps: 100,
  };
  assert.deepEqual(validateHyperliquidMainnetRoundTripRequest(body, recipient), []);
  return { body, recipient };
}
