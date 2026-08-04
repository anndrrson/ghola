#!/usr/bin/env node

const baseUrl = (process.env.GHOLA_READONLY_LOAD_BASE_URL || "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const clients = Number.parseInt(process.env.GHOLA_READONLY_LOAD_CLIENTS || "100", 10);
const endpoint = `${baseUrl}/api/billing/founding-cohort`;

if (!Number.isInteger(clients) || clients < 1 || clients > 1_000) {
  throw new Error("GHOLA_READONLY_LOAD_CLIENTS must be between 1 and 1000");
}

const startedAt = performance.now();
const results = await Promise.all(
  Array.from({ length: clients }, async () => {
    const requestStartedAt = performance.now();
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null);
    return {
      status: response.status,
      durationMs: performance.now() - requestStartedAt,
      valid:
        response.ok &&
        Number.isInteger(body?.capacity) &&
        Number.isInteger(body?.remaining_seats) &&
        body.remaining_seats >= 0 &&
        body.remaining_seats <= body.capacity,
    };
  }),
);

const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
const percentile = (fraction) =>
  durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))];
const failed = results.filter((result) => !result.valid);
const summary = {
  endpoint,
  concurrent_clients: clients,
  successful_responses: clients - failed.length,
  failed_responses: failed.length,
  wall_time_ms: Math.round(performance.now() - startedAt),
  p50_ms: Math.round(percentile(0.5)),
  p95_ms: Math.round(percentile(0.95)),
  p99_ms: Math.round(percentile(0.99)),
  status_counts: Object.fromEntries(
    [...new Set(results.map((result) => result.status))].map((status) => [
      status,
      results.filter((result) => result.status === status).length,
    ]),
  ),
};

console.log(JSON.stringify(summary, null, 2));
if (failed.length > 0) process.exit(1);
