import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  AsterExecutionError,
  asterCredentialFromVault,
  readAsterAccountState,
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

test("classifies Aster's official deposit gate without submitting", async () => {
  let calls = 0;
  await assert.rejects(() => signedRequest({
    credential: credential(),
    method: "GET",
    path: "/fapi/v3/account",
    params: {},
    now: () => 1_800_000_000_000,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ code: -5050, msg: "This function can only be used after deposit" }, 400);
    },
  }), (error) => {
    assert.equal(error instanceof AsterExecutionError, true);
    assert.equal(error.status, 409);
    assert.equal(error.code, "aster_deposit_required");
    assert.deepEqual(error.details, {
      venue_code: -5050,
      venue_message: "This function can only be used after deposit",
    });
    return true;
  });
  assert.equal(calls, 1);
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
      calls.push({ path: parsed.pathname, method: init.method, symbol: parsed.searchParams.get("symbol") });
      if (parsed.pathname.endsWith("/time")) return jsonResponse({ serverTime: 1_800_000_000_000 });
      if (parsed.pathname.endsWith("/premiumIndex")) return jsonResponse({ symbol: "BTCUSDT", markPrice: "60000" });
      if (parsed.pathname.endsWith("/exchangeInfo")) return jsonResponse({ symbols: [{
        symbol: "BTCUSDT",
        status: "TRADING",
        filters: [
          { filterType: "PRICE_FILTER", minPrice: "0.10", maxPrice: "1000000", tickSize: "0.10" },
          { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
          { filterType: "MIN_NOTIONAL", notional: "5" },
          { filterType: "PERCENT_PRICE", multiplierUp: "1.15", multiplierDown: "0.85" },
          { filterType: "MAX_NUM_ORDERS", limit: 200 },
        ],
      }] });
      if (parsed.pathname.endsWith("/account")) return jsonResponse({
        canTrade: true,
        availableBalance: "100",
        totalMarginBalance: "100",
        totalInitialMargin: "10",
        totalMaintMargin: "5",
      });
      if (parsed.pathname.endsWith("/positionRisk")) return jsonResponse([{
        symbol: "ETHUSDT",
        positionAmt: "0.5",
        markPrice: "100000",
        liquidationPrice: "70000",
      }]);
      if (parsed.pathname.endsWith("/openOrders")) return jsonResponse([{ symbol: "ETHUSDT", orderId: 9 }]);
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
  assert.deepEqual(result.market_rules, {
    source: "aster_fapi_v3_exchange_info",
    price_filter: { min_price: "0.1", max_price: "1000000", tick_size: "0.1" },
    lot_size: { min_quantity: "0.001", max_quantity: "100", step_size: "0.001" },
    minimum_notional: "5",
    percent_price: { mark_price: "60000", multiplier_up: "1.15", multiplier_down: "0.85" },
    max_num_orders: { limit: 200 },
  });
  assert.equal(result.account.position_count, 1);
  assert.equal(result.account.open_order_count, 1);
  assert.equal(result.account.target_symbol_open_order_count, 0);
  assert.equal(result.account.flat_zero_orders, false);
  assert.equal(result.account.liquidation_distance_bps, 3_000);
  assert.equal(result.account.liquidation_distance_verified, true);
  assert.equal(result.account.liquidation_distance_source, "aster_fapi_v3_position_risk_v1");
  assert.equal(result.authority_boundary.venue_native_trade_only, true);
  assert.equal(result.authority_boundary.withdrawal_request_permitted, false);
  assert.equal(calls.length, 7);
  assert.equal(calls.every((call) => call.method === "GET"), true);
  assert.equal(calls.some((call) => call.path.endsWith("/order")), false);
  assert.equal(calls.find((call) => call.path.endsWith("/positionRisk")).symbol, null);
  assert.equal(calls.find((call) => call.path.endsWith("/openOrders")).symbol, null);
  assert.equal(calls.find((call) => call.path.endsWith("/commissionRate")).symbol, "BTCUSDT");
});

