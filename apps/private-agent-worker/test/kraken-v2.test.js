import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { compileAllocationPlan } from "../src/kraken-v2/compiler.js";
import { trustedXStockMetadata } from "../src/kraken-v2/adapter.js";
import { createReceiptSigner, verifyReceipt } from "../src/kraken-v2/receipt.js";
import { KrakenV2State } from "../src/kraken-v2/state.js";
import { parseAllocationIntent, parseMandate } from "../src/kraken-v2/types.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");

function mandate() {
  return {
    version: 1,
    mandate_id: "mandate:one",
    connection_id: "connection:one",
    owner_commitment: "owner_commitment",
    account_commitment: "account_commitment",
    sleeves: [
      {
        sleeve_id: "sleeve:alpha",
        label: "Alpha",
        capital_weight_bps: 6_000,
        agent_subject: "agent:alpha",
      },
      {
        sleeve_id: "sleeve:beta",
        label: "Beta",
        capital_weight_bps: 4_000,
        agent_subject: "agent:beta",
      },
    ],
    limits: {
      max_single_order_usd: "10000",
      max_daily_turnover_usd: "20000",
      max_slippage_bps: 100,
      max_asset_weight_bps: 10_000,
      max_drawdown_bps: 2_000,
      max_orders_per_rebalance: 10,
      min_order_usd: "10",
      drift_threshold_bps: 10,
      max_quote_age_ms: 5_000,
      max_intent_ttl_seconds: 3_600,
    },
    status: "active",
    approved_at: "2026-07-24T11:59:00.000Z",
    expires_at: "2026-07-25T11:59:00.000Z",
    approval_commitment: "approval_commitment",
  };
}

function intent(sleeve, agent, sequence, weights) {
  return {
    version: 1,
    connection_id: "connection:one",
    owner_commitment: "owner_commitment",
    account_commitment: "account_commitment",
    sleeve_id: sleeve,
    agent_subject: agent,
    sequence,
    idempotency_key: `${sleeve}:${sequence}`,
    effective_at: "2026-07-24T12:00:00.000Z",
    expires_at: "2026-07-24T12:30:00.000Z",
    weights_bps: weights,
    request_signature_commitment: "request_commitment",
  };
}

describe("Kraken v2 allocation compiler", () => {
  it("nets conflicting sleeve allocations into one portfolio delta", () => {
    const parsedMandate = parseMandate(mandate(), NOW);
    const intents = [
      parseAllocationIntent(
        intent("sleeve:alpha", "agent:alpha", 1, { USD: 0, "US_EQUITY:AAPL": 10_000 }),
        parsedMandate,
        NOW,
      ),
      parseAllocationIntent(
        intent("sleeve:beta", "agent:beta", 1, { USD: 10_000, "US_EQUITY:AAPL": 0 }),
        parsedMandate,
        NOW,
      ),
    ];
    const result = compileAllocationPlan({
      mandate: parsedMandate,
      intents,
      snapshot: {
        completeness: "complete",
        snapshot_commitment: "snapshot_commitment",
        usd_balance: "400",
        positions: {
          "US_EQUITY:AAPL": { notional_usd: "600" },
        },
        open_orders: {},
      },
      now: NOW,
    });
    assert.equal(result.target_notional_usd["US_EQUITY:AAPL"], "600");
    assert.equal(result.status, "no_op");
  });

  it("blocks compilation until every active sleeve has an allocation", () => {
    const result = compileAllocationPlan({
      mandate: parseMandate(mandate(), NOW),
      intents: [],
      snapshot: {
        completeness: "complete",
        snapshot_commitment: "snapshot_commitment",
        usd_balance: "1000",
        positions: {},
        open_orders: {},
      },
      now: NOW,
    });
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.paused_sleeves, ["sleeve:alpha", "sleeve:beta"]);
  });
});

describe("Kraken v2 durable invariants", () => {
  it("deduplicates intents and rejects non-monotonic sequences", async () => {
    const state = new KrakenV2State();
    const first = intent("sleeve:alpha", "agent:alpha", 1, { USD: 10_000 });
    assert.equal((await state.putIntent(first)).duplicate, false);
    assert.equal((await state.putIntent(first)).duplicate, true);
    await assert.rejects(
      state.putIntent({ ...first, idempotency_key: "another:key" }),
      (error) => error.code === "stale_intent_sequence",
    );
  });

  it("issues independently verifiable Ed25519 receipts", () => {
    const pair = generateKeyPairSync("ed25519");
    const signer = createReceiptSigner({ privateKey: pair.privateKey });
    const receipt = signer.issue({
      connection_id: "connection:one",
      run_id: "run:one",
      status: "no_op",
      child_orders: [],
    }, NOW);
    assert.equal(verifyReceipt(receipt), true);
    assert.equal(verifyReceipt({ ...receipt, status: "completed" }), false);
  });
});

describe("Kraken xStocks catalog classification", () => {
  it("accepts Kraken's documented ticker-x USD convention without guessing other assets", () => {
    assert.equal(trustedXStockMetadata({
      altname: "AAPLxUSD",
      wsname: "AAPLx/USD",
      base: "AAPLx",
      quote: "ZUSD",
      pair: {},
      asset: {},
    }), true);
    assert.equal(trustedXStockMetadata({
      altname: "XBTUSD",
      wsname: "XBT/USD",
      base: "XXBT",
      quote: "ZUSD",
      pair: {},
      asset: {},
    }), false);
  });
});
