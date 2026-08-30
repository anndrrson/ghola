import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  AsterExecutionError,
  asterCredentialFromVault,
  readAsterFundingSettlements,
  signedRequest,
  submitAndReconcileAsterExecution,
  submitAsterExecution,
  verifyAsterNoSubmit,
} from "../src/venues/aster.js";
import { executeAutopilotOrder } from "../src/execution/private-execution.js";
import { createWorkerState } from "../src/state/private-state.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const SIGNER = privateKeyToAccount(PRIVATE_KEY).address.toLowerCase();
const USER = `0x${"22".repeat(20)}`;
const ENV = { PRIVATE_AGENT_ASTER_ALLOW_MAINNET: "true", PRIVATE_AGENT_ASTER_LIVE_MODE: "full_ticket" };

test("validates that the sealed Aster signer matches its API wallet key", () => {
  const credential = asterCredentialFromVault({
    kind: "ghola_aster_execution_vault",
    user_address: USER,
    signer_address: SIGNER,
    api_wallet_private_key: PRIVATE_KEY,
  });
  assert.equal(credential.signer_address, SIGNER);
  assert.throws(() => asterCredentialFromVault({
    kind: "ghola_aster_execution_vault",
    user_address: USER,
    signer_address: `0x${"33".repeat(20)}`,
    api_wallet_private_key: PRIVATE_KEY,
  }), /does not match/);
});

test("signs Aster V3 parameters in ASCII order without exposing the private key", async () => {
  let observed;
  const result = await signedRequest({
    credential: credential(),
    method: "GET",
    path: "/fapi/v3/account",
    params: { symbol: "BTCUSDT", recvWindow: "5000" },
    now: () => 1_800_000_000_000,
    fetchImpl: async (url, init) => {
      observed = { url: String(url), init };
      return jsonResponse({ canTrade: true });
    },
  });
  assert.equal(result.canTrade, true);
  const query = new URL(observed.url).searchParams;
  assert.equal(query.get("user"), USER);
  assert.equal(query.get("signer"), SIGNER);
  assert.match(query.get("signature"), /^0x[0-9a-f]{130}$/);
  assert.equal(observed.url.includes(PRIVATE_KEY.slice(2)), false);
});

test("performs authenticated account and order-shape checks without submitting", async () => {
  const calls = [];
  const result = await verifyAsterNoSubmit({
    credential: credential(),
    instruction: orderInstruction(),
    clientOrderId: "ghola-carry-0001",
    now: () => 1_800_000_000_000,
    env: ENV,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ path: parsed.pathname, method: init.method });
      if (parsed.pathname.endsWith("/time")) return jsonResponse({ serverTime: 1_800_000_000_000 });
      if (parsed.pathname.endsWith("/exchangeInfo")) return jsonResponse({ symbols: [{
        symbol: "BTCUSDT",
        status: "TRADING",
        filters: [
          { filterType: "PRICE_FILTER", tickSize: "0.10" },
          { filterType: "LOT_SIZE", stepSize: "0.001" },
        ],
      }] });
      if (parsed.pathname.endsWith("/account")) return jsonResponse({
        canTrade: true,
        availableBalance: "100",
        totalInitialMargin: "10",
        totalMaintMargin: "5",
      });
      if (parsed.pathname.endsWith("/positionRisk")) return jsonResponse([{
        symbol: "BTCUSDT",
        positionAmt: "0.5",
        markPrice: "100000",
        liquidationPrice: "70000",
      }]);
      if (parsed.pathname.endsWith("/openOrders")) return jsonResponse([]);
      if (parsed.pathname.endsWith("/commissionRate")) return jsonResponse({ makerCommissionRate: "0.0001", takerCommissionRate: "0.00035" });
      return jsonResponse({}, 404);
    },
  });
  assert.equal(result.status, "verified_ready");
  assert.equal(result.checks.transaction_broadcast, false);
  assert.equal(result.account.taker_fee_bps, 3.5);
  assert.equal(result.account.fee_source, "aster_account_commission_rate");
  assert.equal(result.account.fees_exact_for_account, true);
  assert.equal(result.account.fees_conservative_upper_bound, false);
  assert.equal(result.account.position_count, 1);
  assert.equal(result.account.liquidation_distance_bps, 3_000);
  assert.equal(result.account.liquidation_distance_verified, true);
  assert.equal(result.account.liquidation_distance_source, "aster_fapi_v3_position_risk_v1");
  assert.equal(result.authority_boundary.venue_native_trade_only, true);
  assert.equal(result.authority_boundary.withdrawal_request_permitted, false);
  assert.equal(calls.length, 6);
  assert.equal(calls.every((call) => call.method === "GET"), true);
  assert.equal(calls.some((call) => call.path.endsWith("/order")), false);
});

