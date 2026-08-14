import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as startMarketMaker } from "./market-maker/start/route";
import { POST as runArbitrage } from "./run/route";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tri-venue route spend boundary", () => {
  it.each([
    ["run", runArbitrage],
    ["market maker", startMarketMaker],
  ] as const)("blocks %s before authentication, nonce mutation, or transport", async (_label, post) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must not run"));
    const request = new Request("https://ghola.test/v1/private-account/arb/tri-venue/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ live_submit: true }),
    });

    const response = await post(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      version: 1,
      error: "private_agent_test_environment",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
