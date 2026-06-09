#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const prodEnvPath = process.env.GHOLA_PRIVATE_AGENT_PROD_ENV || "";
if (!prodEnvPath) {
  loadEnvFile(process.env.GHOLA_PRIVATE_AGENT_STAGING_ENV || `${ROOT}/.dev/private-agent-staging.env`);
}
loadEnvFile(prodEnvPath, { override: true });

const workerUrl = trimUrl(
  env("PRIVATE_AGENT_WORKER_URL") ||
    env("GHOLA_PRIVATE_AGENT_EXECUTION_URL") ||
    env("GHOLA_PRIVATE_AGENT_WORKER_URL") ||
    env("PHALA_AGENT_ENDPOINT"),
);
const token = env("PRIVATE_AGENT_EXECUTION_TOKEN") ||
  env("GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN");
const capabilitySecret = env("PRIVATE_AGENT_WORKER_CAPABILITY_SECRET") ||
  env("GHOLA_WORKER_CAPABILITY_SECRET");
const venues = env("GHOLA_POOLED_READINESS_VENUES", "hyperliquid,phoenix,jupiter,coinbase")
  .split(",")
  .map((venue) => venue.trim())
  .filter(Boolean);

if (!workerUrl) fail("PRIVATE_AGENT_WORKER_URL, GHOLA_PRIVATE_AGENT_EXECUTION_URL, or GHOLA_PRIVATE_AGENT_WORKER_URL is required");
if (!token && !capabilitySecret) {
  fail("PRIVATE_AGENT_EXECUTION_TOKEN, GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN, PRIVATE_AGENT_WORKER_CAPABILITY_SECRET, or GHOLA_WORKER_CAPABILITY_SECRET is required");
}

const checks = [];
checks.push(await safeGet("/health"));
checks.push(await safeGet("/ready"));
checks.push(await safeGet("/.well-known/private-agent-recipient"));
checks.push(await pooledReadiness());

const summary = {
  version: 1,
  worker_url_configured: Boolean(workerUrl),
  checked_at: new Date().toISOString(),
  checks: checks.map(redactedCheck),
};
console.log(JSON.stringify(summary, null, 2));

if (checks.some((check) => !check.ok)) process.exit(1);
const readiness = checks.find((check) => check.path === "/venues/pools/readiness")?.body;
if (readiness?.ready !== true) process.exit(2);

async function safeGet(path) {
  return request(path, { method: "GET" });
}

async function pooledReadiness() {
  const path = "/venues/pools/readiness";
  const body = {
    version: 1,
    operation_class: "pooled_readiness",
    venues,
  };
  return request(path, {
    method: "POST",
    headers: {
      authorization: authorizationHeader({ path, body }),
      "content-type": "application/json",
      "x-ghola-sealed-execution-required": "true",
    },
    body: JSON.stringify(body),
  });
}

async function request(path, init) {
  try {
    const response = await fetch(`${workerUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { non_json_prefix: text.slice(0, 160) };
      }
    }
    return {
      path,
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch (error) {
    return {
      path,
      ok: false,
      status: 0,
      body: {
        error: error instanceof Error ? error.message : String(error),
        error_name: error instanceof Error ? error.name : "Error",
        cause_code: error?.cause?.code || null,
        cause_name: error?.cause?.name || null,
      },
    };
  }
}

function authorizationHeader({ path, body }) {
  if (!capabilitySecret) return `Bearer ${token}`;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    version: 1,
    issuer: "ghola-pooled-readiness-probe",
    method: "POST",
    path,
    scope: "credential:verify",
    body_hash: bodyHash(body),
    jti: randomUUID(),
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    operation_class: "pooled_readiness",
  };
  const payloadB64 = Buffer.from(stableJson(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", capabilitySecret).update(payloadB64).digest("base64url");
  return `Bearer ghcap_v1.${payloadB64}.${signature}`;
}

function redactedCheck(check) {
  const body = check.body && typeof check.body === "object"
    ? redactBody(check.body)
    : check.body;
  return {
    path: check.path,
    ok: check.ok,
    status: check.status,
    body,
  };
}

function redactBody(value) {
  if (Array.isArray(value)) return value.map(redactBody);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (isSecretKey(key)) return [key, "[redacted]"];
    return [key, redactBody(child)];
  }));
}

function isSecretKey(key) {
  const normalized = String(key).toLowerCase();
  return normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("private_key") ||
    normalized.includes("api_wallet") ||
    normalized.includes("api_private") ||
    normalized.includes("mnemonic") ||
    normalized.includes("seed");
}

function bodyHash(body) {
  return createHash("sha256").update(stableJson(body)).digest("hex");
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

function loadEnvFile(path, options = {}) {
  if (!path || !existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] && !options.override) continue;
    process.env[key] = unquoteEnv(rawValue.trim());
  }
}

function unquoteEnv(value) {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1).replace(/'\\''/g, "'").replace(/\\n/g, "\n");
  }
  return value;
}

function env(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function trimUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

function fail(message) {
  console.error(`[pooled-readiness] ${message}`);
  process.exit(1);
}
