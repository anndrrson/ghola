import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { CARRY_EXECUTION_VENUES } from "@ghola/execution-core";
import {
  verifyPreviewProductRuntimeConfig,
  verifyPrivateWorkerRuntimeAuthorization,
  verifyPrivateWorkerRuntimeConfig,
} from "./check-private-worker-runtime-config.mjs";

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const FUNDING_PRIVATE_KEY = generateKeyPairSync("ed25519").privateKey;
const FUNDING_PUBLIC_KEY = createPublicKey(FUNDING_PRIVATE_KEY).export({
  format: "der",
  type: "spki",
}).toString("base64");
const ROTATED_FUNDING_PUBLIC_KEY = createPublicKey(
  generateKeyPairSync("ed25519").privateKey,
).export({
  format: "der",
  type: "spki",
}).toString("base64");

function vercelEnv(overrides = {}) {
  return {
    VERCEL: "1",
    GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "shared-secret",
    GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: IMAGE_DIGEST,
    GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: FUNDING_PUBLIC_KEY,
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

function productEnv(overrides = {}) {
  return {
    VERCEL: "1",
    NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID: "organization-id",
    NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID: "auth-proxy-config-id",
    GHOLA_TURNKEY_QUERY_ORGANIZATION_ID: "query-organization-id",
    GHOLA_TURNKEY_QUERY_API_PUBLIC_KEY: "query-api-public-key",
    GHOLA_TURNKEY_QUERY_API_PRIVATE_KEY: "query-api-private-key",
    GHOLA_LIGHTER_BUILDER_KEY: "lighter-builder-key",
    GHOLA_LIGHTER_ETHEREUM_RPC_URL: "https://ethereum.example/rpc",
    GHOLA_PRIVATE_AGENT_BETA_PUBLIC_ENABLED: "true",
    NEXT_PUBLIC_GHOLA_PERPS_MAINNET_ENABLED: "true",
    DATABASE_URL: "postgres://private-account-store",
    ...overrides,
  };
}

test("skips local builds", () => {
  assert.deepEqual(verifyPrivateWorkerRuntimeConfig({}), { skipped: true });
  assert.deepEqual(verifyPreviewProductRuntimeConfig({}), { skipped: true });
});

test("requires the Turnkey product runtime for every Vercel artifact", () => {
  for (const key of [
    "NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID",
    "NEXT_PUBLIC_TURNKEY_PERPS_AUTH_PROXY_CONFIG_ID",
  ]) {
    assert.throws(
      () => verifyPreviewProductRuntimeConfig(productEnv({ [key]: "" })),
      new RegExp(`missing ${key}`),
    );
  }
});

test("requires materialized Lighter and query-only Turnkey credentials", () => {
  for (const key of [
    "GHOLA_TURNKEY_QUERY_ORGANIZATION_ID",
    "GHOLA_TURNKEY_QUERY_API_PUBLIC_KEY",
    "GHOLA_TURNKEY_QUERY_API_PRIVATE_KEY",
    "GHOLA_LIGHTER_BUILDER_KEY",
    "GHOLA_LIGHTER_ETHEREUM_RPC_URL",
  ]) {
    assert.throws(
      () => verifyPreviewProductRuntimeConfig(productEnv({ [key]: "" })),
      new RegExp(`missing ${key}`),
    );
  }
  assert.throws(
    () => verifyPreviewProductRuntimeConfig(productEnv({ GHOLA_LIGHTER_BUILDER_KEY: "[SENSITIVE]" })),
    /preview_env_opaque:GHOLA_LIGHTER_BUILDER_KEY:runtime/,
  );
  assert.throws(
    () => verifyPreviewProductRuntimeConfig(productEnv({ GHOLA_LIGHTER_ETHEREUM_RPC_URL: "http:\/\/ethereum.example" })),
    /Lighter Ethereum RPC URL must use HTTPS/,
  );
});

test("requires public beta and mainnet delegation flags", () => {
  for (const key of [
    "GHOLA_PRIVATE_AGENT_BETA_PUBLIC_ENABLED",
    "NEXT_PUBLIC_GHOLA_PERPS_MAINNET_ENABLED",
  ]) {
    assert.throws(
      () => verifyPreviewProductRuntimeConfig(productEnv({ [key]: "false" })),
      new RegExp(`${key}=true`),
    );
  }
});

test("requires durable private account persistence", () => {
  assert.throws(
    () => verifyPreviewProductRuntimeConfig(productEnv({ DATABASE_URL: "" })),
    /missing private account Postgres persistence/,
  );
  assert.throws(
    () => verifyPreviewProductRuntimeConfig(productEnv({
      GHOLA_PRIVATE_ACCOUNT_STORE: "memory",
    })),
    /cannot use memory-only/,
  );
});

test("accepts Postgres or private Blob product persistence", () => {
  assert.deepEqual(verifyPreviewProductRuntimeConfig(productEnv()), {
    skipped: false,
    turnkey: "configured",
    beta_public: "enabled",
    mainnet_delegation: "enabled",
    persistence: "postgres",
  });
  assert.deepEqual(verifyPreviewProductRuntimeConfig(productEnv({
    DATABASE_URL: "",
    GHOLA_PRIVATE_ACCOUNT_STORE: "blob",
    GHOLA_PRIVATE_ACCOUNT_BLOB_READ_WRITE_TOKEN: "blob-token",
    GHOLA_PRIVATE_ACCOUNT_BLOB_ACCESS: "private",
  })), {
    skipped: false,
    turnkey: "configured",
    beta_public: "enabled",
    mainnet_delegation: "enabled",
    persistence: "blob-private",
  });
});

test("rejects public Blob storage and opaque product values", () => {
  assert.throws(
    () => verifyPreviewProductRuntimeConfig(productEnv({
      DATABASE_URL: "",
      GHOLA_PRIVATE_ACCOUNT_STORE: "blob",
      GHOLA_PRIVATE_ACCOUNT_BLOB_READ_WRITE_TOKEN: "blob-token",
      GHOLA_PRIVATE_ACCOUNT_BLOB_ACCESS: "public",
    })),
    /Blob persistence must be private/,
  );
  assert.throws(
    () => verifyPreviewProductRuntimeConfig(productEnv({
      NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID: "[SENSITIVE]",
    })),
    /preview_env_opaque:NEXT_PUBLIC_TURNKEY_PERPS_ORGANIZATION_ID:runtime/,
  );
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

test("rejects opaque Vercel placeholders before any worker request", async () => {
  const env = vercelEnv({
    PRIVATE_AGENT_WORKER_CAPABILITY_SECRET: "[SENSITIVE]",
  });
  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig(env),
    /preview_env_opaque:PRIVATE_AGENT_WORKER_CAPABILITY_SECRET:runtime/,
  );

  let requests = 0;
  await assert.rejects(
    verifyPrivateWorkerRuntimeAuthorization(env, async () => {
      requests += 1;
      return Response.json({}, { status: 500 });
    }),
    /preview_env_opaque:PRIVATE_AGENT_WORKER_CAPABILITY_SECRET:runtime/,
  );
  assert.equal(requests, 0);
});

test("requires exact worker image and funding-signer pins", () => {
  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig(vercelEnv({ GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST: "" })),
    /worker image digest pin/,
  );
  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig(vercelEnv({ GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: "" })),
    /funding signer pin/,
  );
  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig(vercelEnv({ GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: "not-a-key" })),
    /invalid private worker funding signer pin/,
  );
  assert.throws(
    () => verifyPrivateWorkerRuntimeConfig(vercelEnv({
      PRIVATE_AGENT_FUNDING_SIGNER_KEYS_B64: ROTATED_FUNDING_PUBLIC_KEY,
    })),
    /funding signer pins aliases disagree/,
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

test("accepts the active worker signer during a pinned key rotation", async () => {
  const result = await verifyPrivateWorkerRuntimeAuthorization(vercelEnv({
    GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64: `${ROTATED_FUNDING_PUBLIC_KEY},${FUNDING_PUBLIC_KEY}`,
  }), async () => Response.json(compatibilityProof(), { status: 200 }));

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
