import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertPrivateExecutionRecoveryInvariant,
  executeCoinbaseOrder,
  executeSolanaPerpsOrder,
} from "../src/execution/private-execution.js";

describe("private execution recovery containment", () => {
  it("blocks Coinbase partner omnibus placements before claims, connectors, or accounting", async () => {
    for (const operationClass of ["spot_limit_order", "spot_market_order"]) {
      const { state, calls } = instrumentedState({
        template: { order: limitOrder("BTC-USD", "Gtc") },
      });
      let connectorCalls = 0;

      await withEnvironment({ PRIVATE_AGENT_VENUE_DRY_RUN: null }, async () => {
        await assert.rejects(
          executeCoinbaseOrder({
            body: coinbaseBody(operationClass, `coinbase_contained_${operationClass}`),
            recipient: null,
            state,
            submitExecution: async () => {
              connectorCalls += 1;
              return adapterResult("submitted");
            },
          }),
          (error) => error.status === 503 &&
            error.code === "COINBASE_LIVE_EXECUTION_RECOVERY_UNPROVEN",
        );
      });

      assert.equal(connectorCalls, 0, operationClass);
      assert.equal(calls.claim, 0, operationClass);
      assert.equal(calls.policyCount, 0, operationClass);
      assert.equal(calls.policyAmount, 0, operationClass);
      assert.equal(calls.allocation, 0, operationClass);
      assert.equal(calls.reserve, 0, operationClass);
      assert.equal(calls.release, 0, operationClass);
      assert.equal(calls.settle, 0, operationClass);
    }
  });

  it("blocks Phoenix live orders and Backpack resting orders before credentials, claims, or connectors", async () => {
    for (const [venueId, expectedCode] of [
      ["phoenix", "PHOENIX_LIVE_EXECUTION_RECOVERY_UNPROVEN"],
      ["backpack", "BACKPACK_RESTING_ORDER_RECOVERY_UNPROVEN"],
    ]) {
      const { state, calls } = instrumentedState({
        template: { order: limitOrder("SOL-PERP", "Gtc") },
      });
      let connectorCalls = 0;

      await withEnvironment({ PRIVATE_AGENT_VENUE_DRY_RUN: null }, async () => {
        await assert.rejects(
          executeSolanaPerpsOrder({
            body: solanaPerpsBody(venueId),
            recipient: null,
            state,
            submitExecution: async () => {
              connectorCalls += 1;
              return adapterResult("submitted");
            },
          }),
          (error) => error.status === 503 && error.code === expectedCode,
        );
      });

      assert.equal(connectorCalls, 0, venueId);
      assert.equal(calls.claim, 0, venueId);
      assert.equal(calls.policyCount, 0, venueId);
      assert.equal(calls.policyAmount, 0, venueId);
      assert.equal(calls.reserve, 0, venueId);
      assert.equal(calls.settle, 0, venueId);
    }
  });

  it("keeps only Backpack IOC and Hyperliquid paths available", () => {
    for (const input of [
      {
        venue_id: "backpack",
        execution_mode: "ghola_pooled",
        instruction: { operation_class: "perp_limit_order", order: { tif: "Ioc" } },
      },
      {
        venue_id: "hyperliquid",
        execution_mode: "ghola_pooled",
        instruction: { operation_class: "limit_order", order: { tif: "Gtc" } },
      },
    ]) {
      assert.doesNotThrow(() => assertPrivateExecutionRecoveryInvariant(input));
    }
  });

  it("blocks every Coinbase placement mode until recovery is proven", () => {
    for (const instruction of [
      { operation_class: "spot_market_order", order: {} },
      { operation_class: "spot_limit_order", order: { tif: "Gtc", post_only: false } },
      { operation_class: "spot_limit_order", order: { tif: "Ioc", post_only: false } },
      { operation_class: "spot_limit_order", order: { tif: "Fok", post_only: false } },
      { operation_class: "spot_limit_order", order: { tif: "Ioc", post_only: true } },
    ]) {
      assert.throws(
        () => assertPrivateExecutionRecoveryInvariant({
          venue_id: "coinbase_advanced",
          execution_mode: "byo_api_key",
          instruction,
        }),
        (error) => error.code === "COINBASE_LIVE_EXECUTION_RECOVERY_UNPROVEN",
      );
    }
  });

  it("allows Coinbase cancel without creating an omnibus reservation or settlement", async () => {
    const target = "coinbase_target_work_order";
    const { state, calls } = instrumentedState({
      target,
      template: { cancel: { market: "BTC-USD", target_work_order_commitment: target } },
    });
    let connectorCalls = 0;

    const receipt = await withEnvironment({
      PRIVATE_AGENT_VENUE_DRY_RUN: null,
      PRIVATE_AGENT_MAX_VENUE_REQUESTS_PER_MINUTE: "0",
      PRIVATE_AGENT_COINBASE_PARTNER_POOL_VAULT_JSON: JSON.stringify({
        network: "sandbox",
        api_key_name: "organizations/test/apiKeys/test",
        api_private_key_pem: "unused-by-injected-connector",
      }),
    }, () => executeCoinbaseOrder({
      body: coinbaseBody("cancel", "coinbase_cancel_work_order"),
      recipient: null,
      state,
      submitExecution: async () => {
        connectorCalls += 1;
        return adapterResult("cancelled");
      },
    }));

    assert.equal(receipt.status, "cancelled");
    assert.equal(connectorCalls, 1);
    assert.equal(calls.claim, 1);
    assert.equal(calls.allocation, 0);
    assert.equal(calls.reserve, 0);
    assert.equal(calls.release, 0);
    assert.equal(calls.settle, 0);
  });

  it("blocks Coinbase BYO resting placement before claims or connector calls", async () => {
    const { state, calls } = instrumentedState({
      template: { order: limitOrder("BTC-USD", "Gtc") },
    });
    let connectorCalls = 0;

    await withEnvironment({ PRIVATE_AGENT_VENUE_DRY_RUN: null }, async () => {
      await assert.rejects(
        executeCoinbaseOrder({
          body: coinbaseBody(
            "spot_limit_order",
            "coinbase_byo_resting_work_order",
            "byo_api_key",
          ),
          recipient: null,
          state,
          submitExecution: async () => {
            connectorCalls += 1;
            return adapterResult("submitted");
          },
        }),
        (error) => error.code === "COINBASE_LIVE_EXECUTION_RECOVERY_UNPROVEN",
      );
    });

    assert.equal(connectorCalls, 0);
    assert.equal(calls.claim, 0);
    assert.equal(calls.policyCount, 0);
    assert.equal(calls.policyAmount, 0);
    assert.equal(calls.allocation, 0);
    assert.equal(calls.reserve, 0);
    assert.equal(calls.release, 0);
    assert.equal(calls.settle, 0);
  });

  it("fails unresolved cancellation with an explicit code before claims or connector calls", async () => {
    const target = "missing_coinbase_target";
    const { state, calls } = instrumentedState({
      template: { cancel: { market: "BTC-USD", target_work_order_commitment: target } },
    });
    let connectorCalls = 0;

    await assert.rejects(
      executeCoinbaseOrder({
        body: coinbaseBody("cancel", "unresolved_cancel_work_order"),
        recipient: null,
        state,
        submitExecution: async () => {
          connectorCalls += 1;
          return adapterResult("cancelled");
        },
      }),
      (error) => error.status === 400 && error.code === "EXECUTION_CANCEL_TARGET_UNRESOLVED",
    );

    assert.equal(connectorCalls, 0);
    assert.equal(calls.claim, 0);
    assert.equal(calls.policyCount, 0);
    assert.equal(calls.policyAmount, 0);
    assert.equal(calls.allocation, 0);
    assert.equal(calls.reserve, 0);
    assert.equal(calls.release, 0);
    assert.equal(calls.settle, 0);
  });
});