test("rejects an Aster order below venue minimum notional before authenticated account checks", async () => {
  const calls = [];
  await assert.rejects(() => verifyAsterNoSubmit({
    credential: credential(),
    instruction: orderInstruction(),
    clientOrderId: "ghola-carry-filter-1",
    now: () => 1_800_000_000_000,
    env: ENV,
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: init.method });
      if (path.endsWith("/time")) return jsonResponse({ serverTime: 1_800_000_000_000 });
      if (path.endsWith("/premiumIndex")) return jsonResponse({ symbol: "BTCUSDT", markPrice: "60000" });
      if (path.endsWith("/exchangeInfo")) return jsonResponse({ symbols: [{
        symbol: "BTCUSDT",
        status: "TRADING",
        filters: [
          { filterType: "PRICE_FILTER", minPrice: "0.10", maxPrice: "1000000", tickSize: "0.10" },
          { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
          { filterType: "MIN_NOTIONAL", notional: "1000" },
          { filterType: "MAX_NUM_ORDERS", limit: 200 },
        ],
      }] });
      throw new Error("authenticated account read must not run");
    },
  }), (error) => error instanceof AsterExecutionError
    && error.code === "venue_rejected"
    && /minimum notional/.test(error.message));
  assert.equal(calls.length, 3);
  assert.equal(calls.every((call) => call.method === "GET"), true);
  assert.equal(calls.some((call) => call.path.endsWith("/account")), false);
});

