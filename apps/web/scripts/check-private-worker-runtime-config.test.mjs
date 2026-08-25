import assert from "node:assert/strict";
import test from "node:test";
import { verifyPrivateWorkerRuntimeConfig } from "./check-private-worker-runtime-config.mjs";

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
