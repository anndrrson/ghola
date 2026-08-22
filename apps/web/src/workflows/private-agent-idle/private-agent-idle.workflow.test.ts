import { afterEach, describe, expect, it } from "vitest";
import { getRun, start } from "workflow/api";
import { waitForSleep } from "@workflow/vitest";
import { privateAgentIdleShutdownWorkflow } from ".";

afterEach(() => {
  delete process.env.GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN;
  delete process.env.GHOLA_PRIVATE_AGENT_LEASE_STORE;
  delete process.env.PHALA_CLOUD_API_KEY;
});

describe("private-agent durable idle shutdown", () => {
  it("sleeps without compute and then performs the guarded stop step", async () => {
    // Keep the provider call disabled in this orchestration test. The stop
    // step's success/retry paths are covered separately with unit mocks.
    process.env.GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN = "false";
    process.env.GHOLA_PRIVATE_AGENT_LEASE_STORE = "memory";

    const run = await start(privateAgentIdleShutdownWorkflow, [
      {
        provider_id: "phala",
        lease_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    ]);
    const sleepId = await waitForSleep(run);
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

    await expect(run.returnValue).resolves.toMatchObject({
      provider_id: "phala",
      status: "disabled",
      attempted: false,
      stopped: false,
    });
  });
});