test("requires canonical PRICE_FILTER and LOT_SIZE evidence before authenticated Aster checks", async (t) => {
  const canonical = [
    { filterType: "PRICE_FILTER", minPrice: "0.10", maxPrice: "1000000", tickSize: "0.10" },
    { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
    { filterType: "MAX_NUM_ORDERS", limit: 200 },
  ];
  for (const missingType of ["PRICE_FILTER", "LOT_SIZE"]) {
    await t.test(`missing ${missingType}`, async () => {
      let authenticatedRead = false;
      await assert.rejects(() => verifyAsterNoSubmit({
        credential: credential(),
        instruction: orderInstruction(),
        clientOrderId: `ghola-filter-${missingType === "PRICE_FILTER" ? "price" : "lot"}`,
        now: () => 1_800_000_000_000,
        env: ENV,
        fetchImpl: async (url) => {
          const path = new URL(url).pathname;
          if (path.endsWith("/time")) return jsonResponse({ serverTime: 1_800_000_000_000 });
          if (path.endsWith("/premiumIndex")) return jsonResponse({ symbol: "BTCUSDT", markPrice: "60000" });
          if (path.endsWith("/exchangeInfo")) return jsonResponse({ symbols: [{
            symbol: "BTCUSDT",
            status: "TRADING",
            filters: canonical.filter((filter) => filter.filterType !== missingType),
          }] });
          authenticatedRead = true;
          throw new Error("authenticated account read must not run");
        },
      }), (error) => error instanceof AsterExecutionError
        && error.code === "connector_submit_failed"
        && error.message.includes(missingType));
      assert.equal(authenticatedRead, false);
    });
  }
});

test("uses exact decimal math for Aster minimum-notional validation", async () => {
  await assert.rejects(() => verifyAsterNoSubmit({
    credential: credential(),
    instruction: {
      ...orderInstruction(),
      order: { ...orderInstruction().order, base_size: "0.2", limit_price: "0.1" },
    },
    clientOrderId: "ghola-exact-notional-1",
    now: () => 1_800_000_000_000,
    env: ENV,
    fetchImpl: noSubmitFetch({ filters: [
      { filterType: "PRICE_FILTER", minPrice: "0.1", maxPrice: "100", tickSize: "0.1" },
      { filterType: "LOT_SIZE", minQty: "0.1", maxQty: "100", stepSize: "0.1" },
      { filterType: "MIN_NOTIONAL", notional: "0.020000000000000001" },
      { filterType: "MAX_NUM_ORDERS", limit: 200 },
    ] }),
  }), (error) => error instanceof AsterExecutionError
    && error.code === "venue_rejected"
    && /minimum notional/.test(error.message));
});

test("honors disabled Aster maximum-price and tick-size rules", async () => {
  const result = await verifyAsterNoSubmit({
    credential: credential(),
    instruction: orderInstruction(),
    clientOrderId: "ghola-disabled-price-rules-1",
    now: () => 1_800_000_000_000,
    env: ENV,
    fetchImpl: noSubmitFetch({ filters: [
      { filterType: "PRICE_FILTER", minPrice: "0", maxPrice: "0", tickSize: "0" },
      { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
      { filterType: "MAX_NUM_ORDERS", limit: 200 },
    ] }),
  });
  assert.equal(result.status, "verified_ready");
  assert.deepEqual(result.market_rules.price_filter, {
    min_price: "0",
    max_price: "0",
    tick_size: "0",
  });
});

test("fails closed on malformed or ambiguous Aster filter and mark-price evidence", async (t) => {
  const base = [
    { filterType: "PRICE_FILTER", minPrice: "0.1", maxPrice: "1000000", tickSize: "0.1" },
    { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
    { filterType: "MAX_NUM_ORDERS", limit: 200 },
  ];
  const cases = [
    { name: "malformed minimum notional", filters: [...base, { filterType: "MIN_NOTIONAL", notional: "invalid" }] },
    { name: "duplicate minimum notional", filters: [...base, { filterType: "MIN_NOTIONAL", notional: "5" }, { filterType: "MIN_NOTIONAL", notional: "6" }] },
    { name: "duplicate percent price", filters: [...base, { filterType: "PERCENT_PRICE", multiplierUp: "1.1", multiplierDown: "0.9" }, { filterType: "PERCENT_PRICE", multiplierUp: "1.2", multiplierDown: "0.8" }] },
    { name: "mismatched mark symbol", filters: base, markSymbol: "ETHUSDT" },
  ];
  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async () => {
      await assert.rejects(() => verifyAsterNoSubmit({
        credential: credential(),
        instruction: orderInstruction(),
        clientOrderId: `ghola-filter-proof-${index}`,
        now: () => 1_800_000_000_000,
        env: ENV,
        fetchImpl: noSubmitFetch(item),
      }), (error) => error instanceof AsterExecutionError && error.code === "connector_submit_failed");
    });
  }
});

test("rejects no-submit readiness when the Aster symbol open-order limit is reached", async () => {
  await assert.rejects(() => verifyAsterNoSubmit({
    credential: credential(),
    instruction: orderInstruction(),
    clientOrderId: "ghola-max-orders-1",
    now: () => 1_800_000_000_000,
    env: ENV,
    fetchImpl: noSubmitFetch({
      filters: [
        { filterType: "PRICE_FILTER", minPrice: "0.1", maxPrice: "1000000", tickSize: "0.1" },
        { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
        { filterType: "MAX_NUM_ORDERS", limit: 1 },
      ],
      openOrders: [{ symbol: "BTCUSDT", orderId: 1 }],
    }),
  }), (error) => error instanceof AsterExecutionError
    && error.code === "venue_rejected"
    && /maximum open orders/.test(error.message));
});

test("fails closed when exact account-wide Aster positions or open orders are unavailable", async () => {
  await assert.rejects(() => readAsterAccountState({
    credential: credential(),
    symbol: "BTC-PERP",
    now: () => 1_800_000_000_000,
    env: ENV,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/account")) return jsonResponse({ canTrade: true, availableBalance: "100" });
      if (path.endsWith("/positionRisk")) return jsonResponse([]);
      if (path.endsWith("/openOrders")) return jsonResponse({ orders: [] });
      if (path.endsWith("/commissionRate")) return jsonResponse({ makerCommissionRate: "0.0001", takerCommissionRate: "0.00035" });
      return jsonResponse({}, 404);
    },
  }), (error) => error instanceof AsterExecutionError
    && error.code === "connector_submit_failed"
    && /account state response/.test(error.message));
});

test("fails closed when Aster margin evidence is incomplete", async () => {
  await assert.rejects(() => readAsterAccountState({
    credential: credential(),
    symbol: "BTC-PERP",
    now: () => 1_800_000_000_000,
    env: ENV,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/account")) return jsonResponse({
        canTrade: true,
        availableBalance: "100",
        totalMarginBalance: "100",
        totalInitialMargin: "0",
      });
      if (path.endsWith("/positionRisk")) return jsonResponse([]);
      if (path.endsWith("/openOrders")) return jsonResponse([]);
      if (path.endsWith("/commissionRate")) return jsonResponse({ makerCommissionRate: "0.0001", takerCommissionRate: "0.00035" });
      return jsonResponse({}, 404);
    },
  }), (error) => error instanceof AsterExecutionError
    && error.code === "connector_submit_failed"
    && /account state response/.test(error.message));
});

