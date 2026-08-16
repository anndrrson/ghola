import { afterEach, describe, expect, it, vi } from "vitest";
import { shieldedPoolHealth } from "./private-account-shielded-pool";

const NOW = new Date("2026-08-12T12:00:00.000Z");

describe("shielded pool health transports", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps public health checks local to their services and blocks sealed-runtime credentials", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => Response.json({
      status: "green",
      observed_at: NOW.toISOString(),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const health = await shieldedPoolHealth(NOW, {
      env: {
        NODE_ENV: "development",
        GHOLA_SHIELDED_POOL_INDEXER_URL: "https://indexer.example",
        GHOLA_SHIELDED_POOL_PROVER_URL: "https://prover.example",
        GHOLA_SHIELDED_POOL_RELAYER_URL: "https://relayer.example",
        GHOLA_PRIVATE_RUNTIME_URL: "https://sealed-runtime.example",
        GHOLA_PRIVATE_RUNTIME_TOKEN: "sealed-runtime-token",
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual([
      "https://indexer.example/healthz",
      "https://indexer.example/tree-state",
      "https://prover.example/healthz",
      "https://relayer.example/healthz",
    ]);
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain("sealed-runtime-token");
    expect(health.sealed_runtime).toMatchObject({
      status: "red",
      reason: "sealed runtime health transport is disabled",
    });
  });
});