test("never retries an ambiguous Aster submission", async () => {
  let calls = 0;
  await assert.rejects(() => submitAsterExecution({
    credential: credential(),
    instruction: orderInstruction(),
    clientOrderId: "ghola-carry-0002",
    env: ENV,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("timeout");
    },
  }), (error) => error instanceof AsterExecutionError && error.code === "submission_outcome_ambiguous");
  assert.equal(calls, 1);
});

test("submits Aster once and reconciles only the exact client order until terminal", async () => {
  let submitCalls = 0;
  let reconcileCalls = 0;
  const result = await submitAndReconcileAsterExecution({
    credential: credential(),
    instruction: orderInstruction(),
    clientOrderId: "ghola-carry-0004",
    env: ENV,
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (init.method === "POST") {
        submitCalls += 1;
        return jsonResponse({ symbol: "BTCUSDT", clientOrderId: "ghola-carry-0004", orderId: 44, status: "NEW", executedQty: "0" });
      }
      assert.equal(init.method, "GET");
      assert.equal(parsed.searchParams.get("origClientOrderId"), "ghola-carry-0004");
      reconcileCalls += 1;
      return reconcileCalls === 1
        ? jsonResponse({ symbol: "BTCUSDT", clientOrderId: "ghola-carry-0004", orderId: 44, status: "NEW", executedQty: "0" })
        : jsonResponse({ symbol: "BTCUSDT", clientOrderId: "ghola-carry-0004", orderId: 44, status: "FILLED", executedQty: "0.01", avgPrice: "60000" });
    },
  });
  assert.equal(submitCalls, 1);
  assert.equal(reconcileCalls, 2);
  assert.equal(result.status, "filled");
  assert.equal(result.final_proof.target_client_order_matched, true);
  assert.equal(result.final_proof.final_venue_execution_proven, true);
  assert.equal(result.provider_ref_seed.submission_order_id, 44);
});

test("recovers an ambiguous Aster submit response by reading the exact order without resubmitting", async () => {
  let submitCalls = 0;
  let reconcileCalls = 0;
  const result = await submitAndReconcileAsterExecution({
    credential: credential(),
    instruction: orderInstruction(),
    clientOrderId: "ghola-carry-0005",
    env: ENV,
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (init.method === "POST") {
        submitCalls += 1;
        return jsonResponse({ msg: "upstream response lost after write" }, 503);
      }
      assert.equal(parsed.searchParams.get("origClientOrderId"), "ghola-carry-0005");
      reconcileCalls += 1;
      return reconcileCalls === 1
        ? jsonResponse({ code: -2013, msg: "Order does not exist." }, 400)
        : jsonResponse({ symbol: "BTCUSDT", clientOrderId: "ghola-carry-0005", orderId: 45, status: "FILLED", executedQty: "0.01", avgPrice: "60000" });
    },
  });
  assert.equal(submitCalls, 1);
  assert.equal(reconcileCalls, 2);
  assert.equal(result.status, "filled");
  assert.equal(result.reconciliation.submissionResponseAmbiguous, true);
  assert.equal(result.reconciliation.submission_retry_count, 0);
  assert.equal(result.reconciliation.target_client_order_only, true);
  assert.equal(result.reconciliation.readFailures, 1);
});

test("bounds exact-order reconciliation when an ambiguous Aster submit cannot be found", async () => {
  let submitCalls = 0;
  let reconcileCalls = 0;
  await assert.rejects(submitAndReconcileAsterExecution({
    credential: credential(),
    instruction: orderInstruction(),
    clientOrderId: "ghola-carry-0006",
    env: {
      ...ENV,
      PRIVATE_AGENT_ASTER_RECONCILE_TIMEOUT_MS: "250",
      PRIVATE_AGENT_ASTER_RECONCILE_INTERVAL_MS: "100",
    },
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    fetchImpl: async (_url, init) => {
      if (init.method === "POST") {
        submitCalls += 1;
        throw new Error("response lost after write");
      }
      reconcileCalls += 1;
      return jsonResponse({ code: -2013, msg: "Order does not exist." }, 400);
    },
  }), (error) => error.code === "submission_outcome_ambiguous");
  assert.equal(submitCalls, 1);
  assert.equal(reconcileCalls, 4);
});

