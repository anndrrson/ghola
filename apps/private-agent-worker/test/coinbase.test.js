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
    delete process.env.PRIVATE_AGENT_VENUE_DRY_RUN;
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
    }
    assert.equal(result.status, "submitted");
    assert.equal(calls.length, 2);
    assert.match(calls[0].authorization, /^Bearer /);
    assert.equal(calls[1].url, "https://api-sandbox.coinbase.com/api/v3/brokerage/orders");
    assert.equal(JSON.stringify(result).includes("api_private_key"), false);
  });
});
