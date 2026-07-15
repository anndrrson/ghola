import { afterEach, describe, expect, it } from "vitest";
import { POST } from "./route";

const original = {
  enabled: process.env.GHOLA_CROSS_VENUE_BYO_ENABLED,
  workerUrl: process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL,
  workerToken: process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN,
};

afterEach(() => {
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

  it("fails closed before authentication when the execution worker contract is disabled", async () => {
    delete process.env.GHOLA_CROSS_VENUE_BYO_ENABLED;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_URL;
    delete process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN;
    const response = await POST(new Request("https://ghola.xyz/v1/private-account/cross-venue/executions", {
      method: "POST",
      headers: { origin: "https://ghola.xyz", "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "cross_venue_execution_not_ready",
      readiness: { ready: false, atomic: false },
    });
  });
});

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