function coinbaseBody(
  operationClass,
  workOrderCommitment = "coinbase_contained_work_order",
  executionMode = "partner_omnibus",
) {
  const body = {
    version: 1,
    venue_id: "coinbase_advanced",
    platform_class: "coinbase_style_provider",
    execution_mode: executionMode,
    operation_class: operationClass,
    work_order_commitment: workOrderCommitment,
  };
  if (executionMode !== "partner_omnibus") {
    return {
      ...body,
      vault_commitment: "coinbase_byo_vault_commitment",
    };
  }
  return {
    ...body,
    omnibus_allocation: {
      allocation_commitment: "coinbase_containment_allocation",
      pool_commitment: "coinbase_containment_pool",
      partner_commitment: "coinbase_containment_partner",
      subledger_account_commitment: "coinbase_containment_subledger",
      status: "allocated",
    },
  };
}

function solanaPerpsBody(venueId) {
  return {
    version: 1,
    venue_id: venueId,
    platform_class: "solana_perps_market",
    execution_mode: "user_stealth",
    operation_class: "perp_limit_order",
    work_order_commitment: `${venueId}_contained_work_order`,
  };
}

function limitOrder(market, tif) {
  return {
    market,
    side: "buy",
    base_size: "0.001",
    limit_price: "10000",
    order_type: "limit",
    tif,
  };
}

function adapterResult(status) {
  return {
    status,
    provider_ref_seed: { status },
    result_seed: { status },
    fills: [],
    final_proof: null,
  };
}

function instrumentedState({ template, target = null }) {
  const calls = {
    claim: 0,
    policyCount: 0,
    policyAmount: 0,
    allocation: 0,
    reserve: 0,
    release: 0,
    settle: 0,
  };
  const state = {
    async getIdempotency(workOrderCommitment) {
      return workOrderCommitment === target ? { receipt: { status: "submitted" } } : null;
    },
    async findSession() {
      return { strategy_policy: { execution_instruction_template: template } };
    },
    async deriveClientOrderId(prefix, workOrderCommitment) {
      return `${prefix}_${workOrderCommitment}`;
    },
    async claimExecution() {
      calls.claim += 1;
      return { status: "claimed", claim_token: "containment_claim_token" };
    },
    async recordExecutionClaimEvidence(_workOrderCommitment, _claimToken, completed) {
      return completed.receipt;
    },
    async completeExecutionClaim(_workOrderCommitment, _claimToken, completed) {
      return completed.receipt;
    },
    async rejectExecutionClaim() {
      return { ok: true };
    },
    async markExecutionClaimReconcileRequired() {
      return { ok: true };
    },
    async incrementPolicyCount() {
      calls.policyCount += 1;
      return { ok: true, count: 1 };
    },
    async incrementPolicyAmount() {
      calls.policyAmount += 1;
      return { ok: true, amount: 1 };
    },
    async putOmnibusAllocation() {
      calls.allocation += 1;
    },
    async reserveOmnibus() {
      calls.reserve += 1;
    },
    async releaseOmnibus() {
      calls.release += 1;
    },
    async settleOmnibusFill() {
      calls.settle += 1;
    },
  };
  return { state, calls };
}

async function withEnvironment(patch, task) {
  const previous = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await task();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
