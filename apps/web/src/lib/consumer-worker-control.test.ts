import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyConsumerWorker } from "./consumer-worker-control";

describe("consumer worker control transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not forward a control token through the default test transport", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await proxyConsumerWorker({
      path: "/consumer/circuit",
      method: "POST",
      tokenEnv: "GHOLA_TRADING_CONTROL_TOKEN",
      body: { action: "halt" },
      env: {
        PRIVATE_AGENT_WORKER_URL: "https://worker.example",
        GHOLA_TRADING_CONTROL_TOKEN: "control-token-longer-than-32-bytes",
      },
    });

    expect(result).toEqual({
      status: 503,
      body: { error: "private_agent_consumer_control_unconfigured" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
