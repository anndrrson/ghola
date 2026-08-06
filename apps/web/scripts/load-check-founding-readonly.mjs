#!/usr/bin/env node

const baseUrl = (process.env.GHOLA_READONLY_LOAD_BASE_URL || "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const clients = Number.parseInt(process.env.GHOLA_READONLY_LOAD_CLIENTS || "100", 10);
const expectedCapacity = Number.parseInt(
  process.env.GHOLA_READONLY_EXPECTED_CAPACITY || "10",
  10,
);
const endpoint = `${baseUrl}/api/billing/founding-cohort`;

if (!Number.isInteger(clients) || clients < 1 || clients > 1_000) {
  throw new Error("GHOLA_READONLY_LOAD_CLIENTS must be between 1 and 1000");
}
if (!Number.isInteger(expectedCapacity) || expectedCapacity < 1) {
  throw new Error("GHOLA_READONLY_EXPECTED_CAPACITY must be a positive integer");
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
    const capacity = body?.capacity;
    const claimedSeats = body?.claimed_seats;
    const remainingSeats = body?.remaining_seats;
    return {
      status: response.status,
      durationMs: performance.now() - requestStartedAt,
      capacity,
      claimedSeats,
      remainingSeats,
      checkoutOpen: body?.checkout_open,
      valid:
        response.ok &&
        capacity === expectedCapacity &&
        Number.isInteger(claimedSeats) &&
        claimedSeats >= 0 &&
        Number.isInteger(remainingSeats) &&
        remainingSeats >= 0 &&
        claimedSeats + remainingSeats === capacity &&
        body?.checkout_open === (remainingSeats > 0),
    };
  }),
);

const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
const percentile = (fraction) =>
  durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))];
const failed = results.filter((result) => !result.valid);
const claimedSeats = results
  .map((result) => result.claimedSeats)
  .filter(Number.isInteger);
const summary = {
  endpoint,
  concurrent_clients: clients,
  expected_capacity: expectedCapacity,
  observed_claimed_seats_min: claimedSeats.length ? Math.min(...claimedSeats) : null,
  observed_claimed_seats_max: claimedSeats.length ? Math.max(...claimedSeats) : null,
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
