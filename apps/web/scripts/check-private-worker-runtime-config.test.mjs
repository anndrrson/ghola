import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyPrivateWorkerRuntimeAuthorization,
  verifyPrivateWorkerRuntimeConfig,
} from "./check-private-worker-runtime-config.mjs";

test("skips local builds", () => {
  assert.deepEqual(verifyPrivateWorkerRuntimeConfig({}), { skipped: true });
});

test("requires a private worker URL for every Vercel artifact", () => {
  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig({
      VERCEL: "1",
      PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "secret",
    }),
    /missing the private worker URL/,
  );
});

test("requires worker authentication and HTTPS", () => {
  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig({
      VERCEL: "1",
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "http://worker.example",
      PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "secret",
    }),
    /must use HTTPS/,
  );
  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig({
      VERCEL: "1",
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
    }),
    /missing private worker authentication/,
  );
});

test("accepts a fully configured Vercel artifact", () => {
  assert.deepEqual(verifyPrivateWorkerRuntimeConfig({
    VERCEL: "1",
    GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "secret",
  }), {
    skipped: false,
    worker_host: "worker.example",
  });
});

test("proves Vercel and the worker share authorization before deployment", async () => {
  let attempts = 0;
  const result = await verifyPrivateWorkerRuntimeAuthorization({
    VERCEL: "1",
    GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.example",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "shared-secret",
  }, async (_input, init) => {
    attempts += 1;
    assert.match(new Headers(init.headers).get("authorization"), /^Bearer ghcap_v1\./);
    return Response.json({
      error: "invalid hyperliquid private session request",
      error_code: "venue_access_required",
    }, { status: 400 });
  });

  assert.equal(attempts, 1);
  assert.equal(result.worker_authorization, "verified");
});

test("blocks deployment when worker authorization drifts", async () => {
  await assert.rejects(
    verifyPrivateWorkerRuntimeAuthorization({
      VERCEL: "1",
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "stale-secret",
    }, async () => Response.json({
      error: "worker capability signature is invalid",
      error_code: "worker_capability_invalid",
    }, { status: 403 })),
    /worker authorization failed \(403\)/,
  );
});
