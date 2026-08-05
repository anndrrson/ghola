#!/usr/bin/env node

import { readFileSync } from "node:fs";

const baseUrl = (process.env.GHOLA_SHARD_LOAD_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const clients = Number.parseInt(process.env.GHOLA_SHARD_LOAD_CLIENTS || "100", 10);
const expectedShards = Number.parseInt(process.env.GHOLA_SHARD_LOAD_EXPECTED_SHARDS || "10", 10);
const expectedPerShard = Number.parseInt(process.env.GHOLA_SHARD_LOAD_USERS_PER_SHARD || "10", 10);
const remoteAllowed = process.env.GHOLA_SHARD_LOAD_ALLOW_REMOTE === "true";
const authorizationFile = process.env.GHOLA_SHARD_LOAD_AUTHORIZATION_FILE?.trim() || "";
const target = new URL(baseUrl);

if (!Number.isInteger(clients) || clients < 1 || clients > 1_000) {
  throw new Error("GHOLA_SHARD_LOAD_CLIENTS must be between 1 and 1000");
}
if (!remoteAllowed && !["127.0.0.1", "localhost", "::1"].includes(target.hostname)) {
  throw new Error("Remote shard checks require GHOLA_SHARD_LOAD_ALLOW_REMOTE=true");
}

const remoteTarget = !["127.0.0.1", "localhost", "::1"].includes(target.hostname);
const suppliedAuthorizations = authorizationFile
  ? readFileSync(authorizationFile, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  : [];
if (remoteTarget && suppliedAuthorizations.length !== clients) {
  throw new Error("Remote shard checks require one authorization header per client in GHOLA_SHARD_LOAD_AUTHORIZATION_FILE");
}

const tokenFor = (index) => `Bearer ${[
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: `shard_load_user_${index}`, email: `shard-load-${index}@example.invalid` })).toString("base64url"),
  "local-load-check",
].join(".")}`;
const authorizationFor = (index) => suppliedAuthorizations[index] || tokenFor(index);

const startedAt = performance.now();
const results = await Promise.all(Array.from({ length: clients }, async (_, index) => {
  const requestStartedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}/v1/private-account/hyperliquid/runtime`, {
      method: "GET",
      headers: { authorization: authorizationFor(index), accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null);
    const provider = body?.providers?.find((candidate) => candidate?.id === "phala");
    return {
      status: response.status,
      duration_ms: performance.now() - requestStartedAt,
      recipient_id: provider?.sealed_recipient?.recipient_id || null,
      ready: response.ok && body?.remote_execution_ready === true && provider?.available === true,
    };
  } catch (error) {
    return {
      status: 0,
      duration_ms: performance.now() - requestStartedAt,
      recipient_id: null,
      ready: false,
      failure: error instanceof Error ? error.name : "request_failed",
    };
  }
}));

const ready = results.filter((result) => result.ready);
const recipientCounts = new Map();
for (const result of ready) {
  recipientCounts.set(result.recipient_id, (recipientCounts.get(result.recipient_id) || 0) + 1);
}
const durations = results.map((result) => result.duration_ms).sort((a, b) => a - b);
const percentile = (fraction) => durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))];
const counts = [...recipientCounts.values()];
const valid =
  ready.length === clients &&
  recipientCounts.size === expectedShards &&
  counts.every((count) => count <= expectedPerShard);

console.log(JSON.stringify({
  endpoint: `${baseUrl}/v1/private-account/hyperliquid/runtime`,
  operation: "authenticated_read_only_shard_reservation",
  orders_previewed_or_submitted: 0,
  concurrent_clients: clients,
  ready_clients: ready.length,
  unique_shards: recipientCounts.size,
  maximum_users_on_one_shard: counts.length ? Math.max(...counts) : 0,
  wall_time_ms: Math.round(performance.now() - startedAt),
  p50_ms: Math.round(percentile(0.5)),
  p95_ms: Math.round(percentile(0.95)),
  p99_ms: Math.round(percentile(0.99)),
  passed: valid,
}, null, 2));

if (!valid) process.exit(1);