test("marks Aster flat only from exact account-wide zero positions and orders", async () => {
  const account = await readAsterAccountState({
    credential: credential(),
    symbol: "BTC-PERP",
    now: () => 1_800_000_000_000,
    env: ENV,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/account")) return jsonResponse({
        canTrade: true,
        availableBalance: "100",
        totalMarginBalance: "100",
        totalInitialMargin: "0",
        totalMaintMargin: "0",
      });
      if (path.endsWith("/positionRisk")) return jsonResponse([
        { symbol: "BTCUSDT", positionAmt: "0" },
        { symbol: "ETHUSDT", positionAmt: "0" },
      ]);
      if (path.endsWith("/openOrders")) return jsonResponse([]);
      if (path.endsWith("/commissionRate")) return jsonResponse({});
      return jsonResponse({}, 404);
    },
  });
  assert.equal(account.position_count, 0);
  assert.equal(account.open_order_count, 0);
  assert.equal(account.flat_zero_orders, true);
  assert.equal(account.maker_fee_bps, null);
  assert.equal(account.taker_fee_bps, null);
  assert.equal(account.fees_exact_for_account, false);
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
      if (parsed.pathname.endsWith("/userTrades")) {
        assert.equal(parsed.searchParams.get("symbol"), "BTCUSDT");
        assert.equal(parsed.searchParams.get("startTime"), "1800000000000");
        assert.equal(parsed.searchParams.get("endTime"), "1800000000200");
        assert.equal(parsed.searchParams.get("limit"), "1000");
        return jsonResponse([
          { symbol: "BTCUSDT", id: 4001, orderId: 44, price: "59990", qty: "0.004", quoteQty: "239.96", commission: "-0.083986", commissionAsset: "USDT", time: 1_800_000_000_100 },
          { symbol: "BTCUSDT", id: 4002, orderId: 44, price: "60006.666666666666666667", qty: "0.006", quoteQty: "360.04", commission: "-0.126014", commissionAsset: "USDT", time: 1_800_000_000_200 },
        ]);
      }
      assert.equal(parsed.searchParams.get("origClientOrderId"), "ghola-carry-0004");
      reconcileCalls += 1;
      return reconcileCalls === 1
        ? jsonResponse({ symbol: "BTCUSDT", clientOrderId: "ghola-carry-0004", orderId: 44, status: "NEW", executedQty: "0" })
        : jsonResponse({
            symbol: "BTCUSDT",
            clientOrderId: "ghola-carry-0004",
            orderId: 44,
            status: "FILLED",
            executedQty: "0.010",
            cumQuote: "600.00",
            avgPrice: "60000",
            cumCommission: "999",
            commissionAsset: "FAKE",
            time: 1_800_000_000_000,
            updateTime: 1_800_000_000_200,
          });
    },
  });
  assert.equal(submitCalls, 1);
  assert.equal(reconcileCalls, 2);
  assert.equal(result.status, "filled");
  assert.equal(result.final_proof.target_client_order_matched, true);
  assert.equal(result.final_proof.final_venue_execution_proven, true);
  assert.equal(result.final_proof.broadcast_performed, true);
  assert.equal(result.final_proof.filled_base_size, "0.01");
  assert.equal(result.final_proof.filled_quote_notional, "600");
  assert.equal(result.final_proof.average_fill_price, "60000");
  assert.equal(result.final_proof.fee_quote_amount, "0.21");
  assert.equal(result.final_proof.fee_asset, "USDT");
  assert.equal(result.final_proof.realized_fees_exact, true);
  assert.equal(result.final_proof.realized_fee_source, "aster_fapi_v3_user_trades_v1");
  assert.equal(result.fills.length, 2);
  assert.equal(result.provider_ref_seed.submission_order_id, 44);
});

test("fails closed when bounded Aster user-trade size, notional, or commission-asset evidence is partial", async (t) => {
  const cases = [
    {
      name: "partial base size",
      trade: { symbol: "BTCUSDT", id: 8001, orderId: 80, price: "60000", qty: "0.009", quoteQty: "540", commission: "-0.189", commissionAsset: "USDT", time: 1_800_000_000_100 },
    },
    {
      name: "non-quote commission asset",
      trade: { symbol: "BTCUSDT", id: 8002, orderId: 80, price: "60000", qty: "0.01", quoteQty: "600", commission: "-0.21", commissionAsset: "ASTER", time: 1_800_000_000_100 },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      await assert.rejects(() => submitAndReconcileAsterExecution({
        credential: credential(),
        instruction: orderInstruction(),
        clientOrderId: "ghola-carry-exact-0080",
        env: ENV,
        now: () => 1_800_000_000_000,
        sleep: async () => {},
        fetchImpl: async (url, init) => {
          const path = new URL(url).pathname;
          if (init.method === "POST") {
            return jsonResponse({ symbol: "BTCUSDT", clientOrderId: "ghola-carry-exact-0080", orderId: 80, status: "NEW", executedQty: "0" });
          }
          if (path.endsWith("/userTrades")) return jsonResponse([item.trade]);
          return jsonResponse({
            symbol: "BTCUSDT",
            clientOrderId: "ghola-carry-exact-0080",
            orderId: 80,
            status: "FILLED",
            executedQty: "0.01",
            cumQuote: "600",
            avgPrice: "60000",
            time: 1_800_000_000_000,
            updateTime: 1_800_000_000_100,
          });
        },
      }), (error) => error instanceof AsterExecutionError
        && error.code === "submission_outcome_ambiguous"
        && /trade/.test(error.message));
    });
  }
});

