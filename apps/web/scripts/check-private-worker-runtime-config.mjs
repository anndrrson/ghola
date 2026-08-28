import { createHash, createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

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
  return { ...config, worker_authorization: "verified" };
}

function first(env, ...keys) {
  for (const key of keys) {
    const value = String(env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function optionalHttpsUrl(raw, label) {
  const value = String(raw || "").trim();
  if (!value) return null;
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
  if (primary && legacy && primary !== legacy) {
    throw new Error(`Vercel release ${label} aliases disagree`);
  }
  return primary || legacy;
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
