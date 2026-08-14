import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  buildOperatorEvent,
  emitOperatorEvent,
  resetOperatorAlertDedupeForTests,
} from "../src/observability/operator-events.js";

test("operator events expose only allowlisted fields", () => {
  const event = buildOperatorEvent("execution claim", {
    severity: "critical",
    venue_id: "hyperliquid",
    execution_id: "execution_123",
    work_order_commitment: "work_123",
    final_flat_proven: true,
    error_code: "TIMEOUT",
    private_key: "secret",
    account_address: "0xsecret",
    error_message: "contains credential",
  }, { now: () => Date.parse("2026-08-13T12:00:00.000Z") });

  assert.deepEqual(event, {
    timestamp: "2026-08-13T12:00:00.000Z",
    service: "ghola-private-agent-worker",
    event: "execution_claim",
    severity: "critical",
    venue_id: "hyperliquid",
    execution_id: "execution_123",
    work_order_commitment: "work_123",
    final_flat_proven: true,
    error_code: "TIMEOUT",
  });
});

test("critical events alert once per dedupe window without blocking on transport failure", async () => {
  resetOperatorAlertDedupeForTests();
  const writes = [];
  let calls = 0;
  const options = {
    webhookUrl: "https://operator.invalid/alert",
    nowMs: 10_000,
    dedupeWindowMs: 60_000,
    write: (line) => writes.push(JSON.parse(line)),
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline");
    },
  };
  await emitOperatorEvent("execution_reconciliation_required", {
    severity: "critical",
    work_order_commitment: "work_123",
    error_code: "TIMEOUT",
  }, options);
  await emitOperatorEvent("execution_reconciliation_required", {
    severity: "critical",
    work_order_commitment: "work_123",
    error_code: "TIMEOUT",
  }, options);

  assert.equal(writes.length, 2);
  assert.equal(calls, 1);
});

test("informational events never call the alert webhook", async () => {
  let calls = 0;
  await emitOperatorEvent("execution_claim_completed", {
    severity: "info",
    work_order_commitment: "work_123",
  }, {
    webhookUrl: "https://operator.invalid/alert",
    write: () => {},
    fetchImpl: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
});

test("critical alerts reach a real HTTP receiver with redacted JSON", async () => {
  resetOperatorAlertDedupeForTests();
  let received = null;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      response.writeHead(202).end();
    });
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await emitOperatorEvent("execution_reconciliation_required", {
      severity: "critical",
      venue_id: "hyperliquid",
      work_order_commitment: "work_http_123",
      error_code: "CONNECTOR_TIMEOUT",
      api_wallet_private_key: "must-not-appear",
    }, {
      webhookUrl: `http://127.0.0.1:${address.port}/alert`,
      alertToken: "operator-token",
      dedupeWindowMs: 0,
      write: () => {},
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(received.authorization, "Bearer operator-token");
  assert.equal(received.body.event, "execution_reconciliation_required");
  assert.equal(received.body.work_order_commitment, "work_http_123");
  assert.equal(JSON.stringify(received.body).includes("must-not-appear"), false);
});
