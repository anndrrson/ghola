import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  assertCoinbaseKeyPermissions,
  buildCoinbaseJwt,
  reconcileCoinbaseExecution,
  submitCoinbaseExecution,
} from "../src/venues/coinbase.js";

function testCredential() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    network: "sandbox",
    base_url: "https://api-sandbox.coinbase.com/api/v3/brokerage",
    api_key_name: "organizations/test/apiKeys/test",
    api_private_key_pem: privateKey.export({ format: "pem", type: "sec1" }),
    portfolio_id: null,
  };
}

function decodeJwtPart(token, index) {
  return JSON.parse(Buffer.from(token.split(".")[index], "base64url").toString("utf8"));
}

describe("coinbase live adapter", () => {
  it("builds short-lived ES256 JWTs bound to the request URI", () => {
    const credential = testCredential();
    const token = buildCoinbaseJwt({
      credential,
      method: "GET",
      pathWithQuery: "/api/v3/brokerage/key_permissions",
      now: new Date("2026-05-28T12:00:00Z"),
    });
    const header = decodeJwtPart(token, 0);
    const payload = decodeJwtPart(token, 1);
    assert.equal(header.alg, "ES256");
    assert.equal(header.kid, credential.api_key_name);
    assert.equal(payload.iss, "cdp");
    assert.equal(payload.sub, credential.api_key_name);
    assert.equal(payload.exp - payload.nbf, 120);
    assert.equal(payload.uri, "GET api-sandbox.coinbase.com/api/v3/brokerage/key_permissions");
  });

  it("rejects transfer-enabled keys before order submission", async () => {
    const credential = testCredential();
    await assert.rejects(
      assertCoinbaseKeyPermissions(credential, async () =>
        new Response(JSON.stringify({
          can_view: true,
          can_trade: true,
          can_transfer: true,
        }), { status: 200 }),
      ),
      /transfer-enabled/,
    );
  });

  it("preflights permissions and submits redacted order calls with mocked network", async () => {
    const oldDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    const oldLiveMode = process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE;
    delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = "full";
    const credential = testCredential();
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), method: init.method, authorization: init.headers.authorization });
      if (String(url).endsWith("/key_permissions")) {
        return new Response(JSON.stringify({
          can_view: true,
          can_trade: true,
          can_transfer: false,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, order_id: "venue_order_secret" }), {
        status: 200,
      });
    };
    let result;
    try {
      result = await submitCoinbaseExecution({
        credential,
        clientOrderId: "ghola_test_client_order",
        fetchImpl,
        instruction: {
          operation_class: "spot_limit_order",
          order: {
            market: "BTC-USD",
            side: "buy",
            base_size: "0.001",
            limit_price: "10000",
            tif: "gtc",
            post_only: false,
          },
        },
      });
    } finally {
      if (oldDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
      else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = oldDryRun;
      if (oldLiveMode === undefined) delete process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE;
      else process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = oldLiveMode;
    }
    assert.equal(result.status, "submitted");
    assert.equal(calls.length, 2);
    assert.match(calls[0].authorization, /^Bearer /);
    assert.equal(calls[1].url, "https://api-sandbox.coinbase.com/api/v3/brokerage/orders");
    assert.equal(JSON.stringify(result).includes("api_private_key"), false);
  });

  it("sends exactly the authoritative quote size for IOC orders", async () => {
    const oldDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    const oldLiveMode = process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE;
    const oldProducts = process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS;
    delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = "full";
    process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS = "BTC-USD";
    const requestBodies = [];
    try {
      await submitCoinbaseExecution({
        credential: testCredential(),
        clientOrderId: "ghola_quote_ioc",
        fetchImpl: async (url, init) => {
          if (String(url).endsWith("/key_permissions")) {
            return new Response(JSON.stringify({ can_view: true, can_trade: true, can_transfer: false }), { status: 200 });
          }
          requestBodies.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ success: true, order_id: "order_ioc" }), { status: 200 });
        },
        instruction: {
          operation_class: "spot_limit_order",
          order: {
            market: "BTC-USD",
            side: "buy",
            size_mode: "quote",
            quote_size: "25",
            base_size: "0.0004",
            limit_price: "62500",
            tif: "ioc",
            post_only: false,
          },
        },
      });
    } finally {
      if (oldDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
      else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = oldDryRun;
      if (oldLiveMode === undefined) delete process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE;
      else process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = oldLiveMode;
      if (oldProducts === undefined) delete process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS;
      else process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS = oldProducts;
    }

    assert.deepEqual(requestBodies[0].order_configuration.sor_limit_ioc, {
      quote_size: "25",
      limit_price: "62500",
      rfq_disabled: true,
    });
  });

  it("rejects ambiguous dual-size orders without an authoritative mode before network access", async () => {
    const oldDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    const oldLiveMode = process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE;
    delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = "full";
    let fetchCalls = 0;
    try {
      await assert.rejects(
        () => submitCoinbaseExecution({
          credential: testCredential(),
          clientOrderId: "ghola_ambiguous_size",
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("network should not be reached");
          },
          instruction: {
            operation_class: "spot_limit_order",
            order: {
              market: "BTC-USD",
              side: "buy",
              quote_size: "25",
              base_size: "0.0004",
              limit_price: "62500",
              tif: "ioc",
            },
          },
        }),
        /one authoritative size mode/,
      );
    } finally {
      if (oldDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
      else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = oldDryRun;
      if (oldLiveMode === undefined) delete process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE;
      else process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = oldLiveMode;
    }
    assert.equal(fetchCalls, 0);
  });

  it("caps the authoritative base size even when a smaller quote size is also present", async () => {
    const oldDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    const oldLiveMode = process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE;
    const oldMaxNotional = process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD;
    delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = "full";
    process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD = "100";
    let fetchCalls = 0;
    try {
      await assert.rejects(
        () => submitCoinbaseExecution({
          credential: testCredential(),
          clientOrderId: "ghola_base_cap",
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("network should not be reached");
          },
          instruction: {
            operation_class: "spot_limit_order",
            order: {
              market: "BTC-USD",
              side: "buy",
              size_mode: "base",
              base_size: "2",
              quote_size: "1",
              limit_price: "100",
              tif: "ioc",
            },
          },
        }),
        /exceeds notional cap/,
      );
    } finally {
      if (oldDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
      else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = oldDryRun;
      if (oldLiveMode === undefined) delete process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE;
      else process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = oldLiveMode;
      if (oldMaxNotional === undefined) delete process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD;
      else process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD = oldMaxNotional;
    }
    assert.equal(fetchCalls, 0);
  });

  it("blocks products outside the Coinbase live allowlist before key preflight", async () => {
    const oldDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    const oldLiveMode = process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE;
    const oldProducts = process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS;
    delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = "full";
    process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS = "BTC-USD";
    try {
      await assert.rejects(
        () => submitCoinbaseExecution({
          credential: testCredential(),
          clientOrderId: "coinbase_product_blocked",
          fetchImpl: async () => {
            throw new Error("fetch should not be called");
          },
          instruction: {
            operation_class: "spot_limit_order",
            order: {
              market: "SOL-USD",
              side: "buy",
              quote_size: "5",
              limit_price: "100",
              tif: "gtc",
            },
          },
        }),
        /outside allowlist/,
      );
    } finally {
      if (oldDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
      else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = oldDryRun;
      if (oldLiveMode === undefined) delete process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE;
      else process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = oldLiveMode;
      if (oldProducts === undefined) delete process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS;
      else process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS = oldProducts;
    }
  });

  it("blocks Coinbase live orders above the notional cap before key preflight", async () => {
    const oldDryRun = process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    const oldLiveMode = process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE;
    const oldProducts = process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS;
    const oldCap = process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD;
    delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
    process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = "full";
    process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS = "BTC-USD";
    process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD = "1000";
    try {
      await assert.rejects(
        () => submitCoinbaseExecution({
          credential: testCredential(),
          clientOrderId: "coinbase_notional_blocked",
          fetchImpl: async () => {
            throw new Error("fetch should not be called");
          },
          instruction: {
            operation_class: "spot_market_order",
            order: {
              market: "BTC-USD",
              side: "buy",
              quote_size: "1001",
            },
          },
        }),
        /notional cap/,
      );
    } finally {
      if (oldDryRun === undefined) delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
      else process.env.PRIVATE_AGENT_VENUE_DRY_RUN = oldDryRun;
      if (oldLiveMode === undefined) delete process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE;
      else process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = oldLiveMode;
      if (oldProducts === undefined) delete process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS;
      else process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS = oldProducts;
      if (oldCap === undefined) delete process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD;
      else process.env.PRIVATE_AGENT_COINBASE_LIVE_MAX_NOTIONAL_USD = oldCap;
    }
  });

  it("reconciles only the exact client order and exact fills", async () => {
    const previous = liveCoinbaseEnvironment();
    const calls = [];
    try {
      const result = await reconcileCoinbaseExecution({
        credential: testCredential(),
        clientOrderId: "ghola_exact_client",
        instruction: {
          operation_class: "reconcile",
          reconcile: { product_id: "BTC-USD" },
        },
        fetchImpl: async (url) => {
          const value = String(url);
          calls.push(value);
          if (value.endsWith("/key_permissions")) {
            return jsonResponse({ can_view: true, can_trade: true, can_transfer: false });
          }
          if (value.includes("/orders/historical/batch?")) {
            return jsonResponse({
              orders: [{
                order_id: "order_exact",
                client_order_id: "ghola_exact_client",
                product_id: "BTC-USD",
                status: "FILLED",
                filled_size: "0.002",
              }],
              has_next: false,
            });
          }
          if (value.includes("/orders/historical/fills?order_ids=order_exact")) {
            return jsonResponse({
              fills: [
                { order_id: "other", size: "9", price: "1" },
                { order_id: "order_exact", trade_id: "fill_1", size: "0.001", price: "10000", commission: "0.01" },
                { order_id: "order_exact", trade_id: "fill_2", size: "0.001", price: "10001", commission: "0.01" },
              ],
            });
          }
          throw new Error(`unexpected request ${value}`);
        },
      });
      assert.equal(result.status, "filled");
      assert.equal(result.fills.length, 2);
      assert.equal(result.final_proof.provider_order_id, "order_exact");
      assert.equal(result.final_proof.final_fill_proven, true);
      assert.equal(result.final_proof.terminal_status, "filled");
      assert.equal(calls.some((url) => url.includes("product_ids=BTC-USD")), true);
    } finally {
      restoreEnvironment(previous);
    }
  });

  it("cancels by resolved provider order id and proves terminal cancellation", async () => {
    const previous = liveCoinbaseEnvironment();
    const requests = [];
    try {
      const result = await submitCoinbaseExecution({
        credential: testCredential(),
        clientOrderId: "cancel_work_order_client",
        instruction: {
          operation_class: "cancel",
          cancel: {
            market: "BTC-USD",
            client_order_id: "target_client",
          },
        },
        fetchImpl: async (url, init) => {
          const value = String(url);
          requests.push({ value, method: init.method, body: init.body ? JSON.parse(init.body) : null });
          if (value.endsWith("/key_permissions")) {
            return jsonResponse({ can_view: true, can_trade: true, can_transfer: false });
          }
          if (value.includes("/orders/historical/batch?")) {
            return jsonResponse({
              orders: [{
                order_id: "provider_order_1",
                client_order_id: "target_client",
                product_id: "BTC-USD",
                status: "OPEN",
                filled_size: "0",
              }],
              has_next: false,
            });
          }
          if (value.endsWith("/orders/batch_cancel")) {
            return jsonResponse({ results: [{ success: true, order_id: "provider_order_1" }] });
          }
          if (value.endsWith("/orders/historical/provider_order_1")) {
            return jsonResponse({
              order: {
                order_id: "provider_order_1",
                client_order_id: "target_client",
                product_id: "BTC-USD",
                status: "CANCELLED",
                filled_size: "0",
              },
            });
          }
          if (value.includes("/orders/historical/fills?order_ids=provider_order_1")) {
            return jsonResponse({ fills: [] });
          }
          throw new Error(`unexpected request ${value}`);
        },
      });
      assert.equal(result.status, "cancelled");
      assert.equal(result.final_proof.terminal_status, "cancelled");
      assert.equal(result.final_proof.final_fill_proven, true);
      const cancel = requests.find((request) => request.value.endsWith("/orders/batch_cancel"));
      assert.deepEqual(cancel.body, { order_ids: ["provider_order_1"] });
    } finally {
      restoreEnvironment(previous);
    }
  });

  it("fails closed when Coinbase reports a per-order cancel failure", async () => {
    const previous = liveCoinbaseEnvironment();
    try {
      await assert.rejects(
        () => submitCoinbaseExecution({
          credential: testCredential(),
          clientOrderId: "cancel_failure_work_order",
          instruction: {
            operation_class: "cancel",
            cancel: { market: "BTC-USD", order_id: "provider_order_failed", client_order_id: "target_client" },
          },
          fetchImpl: async (url) => {
            const value = String(url);
            if (value.endsWith("/key_permissions")) {
              return jsonResponse({ can_view: true, can_trade: true, can_transfer: false });
            }
            if (value.endsWith("/orders/historical/provider_order_failed")) {
              return jsonResponse({
                order: {
                  order_id: "provider_order_failed",
                  client_order_id: "target_client",
                  product_id: "BTC-USD",
                  status: "OPEN",
                },
              });
            }
            if (value.endsWith("/orders/batch_cancel")) {
              return jsonResponse({
                results: [{ success: false, order_id: "provider_order_failed", failure_reason: "UNKNOWN_CANCEL_ORDER" }],
              });
            }
            throw new Error(`unexpected request ${value}`);
          },
        }),
        (error) => error.code === "COINBASE_CANCEL_NOT_ACCEPTED",
      );
    } finally {
      restoreEnvironment(previous);
    }
  });
});

function liveCoinbaseEnvironment() {
  const previous = {
    PRIVATE_AGENT_VENUE_DRY_RUN: process.env.PRIVATE_AGENT_VENUE_DRY_RUN,
    PRIVATE_AGENT_COINBASE_LIVE_MODE: process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE,
    PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS: process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS,
  };
  delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
  process.env.PRIVATE_AGENT_COINBASE_LIVE_MODE = "full";
  process.env.PRIVATE_AGENT_COINBASE_ALLOWED_PRODUCTS = "BTC-USD";
  return previous;
}

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
