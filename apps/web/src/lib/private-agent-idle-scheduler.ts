import type { PrivateAgentRuntimeLeaseRecord } from "./private-agent-runtime-lease";
import { privateAgentIdleShutdownWorkflow } from "@/workflows/private-agent-idle";
import { start } from "workflow/api";

export interface PrivateAgentIdleScheduleResult {
  scheduled: boolean;
  run_id?: string;
  reason?: string;
}

/**
 * Enqueue the durable idle timer before paid capacity is started. `start()`
 * returns after the timer is persisted; the sleeping workflow consumes no
 * active compute while it waits for the lease deadline.
 */
export async function schedulePhalaIdleShutdown(
  lease: PrivateAgentRuntimeLeaseRecord,
): Promise<PrivateAgentIdleScheduleResult> {
  try {
    const run = await start(privateAgentIdleShutdownWorkflow, [
      {
        provider_id: "phala",
        lease_expires_at: lease.lease_expires_at,
      },
    ]);
    return { scheduled: true, run_id: run.runId };
  } catch {
    return {
      scheduled: false,
      reason: "Durable Phala idle shutdown could not be scheduled.",
    };
  }
}
