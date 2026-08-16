import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { POST as cancel } from "./[id]/cancel/route";
import { POST as close } from "./[id]/close/route";

const original = {
  enabled: process.env.GHOLA_CROSS_VENUE_BYO_ENABLED,
  workerUrl: process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL,
  workerToken: process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN,
};

afterEach(() => {
  vi.restoreAllMocks();
  restore("GHOLA_CROSS_VENUE_BYO_ENABLED", original.enabled);
  restore("GHOLA_PRIVATE_AGENT_EXECUTION_URL", original.workerUrl);
  restore("GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN", original.workerToken);
});

describe("cross-venue execution submit route", () => {
  it("rejects cross-origin mutation requests", async () => {
    const response = await POST(new Request("https://ghola.xyz/v1/private-account/cross-venue/executions", {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "same_origin_required" });
  });

  it("fails closed before authentication and worker probing in test/local runtimes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must not run"));
    delete process.env.GHOLA_CROSS_VENUE_BYO_ENABLED;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN;
    const response = await POST(new Request("https://ghola.xyz/v1/private-account/cross-venue/executions", {
      method: "POST",
      headers: { origin: "https://ghola.xyz", "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      version: 1,
      error: "private_agent_test_environment",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks cancellation before authentication, store mutation, or worker transport", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must not run"));
    const response = await cancel(
      new Request("https://ghola.xyz/v1/private-account/cross-venue/executions/execution_1/cancel", {
        method: "POST",
        headers: { origin: "https://ghola.xyz", "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ id: "execution_1" }) },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      version: 1,
      error: "private_agent_test_environment",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks paired close before authentication, store mutation, or worker transport", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must not run"));
    const response = await close(
      new Request("https://ghola.xyz/v1/private-account/cross-venue/executions/execution_1/close", {
        method: "POST",
        headers: { origin: "https://ghola.xyz", "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ id: "execution_1" }) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ version: 1, error: "private_agent_test_environment" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