test("uses bounded monotonic Aster user-trade pagination to complete one exact order", async () => {
  const firstPage = Array.from({ length: 999 }, (_, index) => ({
    symbol: "BTCUSDT",
    id: 1_000 + index,
    orderId: 999,
    time: 1_800_000_000_050,
  }));
  firstPage.push({ symbol: "BTCUSDT", id: 1_999, orderId: 90, price: "60000", qty: "0.004", quoteQty: "240", commission: "-0.084", commissionAsset: "USDT", time: 1_800_000_000_100 });
  let tradePages = 0;
  const result = await submitAndReconcileAsterExecution({
    credential: credential(),
    instruction: orderInstruction(),
    clientOrderId: "ghola-carry-page-0090",
    env: ENV,
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (init.method === "POST") return jsonResponse({ symbol: "BTCUSDT", clientOrderId: "ghola-carry-page-0090", orderId: 90, status: "NEW", executedQty: "0" });
      if (parsed.pathname.endsWith("/userTrades")) {
        tradePages += 1;
        if (tradePages === 1) return jsonResponse(firstPage);
        assert.equal(parsed.searchParams.get("fromId"), "2000");
        assert.equal(parsed.searchParams.has("startTime"), false);
        return jsonResponse([{ symbol: "BTCUSDT", id: 2_000, orderId: 90, price: "60000", qty: "0.006", quoteQty: "360", commission: "-0.126", commissionAsset: "USDT", time: 1_800_000_000_200 }]);
      }
      return jsonResponse({
        symbol: "BTCUSDT",
        clientOrderId: "ghola-carry-page-0090",
        orderId: 90,
        status: "FILLED",
        executedQty: "0.01",
        cumQuote: "600",
        avgPrice: "60000",
        time: 1_800_000_000_000,
        updateTime: 1_800_000_000_200,
      });
    },
  });
  assert.equal(tradePages, 2);
  assert.equal(result.result_seed.exact_trade_evidence.fetched_page_count, 2);
  assert.equal(result.result_seed.exact_trade_evidence.returned_trade_count, 1001);
  assert.equal(result.final_proof.fee_quote_amount, "0.21");
  assert.equal(result.final_proof.realized_fees_exact, true);
});

test("normalizes positive Aster commission balance deltas as exact rebates", async () => {
  const result = await submitAndReconcileAsterExecution({
    credential: credential(),
    instruction: orderInstruction(),
    clientOrderId: "ghola-carry-rebate-91",
    env: ENV,
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      if (init.method === "POST") return jsonResponse({ symbol: "BTCUSDT", clientOrderId: "ghola-carry-rebate-91", orderId: 91, status: "NEW", executedQty: "0" });
      if (path.endsWith("/userTrades")) return jsonResponse([{ symbol: "BTCUSDT", id: 9_100, orderId: 91, price: "60000", qty: "0.01", quoteQty: "600", commission: "0.05", commissionAsset: "USDT", time: 1_800_000_000_100 }]);
      return jsonResponse({ symbol: "BTCUSDT", clientOrderId: "ghola-carry-rebate-91", orderId: 91, status: "FILLED", executedQty: "0.01", cumQuote: "600", time: 1_800_000_000_000, updateTime: 1_800_000_000_100 });
    },
  });
  assert.equal(result.final_proof.fee_quote_amount, "-0.05");
  assert.equal(result.fills[0].fee, "-0.05");
});

test("rejects a malformed terminal Aster fill with zero execution", async () => {
  const malformed = {
    symbol: "BTCUSDT",
    clientOrderId: "ghola-zero-fill-1",
    orderId: 92,
    status: "FILLED",
    executedQty: "0",
    cumQuote: "0",
    time: 1_800_000_000_000,
    updateTime: 1_800_000_000_100,
  };
  const direct = await submitAsterExecution({
    credential: credential(),
    instruction: {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "aster",
      operation_class: "reconcile",
      reconcile: { market: "BTC-PERP", target_client_order_id: "ghola-zero-fill-1" },
    },
    clientOrderId: "ignored-zero-fill",
    env: ENV,
    fetchImpl: async () => jsonResponse(malformed),
  });
  assert.equal(direct.status, "unknown");
  assert.equal(direct.final_proof.final_venue_execution_proven, false);
  assert.equal(direct.final_proof.open_order_count, null);
  await assert.rejects(() => submitAndReconcileAsterExecution({
    credential: credential(),
    instruction: {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "aster",
      operation_class: "reconcile",
      reconcile: { market: "BTC-PERP", target_client_order_id: "ghola-zero-fill-1" },
    },
    clientOrderId: "ignored-zero-fill",
    env: ENV,
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    fetchImpl: async (url) => new URL(url).pathname.endsWith("/userTrades")
      ? jsonResponse([])
      : jsonResponse(malformed),
  }), (error) => error instanceof AsterExecutionError
    && error.code === "submission_outcome_ambiguous"
    && /no exact execution/.test(error.message));
});

