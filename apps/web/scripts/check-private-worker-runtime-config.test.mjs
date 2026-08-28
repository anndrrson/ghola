import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { CARRY_EXECUTION_VENUES } from "@ghola/execution-core";
import {
  verifyPrivateWorkerRuntimeAuthorization,
  verifyPrivateWorkerRuntimeConfig,
} from "./check-private-worker-runtime-config.mjs";

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const FUNDING_PRIVATE_KEY = generateKeyPairSync("ed25519").privateKey;
const FUNDING_SIGNING_KEY = FUNDING_PRIVATE_KEY.export({
  format: "der",
  type: "pkcs8",
}).toString("base64");
const FUNDING_PUBLIC_KEY = createPublicKey(FUNDING_PRIVATE_KEY).export({
  format: "der",
  type: "spki",
}).toString("base64");

function vercelEnv(overrides = {}) {
  return {
    VERCEL: "1",
    GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "shared-secret",
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: IMAGE_DIGEST,
    GHOLA_PRIVATE_AGENT_FUNDING_SIGNING_KEY: FUNDING_SIGNING_KEY,
    ...overrides,
  };
}

function compatibilityProof(overrides = {}) {
  return {
    version: 1,
    authorized: true,
    authorization_protocol: "ghcap_v1",
    worker_image_digest: IMAGE_DIGEST,
    funding_signer_public_key_b64: FUNDING_PUBLIC_KEY,
    carry_execution_venue_ids: [...CARRY_EXECUTION_VENUES],
    ...overrides,
  };
}

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

test("blocks deployment when capability-secret aliases disagree", async () => {
  const env = vercelEnv({
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "current-secret",
    GHOLA_WORKER_CAPABILITY_SECRET: "stale-secret",
  });
  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig(env),
    /worker capability secret aliases disagree/,
  );
  await assert.rejects(
    verifyPrivateWorkerRuntimeAuthorization(env, async () => {
      throw new Error("the probe must not run with ambiguous authorization");
    }),
    /worker capability secret aliases disagree/,
  );
});

test("blocks deployment when execution-token aliases disagree", () => {
  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig({
      ...vercelEnv({ PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "" }),
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "current-token",
      PRIVATE_AGENT_EXECUTION_TOKEN: "stale-token",
    }),
    /private worker execution token aliases disagree/,
  );
});

test("accepts a fully configured Vercel artifact", () => {
  assert.deepEqual(verifyPrivateWorkerRuntimeConfig(vercelEnv()), {
    skipped: false,
    worker_host: "worker.example",
  });
});

test("requires exact worker image and funding-signer pins", () => {
  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig(vercelEnv({ GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: "" })),
    /worker image digest pin/,
  );
  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig(vercelEnv({ GHOLA_PRIVATE_AGENT_FUNDING_SIGNING_KEY: "" })),
    /funding signer pin/,
  );
});

test("validates a dedicated public Carry shadow worker without using it for execution", () => {
  assert.deepEqual(verifyPrivateWorkerRuntimeConfig(vercelEnv({
    GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://execution.example",
    GHOLA_CARRY_SHADOW_WORKER_URL: "https://shadow.example",
  })), {
    skipped: false,
    worker_host: "execution.example",
    carry_shadow_worker_host: "shadow.example",
  });

  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig(vercelEnv({
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://execution.example",
      GHOLA_CARRY_SHADOW_WORKER_URL: "http://shadow.example",
    })),
    /Carry shadow worker URL must use HTTPS/,
  );
});

test("proves Vercel and the worker share authorization before deployment", async () => {
  let attempts = 0;
  const result = await verifyPrivateWorkerRuntimeAuthorization(vercelEnv({
    GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL: "https://worker.example",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "shared-secret",
  }), async (input, init) => {
    attempts += 1;
    assert.equal(
      String(input),
      "https://worker.example/.well-known/private-agent-authorization",
    );
    assert.match(new Headers(init.headers).get("authorization"), /^Bearer ghcap_v1\./);
    return Response.json(compatibilityProof(), { status: 200 });
  });

  assert.equal(attempts, 1);
  assert.equal(result.worker_authorization, "verified");
});

test("blocks deployment when authenticated worker identity differs", async () => {
  await assert.rejects(
    verifyPrivateWorkerRuntimeAuthorization(vercelEnv(), async () =>
      Response.json(compatibilityProof({
        worker_image_digest: `sha256:${"b".repeat(64)}`,
      }), { status: 200 })),
    /compatibility evidence does not match/,
  );
});

test("blocks deployment when worker authorization drifts", async () => {
  await assert.rejects(
    verifyPrivateWorkerRuntimeAuthorization(vercelEnv({
      PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "stale-secret",
    }), async () => Response.json({
      error: "worker capability signature is invalid",
      error_code: "worker_capability_invalid",
    }, { status: 403 })),
    /worker authorization failed \(403\)/,
  );
});