test("reads signed Aster funding settlements without submitting", async () => {
  let observed;
  const rows = await readAsterFundingSettlements({
    credential: credential(),
    symbol: "BTC",
    start_time_ms: 1_800_000_000_000,
    end_time_ms: 1_800_003_600_000,
    now: () => 1_800_003_600_000,
    fetchImpl: async (url, init) => {
      observed = { url: new URL(url), method: init.method };
      return jsonResponse([{ symbol: "BTCUSDT", incomeType: "FUNDING_FEE", income: "-0.0125", asset: "USDT", time: 1_800_003_600_000, tranId: 42 }]);
    },
  });
  assert.equal(observed.method, "GET");
  assert.equal(observed.url.pathname, "/fapi/v1/income");
  assert.equal(observed.url.searchParams.get("incomeType"), "FUNDING_FEE");
  assert.deepEqual(rows, [{ venue_id: "aster", asset: "BTC", occurred_at_ms: 1_800_003_600_000, amount_quote: "-0.0125", quote_asset: "USDT", settlement_id: "42" }]);
});

test("reconciles by the exact client order id", async () => {
  let observed;
  const result = await submitAsterExecution({
    credential: credential(),
    instruction: {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "aster",
      operation_class: "reconcile",
      reconcile: { market: "BTC-PERP", target_client_order_id: "ghola-carry-0003" },
    },
    clientOrderId: "ignored-fallback",
    env: ENV,
    fetchImpl: async (url, init) => {
      observed = { url: new URL(url), method: init.method };
      return jsonResponse({ symbol: "BTCUSDT", clientOrderId: "ghola-carry-0003", status: "FILLED", executedQty: "0.01", avgPrice: "60000" });
    },
  });
  assert.equal(observed.method, "GET");
  assert.equal(observed.url.searchParams.get("origClientOrderId"), "ghola-carry-0003");
  assert.equal(result.status, "filled");
  assert.equal(result.final_proof.final_venue_execution_proven, true);
});

test("keeps explicit Aster reconciliation bound to the original order across read failures", async () => {
  const targets = [];
  let reads = 0;
  const result = await submitAndReconcileAsterExecution({
    credential: credential(),
    instruction: {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "aster",
      operation_class: "reconcile",
      reconcile: { market: "BTC-PERP", target_client_order_id: "ghola-original-0007" },
    },
    clientOrderId: "ghola-reconcile-0007",
    env: ENV,
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      assert.equal(init.method, "GET");
      targets.push(new URL(url).searchParams.get("origClientOrderId"));
      reads += 1;
      if (reads === 1) throw new Error("temporary read failure");
      return jsonResponse({
        symbol: "BTCUSDT",
        clientOrderId: "ghola-original-0007",
        orderId: 47,
        status: "FILLED",
        executedQty: "0.01",
        avgPrice: "60000",
      });
    },
  });
  assert.deepEqual(targets, ["ghola-original-0007", "ghola-original-0007"]);
  assert.equal(result.status, "filled");
  assert.equal(result.reconciliation.reconcileOnly, true);
  assert.equal(result.reconciliation.submission_retry_count, 0);
});

test("routes Aster through durable policy and idempotency state in dry-run", async (t) => {
  const old = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "ghola-aster-route-"));
  t.after(() => {
    process.env = old;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
  process.env.PRIVATE_AGENT_ASTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_ASTER_LIVE_MODE = "full_ticket";
  process.env.PRIVATE_AGENT_ASTER_FULL_TICKET_MAX_NOTIONAL_USD = "25";
  const state = createWorkerState(dir);
  const args = {
    venue_id: "aster",
    operation_class: "limit_order",
    work_order_commitment: "work:aster:carry:0001",
    policy_commitment: "policy:aster:carry:0001",
    session_policy: {
      policy_commitment: "policy:aster:carry:0001",
      market_allowlist: ["BTC-PERP"],
      max_notional_bucket: "25",
      max_order_count: 2,
      max_daily_notional_bucket: "100",
      kill_switch: false,
    },
    instruction: {
      ...orderInstruction(),
      order: { ...orderInstruction().order, base_size: "0.01", limit_price: "1000" },
    },
    execution: { execution_mode: "byo_api_key" },
    recipient: null,
    state,
  };
  const first = await executeAutopilotOrder(args);
  const second = await executeAutopilotOrder(args);
  assert.equal(first.venue_id, "aster");
  assert.equal(first.status, "open");
  assert.equal(second.result_commitment, first.result_commitment);
  assert.equal(second.provider_ref_commitment, first.provider_ref_commitment);
  assert.equal((await state.getExecutionAttempt(args.work_order_commitment)).status, "open");
});