test("reports unknown Aster order state with unknown open-order count", async () => {
  const result = await submitAndReconcileAsterExecution({
    credential: credential(),
    instruction: {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "aster",
      operation_class: "reconcile",
      reconcile: { market: "BTC-PERP", target_client_order_id: "ghola-unknown-1" },
    },
    clientOrderId: "ignored-unknown",
    env: { ...ENV, PRIVATE_AGENT_ASTER_RECONCILE_TIMEOUT_MS: "250", PRIVATE_AGENT_ASTER_RECONCILE_INTERVAL_MS: "100" },
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    fetchImpl: async (url) => new URL(url).pathname.endsWith("/userTrades")
      ? jsonResponse([])
      : jsonResponse({
          symbol: "BTCUSDT",
          clientOrderId: "ghola-unknown-1",
          orderId: 93,
          status: "PENDING_CANCEL",
          executedQty: "0",
          cumQuote: "0",
          time: 1_800_000_000_000,
          updateTime: 1_800_000_000_100,
        }),
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.final_proof.final_venue_execution_proven, false);
  assert.equal(result.final_proof.open_order_count, null);
});

test("fails closed when acknowledged and reconciled Aster order ids differ", async () => {
  let submits = 0;
  let reads = 0;
  await assert.rejects(() => submitAndReconcileAsterExecution({
    credential: credential(),
    instruction: orderInstruction(),
    clientOrderId: "ghola-order-id-mismatch-1",
    env: { ...ENV, PRIVATE_AGENT_ASTER_RECONCILE_TIMEOUT_MS: "250", PRIVATE_AGENT_ASTER_RECONCILE_INTERVAL_MS: "100" },
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      if (init.method === "POST") {
        submits += 1;
        return jsonResponse({ symbol: "BTCUSDT", clientOrderId: "ghola-order-id-mismatch-1", orderId: 94, status: "NEW", executedQty: "0" });
      }
      if (new URL(url).pathname.endsWith("/userTrades")) throw new Error("mismatched order must not read trades");
      reads += 1;
      return jsonResponse({
        symbol: "BTCUSDT",
        clientOrderId: "ghola-order-id-mismatch-1",
        orderId: 95,
        status: "FILLED",
        executedQty: "0.01",
        cumQuote: "600",
        time: 1_800_000_000_000,
        updateTime: 1_800_000_000_100,
      });
    },
  }), (error) => error instanceof AsterExecutionError && error.code === "submission_outcome_ambiguous");
  assert.equal(submits, 1);
  assert.equal(reads, 4);
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
      if (parsed.pathname.endsWith("/userTrades")) {
        return jsonResponse([{ symbol: "BTCUSDT", id: 5001, orderId: 45, price: "60000", qty: "0.01", quoteQty: "600", commission: "-0.21", commissionAsset: "USDT", time: 1_800_000_000_100 }]);
      }
      assert.equal(parsed.searchParams.get("origClientOrderId"), "ghola-carry-0005");
      reconcileCalls += 1;
      return reconcileCalls === 1
        ? jsonResponse({ code: -2013, msg: "Order does not exist." }, 400)
        : jsonResponse({
            symbol: "BTCUSDT",
            clientOrderId: "ghola-carry-0005",
            orderId: 45,
            status: "FILLED",
            executedQty: "0.01",
            cumQuote: "600",
            avgPrice: "60000",
            time: 1_800_000_000_000,
            updateTime: 1_800_000_000_100,
          });
    },
  });
  assert.equal(submitCalls, 1);
  assert.equal(reconcileCalls, 2);
  assert.equal(result.status, "filled");
  assert.equal(result.final_proof.broadcast_performed, false);
  assert.equal(result.reconciliation.submissionResponseAmbiguous, true);
  assert.equal(result.reconciliation.submission_retry_count, 0);
  assert.equal(result.reconciliation.target_client_order_only, true);
  assert.equal(result.reconciliation.readFailures, 1);
});

