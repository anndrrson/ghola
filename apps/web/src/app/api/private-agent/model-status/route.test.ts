import { describe, expect, it, vi } from "vitest";
import { readTradingModelStatus } from "./route";

describe("private-agent model status", () => {
  it("fails closed when the worker is not configured", async () => {
    const status = await readTradingModelStatus({ env: {} });

    expect(status).toMatchObject({
      worker_configured: false,
      reachable: false,
      configured: false,
      error: "worker_endpoint_unconfigured",
    });
  });

  it("returns only redacted model metadata", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      decision_provider: {
        configured: true,
        provider_kind: "openai_compatible",
        model_id: "local-model",
        endpoint_origin: "https://models.example/v1?token=secret",
        local: false,
        structured_outputs: true,
        api_key: "must-not-leak",
      },
    }))) as unknown as typeof fetch;

    const status = await readTradingModelStatus({
      env: { GHOLA_PRIVATE_AGENT_WORKER_URL: "https://worker.example/runtime" },
      fetchImpl,
    });

    expect(status).toEqual({
      version: 1,
      worker_configured: true,
      reachable: true,
      configured: true,
      provider_kind: "openai_compatible",
      model_id: "local-model",
      endpoint_origin: "https://models.example",
      local: false,
      structured_outputs: true,
      error: null,
    });
    expect(JSON.stringify(status)).not.toContain("must-not-leak");
  });

  it("rejects non-loopback HTTP before fetching", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const status = await readTradingModelStatus({
      env: { GHOLA_PRIVATE_AGENT_WORKER_URL: "http://worker.example" },
      fetchImpl,
    });

    expect(status.error).toBe("worker_endpoint_unsafe");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