test("refreshes read-only Aster reconciliation instead of replaying a stale cache", async (t) => {
  const old = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "ghola-aster-reconcile-refresh-"));
  t.after(() => {
    process.env = old;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
  process.env.PRIVATE_AGENT_ASTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_ASTER_LIVE_MODE = "full_ticket";
  const state = createWorkerState(dir);
  const targetWork = "work:aster:original:0001";
  await state.putIdempotency(targetWork, { status: "submitted" });
  const originalPutAttempt = state.putExecutionAttempt.bind(state);
  let attemptWrites = 0;
  state.putExecutionAttempt = async (...args) => {
    attemptWrites += 1;
    return originalPutAttempt(...args);
  };
  const args = {
    venue_id: "aster",
    operation_class: "reconcile",
    work_order_commitment: "work:aster:reconcile:0001",
    policy_commitment: "policy:aster:reconcile:0001",
    session_policy: {
      policy_commitment: "policy:aster:reconcile:0001",
      market_allowlist: ["BTC-PERP"],
      max_notional_bucket: "25",
      max_order_count: 2,
      max_daily_notional_bucket: "100",
      kill_switch: false,
    },
    instruction: {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "aster",
      operation_class: "reconcile",
      reconcile: { market: "BTC-PERP", target_work_order_commitment: targetWork },
    },
    execution: { execution_mode: "byo_api_key" },
    recipient: null,
    state,
  };
  await executeAutopilotOrder(args);
  await executeAutopilotOrder(args);
  assert.equal(attemptWrites, 4);
  assert.equal((await state.getExecutionAttempt(args.work_order_commitment)).submit_count, 0);
});

test("allows exact reconciliation of a durably recorded recovery child", async (t) => {
  const old = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "ghola-aster-recovery-child-"));
  t.after(() => {
    process.env = old;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.PRIVATE_AGENT_VENUE_DRY_RUN = "true";
  process.env.PRIVATE_AGENT_ASTER_ALLOW_MAINNET = "true";
  process.env.PRIVATE_AGENT_ASTER_LIVE_MODE = "full_ticket";
  const state = createWorkerState(dir);
  const sagaId = "saga:aster:recovery-child:0001";
  const legId = `${sagaId}:aster`;
  const targetWork = "work:aster:recovery-child:0001";
  state.getMultiLegSaga = async () => ({
    saga_id: sagaId,
    execution_context: {
      autopilot_session_id: "autopilot:aster:recovery-child:0001",
      policy_commitment: "policy:aster:recovery-child:0001",
      legs: [{ leg_id: legId, work_order_commitment: "work:aster:original:recovery-child" }],
    },
    legs: [{ leg_id: legId, venue_id: "aster" }],
  });
  const originalGetIdempotency = state.getIdempotency.bind(state);
  state.getIdempotency = async (key) => key.startsWith("accounting:recovery:")
    ? {
        receipt: {
          version: 1,
          kind: "multi_leg_recovery_accounting",
          saga_id: sagaId,
          leg_id: legId,
          venue_id: "aster",
          action: "unwind",
          executions: [{ work_order_commitment: targetWork }],
        },
      }
    : originalGetIdempotency(key);
  const receipt = await executeAutopilotOrder({
    venue_id: "aster",
    operation_class: "reconcile",
    work_order_commitment: "work:aster:recovery-child:reconcile:0001",
    policy_commitment: "policy:aster:recovery-child:0001",
    session_policy: {
      policy_commitment: "policy:aster:recovery-child:0001",
      market_allowlist: ["BTC-PERP"],
      max_notional_bucket: "25",
      max_order_count: 4,
      max_daily_notional_bucket: "100",
      kill_switch: false,
    },
    instruction: {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "aster",
      operation_class: "reconcile",
      reconcile: { market: "BTC-PERP", target_work_order_commitment: targetWork },
    },
    execution: {
      execution_mode: "byo_api_key",
      autopilot_session_id: "autopilot:aster:recovery-child:0001",
      recovery_saga_id: sagaId,
    },
    recipient: null,
    state,
  });
  assert.equal(receipt.status, "open");
  assert.equal((await state.getExecutionAttempt("work:aster:recovery-child:reconcile:0001")).submit_count, 0);
});

function credential() {
  return asterCredentialFromVault({
    kind: "ghola_aster_execution_vault",
    user_address: USER,
    signer_address: SIGNER,
    api_wallet_private_key: PRIVATE_KEY,
  });
}

function orderInstruction() {
  return {
    version: 1,
    kind: "ghola_private_execution_instruction",
    venue_id: "aster",
    operation_class: "limit_order",
    order: {
      market: "BTC-PERP",
      side: "buy",
      base_size: "0.010",
      limit_price: "60000.10",
      tif: "IOC",
      reduce_only: false,
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