test("recovers an ambiguous Aster cancel by reconciling the exact original order without resubmitting", async () => {
  let cancelCalls = 0;
  let reconcileCalls = 0;
  const result = await submitAndReconcileAsterExecution({
    credential: credential(),
    instruction: {
      version: 1,
      kind: "ghola_private_execution_instruction",
      venue_id: "aster",
      operation_class: "cancel",
      cancel: { market: "BTC-PERP", client_order_id: "ghola-original-cancel-1" },
    },
    clientOrderId: "ghola-cancel-work-1",
    env: ENV,
    now: () => 1_800_000_000_000,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (init.method === "DELETE") {
        cancelCalls += 1;
        return jsonResponse({ msg: "response lost after cancel" }, 503);
      }
      if (parsed.pathname.endsWith("/userTrades")) return jsonResponse([]);
      reconcileCalls += 1;
      assert.equal(init.method, "GET");
      assert.equal(parsed.searchParams.get("symbol"), "BTCUSDT");
      assert.equal(parsed.searchParams.get("origClientOrderId"), "ghola-original-cancel-1");
      return jsonResponse({
        symbol: "BTCUSDT",
        clientOrderId: "ghola-original-cancel-1",
        orderId: 48,
        status: "CANCELED",
        executedQty: "0",
        cumQuote: "0",
        time: 1_800_000_000_000,
        updateTime: 1_800_000_000_100,
      });
    },
  });
  assert.equal(cancelCalls, 1);
  assert.equal(reconcileCalls, 1);
  assert.equal(result.status, "cancelled");
  assert.equal(result.final_proof.target_client_order_matched, true);
  assert.equal(result.final_proof.final_venue_execution_proven, true);
  assert.equal(result.final_proof.broadcast_performed, false);
  assert.equal(result.reconciliation.submissionResponseAmbiguous, true);
  assert.equal(result.reconciliation.submission_retry_count, 0);
  assert.equal(result.final_proof.realized_fees_exact, true);
  assert.equal(result.final_proof.fee_quote_amount, "0");
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
  const observed = [];
  const rows = await readAsterFundingSettlements({
    credential: credential(),
    symbol: "BTC",
    start_time_ms: 1_800_000_000_000,
    end_time_ms: 1_800_003_600_000,
    now: () => 1_800_003_600_000,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      observed.push({ url: parsed, method: init.method });
      if (parsed.pathname === "/products/USDT-USDC/book") return jsonResponse({
        sequence: 1,
        bids: [["0.9998", "100"]],
        asks: [["1.0002", "100"]],
      }, 200, { date: new Date(1_800_003_600_000).toUTCString() });
      return jsonResponse([{ symbol: "BTCUSDT", incomeType: "FUNDING_FEE", income: "-0.0125", asset: "USDT", time: 1_800_003_600_000, tranId: 42 }]);
    },
  });
  assert.equal(observed[0].method, "GET");
  assert.equal(observed[0].url.pathname, "/fapi/v1/income");
  assert.equal(observed[0].url.searchParams.get("incomeType"), "FUNDING_FEE");
  assert.equal(observed[1].url.pathname, "/products/USDT-USDC/book");
  const [{ cashflow_valuation: valuation, ...settlement }] = rows;
  assert.deepEqual(settlement, {
    venue_id: "aster",
    asset: "BTC",
    occurred_at_ms: 1_800_003_600_000,
    amount_quote: "-0.0125",
    amount_quote_scale: 4,
    amount_quote_micro: -12_500,
    quote_asset: "USDT",
    settlement_id: "42",
  });
  assert.equal(valuation.source_asset, "USDT");
  assert.equal(valuation.valuation_asset, "USDC");
  assert.equal(valuation.bound_source_amount_micro, -12_500);
  assert.equal(valuation.credit_rate_e8, 99_976_000);
  assert.equal(valuation.debit_rate_e8, 100_024_000);
  assert.equal(valuation.evidence_payload.source_amount_decimal, "-0.0125");
  assert.match(valuation.evidence_commitment, /^carry:cashflow-valuation:evidence:[0-9a-f]{64}$/);
});

