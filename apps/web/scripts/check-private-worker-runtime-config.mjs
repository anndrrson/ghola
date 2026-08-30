import { createHash, createHmac, createPublicKey, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CARRY_EXECUTION_VENUES } from "@ghola/execution-core";
import { assertMaterializedVercelEnvValue } from "./verify-preview-env-parity.mjs";

export function verifyPrivateWorkerRuntimeConfig(env = process.env) {
  if (env.VERCEL !== "1") return { skipped: true };

  const rawUrl = first(env,
    "GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL",
    "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
    "GHOLA_PRIVATE_AGENT_WORKER_URL",
    "PHALA_AGENT_ENDPOINT",
  );
  if (!rawUrl) throw new Error("Vercel release is missing the private worker URL");

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Vercel release has an invalid private worker URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Vercel release private worker URL must use HTTPS");
  }

  const carryShadowUrl = optionalHttpsUrl(
    env.GHOLA_CARRY_SHADOW_WORKER_URL,
    "Vercel release Carry shadow worker URL",
  );

  const workerAuth = capabilitySecret(env) || executionToken(env);
  if (!workerAuth) throw new Error("Vercel release is missing private worker authentication");
  expectedWorkerCompatibility(env);

  return {
    skipped: false,
    worker_host: url.host,
    ...(carryShadowUrl ? { carry_shadow_worker_host: carryShadowUrl.host } : {}),
  };
}

export async function verifyPrivateWorkerRuntimeAuthorization(
  env = process.env,
  fetchImpl = fetch,
) {
  const config = verifyPrivateWorkerRuntimeConfig(env);
  if (config.skipped) return config;
  const rawUrl = first(env,
    "GHOLA_CONNECTOR_HYPERLIQUID_STYLE_MARKET_URL",
    "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
    "GHOLA_PRIVATE_AGENT_WORKER_URL",
    "PHALA_AGENT_ENDPOINT",
  );
  const path = "/.well-known/private-agent-authorization";
  const body = {
    version: 1,
    operation_class: "runtime_authorization_probe",
  };
  const authorization = workerAuthorization(env, path, body);
  const response = await fetchImpl(new URL(path, rawUrl), {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const responseBody = await response.json().catch(() => ({}));
  if (
    response.status !== 200 ||
    responseBody.version !== 1 ||
    responseBody.authorized !== true
  ) {
    throw new Error(`Vercel release private worker authorization failed (${response.status})`);
  }
  const expected = expectedWorkerCompatibility(env);
  if (
    responseBody.authorization_protocol !== "ghcap_v1" ||
    responseBody.worker_image_digest !== expected.worker_image_digest ||
    !expected.funding_signer_public_keys_b64.includes(responseBody.funding_signer_public_key_b64) ||
    !sameStrings(responseBody.carry_execution_venue_ids, CARRY_EXECUTION_VENUES)
  ) {
    throw new Error("Vercel release private worker compatibility evidence does not match this deployment");
  }
  return { ...config, worker_authorization: "verified" };
}

function first(env, ...keys) {
  for (const key of keys) {
    const value = String(env[key] || "").trim();
    if (!value) continue;
    assertMaterializedVercelEnvValue(key, value, "runtime");
    return value;
  }
  return "";
}

function optionalHttpsUrl(raw, label) {
  const value = String(raw || "").trim();
  if (!value) return null;
  assertMaterializedVercelEnvValue("GHOLA_CARRY_SHADOW_WORKER_URL", value, "runtime");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return url;
}

function workerAuthorization(env, path, body) {
  const secret = capabilitySecret(env);
  if (!secret) {
    return `Bearer ${executionToken(env)}`;
  }
  const now = Math.floor(Date.now() / 1_000);
  const payload = {
    version: 1,
    issuer: "ghola-web",
    method: "POST",
    path,
    scope: "runtime:read",
    body_hash: createHash("sha256").update(stableJson(body)).digest("hex"),
    jti: randomUUID(),
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    operation_class: body.operation_class,
  };
  const encoded = Buffer.from(stableJson(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `Bearer ghcap_v1.${encoded}.${signature}`;
}

function capabilitySecret(env) {
  return consistentAlias(env,
    "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
    "GHOLA_WORKER_CAPABILITY_SECRET",
    "worker capability secret",
  );
}

function executionToken(env) {
  return consistentAlias(env,
    "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
    "PRIVATE_AGENT_EXECUTION_TOKEN",
    "private worker execution token",
  );
}

function consistentAlias(env, primaryKey, legacyKey, label) {
  const primary = String(env[primaryKey] || "").trim();
  const legacy = String(env[legacyKey] || "").trim();
  if (primary) assertMaterializedVercelEnvValue(primaryKey, primary, "runtime");
  if (legacy) assertMaterializedVercelEnvValue(legacyKey, legacy, "runtime");
  if (primary && legacy && primary !== legacy) {
    throw new Error(`Vercel release ${label} aliases disagree`);
  }
  return primary || legacy;
}

function expectedWorkerCompatibility(env) {
  const imageDigest = first(env,
    "GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST",
    "GHOLA_PRIVATE_AGENT_IMAGE_DIGEST",
    "PHALA_CVM_IMAGE_DIGEST",
  ).toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    throw new Error("Vercel release is missing a valid private worker image digest pin");
  }
  const fundingSignerPins = consistentAlias(env,
    "GHOLA_FUNDING_WORKER_SIGNER_KEYS_B64",
    "PRIVATE_AGENT_FUNDING_SIGNER_KEYS_B64",
    "private worker funding signer pins",
  );
  if (!fundingSignerPins) {
    throw new Error("Vercel release is missing the private worker funding signer pin");
  }
  const fundingSignerPublicKeys = fundingSignerPins.split(",").map((pin) => pin.trim()).filter(Boolean);
  if (fundingSignerPublicKeys.length === 0) {
    throw new Error("Vercel release is missing the private worker funding signer pin");
  }
  for (const pin of fundingSignerPublicKeys) {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(pin, "base64"),
        format: "der",
        type: "spki",
      });
      if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    } catch {
      throw new Error("Vercel release has an invalid private worker funding signer pin");
    }
  }
  return {
    worker_image_digest: imageDigest,
    funding_signer_public_keys_b64: fundingSignerPublicKeys,
  };
}

function sameStrings(value, expected) {
  return Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((item, index) => value[index] === item);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

async function main() {
  const result = await verifyPrivateWorkerRuntimeAuthorization();
  console.log(result.skipped
    ? "[private-worker-runtime-config] skipped outside Vercel"
    : `[private-worker-runtime-config] verified ${result.worker_host} authorization`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
