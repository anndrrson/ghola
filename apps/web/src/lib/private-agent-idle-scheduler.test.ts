import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivateAgentRuntimeLeaseRecord } from "./private-agent-runtime-lease";
import { schedulePhalaIdleShutdown } from "./private-agent-idle-scheduler";
import { privateAgentIdleShutdownWorkflow } from "@/workflows/private-agent-idle";

const workflowApi = vi.hoisted(() => ({
  start: vi.fn(),
}));

vi.mock("workflow/api", () => workflowApi);

afterEach(() => {
  vi.clearAllMocks();
});

const LEASE: PrivateAgentRuntimeLeaseRecord = {
  version: 1,
  provider_id: "phala",
  state: "active",
  last_activity_at: "2026-08-06T12:00:00.000Z",
  lease_expires_at: "2026-08-06T12:30:00.000Z",
  last_reason: "test",
  updated_at: "2026-08-06T12:00:00.000Z",
};

describe("private-agent idle scheduler", () => {
  it("persists a durable shutdown at the exact lease deadline", async () => {
    workflowApi.start.mockResolvedValue({ runId: "wrun_idle_1" });

    const result = await schedulePhalaIdleShutdown(LEASE);

    expect(result).toEqual({ scheduled: true, run_id: "wrun_idle_1" });
    expect(workflowApi.start).toHaveBeenCalledWith(
      privateAgentIdleShutdownWorkflow,
      [
        {
          provider_id: "phala",
          lease_expires_at: LEASE.lease_expires_at,
        },
      ],
    );
  });

  it("fails closed without exposing scheduler internals", async () => {
    workflowApi.start.mockRejectedValue(new Error("sensitive backend detail"));

    const result = await schedulePhalaIdleShutdown(LEASE);

    expect(result).toEqual({
      scheduled: false,
      reason: "Durable Phala idle shutdown could not be scheduled.",
    });
  });
});
