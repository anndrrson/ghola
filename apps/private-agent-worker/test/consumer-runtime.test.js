import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  consumerFeeMicroUsdc,
  createConsumerRuntime,
  verifyVercelSpendWebhookSignature,
} from "../src/consumer/runtime.js";

describe("durable consumer runtime", () => {
  it("charges no fee for an unfilled order and enforces the minimum on fills", () => {
    assert.equal(consumerFeeMicroUsdc(0), 0);
    assert.equal(consumerFeeMicroUsdc(1_000_000), 50_000);
    assert.equal(consumerFeeMicroUsdc(100_000_000), 100_000);
  });

  it("verifies Vercel HMAC-SHA1 spend webhook signatures in constant-time form", () => {
    const body = JSON.stringify({ thresholdPercent: 100, currentSpend: 5 });
    const secret = "s".repeat(32);
    const signature = createHmac("sha1", secret).update(body).digest("hex");
    assert.equal(verifyVercelSpendWebhookSignature({ body, signature, secret }), true);
    assert.equal(verifyVercelSpendWebhookSignature({ body: `${body} `, signature, secret }), false);
  });

  it("reports blocked when the durable database is not configured", async () => {
    const runtime = createConsumerRuntime({ databaseUrl: "" });
    assert.deepEqual(await runtime.ready(), { ready: false, error: "consumer_database_unconfigured" });
    runtime.stop();
  });
});
