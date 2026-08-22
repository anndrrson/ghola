import { afterEach, describe, expect, it, vi } from "vitest";
import { stopExpiredPhalaPrivateAgent } from "./steps";

const phala = vi.hoisted(() => ({
  stopIdlePhalaPrivateAgent: vi.fn(),
}));

vi.mock("@/lib/private-agent-phala", () => ({
  stopIdlePhalaPrivateAgent: phala.stopIdlePhalaPrivateAgent,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("private-agent idle stop step", () => {
  it("returns a minimal persisted summary after an idempotent stop", async () => {
    phala.stopIdlePhalaPrivateAgent.mockResolvedValue({
      attempted: true,
      stopped: true,
      status: "stopped",
      cvm_name: "test-worker",
    });

    await expect(stopExpiredPhalaPrivateAgent("phala")).resolves.toEqual({
      provider_id: "phala",
      status: "stopped",
      attempted: true,
      stopped: true,
      lease_expires_at: null,
    });
  });

  it("turns a transient control-plane failure into a bounded retry", async () => {
    phala.stopIdlePhalaPrivateAgent.mockResolvedValue({
      attempted: true,
      stopped: false,
      status: "failed",
      cvm_name: "test-worker",
      reason: "do not persist provider details",
    });

    await expect(stopExpiredPhalaPrivateAgent("phala")).rejects.toMatchObject({
      name: "RetryableError",
      message: "Phala idle stop failed; retrying safely.",
    });
    expect(stopExpiredPhalaPrivateAgent.maxRetries).toBe(3);
  });
});
