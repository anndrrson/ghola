import { afterEach, describe, expect, it, vi } from "vitest";
import { probeConfiguredAutopilotWorkerReadiness } from "./private-agent-worker-readiness";
import { brandPrivateAgentMockTransport } from "./private-agent-spend-policy";

describe("autopilot worker readiness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts the exact configured worker only when its readiness endpoint is ready", async () => {
    const calls: string[] = [];
    const readiness = await probeConfiguredAutopilotWorkerReadiness({
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
    }, brandPrivateAgentMockTransport((async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ready: true, missing: [] }), { status: 200 });
    }) as typeof fetch));

    expect(calls).toEqual(["https://worker.example/ready"]);
    expect(readiness).toEqual({
      ok: true,
      error: null,
      missing: [],
      status: 200,
    });
  });

  it("preserves missing attestation evidence in a safe readiness error", async () => {
    const readiness = await probeConfiguredAutopilotWorkerReadiness({
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
    }, brandPrivateAgentMockTransport((async () => new Response(JSON.stringify({
      ready: false,
      missing: ["attestation", "measurement", "attestation_hash"],
    }), { status: 503 })) as typeof fetch));

    expect(readiness).toEqual({
      ok: false,
      error: "worker_not_ready:attestation,measurement,attestation_hash",
      missing: ["attestation", "measurement", "attestation_hash"],
      status: 503,
    });
  });

  it("fails closed when worker authorization is not configured", async () => {
    const readiness = await probeConfiguredAutopilotWorkerReadiness({
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
    }, async () => {
      throw new Error("fetch should not be called");
    });

    expect(readiness).toEqual({
      ok: false,
      error: "worker_not_configured",
      missing: [],
      status: null,
    });
  });

  it("does not probe a configured remote worker through the default test transport", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);

    const readiness = await probeConfiguredAutopilotWorkerReadiness({
      GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
      GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "token",
    });

    expect(readiness).toMatchObject({ ok: false, error: "worker_not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