test("rejects a malformed Aster funding history response", async () => {
  await assert.rejects(readAsterFundingSettlements({
    credential: credential(),
    symbol: "BTC",
    start_time_ms: 1_800_000_000_000,
    end_time_ms: 1_800_003_600_000,
    now: () => 1_800_003_600_000,
    fetchImpl: async () => jsonResponse({ rows: [] }),
  }), (error) => error.code === "connector_submit_failed");
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
      return jsonResponse({ symbol: "BTCUSDT", clientOrderId: "ghola-carry-0003", status: "FILLED", executedQty: "0.01", cumQuote: "600", avgPrice: "60000" });
    },
  });
  assert.equal(observed.method, "GET");
  assert.equal(observed.url.searchParams.get("origClientOrderId"), "ghola-carry-0003");
  assert.equal(result.status, "filled");
  assert.equal(result.final_proof.final_venue_execution_proven, true);
  assert.equal(result.final_proof.broadcast_performed, false);
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
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/userTrades")) {
        return jsonResponse([{ symbol: "BTCUSDT", id: 7001, orderId: 47, price: "60000", qty: "0.01", quoteQty: "600", commission: "-0.21", commissionAsset: "USDT", time: 1_800_000_000_100 }]);
      }
      targets.push(parsed.searchParams.get("origClientOrderId"));
      reads += 1;
      if (reads === 1) throw new Error("temporary read failure");
      return jsonResponse({
        symbol: "BTCUSDT",
        clientOrderId: "ghola-original-0007",
        orderId: 47,
        status: "FILLED",
        executedQty: "0.01",
        cumQuote: "600",
        avgPrice: "60000",
        time: 1_800_000_000_000,
        updateTime: 1_800_000_000_100,
      });
    },
  });
  assert.deepEqual(targets, ["ghola-original-0007", "ghola-original-0007"]);
  assert.equal(result.status, "filled");
  assert.equal(result.final_proof.broadcast_performed, false);
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

test("atomically claims one Aster submission under concurrent identical requests", async (t) => {
  const old = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "ghola-aster-concurrent-submit-"));
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
    work_order_commitment: "work:aster:concurrent:0001",
    policy_commitment: "policy:aster:concurrent:0001",
    session_policy: {
      policy_commitment: "policy:aster:concurrent:0001",
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
  const originalGetAttempt = state.getExecutionAttempt.bind(state);
  const originalClaimAttempt = state.claimExecutionAttemptWithPolicyUsage.bind(state);
  let reads = 0;
  let releaseReads;
  let firstRead;
  const bothRead = new Promise((resolve) => { releaseReads = resolve; });
  const firstReadStarted = new Promise((resolve) => { firstRead = resolve; });
  const claims = [];
  state.getExecutionAttempt = async (key) => {
    const result = await originalGetAttempt(key);
    if (key === args.work_order_commitment && reads < 2) {
      reads += 1;
      if (reads === 1) {
        firstRead();
        await bothRead;
      } else {
        releaseReads();
      }
    }
    return result;
  };
  state.claimExecutionAttemptWithPolicyUsage = async (...claimArgs) => {
    const result = await originalClaimAttempt(...claimArgs);
    claims.push(result.ok);
    return result;
  };

  const first = executeAutopilotOrder(args);
  await firstReadStarted;
  const second = executeAutopilotOrder(args);
  const outcomes = await Promise.allSettled([first, second]);
  assert.deepEqual(claims.sort(), [false, true]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(rejected.reason.status, 409);
  assert.match(rejected.reason.message, /reconcile it instead of retrying/);
  const attempt = await originalGetAttempt(args.work_order_commitment);
  assert.equal(attempt.submit_count, 1);
  assert.equal(attempt.ambiguity_retry_count, 0);
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
  state.claimExecutionAttemptWithPolicyUsage = async () => {
    throw new Error("read-only reconciliation must not claim a submission");
  };
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

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function noSubmitFetch({ filters, markSymbol = "BTCUSDT", openOrders = [] }) {
  return async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/time")) return jsonResponse({ serverTime: 1_800_000_000_000 });
    if (path.endsWith("/premiumIndex")) return jsonResponse({ symbol: markSymbol, markPrice: "60000" });
    if (path.endsWith("/exchangeInfo")) return jsonResponse({ symbols: [{ symbol: "BTCUSDT", status: "TRADING", filters }] });
    if (path.endsWith("/account")) return jsonResponse({
      canTrade: true,
      availableBalance: "100",
      totalMarginBalance: "100",
      totalInitialMargin: "0",
      totalMaintMargin: "0",
    });
    if (path.endsWith("/positionRisk")) return jsonResponse([]);
    if (path.endsWith("/openOrders")) return jsonResponse(openOrders);
    if (path.endsWith("/commissionRate")) return jsonResponse({ makerCommissionRate: "0.0001", takerCommissionRate: "0.00035" });
    return jsonResponse({}, 404);
  };
}
