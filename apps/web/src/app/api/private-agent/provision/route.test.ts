import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe("private-agent provision route", () => {
  it("blocks localhost provisioning before any external request", async () => {
    vi.stubEnv("VERCEL_ENV", "development");
    process.env.GHOLA_PRIVATE_AGENT_PROVISION_TOKEN = "operator-token";
    process.env.GHOLA_PRIVATE_AGENT_SPEND_ARMED = "true";
    process.env.GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED = "true";
    process.env.GHOLA_PRIVATE_AGENT_JIT_PROVISIONING = "true";
    process.env.PHALA_CLOUD_API_KEY = "phala-key";
    process.env.GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN = "worker-token";
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const response = await POST(new Request("http://localhost:3000/api/private-agent/provision", {
      method: "POST",
      headers: { authorization: "Bearer operator-token" },
    }) as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "private_agent_runtime_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
