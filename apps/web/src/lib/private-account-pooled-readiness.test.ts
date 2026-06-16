import { describe, expect, it } from "vitest";
import {
  getPooledWorkerReadiness,
  pooledWorkerVenueGateFromReadiness,
  type PooledWorkerReadiness,
} from "./private-account-pooled-readiness";

describe("pooled worker per-venue readiness gate", () => {
  it("allows a ready Phoenix venue when unrelated pooled venues are blocked", () => {
    const readiness: PooledWorkerReadiness = {
      status: "blocked",
      ready: false,
      endpoint_configured: true,
      reason_codes: [],
      checked_at: "2026-06-13T07:06:38.812Z",
      venues: {
        hyperliquid: {
          venue_id: "hyperliquid",
          status: "blocked",
          ready: false,
          reason_codes: ["hyperliquid_pooled_account_pool_missing"],
        },
        phoenix: {
          venue_id: "phoenix",
          status: "ready",
          ready: true,
          reason_codes: [],
        },
        backpack: {
          venue_id: "backpack",
          status: "blocked",
          ready: false,
          reason_codes: ["pooled_worker_venue_unsupported"],
        },
        jupiter: {
          venue_id: "jupiter",
          status: "blocked",
          ready: false,
          reason_codes: ["jupiter_api_key_missing"],
        },
        coinbase: {
          venue_id: "coinbase",
          status: "blocked",
          ready: false,
          reason_codes: ["coinbase_omnibus_pool_not_ready"],
        },
      },
    };

    expect(pooledWorkerVenueGateFromReadiness("phoenix", readiness)).toEqual({
      ok: true,
      reason_codes: [],
    });
    expect(pooledWorkerVenueGateFromReadiness("hyperliquid", readiness)).toEqual({
      ok: false,
      error: "pooled_worker_not_ready",
      reason_codes: ["hyperliquid_pooled_account_pool_missing"],
    });
  });

  it("fails a ready venue when the worker reports a global safety blocker", () => {
    const readiness: PooledWorkerReadiness = {
      status: "blocked",
      ready: false,
      endpoint_configured: true,
      reason_codes: ["worker_state_store_not_shared"],
      checked_at: "2026-06-13T07:06:38.812Z",
      venues: {
        hyperliquid: {
          venue_id: "hyperliquid",
          status: "blocked",
          ready: false,
          reason_codes: ["hyperliquid_pooled_account_pool_missing"],
        },
        phoenix: {
          venue_id: "phoenix",
          status: "ready",
          ready: true,
          reason_codes: [],
        },
        backpack: {
          venue_id: "backpack",
          status: "blocked",
          ready: false,
          reason_codes: ["pooled_worker_venue_unsupported"],
        },
        jupiter: {
          venue_id: "jupiter",
          status: "blocked",
          ready: false,
          reason_codes: ["jupiter_api_key_missing"],
        },
        coinbase: {
          venue_id: "coinbase",
          status: "blocked",
          ready: false,
          reason_codes: ["coinbase_omnibus_pool_not_ready"],
        },
      },
    };

    expect(pooledWorkerVenueGateFromReadiness("phoenix", readiness)).toEqual({
      ok: false,
      error: "pooled_worker_not_ready",
      reason_codes: ["worker_state_store_not_shared"],
    });
  });

  it("retries legacy workers without unsupported venues instead of failing the whole probe", async () => {
    const requests: unknown[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push(body);
      if (Array.isArray(body.venues) && body.venues.includes("backpack")) {
        return new Response(JSON.stringify({
          error: "invalid pooled readiness request",
          details: ["venue backpack is unsupported"],
        }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        version: 1,
        status: "ready",
        ready: true,
        venues: [
          { venue_id: "hyperliquid", status: "ready", ready: true, reason_codes: [] },
          { venue_id: "phoenix", status: "ready", ready: true, reason_codes: [] },
          { venue_id: "jupiter", status: "ready", ready: true, reason_codes: [] },
          { venue_id: "coinbase", status: "ready", ready: true, reason_codes: [] },
        ],
        reason_codes: [],
        checked_at: "2026-06-15T17:51:58.982Z",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const readiness = await getPooledWorkerReadiness({
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_WORKER_CAPABILITY_SECRET: "worker-capability-secret",
    }, fetchImpl);

    expect(requests).toHaveLength(2);
    expect((requests[0] as { venues: string[] }).venues).toContain("backpack");
    expect((requests[1] as { venues: string[] }).venues).not.toContain("backpack");
    expect(pooledWorkerVenueGateFromReadiness("phoenix", readiness)).toEqual({
      ok: true,
      reason_codes: [],
    });
    expect(pooledWorkerVenueGateFromReadiness("backpack", readiness)).toEqual({
      ok: false,
      error: "pooled_worker_not_ready",
      reason_codes: ["pooled_worker_venue_unsupported"],
    });
  });

  it("prefers an explicit worker URL over Phala discovery env", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        version: 1,
        status: "blocked",
        ready: false,
        venues: [
          { venue_id: "hyperliquid", status: "blocked", ready: false, reason_codes: ["hyperliquid_pooled_account_pool_missing"] },
          { venue_id: "phoenix", status: "ready", ready: true, reason_codes: [] },
          { venue_id: "backpack", status: "blocked", ready: false, reason_codes: ["backpack_pooled_disabled"] },
          { venue_id: "jupiter", status: "blocked", ready: false, reason_codes: ["jupiter_api_key_missing"] },
          { venue_id: "coinbase", status: "blocked", ready: false, reason_codes: ["coinbase_omnibus_pool_not_ready"] },
        ],
        reason_codes: [],
        checked_at: "2026-06-16T14:15:00.000Z",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const readiness = await getPooledWorkerReadiness({
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://explicit-worker.example",
      GHOLA_PRIVATE_AGENT_PROVIDER: "phala",
      PHALA_CLOUD_API_KEY: "phala_api_key_present",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "worker-token",
    }, fetchImpl);

    expect(urls).toEqual(["https://explicit-worker.example/venues/pools/readiness"]);
    expect(pooledWorkerVenueGateFromReadiness("phoenix", readiness)).toEqual({
      ok: true,
      reason_codes: [],
    });
  });
});
