import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  assertCoinbaseKeyPermissions,
  buildCoinbaseJwt,
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
});
